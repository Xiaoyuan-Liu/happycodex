/**
 * ToolRegistry 单测 —— 注册 / specs / has / dispatch（命中、未知、handler 抛错、覆盖）。
 *
 * 用 FakeToolBridge + 自造几个最小 ToolDefinition 验证：
 * - register 后 specs() 含其 spec、has() 为 true；
 * - dispatch 命中 → handler 结果原样返回；
 * - 未知工具 → success:false 且 text 含 'unknown tool'；
 * - handler 抛错 → success:false 且错误不冒泡（dispatcher 依赖此不变量）。
 */

import { describe, expect, it } from 'vitest';
import { toolTextResult } from '../src/appserver/protocol.js';
import type {
  DynamicToolSpec,
  DynamicToolCallResponse,
} from '../src/appserver/protocol.js';
import { ToolRegistry } from '../src/runtime/tools/registry.js';
import type {
  ToolContext,
  ToolDefinition,
} from '../src/runtime/tools/types.js';
import { FakeToolBridge } from './helpers/fake-tool-bridge.js';

// ── 测试工具构造 ──────────────────────────────────────────────────
function spec(name: string, description = `desc ${name}`): DynamicToolSpec {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

/** 命中即返回 canned 结果的工具。 */
function okTool(
  name: string,
  result: DynamicToolCallResponse = toolTextResult(`ok:${name}`),
): ToolDefinition {
  return {
    spec: spec(name),
    handler: async () => result,
  };
}

/** handler 抛错的工具（验证 dispatch 兜底）。 */
function throwingTool(name: string, message: string): ToolDefinition {
  return {
    spec: spec(name),
    handler: async () => {
      throw new Error(message);
    },
  };
}

function makeCtx(): ToolContext {
  return {
    groupFolder: 'main',
    threadId: 'th_test',
    bridge: new FakeToolBridge(),
  };
}

// ── register / specs / has ────────────────────────────────────────
describe('ToolRegistry — register / specs / has', () => {
  it('register 后 specs() 含其 spec，has() 为 true', () => {
    const reg = new ToolRegistry();
    reg.register(okTool('alpha'));
    reg.register(okTool('beta'));

    const names = reg.specs().map((s) => s.name);
    expect(names).toEqual(['alpha', 'beta']);
    expect(reg.has('alpha')).toBe(true);
    expect(reg.has('beta')).toBe(true);
    expect(reg.has('missing')).toBe(false);
  });

  it('specs() 返回完整 DynamicToolSpec（含 description / inputSchema）', () => {
    const reg = new ToolRegistry();
    const def = okTool('gamma');
    reg.register(def);

    const specs = reg.specs();
    expect(specs).toHaveLength(1);
    expect(specs[0]).toEqual(def.spec);
  });

  it('specs() 顺序稳定（按首次插入序）', () => {
    const reg = new ToolRegistry();
    for (const n of ['t1', 't2', 't3', 't4']) reg.register(okTool(n));
    expect(reg.specs().map((s) => s.name)).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('空注册表 specs() 为空、has() 全 false', () => {
    const reg = new ToolRegistry();
    expect(reg.specs()).toEqual([]);
    expect(reg.has('anything')).toBe(false);
  });

  it('重名后注册覆盖（spec + handler），位置不变', async () => {
    const reg = new ToolRegistry();
    reg.register(okTool('a'));
    reg.register(okTool('dup', toolTextResult('first')));
    reg.register(okTool('b'));
    // 覆盖 dup
    reg.register(okTool('dup', toolTextResult('second')));

    // 位置保持首次插入序（a, dup, b），不因覆盖移到末尾
    expect(reg.specs().map((s) => s.name)).toEqual(['a', 'dup', 'b']);

    const res = await reg.dispatch('dup', {}, makeCtx());
    expect(res.success).toBe(true);
    expect(res.contentItems).toEqual([{ type: 'inputText', text: 'second' }]);
  });
});

// ── dispatch 命中 ─────────────────────────────────────────────────
describe('ToolRegistry — dispatch 命中', () => {
  it('命中 handler，结果原样返回', async () => {
    const reg = new ToolRegistry();
    reg.register(okTool('hit', toolTextResult('handled')));

    const res = await reg.dispatch('hit', { foo: 1 }, makeCtx());
    expect(res).toEqual({
      contentItems: [{ type: 'inputText', text: 'handled' }],
      success: true,
    });
  });

  it('handler 收到 args 与 ctx', async () => {
    const reg = new ToolRegistry();
    let seenArgs: unknown;
    let seenFolder: string | undefined;
    reg.register({
      spec: spec('echo'),
      handler: async (args, ctx) => {
        seenArgs = args;
        seenFolder = ctx.groupFolder;
        return toolTextResult('done');
      },
    });

    const ctx = makeCtx();
    const res = await reg.dispatch('echo', { x: 42 }, ctx);
    expect(res.success).toBe(true);
    expect(seenArgs).toEqual({ x: 42 });
    expect(seenFolder).toBe('main');
  });

  it('handler 可经由 ctx.bridge 施加副作用', async () => {
    const reg = new ToolRegistry();
    reg.register({
      spec: spec('send'),
      handler: async (_args, ctx) => {
        await ctx.bridge.sendMessage(ctx.groupFolder, 'hello');
        return toolTextResult('sent');
      },
    });

    const bridge = new FakeToolBridge();
    const ctx: ToolContext = { groupFolder: 'home-7', threadId: null, bridge };
    const res = await reg.dispatch('send', {}, ctx);

    expect(res.success).toBe(true);
    expect(bridge.opNames()).toEqual(['sendMessage']);
    expect(bridge.lastCall()).toEqual({ op: 'sendMessage', args: ['home-7', 'hello'] });
  });
});

// ── dispatch 错误路径 ─────────────────────────────────────────────
describe('ToolRegistry — dispatch 错误兜底（绝不抛）', () => {
  it('未知工具 → success:false 且 text 含 "unknown tool"', async () => {
    const reg = new ToolRegistry();
    reg.register(okTool('present'));

    const res = await reg.dispatch('absent', {}, makeCtx());
    expect(res.success).toBe(false);
    expect(res.contentItems).toHaveLength(1);
    const item = res.contentItems[0];
    expect(item?.type).toBe('inputText');
    expect(item?.type === 'inputText' ? item.text : '').toContain('unknown tool');
    expect(item?.type === 'inputText' ? item.text : '').toContain('absent');
  });

  it('handler 抛 Error → success:false 且不冒泡，text 为 error.message', async () => {
    const reg = new ToolRegistry();
    reg.register(throwingTool('boom', 'kaboom'));

    const res = await reg.dispatch('boom', {}, makeCtx());
    expect(res.success).toBe(false);
    const item = res.contentItems[0];
    expect(item?.type === 'inputText' ? item.text : '').toBe('kaboom');
  });

  it('handler 抛非 Error（reject 字符串） → success:false 且不冒泡', async () => {
    const reg = new ToolRegistry();
    reg.register({
      spec: spec('rejstr'),
      handler: async () => Promise.reject('plain-string-failure'),
    });

    const res = await reg.dispatch('rejstr', {}, makeCtx());
    expect(res.success).toBe(false);
    const item = res.contentItems[0];
    expect(item?.type === 'inputText' ? item.text : '').toContain('plain-string-failure');
  });

  it('多次 dispatch 不互相污染（错误后仍能正常命中）', async () => {
    const reg = new ToolRegistry();
    reg.register(okTool('good', toolTextResult('fine')));
    reg.register(throwingTool('bad', 'oops'));

    const a = await reg.dispatch('bad', {}, makeCtx());
    expect(a.success).toBe(false);

    const b = await reg.dispatch('good', {}, makeCtx());
    expect(b.success).toBe(true);
    expect(b.contentItems).toEqual([{ type: 'inputText', text: 'fine' }]);
  });
});
