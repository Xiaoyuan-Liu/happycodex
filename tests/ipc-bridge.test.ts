/**
 * IpcToolBridge 单测 —— 用临时目录验证 IPC 文件落盘 + 记忆读写 + 路径穿越防护。
 *
 * 每个用例用 os.tmpdir() 下唯一子目录，afterEach 清理，互不干扰。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { IpcToolBridge } from '../src/runtime/tools/ipc-bridge.js';
import type { ScheduleTaskInput } from '../src/runtime/tools/types.js';

const FOLDER = 'home-test';
const CHAT_JID = 'web:home-test';

let root: string;
let ipcDir: string;
let memoryDir: string;
let bridge: IpcToolBridge;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'happycodex-ipc-'));
  ipcDir = path.join(root, 'ipc');
  memoryDir = path.join(root, 'groups');
  bridge = new IpcToolBridge({ ipcDir, memoryDir, chatJid: CHAT_JID });
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

  it('listTasks 返回已排队的 create 请求摘要', async () => {
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
  it('registerGroup 写 tasks/ 请求（上游通道；processTaskIpc case register_group）', async () => {
    await bridge.registerGroup(FOLDER, 'web:new-group', 'My Group');
    const files = (await listChannel('tasks')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const p = (await readChannelJson('tasks', files[0]!)) as {
      type: string;
      jid: string;
      name: string;
    };
    expect(p.type).toBe('register_group');
    expect(p.jid).toBe('web:new-group');
    expect(p.name).toBe('My Group');
  });

  it('install/uninstallSkill 写 tasks/ 请求（package/skillId + requestId，主进程契约必填）', async () => {
    await bridge.installSkill(FOLDER, 'anthropic/pdf');
    await bridge.uninstallSkill(FOLDER, 'pdf');
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
