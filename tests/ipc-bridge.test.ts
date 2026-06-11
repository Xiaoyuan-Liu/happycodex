/**
 * IpcToolBridge 单测 —— 用临时目录验证 IPC 文件落盘 + 记忆读写 + 路径穿越防护。
 *
 * 每个用例用 os.tmpdir() 下唯一子目录，afterEach 清理，互不干扰。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile, symlink, rename } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { IpcToolBridge } from '../src/runtime/tools/ipc-bridge.js';
import { ToolRegistry } from '../src/runtime/tools/registry.js';
import { createBuiltinTools } from '../src/runtime/tools/builtin.js';
import type { ScheduleTaskInput, ToolContext } from '../src/runtime/tools/types.js';
import type { DynamicToolCallResponse } from '../src/appserver/protocol.js';

const FOLDER = 'home-test';
const CHAT_JID = 'web:home-test';

let root: string;
let ipcDir: string;
let memoryDir: string;
let workspaceDir: string;
let bridge: IpcToolBridge;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'happycodex-ipc-'));
  ipcDir = path.join(root, 'ipc');
  memoryDir = path.join(root, 'groups');
  workspaceDir = path.join(root, 'groups', FOLDER); // 群组工作区（send_image/send_file 锚点）
  // A4：poll 间隔/超时调小——本套件无主进程应答，读类工具快速进入超时/降级路径。
  bridge = new IpcToolBridge({
    ipcDir,
    memoryDir,
    workspaceGroupDir: workspaceDir,
    chatJid: CHAT_JID,
    pollIntervalMs: 5,
    pollTimeoutMs: 100,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 列出 {ipcDir}/{folder}/{channel} 下的文件（目录不存在 → []）。 */
async function listChannel(channel: 'messages' | 'tasks'): Promise<string[]> {
  try {
    return await readdir(path.join(ipcDir, FOLDER, channel));
  } catch {
    return [];
  }
}

async function readChannelJson(channel: 'messages' | 'tasks', file: string): Promise<unknown> {
  const raw = await readFile(path.join(ipcDir, FOLDER, channel, file), 'utf8');
  return JSON.parse(raw);
}

describe('IpcToolBridge — sendMessage', () => {
  it('写出 messages/*.json（上游线格式：type=message + chatJid/groupFolder/timestamp），且无 .tmp 残留', async () => {
    await bridge.sendMessage(FOLDER, 'hello world');

    const files = await listChannel('messages');
    const jsons = files.filter((f) => f.endsWith('.json'));
    const tmps = files.filter((f) => f.endsWith('.tmp'));

    expect(jsons).toHaveLength(1);
    expect(tmps).toHaveLength(0); // 原子写：rename 后无 .tmp 残留

    const payload = (await readChannelJson('messages', jsons[0]!)) as Record<string, unknown>;
    // 主进程消费契约（index.ts messages 分支）：data.type === 'message' && data.chatJid && data.text
    expect(payload.type).toBe('message');
    expect(payload.chatJid).toBe(CHAT_JID);
    expect(payload.groupFolder).toBe(FOLDER);
    expect(payload.text).toBe('hello world');
    expect(typeof payload.timestamp).toBe('string');
    // 非定时任务运行：不得 stamp isScheduledTask/taskId（存在与否决定主进程广播分支）
    expect('isScheduledTask' in payload).toBe(false);
    expect('taskId' in payload).toBe(false);
  });

  it('定时任务运行（isScheduledTask + currentTaskId）→ 条件 stamp isScheduledTask/taskId', async () => {
    const taskBridge = new IpcToolBridge({
      ipcDir,
      memoryDir,
      chatJid: CHAT_JID,
      isScheduledTask: true,
      currentTaskId: 'task-uuid-1',
    });
    await taskBridge.sendMessage(FOLDER, 'progress update');
    const files = (await listChannel('messages')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const payload = (await readChannelJson('messages', files[0]!)) as Record<string, unknown>;
    expect(payload.isScheduledTask).toBe(true);
    expect(payload.taskId).toBe('task-uuid-1');
  });

  it('未绑定 chatJid → sendMessage 抛错（诚实失败，不写主进程会静默丢弃的请求）', async () => {
    const noJid = new IpcToolBridge({ ipcDir, memoryDir });
    await expect(noJid.sendMessage(FOLDER, 'x')).rejects.toThrow(/no chatJid/);
    expect(await listChannel('messages')).toEqual([]);
  });
});

describe('IpcToolBridge — scheduleTask / list / lifecycle', () => {
  const input: ScheduleTaskInput = {
    name: 'nightly',
    prompt: 'do the thing',
    schedule: { kind: 'cron', expr: '0 0 * * *' },
  };

  it('scheduleTask 返回 taskId 且 tasks/ 有上游 flat 格式文件（schedule_task + targetJid）', async () => {
    const { taskId } = await bridge.scheduleTask(FOLDER, input);
    expect(taskId).toMatch(/^task_/);

    const files = (await listChannel('tasks')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);

    const payload = (await readChannelJson('tasks', files[0]!)) as Record<string, unknown>;
    // 主进程消费契约（processTaskIpc case 'schedule_task'）：
    // data.schedule_type && data.schedule_value && data.targetJid，agent 模式还要 prompt。
    expect(payload.type).toBe('schedule_task');
    expect(payload.taskId).toBe(taskId);
    expect(payload.name).toBe('nightly');
    expect(payload.prompt).toBe('do the thing');
    expect(payload.schedule_type).toBe('cron');
    expect(payload.schedule_value).toBe('0 0 * * *');
    expect(payload.targetJid).toBe(CHAT_JID);
    expect(payload.execution_type).toBe('agent');
    expect(payload.context_mode).toBe('group');
    expect(payload.createdBy).toBe(FOLDER);
  });

  it('interval 调度：秒 → 毫秒字符串（上游 schedule_value 语义）；once 透传本地时间戳', async () => {
    await bridge.scheduleTask(FOLDER, {
      name: 'i',
      prompt: 'p',
      schedule: { kind: 'interval', seconds: 300 },
    });
    await bridge.scheduleTask(FOLDER, {
      name: 'o',
      prompt: 'p',
      schedule: { kind: 'once', at: '2099-01-01T00:00:00' },
    });
    const files = (await listChannel('tasks')).filter((f) => f.endsWith('.json'));
    const payloads = await Promise.all(
      files.map(async (f) => (await readChannelJson('tasks', f)) as Record<string, unknown>),
    );
    const interval = payloads.find((p) => p.name === 'i')!;
    expect(interval.schedule_type).toBe('interval');
    expect(interval.schedule_value).toBe('300000');
    const once = payloads.find((p) => p.name === 'o')!;
    expect(once.schedule_type).toBe('once');
    expect(once.schedule_value).toBe('2099-01-01T00:00:00');
  });

  it('未绑定 chatJid → scheduleTask 抛错（targetJid 无来源）', async () => {
    const noJid = new IpcToolBridge({ ipcDir, memoryDir });
    await expect(noJid.scheduleTask(FOLDER, input)).rejects.toThrow(/no chatJid/);
    expect(await listChannel('tasks')).toEqual([]);
  });

  it('listTasks（standalone 降级：无主进程应答超时后）返回已排队的 create 请求摘要', async () => {
    const { taskId } = await bridge.scheduleTask(FOLDER, input);
    const tasks = await bridge.listTasks(FOLDER);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: taskId, name: 'nightly', status: 'queued' });
  });

  it('#10 schedule 后 cancel → listTasks 报 cancelled（绝不再 queued）', async () => {
    const { taskId } = await bridge.scheduleTask(FOLDER, input);
    await bridge.cancelTask(FOLDER, taskId);
    const tasks = await bridge.listTasks(FOLDER);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: taskId, name: 'nightly', status: 'cancelled' });
  });

  it('#10 schedule 后 pause → listTasks 报 paused', async () => {
    const { taskId } = await bridge.scheduleTask(FOLDER, input);
    await bridge.pauseTask(FOLDER, taskId);
    const tasks = await bridge.listTasks(FOLDER);
    expect(tasks[0]).toMatchObject({ id: taskId, status: 'paused' });
  });

  it('#10 最后动作（按 ts）胜出：pause→resume 序列报 queued（用显式 ts 注入定序，避免同毫秒抖动）', async () => {
    // 直接写带显式 ts 的动作文件（上游 flat 线格式），确定性地验证"最后动作胜出"聚合。
    const dir = path.join(ipcDir, FOLDER, 'tasks');
    await mkdir(dir, { recursive: true });
    const writeAction = async (type: string, ts: number, name?: string): Promise<void> => {
      await writeFile(
        path.join(dir, `${type}-${ts}.json`),
        JSON.stringify({ type, taskId: 'task_x', ts, ...(name ? { name } : {}) }),
        'utf8',
      );
    };
    await writeAction('schedule_task', 100, 'job');
    await writeAction('pause_task', 200);
    await writeAction('resume_task', 300); // 最新 ts → resume 胜出 → queued

    const tasks = await bridge.listTasks(FOLDER);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'task_x', name: 'job', status: 'queued' });
  });

  it('#10 同毫秒平局时 cancel 绝不被 create 盖回 queued', async () => {
    const dir = path.join(ipcDir, FOLDER, 'tasks');
    await mkdir(dir, { recursive: true });
    // create 与 cancel 同 ts（极端同毫秒写入）：动作终态优先级保证判 cancelled。
    await writeFile(
      path.join(dir, 'a-create.json'),
      JSON.stringify({ type: 'schedule_task', taskId: 'task_y', ts: 500, name: 'j' }),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'b-cancel.json'),
      JSON.stringify({ type: 'cancel_task', taskId: 'task_y', ts: 500 }),
      'utf8',
    );
    const tasks = await bridge.listTasks(FOLDER);
    expect(tasks[0]).toMatchObject({ id: 'task_y', status: 'cancelled' });
  });

  it('pause/resume/cancelTask 各写一条 {action}_task 请求（上游 flat 格式）', async () => {
    await bridge.pauseTask(FOLDER, 'task_abc');
    await bridge.resumeTask(FOLDER, 'task_abc');
    await bridge.cancelTask(FOLDER, 'task_abc');

    const files = (await listChannel('tasks')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(3);

    const types = new Set<string>();
    for (const f of files) {
      const p = (await readChannelJson('tasks', f)) as { type: string; taskId: string; groupFolder: string };
      expect(p.taskId).toBe('task_abc');
      expect(p.groupFolder).toBe(FOLDER);
      types.add(p.type);
    }
    expect(types).toEqual(new Set(['pause_task', 'resume_task', 'cancel_task']));
  });

  it('目录不存在时 listTasks 返回 []', async () => {
    const tasks = await bridge.listTasks('never-touched');
    expect(tasks).toEqual([]);
  });
});

describe('IpcToolBridge — register / skills', () => {
  it('#17/#23 registerGroup 诚实失败：抛错且不写 tasks/ 请求（冻结 schema 缺 folder，主进程必拒且无回执）', async () => {
    await expect(bridge.registerGroup(FOLDER, 'web:new-group', 'My Group')).rejects.toThrow(
      /register_group 在当前版本不可用/,
    );
    // 错误文案引导走 Web 注册（含 jid，便于管理员定位）。
    await expect(bridge.registerGroup(FOLDER, 'feishu:oc_xyz')).rejects.toThrow(
      /Web 界面注册群组（jid=feishu:oc_xyz）/,
    );
    // 不写出注定被主进程拒绝的请求文件（仅产生 server warn 噪音）。
    expect(await listChannel('tasks')).toEqual([]);
  });

  it('install/uninstallSkill 写 tasks/ 请求（package/skillId + requestId，主进程契约必填）；无主进程应答 → 超时抛错且请求文件保留', async () => {
    // A4：升级为请求-响应协议。本套件无主进程写回 *_result_{requestId}.json → 超时（上游同文案）。
    await expect(bridge.installSkill(FOLDER, 'anthropic/pdf')).rejects.toThrow(
      /Timeout waiting for skill installation result/,
    );
    await expect(bridge.uninstallSkill(FOLDER, 'pdf')).rejects.toThrow(
      /Timeout waiting for skill uninstall result/,
    );
    // 超时后请求文件不删（主进程可能只是慢，迟到执行仍有效——对齐上游）。
    const files = (await listChannel('tasks')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);
    const types = new Set<string>();
    for (const f of files) {
      const p = (await readChannelJson('tasks', f)) as {
        type: string;
        package?: string;
        skillId?: string;
        requestId?: string;
        groupFolder: string;
      };
      // requestId 必填且满足主进程 SAFE_REQUEST_ID_RE（[A-Za-z0-9_-]+）
      expect(p.requestId).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(p.groupFolder).toBe(FOLDER);
      if (p.type === 'install_skill') expect(p.package).toBe('anthropic/pdf');
      if (p.type === 'uninstall_skill') expect(p.skillId).toBe('pdf');
      types.add(p.type);
    }
    expect(types).toEqual(new Set(['install_skill', 'uninstall_skill']));
  });
});

describe('IpcToolBridge — memory append / search / get', () => {
  it('memoryAppend 后 memorySearch 命中、memoryGet 读回内容', async () => {
    await bridge.memoryAppend(FOLDER, 'the secret is 42', 'notes');

    const hits = await bridge.memorySearch(FOLDER, 'SECRET'); // 大小写不敏感
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.path).toBe('notes.md');
    expect(hits[0]!.snippet).toContain('secret is 42');

    const content = await bridge.memoryGet(FOLDER, 'notes.md');
    expect(content).not.toBeNull();
    expect(content!).toContain('the secret is 42');
  });

  it('memoryAppend 默认 scope=CLAUDE', async () => {
    await bridge.memoryAppend(FOLDER, 'default scope line');
    const content = await bridge.memoryGet(FOLDER, 'CLAUDE.md');
    expect(content).not.toBeNull();
    expect(content!).toContain('default scope line');
  });

  it('memoryAppend 多次追加都保留（不覆盖）', async () => {
    await bridge.memoryAppend(FOLDER, 'first');
    await bridge.memoryAppend(FOLDER, 'second');
    const content = await bridge.memoryGet(FOLDER, 'CLAUDE.md');
    expect(content!).toContain('first');
    expect(content!).toContain('second');
  });

  it('memoryGet 对 "../x" 路径穿越返回 null', async () => {
    // 先在 memoryDir 上层放一个目标文件，证明穿越确实被拒
    await writeFile(path.join(root, 'outside.md'), 'leaked', 'utf8');
    const viaTraversal = await bridge.memoryGet(FOLDER, '../../outside.md');
    expect(viaTraversal).toBeNull();
    const single = await bridge.memoryGet(FOLDER, '../x');
    expect(single).toBeNull();
  });

  it('memoryGet 对不存在的文件返回 null', async () => {
    const content = await bridge.memoryGet(FOLDER, 'nope.md');
    expect(content).toBeNull();
  });

  it('#9 memoryAppend 对穿越 scope 抛错（不静默丢弃，让上层报 success:false）', async () => {
    await expect(bridge.memoryAppend(FOLDER, 'x', '../evil')).rejects.toThrow(/unsafe scope/);
    await expect(bridge.memoryAppend(FOLDER, 'x', 'a/b')).rejects.toThrow(/unsafe scope/);
  });

  it('#11 memoryAppend 对含 NUL/控制字符的 scope 抛 unsafe scope（而非 fs TypeError）', async () => {
    const nul = 'a' + String.fromCharCode(0) + 'b';
    await expect(bridge.memoryAppend(FOLDER, 'x', nul)).rejects.toThrow(/unsafe scope/);
    const lf = 'a' + String.fromCharCode(10) + 'b';
    await expect(bridge.memoryAppend(FOLDER, 'x', lf)).rejects.toThrow(/unsafe scope/);
    // 合法 scope（点、下划线、连字符、日期）不受影响。
    await expect(bridge.memoryAppend(FOLDER, 'ok', 'my_scope-2026.01')).resolves.toBeUndefined();
  });

  it('目录不存在时 memorySearch 返回 []', async () => {
    const hits = await bridge.memorySearch('never-touched', 'anything');
    expect(hits).toEqual([]);
  });

  it('memorySearch 跳过非 .md 文件', async () => {
    const dir = path.join(memoryDir, FOLDER);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'data.txt'), 'match here', 'utf8');
    await writeFile(path.join(dir, 'real.md'), 'match here too', 'utf8');
    const hits = await bridge.memorySearch(FOLDER, 'match');
    expect(hits.every((h) => h.path.endsWith('.md'))).toBe(true);
    expect(hits.some((h) => h.path === 'real.md')).toBe(true);
  });
});

describe('IpcToolBridge — #7 folder 越界自洽校验（不依赖调用方先验）', () => {
  it('恶意 folder（.. / 绝对路径）逃出 memory 根 → 读类返回空/null', async () => {
    // 在 memoryDir 上层放一个目标文件，证明越界 folder 无法读出它。
    await writeFile(path.join(root, 'secret.md'), 'leaked memory', 'utf8');
    for (const evil of ['..', '../..', '../../', path.resolve(root)]) {
      expect(await bridge.memorySearch(evil, 'leaked')).toEqual([]);
      expect(await bridge.memoryGet(evil, 'secret.md')).toBeNull();
      expect(await bridge.listTasks(evil)).toEqual([]);
    }
  });

  it('恶意 folder 逃出 ipc 根 → 写类抛错（unsafe folder rejected）', async () => {
    await expect(bridge.sendMessage('..', 'x')).rejects.toThrow(/unsafe folder/);
    await expect(bridge.scheduleTask('../../etc', { name: 'n', prompt: 'p', schedule: { kind: 'interval', seconds: 1 } })).rejects.toThrow(/unsafe folder/);
    await expect(bridge.pauseTask('..', 'task_1')).rejects.toThrow(/unsafe folder/);
  });

  it('恶意 folder 逃出 memory 根 → memoryAppend 抛 unsafe scope', async () => {
    await expect(bridge.memoryAppend('..', 'leak', 'notes')).rejects.toThrow(/unsafe scope/);
  });
});

describe('IpcToolBridge — #8 符号链接穿越防护（物理 containment）', () => {
  it('folder 内指向 memory 根之外的 symlink → memoryGet 返回 null、memorySearch 不命中', async () => {
    // 在 memoryDir 上层放外部目标。
    await writeFile(path.join(root, 'outside-secret.md'), 'symlink-leaked-content', 'utf8');
    const dir = path.join(memoryDir, FOLDER);
    await mkdir(dir, { recursive: true });
    const linkPath = path.join(dir, 'link.md');
    try {
      await symlink(path.join(root, 'outside-secret.md'), linkPath);
    } catch {
      // 不支持 symlink 的平台（罕见）→ 跳过。
      return;
    }

    // 词法校验通过（link.md 在 base 内），但 realpath 解析后落在 base 外 → 拒。
    expect(await bridge.memoryGet(FOLDER, 'link.md')).toBeNull();

    // memorySearch 用 lstat 识别 symlink 并跳过，不读出其目标内容。
    const hits = await bridge.memorySearch(FOLDER, 'symlink-leaked-content');
    expect(hits.some((h) => h.path === 'link.md')).toBe(false);
    expect(hits).toEqual([]);
  });

  it('folder 内指向 base 内部的普通 symlink 也被 lstat 跳过（保守，不读链接）', async () => {
    const dir = path.join(memoryDir, FOLDER);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'target.md'), 'inside content', 'utf8');
    try {
      await symlink(path.join(dir, 'target.md'), path.join(dir, 'alias.md'));
    } catch {
      return;
    }
    const hits = await bridge.memorySearch(FOLDER, 'inside content');
    // 真实文件 target.md 命中；symlink alias.md 被跳过。
    expect(hits.some((h) => h.path === 'target.md')).toBe(true);
    expect(hits.some((h) => h.path === 'alias.md')).toBe(false);
  });
});

// ───────────────────────── A4：send_image / send_file ─────────────────────────

/** 一个合法的最小 PNG 头（magic 8 字节 + 补足 ≥12 字节，命中 detectImageMimeTypeStrict）。 */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

describe('IpcToolBridge — sendImage（A4）', () => {
  it('工作区内 PNG → messages 通道 type:image（命中主进程消费端字段）+ 返回元数据', async () => {
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, 'chart.png'), PNG_BYTES);

    const r = await bridge.sendImage(FOLDER, 'chart.png', '本周趋势');
    expect(r).toEqual({ fileName: 'chart.png', mimeType: 'image/png', sizeBytes: PNG_BYTES.length });

    const files = (await listChannel('messages')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const p = (await readChannelJson('messages', files[0]!)) as Record<string, unknown>;
    // 主进程消费契约（index.ts image 分支）：data.type === 'image' && data.chatJid && data.imageBase64
    expect(p.type).toBe('image');
    expect(p.chatJid).toBe(CHAT_JID);
    expect(p.groupFolder).toBe(FOLDER);
    expect(p.imageBase64).toBe(PNG_BYTES.toString('base64'));
    expect(p.mimeType).toBe('image/png');
    expect(p.caption).toBe('本周趋势');
    expect(p.fileName).toBe('chart.png');
    expect(typeof p.timestamp).toBe('string');
    // 非定时任务运行：不得 stamp isScheduledTask/taskId
    expect('isScheduledTask' in p).toBe(false);
    expect('taskId' in p).toBe(false);
  });

  it('无 caption → 落盘不带 caption 键（对齐上游 caption || undefined 语义）', async () => {
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, 'x.png'), PNG_BYTES);
    await bridge.sendImage(FOLDER, 'x.png');
    const files = (await listChannel('messages')).filter((f) => f.endsWith('.json'));
    const p = (await readChannelJson('messages', files[0]!)) as Record<string, unknown>;
    expect('caption' in p).toBe(false);
  });

  it('定时任务运行 → 条件 stamp isScheduledTask/taskId（任务广播分支路由依据）', async () => {
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, 'x.png'), PNG_BYTES);
    const taskBridge = new IpcToolBridge({
      ipcDir,
      memoryDir,
      workspaceGroupDir: workspaceDir,
      chatJid: CHAT_JID,
      isScheduledTask: true,
      currentTaskId: 'task-img-1',
    });
    await taskBridge.sendImage(FOLDER, 'x.png');
    const files = (await listChannel('messages')).filter((f) => f.endsWith('.json'));
    const p = (await readChannelJson('messages', files[0]!)) as Record<string, unknown>;
    expect(p.isScheduledTask).toBe(true);
    expect(p.taskId).toBe('task-img-1');
  });

  it('路径穿越（../）逃出工作区 → 抛错且不落盘', async () => {
    await writeFile(path.join(root, 'evil.png'), PNG_BYTES);
    await expect(bridge.sendImage(FOLDER, '../../evil.png')).rejects.toThrow(
      /within workspace directory/,
    );
    expect((await listChannel('messages')).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('文件不存在 / 空文件 / 非图片内容 → 各自抛对应错误', async () => {
    await mkdir(workspaceDir, { recursive: true });
    await expect(bridge.sendImage(FOLDER, 'missing.png')).rejects.toThrow(/file not found/);

    await writeFile(path.join(workspaceDir, 'empty.png'), Buffer.alloc(0));
    await expect(bridge.sendImage(FOLDER, 'empty.png')).rejects.toThrow(/image file is empty/);

    await writeFile(path.join(workspaceDir, 'fake.png'), Buffer.from('definitely not an image'));
    await expect(bridge.sendImage(FOLDER, 'fake.png')).rejects.toThrow(/supported image format/);
  });

  it('未绑定 chatJid / 未绑定工作区目录 → 抛错（诚实失败）', async () => {
    const noJid = new IpcToolBridge({ ipcDir, memoryDir, workspaceGroupDir: workspaceDir });
    await expect(noJid.sendImage(FOLDER, 'x.png')).rejects.toThrow(/no chatJid/);
    const noWs = new IpcToolBridge({ ipcDir, memoryDir, chatJid: CHAT_JID });
    await expect(noWs.sendImage(FOLDER, 'x.png')).rejects.toThrow(/no workspace directory/);
  });
});

describe('IpcToolBridge — sendFile（A4）', () => {
  it('相对路径 → tasks 通道 {type:send_file, chatJid, filePath, fileName, timestamp}（命中消费端 case）', async () => {
    await mkdir(path.join(workspaceDir, 'output'), { recursive: true });
    await writeFile(path.join(workspaceDir, 'output', 'report.pdf'), 'pdf-bytes');

    await bridge.sendFile(FOLDER, 'output/report.pdf', 'report.pdf');

    const files = (await listChannel('tasks')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const p = (await readChannelJson('tasks', files[0]!)) as Record<string, unknown>;
    // 主进程消费契约（processTaskIpc case 'send_file'）：data.chatJid && data.filePath && data.fileName；
    // filePath 为相对工作区路径（消费端按 GROUPS_DIR/{sourceGroup}/filePath 还原）。
    expect(p.type).toBe('send_file');
    expect(p.chatJid).toBe(CHAT_JID);
    expect(p.filePath).toBe('output/report.pdf');
    expect(p.fileName).toBe('report.pdf');
    expect(typeof p.timestamp).toBe('string');
  });

  it('工作区内绝对路径 → 转相对路径落盘（消费端锚点一致）', async () => {
    await mkdir(workspaceDir, { recursive: true });
    const abs = path.join(workspaceDir, 'data.zip');
    await writeFile(abs, 'zip-bytes');
    await bridge.sendFile(FOLDER, abs, 'data.zip');
    const files = (await listChannel('tasks')).filter((f) => f.endsWith('.json'));
    const p = (await readChannelJson('tasks', files[0]!)) as Record<string, unknown>;
    expect(p.filePath).toBe('data.zip');
  });

  it('工作区外绝对路径 / 穿越 / 不存在 → 抛错且不落盘', async () => {
    await writeFile(path.join(root, 'outside.bin'), 'x');
    await expect(
      bridge.sendFile(FOLDER, path.join(root, 'outside.bin'), 'outside.bin'),
    ).rejects.toThrow(/within the workspace/);
    await expect(bridge.sendFile(FOLDER, '../../outside.bin', 'outside.bin')).rejects.toThrow(
      /within the workspace/,
    );
    await expect(bridge.sendFile(FOLDER, 'nope.pdf', 'nope.pdf')).rejects.toThrow(/file not found/);
    expect((await listChannel('tasks')).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('#18 相对路径词法归一化：sub/../report.pdf → 落盘 filePath 为 report.pdf', async () => {
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, 'report.pdf'), 'pdf-bytes');
    await bridge.sendFile(FOLDER, 'sub/../report.pdf', 'report.pdf');
    const files = (await listChannel('tasks')).filter((f) => f.endsWith('.json'));
    const p = (await readChannelJson('tasks', files[0]!)) as Record<string, unknown>;
    expect(p.filePath).toBe('report.pdf');
  });
});

// ───────────────────────── CR#2：send_image / send_file symlink 外泄防护 ─────────────────────────

describe('IpcToolBridge — #2 symlink 外泄防护（生产侧 realpath 物理校验）', () => {
  it('工作区内 symlink 指向工作区外文件 → sendImage/sendFile 均抛越界且不落盘', async () => {
    await mkdir(workspaceDir, { recursive: true });
    const outside = path.join(root, 'secret.png');
    await writeFile(outside, PNG_BYTES);
    await symlink(outside, path.join(workspaceDir, 'leak.png'));

    // 词法上 leak.png 在工作区内（旧实现据此放行并读出目标内容）——物理校验必须拦截。
    await expect(bridge.sendImage(FOLDER, 'leak.png')).rejects.toThrow(
      /within workspace directory/,
    );
    await expect(bridge.sendFile(FOLDER, 'leak.png', 'leak.png')).rejects.toThrow(
      /within the workspace/,
    );
    expect((await listChannel('messages')).filter((f) => f.endsWith('.json'))).toEqual([]);
    expect((await listChannel('tasks')).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('symlink 中间目录逃出工作区 → 同样被物理校验拦截', async () => {
    await mkdir(workspaceDir, { recursive: true });
    const outsideDir = path.join(root, 'outside-dir');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, 'f.png'), PNG_BYTES);
    await symlink(outsideDir, path.join(workspaceDir, 'sub'));

    await expect(bridge.sendImage(FOLDER, 'sub/f.png')).rejects.toThrow(
      /within workspace directory/,
    );
    await expect(bridge.sendFile(FOLDER, 'sub/f.png', 'f.png')).rejects.toThrow(
      /within the workspace/,
    );
  });

  it('悬空 symlink → file not found（不误报越界）', async () => {
    await mkdir(workspaceDir, { recursive: true });
    await symlink(path.join(workspaceDir, 'nope.png'), path.join(workspaceDir, 'dangling.png'));
    await expect(bridge.sendImage(FOLDER, 'dangling.png')).rejects.toThrow(/file not found/);
    await expect(bridge.sendFile(FOLDER, 'dangling.png', 'd.png')).rejects.toThrow(
      /file not found/,
    );
  });

  it('指向工作区内部的合法 symlink 不误拒（物理校验只拦外泄；锚点字段用词法路径）', async () => {
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, 'real.png'), PNG_BYTES);
    await symlink(path.join(workspaceDir, 'real.png'), path.join(workspaceDir, 'alias.png'));

    const r = await bridge.sendImage(FOLDER, 'alias.png');
    expect(r.fileName).toBe('alias.png'); // fileName 保留调用方指定的词法名

    await bridge.sendFile(FOLDER, 'alias.png', 'alias.png');
    const files = (await listChannel('tasks')).filter((f) => f.endsWith('.json'));
    const p = (await readChannelJson('tasks', files[0]!)) as Record<string, unknown>;
    expect(p.filePath).toBe('alias.png'); // relativePath 同样锚定词法路径（消费端语义不变）
  });
});

// ───────────────────────── A4：pollIpcResult 请求-响应协议 ─────────────────────────

/**
 * 假主进程应答器：轮询 tasks 通道直到出现指定 type 的请求文件，按上游写回端语义
 * 原子写 {prefix}_{requestId}.json 结果，并返回读到的请求 payload（供字段断言）。
 */
async function respondToRequest(
  type: string,
  prefix: string,
  result: unknown,
): Promise<Record<string, unknown>> {
  const dir = path.join(ipcDir, FOLDER, 'tasks');
  for (let i = 0; i < 400; i++) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      /* 尚未创建 */
    }
    for (const f of entries.filter((n) => n.endsWith('.json') && !n.includes('_result_'))) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (data.type === type) {
        // 主进程语义：处理完请求后删请求文件 + 原子写回结果文件。
        await rm(path.join(dir, f), { force: true });
        const target = path.join(dir, `${prefix}_${String(data.requestId)}.json`);
        await writeFile(`${target}.tmp`, JSON.stringify(result), 'utf8');
        await rename(`${target}.tmp`, target);
        return data;
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`request of type ${type} never appeared`);
}

describe('IpcToolBridge — pollIpcResult 请求-响应协议（A4）', () => {
  it('listTasks：写 {type:list_tasks, requestId, groupFolder, isAdminHome} 请求 → 读回执并映射 TaskSummary；result 文件读后删除', async () => {
    const adminBridge = new IpcToolBridge({
      ipcDir,
      memoryDir,
      chatJid: CHAT_JID,
      isAdminHome: true,
      pollIntervalMs: 5,
      pollTimeoutMs: 2000,
    });
    const [tasks, req] = await Promise.all([
      adminBridge.listTasks(FOLDER),
      respondToRequest('list_tasks', 'list_tasks_result', {
        success: true,
        tasks: [
          {
            id: 't-1',
            groupFolder: FOLDER,
            prompt: '每日汇报',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
            status: 'active',
            next_run: '2026-06-11T09:00:00.000Z',
          },
          { id: 't-2', groupFolder: FOLDER, prompt: '', schedule_type: 'once', schedule_value: 'x', status: 'paused', next_run: null },
        ],
      }),
    ]);
    // 请求字段对齐上游 list_tasks 工具线格式。
    expect(req.requestId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(req.groupFolder).toBe(FOLDER);
    expect(req.isAdminHome).toBe(true);
    expect(typeof req.timestamp).toBe('string');
    // 回执映射：name ← prompt（缺省回退 id）。
    expect(tasks).toEqual([
      { id: 't-1', name: '每日汇报', status: 'active' },
      { id: 't-2', name: 't-2', status: 'paused' },
    ]);
    // result 文件读后删除（不残留）。
    const leftovers = (await listChannel('tasks')).filter((f) => f.includes('_result_'));
    expect(leftovers).toEqual([]);
  });

  it('listTasks：主进程回 success:false → 抛错（不降级，诚实失败）', async () => {
    const [res] = await Promise.allSettled([
      bridge.listTasks(FOLDER),
      respondToRequest('list_tasks', 'list_tasks_result', { success: false, error: 'db locked' }),
    ]);
    expect(res.status).toBe('rejected');
    expect(String((res as PromiseRejectedResult).reason)).toMatch(/Error listing tasks: db locked/);
  });

  it('installSkill：回执 success + installed 列表透传；请求字段对齐（package/requestId/groupFolder）', async () => {
    const [r, req] = await Promise.all([
      bridge.installSkill(FOLDER, 'anthropic/memory'),
      respondToRequest('install_skill', 'install_skill_result', {
        success: true,
        installed: ['memory', 'think'],
      }),
    ]);
    expect(r.installed).toEqual(['memory', 'think']);
    expect(req.package).toBe('anthropic/memory');
    expect(req.groupFolder).toBe(FOLDER);
    expect(req.requestId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('installSkill：回执 success:false → 抛 Failed to install skill', async () => {
    const [res] = await Promise.allSettled([
      bridge.installSkill(FOLDER, 'anthropic/broken'),
      respondToRequest('install_skill', 'install_skill_result', {
        success: false,
        error: 'registry unreachable',
      }),
    ]);
    expect(res.status).toBe('rejected');
    expect(String((res as PromiseRejectedResult).reason)).toMatch(
      /Failed to install skill "anthropic\/broken": registry unreachable/,
    );
  });

  it('uninstallSkill：回执 success → 正常返回；请求字段对齐（skillId）', async () => {
    const [, req] = await Promise.all([
      bridge.uninstallSkill(FOLDER, 'memory'),
      respondToRequest('uninstall_skill', 'uninstall_skill_result', { success: true }),
    ]);
    expect(req.skillId).toBe('memory');
    expect(req.groupFolder).toBe(FOLDER);
  });
});

// ─────────────── 端到端：registry.dispatch × builtin handler × IpcToolBridge ───────────────

describe('端到端（真 ToolRegistry + builtin handler + IpcToolBridge + 假主进程回执）', () => {
  /** 真 registry：17 个内置工具全量注册（与 codex-runner / session-manager 同构）。 */
  function e2e(): { registry: ToolRegistry; ctx: ToolContext } {
    const registry = new ToolRegistry();
    for (const def of createBuiltinTools()) registry.register(def);
    const e2eBridge = new IpcToolBridge({
      ipcDir,
      memoryDir,
      chatJid: CHAT_JID,
      pollIntervalMs: 5,
      pollTimeoutMs: 2000,
    });
    return { registry, ctx: { groupFolder: FOLDER, threadId: 'th_e2e', bridge: e2eBridge } };
  }

  function text(r: DynamicToolCallResponse): string {
    return (r.contentItems[0] as { text: string }).text;
  }

  it('#20 install_skill：主进程回执 success + installed → 工具结果 success:true 且透传安装列表', async () => {
    const { registry, ctx } = e2e();
    const [r] = await Promise.all([
      registry.dispatch('install_skill', { name: 'anthropic/memory' }, ctx),
      respondToRequest('install_skill', 'install_skill_result', {
        success: true,
        installed: ['memory', 'think'],
      }),
    ]);
    expect(r.success).toBe(true);
    expect(text(r)).toMatch(/Skill "anthropic\/memory" 已安装：memory, think/);
  });

  it('#20 install_skill：主进程回执 success:false → 工具结果 success:false 携真实 error（失败路径不再静默）', async () => {
    const { registry, ctx } = e2e();
    const [r] = await Promise.all([
      registry.dispatch('install_skill', { name: 'anthropic/broken' }, ctx),
      respondToRequest('install_skill', 'install_skill_result', {
        success: false,
        error: 'registry unreachable',
      }),
    ]);
    expect(r.success).toBe(false);
    expect(text(r)).toMatch(/Failed to install skill "anthropic\/broken": registry unreachable/);
  });

  it('#17/#23 register_group：dispatch → success:false 携诚实文案，且不落任何 IPC 文件', async () => {
    const { registry, ctx } = e2e();
    const r = await registry.dispatch('register_group', { jid: 'feishu:oc_e2e' }, ctx);
    expect(r.success).toBe(false);
    expect(text(r)).toMatch(/register_group 在当前版本不可用/);
    expect(text(r)).toMatch(/Web 界面注册群组/);
    expect(await listChannel('tasks')).toEqual([]);
    expect(await listChannel('messages')).toEqual([]);
  });
});

describe('IpcToolBridge — discord_*（A4）', () => {
  const DISCORD_JID = 'discord:123456789012345678';

  function discordBridge(): IpcToolBridge {
    return new IpcToolBridge({
      ipcDir,
      memoryDir,
      chatJid: DISCORD_JID,
      pollIntervalMs: 5,
      pollTimeoutMs: 2000,
    });
  }

  it('非 discord 聊天 → 三个工具都抛 only works in Discord channels（不写请求）', async () => {
    await expect(bridge.discordGetHistory(FOLDER)).rejects.toThrow(
      /discord_get_history only works in Discord channels\. Current chat: web:home-test/,
    );
    await expect(bridge.discordGetChannelInfo(FOLDER)).rejects.toThrow(
      /discord_get_channel_info only works in Discord channels/,
    );
    await expect(bridge.discordGetServerInfo(FOLDER)).rejects.toThrow(
      /discord_get_server_info only works in Discord channels/,
    );
    expect((await listChannel('tasks')).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('discordGetHistory：请求字段对齐（chatJid/limit/before/requestId）+ 回执 messages 透传', async () => {
    const msg = {
      id: '111111111111111111',
      authorName: 'alice',
      authorBot: false,
      content: 'hi there',
      timestamp: '2026-06-10T00:00:00.000Z',
      attachments: [],
      edited: false,
    };
    const [messages, req] = await Promise.all([
      discordBridge().discordGetHistory(FOLDER, { limit: 25, before: '222222222222222222' }),
      respondToRequest('discord_get_history', 'discord_get_history_result', {
        success: true,
        messages: [msg],
      }),
    ]);
    expect(messages).toEqual([msg]);
    expect(req.chatJid).toBe(DISCORD_JID);
    expect(req.limit).toBe(25);
    expect(req.before).toBe('222222222222222222');
    expect(req.requestId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('discordGetHistory：回执 success:false → 抛 Error fetching Discord history', async () => {
    const [res] = await Promise.allSettled([
      discordBridge().discordGetHistory(FOLDER),
      respondToRequest('discord_get_history', 'discord_get_history_result', {
        success: false,
        error: 'channel not cached',
      }),
    ]);
    expect(res.status).toBe('rejected');
    expect(String((res as PromiseRejectedResult).reason)).toMatch(
      /Error fetching Discord history: channel not cached/,
    );
  });

  it('discordGetChannelInfo / discordGetServerInfo：回执 channel/guild 透传；guild 缺省 → null（DM）', async () => {
    const [channel] = await Promise.all([
      discordBridge().discordGetChannelInfo(FOLDER),
      respondToRequest('discord_get_channel_info', 'discord_get_channel_info_result', {
        success: true,
        channel: { name: 'general', type: 'guild_text' },
      }),
    ]);
    expect(channel).toEqual({ name: 'general', type: 'guild_text' });

    const [guild] = await Promise.all([
      discordBridge().discordGetServerInfo(FOLDER),
      respondToRequest('discord_get_server_info', 'discord_get_server_info_result', {
        success: true,
        guild: null,
      }),
    ]);
    expect(guild).toBeNull();
  });

  it('setChatJid 就地切换当前聊天（对齐上游 sourceJid 变更语义）：web → discord 后工具可用', async () => {
    const b = new IpcToolBridge({
      ipcDir,
      memoryDir,
      chatJid: CHAT_JID, // 初始 web
      pollIntervalMs: 5,
      pollTimeoutMs: 2000,
    });
    await expect(b.discordGetChannelInfo(FOLDER)).rejects.toThrow(/only works in Discord channels/);
    b.setChatJid(DISCORD_JID);
    const [channel, req] = await Promise.all([
      b.discordGetChannelInfo(FOLDER),
      respondToRequest('discord_get_channel_info', 'discord_get_channel_info_result', {
        success: true,
        channel: { name: 'switched' },
      }),
    ]);
    expect(channel).toEqual({ name: 'switched' });
    expect(req.chatJid).toBe(DISCORD_JID);
  });
});
