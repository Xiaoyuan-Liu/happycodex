/**
 * createBuiltinTools 单测 —— 用 FakeToolBridge 验证每个工具的 spec 与 handler 行为。
 *
 * 覆盖：
 *  - 返回 17 个工具（A4：12 + send_image/send_file/discord_get_*）且 name 集合正确、唯一；
 *  - 每个工具 spec.inputSchema 是合法的 object schema（additionalProperties:false）；
 *  - 逐个 handler：合法 args → 调对应 bridge 方法（断言 bridge.calls）+ success:true；
 *  - 缺必填字段 → success:false 且文案含 "missing required field"；
 *  - memory_search / list_tasks 把数据带进文本；memory_get 命中文本 / (not found)；
 *  - A4 新工具：send_image 元数据文案、send_file 文案、discord 历史格式化 / DM null 分支。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createBuiltinTools } from '../src/runtime/tools/builtin.js';
import type { ToolContext, ToolDefinition } from '../src/runtime/tools/types.js';
import { FakeToolBridge } from './helpers/fake-tool-bridge.js';

const FOLDER = 'home-42';

function ctxWith(bridge: FakeToolBridge): ToolContext {
  return { groupFolder: FOLDER, threadId: 'th_1', bridge };
}

function toolMap(): Map<string, ToolDefinition> {
  const m = new Map<string, ToolDefinition>();
  for (const t of createBuiltinTools()) m.set(t.spec.name, t);
  return m;
}

const EXPECTED_NAMES = [
  'send_message',
  'send_image',
  'send_file',
  'schedule_task',
  'list_tasks',
  'pause_task',
  'resume_task',
  'cancel_task',
  'register_group',
  'discord_get_history',
  'discord_get_channel_info',
  'discord_get_server_info',
  'install_skill',
  'uninstall_skill',
  'memory_append',
  'memory_search',
  'memory_get',
];

function text(r: { contentItems: Array<{ type: string }> }): string {
  return r.contentItems
    .filter((c): c is { type: 'inputText'; text: string } => c.type === 'inputText')
    .map((c) => c.text)
    .join('');
}

describe('createBuiltinTools — registry shape', () => {
  it('返回恰好 17 个工具（A4 补齐上游完整面）', () => {
    expect(createBuiltinTools()).toHaveLength(17);
  });

  it('name 集合与 HappyClaw 17 工具一致且唯一', () => {
    const names = createBuiltinTools().map((t) => t.spec.name);
    expect(new Set(names).size).toBe(17);
    expect(names.sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it('每个工具描述非空、inputSchema 是 object 且 additionalProperties:false', () => {
    for (const t of createBuiltinTools()) {
      expect(t.spec.description.length).toBeGreaterThan(0);
      const schema = t.spec.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      expect(schema).toHaveProperty('properties');
      expect(schema).toHaveProperty('required');
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it('每次调用返回全新数组（无共享可变状态）', () => {
    const a = createBuiltinTools();
    const b = createBuiltinTools();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });
});

describe('createBuiltinTools — handler 合法路径', () => {
  let bridge: FakeToolBridge;
  let tools: Map<string, ToolDefinition>;

  beforeEach(() => {
    bridge = new FakeToolBridge();
    tools = toolMap();
  });

  it('send_message → bridge.sendMessage(folder, message)', async () => {
    const r = await tools.get('send_message')!.handler({ message: '你好' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'sendMessage', args: [FOLDER, '你好'] });
    expect(text(r)).toContain('消息已发送');
  });

  it('schedule_task (cron) → bridge.scheduleTask + 返回 taskId', async () => {
    bridge.nextTaskId = 'task_cron_99';
    const r = await tools.get('schedule_task')!.handler(
      { name: 'daily', prompt: '汇报进展', schedule: { kind: 'cron', expr: '0 9 * * *' } },
      ctxWith(bridge),
    );
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({
      op: 'scheduleTask',
      args: [FOLDER, { name: 'daily', prompt: '汇报进展', schedule: { kind: 'cron', expr: '0 9 * * *' } }],
    });
    expect(text(r)).toContain('task_cron_99');
  });

  it('schedule_task (interval) → 解析 seconds', async () => {
    const r = await tools.get('schedule_task')!.handler(
      { name: 'poll', prompt: '轮询', schedule: { kind: 'interval', seconds: 300 } },
      ctxWith(bridge),
    );
    expect(r.success).toBe(true);
    const call = bridge.lastCall()!;
    expect(call.op).toBe('scheduleTask');
    expect((call.args[1] as { schedule: unknown }).schedule).toEqual({ kind: 'interval', seconds: 300 });
  });

  it('schedule_task (once) → 解析 at', async () => {
    const r = await tools.get('schedule_task')!.handler(
      { name: 'oneshot', prompt: '提醒', schedule: { kind: 'once', at: '2026-02-01T15:30:00' } },
      ctxWith(bridge),
    );
    expect(r.success).toBe(true);
    const call = bridge.lastCall()!;
    expect((call.args[1] as { schedule: unknown }).schedule).toEqual({
      kind: 'once',
      at: '2026-02-01T15:30:00',
    });
  });

  it('list_tasks → bridge.listTasks，数据进 text', async () => {
    bridge.tasks = [
      { id: 't1', name: 'A', status: 'active' },
      { id: 't2', name: 'B', status: 'paused' },
    ];
    const r = await tools.get('list_tasks')!.handler({}, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'listTasks', args: [FOLDER] });
    const t = text(r);
    expect(t).toContain('共 2 个任务');
    expect(t).toContain('t1');
    expect(t).toContain('paused');
  });

  it('pause_task → bridge.pauseTask(folder, taskId)', async () => {
    const r = await tools.get('pause_task')!.handler({ task_id: 't9' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'pauseTask', args: [FOLDER, 't9'] });
  });

  it('resume_task → bridge.resumeTask(folder, taskId)', async () => {
    const r = await tools.get('resume_task')!.handler({ task_id: 't9' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'resumeTask', args: [FOLDER, 't9'] });
  });

  it('cancel_task → bridge.cancelTask(folder, taskId)', async () => {
    const r = await tools.get('cancel_task')!.handler({ task_id: 't9' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'cancelTask', args: [FOLDER, 't9'] });
  });

  it('register_group → bridge.registerGroup(folder, jid, name)', async () => {
    const r = await tools.get('register_group')!.handler(
      { jid: 'feishu:oc_abc', name: '家庭群' },
      ctxWith(bridge),
    );
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'registerGroup', args: [FOLDER, 'feishu:oc_abc', '家庭群'] });
  });

  it('register_group 无 name → name 传 undefined', async () => {
    const r = await tools.get('register_group')!.handler({ jid: 'feishu:oc_abc' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'registerGroup', args: [FOLDER, 'feishu:oc_abc', undefined] });
  });

  it('install_skill → bridge.installSkill(folder, name)', async () => {
    const r = await tools.get('install_skill')!.handler({ name: 'anthropic/memory' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'installSkill', args: [FOLDER, 'anthropic/memory'] });
  });

  it('uninstall_skill → bridge.uninstallSkill(folder, name)', async () => {
    const r = await tools.get('uninstall_skill')!.handler({ name: 'memory' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'uninstallSkill', args: [FOLDER, 'memory'] });
  });

  it('memory_append → bridge.memoryAppend(folder, content, scope)', async () => {
    const r = await tools.get('memory_append')!.handler(
      { content: '今天部署完成', scope: 'global' },
      ctxWith(bridge),
    );
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'memoryAppend', args: [FOLDER, '今天部署完成', 'global'] });
  });

  it('memory_append 无 scope → scope 传 undefined', async () => {
    const r = await tools.get('memory_append')!.handler({ content: 'x' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'memoryAppend', args: [FOLDER, 'x', undefined] });
  });

  it('memory_search → bridge.memorySearch，命中进 text', async () => {
    bridge.memoryHits = [
      { path: 'CLAUDE.md', snippet: '偏好深色主题' },
      { path: 'memory/2026-01-15.md', snippet: '项目 X 上线' },
    ];
    const r = await tools.get('memory_search')!.handler({ query: '偏好' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'memorySearch', args: [FOLDER, '偏好'] });
    const t = text(r);
    expect(t).toContain('命中 2 条');
    expect(t).toContain('CLAUDE.md');
    expect(t).toContain('项目 X 上线');
  });

  it('memory_get 命中 → 返回文本值', async () => {
    bridge.memoryValue = '记住的内容';
    const r = await tools.get('memory_get')!.handler({ path: 'CLAUDE.md' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'memoryGet', args: [FOLDER, 'CLAUDE.md'] });
    expect(text(r)).toBe('记住的内容');
  });

  it('memory_get 未命中 → "(not found)"', async () => {
    bridge.memoryValue = null;
    const r = await tools.get('memory_get')!.handler({ path: 'missing.md' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(text(r)).toBe('(not found)');
  });

  // ── A4 新工具 ──

  it('send_image → bridge.sendImage(folder, file_path, caption)，文案含元数据', async () => {
    bridge.sendImageResult = { fileName: 'plot.png', mimeType: 'image/png', sizeBytes: 3072 };
    const r = await tools.get('send_image')!.handler(
      { file_path: 'out/plot.png', caption: '趋势图' },
      ctxWith(bridge),
    );
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'sendImage', args: [FOLDER, 'out/plot.png', '趋势图'] });
    expect(text(r)).toBe('Image sent: plot.png (image/png, 3.0KB)');
  });

  it('send_image 无 caption → caption 传 undefined', async () => {
    const r = await tools.get('send_image')!.handler({ file_path: 'a.png' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'sendImage', args: [FOLDER, 'a.png', undefined] });
  });

  it('send_file → bridge.sendFile(folder, filePath, fileName)，文案对齐上游', async () => {
    const r = await tools.get('send_file')!.handler(
      { filePath: 'output/report.pdf', fileName: 'report.pdf' },
      ctxWith(bridge),
    );
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({
      op: 'sendFile',
      args: [FOLDER, 'output/report.pdf', 'report.pdf'],
    });
    expect(text(r)).toBe('Sending file "report.pdf"...');
  });

  it('discord_get_history → 格式化消息列表（authorName/id/bot/edited/reply/附件）', async () => {
    bridge.discordMessages = [
      {
        id: '111111111111111111',
        authorName: 'alice',
        authorBot: false,
        content: 'hello',
        timestamp: '2026-06-10T00:00:00.000Z',
        attachments: [],
        edited: false,
      },
      {
        id: '222222222222222222',
        authorName: 'bot-helper',
        authorBot: true,
        content: '',
        timestamp: '2026-06-10T00:01:00.000Z',
        attachments: [{ name: 'spec.pdf', url: 'https://cdn/x' }],
        replyToId: '111111111111111111',
        edited: true,
      },
    ];
    const r = await tools.get('discord_get_history')!.handler({ limit: 50 }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'discordGetHistory', args: [FOLDER, { limit: 50 }] });
    const t = text(r);
    expect(t).toContain('Discord history (2 messages, oldest first)');
    expect(t).toContain('alice');
    expect(t).toContain('(id=111111111111111111)');
    expect(t).toContain('[bot]');
    expect(t).toContain('(edited)');
    expect(t).toContain('↪111111111111111111');
    expect(t).toContain('(empty)');
    expect(t).toContain('📎 spec.pdf');
  });

  it('discord_get_history 空结果 → No messages found', async () => {
    bridge.discordMessages = [];
    const r = await tools.get('discord_get_history')!.handler({}, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(text(r)).toBe('No messages found in this channel.');
  });

  it('discord_get_channel_info → JSON 透传进文案', async () => {
    bridge.discordChannel = { name: 'general', type: 'guild_text', nsfw: false };
    const r = await tools.get('discord_get_channel_info')!.handler({}, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(bridge.lastCall()).toEqual({ op: 'discordGetChannelInfo', args: [FOLDER] });
    expect(text(r)).toContain('Discord channel info:');
    expect(text(r)).toContain('"name": "general"');
  });

  it('discord_get_server_info → guild JSON；guild=null（DM）→ DM 文案', async () => {
    bridge.discordGuild = { name: 'My Server', memberCount: 42 };
    const r1 = await tools.get('discord_get_server_info')!.handler({}, ctxWith(bridge));
    expect(r1.success).toBe(true);
    expect(text(r1)).toContain('"memberCount": 42');

    bridge.discordGuild = null;
    const r2 = await tools.get('discord_get_server_info')!.handler({}, ctxWith(bridge));
    expect(r2.success).toBe(true);
    expect(text(r2)).toContain('This is a DM channel');
  });

  it('install_skill 回执 installed 列表进文案', async () => {
    bridge.installedSkills = ['memory', 'think'];
    const r = await tools.get('install_skill')!.handler({ name: 'anthropic/memory' }, ctxWith(bridge));
    expect(r.success).toBe(true);
    expect(text(r)).toContain('memory, think');
  });
});

describe('createBuiltinTools — 缺必填字段 → success:false', () => {
  let bridge: FakeToolBridge;
  let tools: Map<string, ToolDefinition>;

  beforeEach(() => {
    bridge = new FakeToolBridge();
    tools = toolMap();
  });

  async function expectMissing(name: string, args: unknown): Promise<void> {
    const r = await tools.get(name)!.handler(args, ctxWith(bridge));
    expect(r.success, `${name} with ${JSON.stringify(args)} should fail`).toBe(false);
    expect(text(r)).toContain('missing required field');
    // 失败路径不应触达 bridge（schedule 字段错误等校验前置）
    expect(bridge.calls).toHaveLength(0);
  }

  it('send_message 缺 message', () => expectMissing('send_message', {}));
  it('send_message message 为空串', () => expectMissing('send_message', { message: '   ' }));
  it('schedule_task 缺 name', () =>
    expectMissing('schedule_task', { prompt: 'p', schedule: { kind: 'cron', expr: '* * * * *' } }));
  it('schedule_task 缺 prompt', () =>
    expectMissing('schedule_task', { name: 'n', schedule: { kind: 'cron', expr: '* * * * *' } }));
  it('schedule_task 缺 schedule', () => expectMissing('schedule_task', { name: 'n', prompt: 'p' }));
  it('schedule_task cron 缺 expr', () =>
    expectMissing('schedule_task', { name: 'n', prompt: 'p', schedule: { kind: 'cron' } }));
  it('schedule_task once 缺 at', () =>
    expectMissing('schedule_task', { name: 'n', prompt: 'p', schedule: { kind: 'once' } }));
  it('send_image 缺 file_path', () => expectMissing('send_image', { caption: 'x' }));
  it('send_file 缺 filePath', () => expectMissing('send_file', { fileName: 'a.pdf' }));
  it('send_file 缺 fileName', () => expectMissing('send_file', { filePath: 'a.pdf' }));
  it('pause_task 缺 task_id', () => expectMissing('pause_task', {}));
  it('resume_task 缺 task_id', () => expectMissing('resume_task', {}));
  it('cancel_task 缺 task_id', () => expectMissing('cancel_task', {}));
  it('register_group 缺 jid', () => expectMissing('register_group', { name: 'x' }));
  it('install_skill 缺 name', () => expectMissing('install_skill', {}));
  it('uninstall_skill 缺 name', () => expectMissing('uninstall_skill', {}));
  it('memory_append 缺 content', () => expectMissing('memory_append', { scope: 'global' }));
  it('memory_search 缺 query', () => expectMissing('memory_search', {}));
  it('memory_get 缺 path', () => expectMissing('memory_get', {}));
  it('args 非对象（null）也安全失败', () => expectMissing('send_message', null));
  it('args 非对象（字符串）也安全失败', () => expectMissing('memory_get', 'oops'));
});

describe('createBuiltinTools — A4 非法字段值（不触达 bridge）', () => {
  let bridge: FakeToolBridge;
  let tools: Map<string, ToolDefinition>;

  beforeEach(() => {
    bridge = new FakeToolBridge();
    tools = toolMap();
  });

  it('discord_get_history limit 越界 / 非整数 → success:false', async () => {
    for (const limit of [0, 101, 1.5, 'ten']) {
      const r = await tools.get('discord_get_history')!.handler({ limit }, ctxWith(bridge));
      expect(r.success, `limit=${String(limit)}`).toBe(false);
      expect(text(r)).toContain('"limit"');
    }
    expect(bridge.calls).toHaveLength(0);
  });

  it('discord_get_history before 非 snowflake → success:false', async () => {
    for (const before of ['abc', '123', 12345]) {
      const r = await tools.get('discord_get_history')!.handler({ before }, ctxWith(bridge));
      expect(r.success, `before=${String(before)}`).toBe(false);
      expect(text(r)).toContain('"before"');
    }
    expect(bridge.calls).toHaveLength(0);
  });

  it('install_skill 非法包名 → success:false（对齐上游 Invalid package format）', async () => {
    const r = await tools.get('install_skill')!.handler({ name: 'not a package!!' }, ctxWith(bridge));
    expect(r.success).toBe(false);
    expect(text(r)).toContain('Invalid package format');
    expect(bridge.calls).toHaveLength(0);
  });

  it('install_skill 允许 owner/repo@skill 与 https URL', async () => {
    const r1 = await tools.get('install_skill')!.handler({ name: 'owner/repo@skill' }, ctxWith(bridge));
    expect(r1.success).toBe(true);
    const r2 = await tools.get('install_skill')!.handler(
      { name: 'https://example.com/skill.git' },
      ctxWith(bridge),
    );
    expect(r2.success).toBe(true);
  });

  it('uninstall_skill 非法 skill ID（含斜杠）→ success:false', async () => {
    const r = await tools.get('uninstall_skill')!.handler({ name: 'a/b' }, ctxWith(bridge));
    expect(r.success).toBe(false);
    expect(text(r)).toContain('Invalid skill ID');
    expect(bridge.calls).toHaveLength(0);
  });
});

describe('createBuiltinTools — schedule_task 非法 schedule', () => {
  it('未知 kind → success:false 且不触达 bridge', async () => {
    const bridge = new FakeToolBridge();
    const tool = toolMap().get('schedule_task')!;
    const r = await tool.handler(
      { name: 'n', prompt: 'p', schedule: { kind: 'weekly' } },
      ctxWith(bridge),
    );
    expect(r.success).toBe(false);
    expect(text(r)).toContain('schedule.kind');
    expect(bridge.calls).toHaveLength(0);
  });

  it('interval seconds 非正数 → success:false', async () => {
    const bridge = new FakeToolBridge();
    const tool = toolMap().get('schedule_task')!;
    const r = await tool.handler(
      { name: 'n', prompt: 'p', schedule: { kind: 'interval', seconds: -5 } },
      ctxWith(bridge),
    );
    expect(r.success).toBe(false);
    expect(text(r)).toContain('schedule.seconds');
    expect(bridge.calls).toHaveLength(0);
  });
});
