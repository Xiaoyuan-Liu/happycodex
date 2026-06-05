/**
 * createBuiltinTools 单测 —— 用 FakeToolBridge 验证每个工具的 spec 与 handler 行为。
 *
 * 覆盖：
 *  - 返回 12 个工具且 name 集合正确、唯一；
 *  - 每个工具 spec.inputSchema 是合法的 object schema（additionalProperties:false）；
 *  - 逐个 handler：合法 args → 调对应 bridge 方法（断言 bridge.calls）+ success:true；
 *  - 缺必填字段 → success:false 且文案含 "missing required field"；
 *  - memory_search / list_task 把数据带进文本；memory_get 命中文本 / (not found)。
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
  'schedule_task',
  'list_task',
  'pause_task',
  'resume_task',
  'cancel_task',
  'register_group',
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
  it('返回恰好 12 个工具', () => {
    expect(createBuiltinTools()).toHaveLength(12);
  });

  it('name 集合与 HappyClaw 12 工具一致且唯一', () => {
    const names = createBuiltinTools().map((t) => t.spec.name);
    expect(new Set(names).size).toBe(12);
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

  it('list_task → bridge.listTasks，数据进 text', async () => {
    bridge.tasks = [
      { id: 't1', name: 'A', status: 'active' },
      { id: 't2', name: 'B', status: 'paused' },
    ];
    const r = await tools.get('list_task')!.handler({}, ctxWith(bridge));
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
