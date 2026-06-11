/**
 * tests/dispatcher.test.ts —— ToolDispatcher：item/tool/call 订阅 → registry.dispatch → respond。
 *
 * FakeClient（implements IAppServerClient）只让 onServerRequest 记录 handler，并暴露
 * emitServerRequest(method, params) 同步驱动 handler、捕获 respond 的返回值；其余方法 no-op。
 * FakeRegistry（implements IToolRegistry）按名分发到内存里注册的 handler，复刻 dispatch 不抛的契约。
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  IAppServerClient,
  IncomingServerRequest,
  ServerNotificationHandler,
  ServerRequestHandler,
} from '../src/contracts.js';
import type { InitializeResponse } from '../src/appserver/protocol.js';
import {
  ServerReq,
  toolTextResult,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type DynamicToolSpec,
} from '../src/appserver/protocol.js';
import type {
  IToolRegistry,
  ToolContext,
  ToolDefinition,
} from '../src/runtime/tools/types.js';
import { ToolDispatcher } from '../src/runtime/tools/dispatcher.js';
import { FakeToolBridge } from './helpers/fake-tool-bridge.js';

// ───────────────────────── FakeClient ─────────────────────────

class FakeClient implements IAppServerClient {
  private serverRequestHandlers = new Set<ServerRequestHandler>();
  /** 记录 dispose 时是否调用取消订阅。 */
  unsubscribeCount = 0;

  async start(): Promise<InitializeResponse> {
    return {
      userAgent: 'fake',
      codexHome: '/tmp/codex',
      platformFamily: 'unix',
      platformOs: 'darwin',
    };
  }
  async request<T = unknown>(): Promise<T> {
    return {} as T;
  }
  notify(): void {}
  onNotification(_handler: ServerNotificationHandler): () => void {
    return () => {};
  }
  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => {
      this.serverRequestHandlers.delete(handler);
      this.unsubscribeCount += 1;
    };
  }
  onClose(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}

  /**
   * 模拟 server→client 请求：驱动所有已注册 handler，捕获最后一次 respond 的返回值。
   * 返回 { responded, result }：responded=false 表示没有 handler 调用 respond（即被忽略）。
   */
  async emitServerRequest(
    method: string,
    params: unknown,
  ): Promise<{ responded: boolean; result?: unknown }> {
    const req: IncomingServerRequest = { id: 1, method, params };
    let responded = false;
    let result: unknown;
    const respond = (r: unknown): void => {
      responded = true;
      result = r;
    };
    for (const handler of this.serverRequestHandlers) {
      handler(req, respond);
    }
    // dispatcher 的 handler 是 async 的（void this.handle(...)）；
    // 用一个微任务刷新点等待 dispatch promise 链 settle。
    await Promise.resolve();
    await Promise.resolve();
    return { responded, result };
  }

  /**
   * 用外部 respond 回调驱动 server 请求（不内部捕获、不等 dispatch settle）。
   * 用于 handler 永不 settle 的超时测试：respond 由看门狗在推进时钟后调用。
   */
  async emitServerRequestRaw(
    method: string,
    params: unknown,
    respond: (result: unknown) => void,
  ): Promise<void> {
    const req: IncomingServerRequest = { id: 1, method, params };
    for (const handler of this.serverRequestHandlers) {
      handler(req, respond);
    }
    await Promise.resolve(); // 让 handle() 走到 await registry.dispatch 与 setTimeout 注册点。
  }
}

// ───────────────────────── FakeRegistry ─────────────────────────

/** 复刻 IToolRegistry.dispatch 契约：未知工具 / handler 抛错都回 success:false，永不抛。 */
class FakeRegistry implements IToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>();
  /** 记录每次 dispatch 的 (tool, args, ctx)，供断言透传。 */
  readonly dispatched: Array<{ tool: string; args: unknown; ctx: ToolContext }> = [];

  register(def: ToolDefinition): void {
    this.defs.set(def.spec.name, def);
  }
  specs(): DynamicToolSpec[] {
    return [...this.defs.values()].map((d) => d.spec);
  }
  has(tool: string): boolean {
    return this.defs.has(tool);
  }
  async dispatch(
    tool: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<DynamicToolCallResponse> {
    this.dispatched.push({ tool, args, ctx });
    const def = this.defs.get(tool);
    if (!def) {
      return toolTextResult(`unknown tool: ${tool}`, false);
    }
    try {
      return await def.handler(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toolTextResult(`tool error: ${message}`, false);
    }
  }
}

// ───────────────────────── helpers ─────────────────────────

function makeTool(name: string, handler: ToolDefinition['handler']): ToolDefinition {
  return {
    spec: {
      name,
      description: `test tool ${name}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    },
    handler,
  };
}

function callParams(overrides: Partial<DynamicToolCallParams>): DynamicToolCallParams {
  return {
    threadId: 'th_default',
    turnId: 'turn_1',
    callId: 'call_1',
    namespace: null,
    tool: 'echo',
    arguments: {},
    ...overrides,
  };
}

function makeDispatcher(opts?: {
  registry?: FakeRegistry;
  client?: FakeClient;
  groupFolder?: string;
  getThreadId?: () => string | null;
  dispatchTimeoutMs?: number;
}): {
  client: FakeClient;
  registry: FakeRegistry;
  bridge: FakeToolBridge;
  dispatcher: ToolDispatcher;
} {
  const client = opts?.client ?? new FakeClient();
  const registry = opts?.registry ?? new FakeRegistry();
  const bridge = new FakeToolBridge();
  const dispatcher = new ToolDispatcher(client, registry, {
    groupFolder: opts?.groupFolder ?? 'main',
    bridge,
    getThreadId: opts?.getThreadId ?? (() => 'th_default'),
    ...(opts?.dispatchTimeoutMs !== undefined ? { dispatchTimeoutMs: opts.dispatchTimeoutMs } : {}),
  });
  return { client, registry, bridge, dispatcher };
}

// ───────────────────────── tests ─────────────────────────

describe('ToolDispatcher', () => {
  it('已注册工具：item/tool/call → respond 收到 handler 结果，registry 被调用', async () => {
    const registry = new FakeRegistry();
    registry.register(
      makeTool('echo', async (args) =>
        toolTextResult(`echoed:${JSON.stringify(args)}`, true),
      ),
    );
    const { client } = makeDispatcher({ registry });

    const { responded, result } = await client.emitServerRequest(
      ServerReq.dynamicToolCall,
      callParams({ tool: 'echo', arguments: { x: 1 } }),
    );

    expect(responded).toBe(true);
    expect(result).toEqual({
      contentItems: [{ type: 'inputText', text: 'echoed:{"x":1}' }],
      success: true,
    });
    // registry 确实被 dispatch（工具名 + 原样 args 透传）。
    expect(registry.dispatched).toHaveLength(1);
    expect(registry.dispatched[0]?.tool).toBe('echo');
    expect(registry.dispatched[0]?.args).toEqual({ x: 1 });
  });

  it('未知工具：respond success:false', async () => {
    const { client, registry } = makeDispatcher();

    const { responded, result } = await client.emitServerRequest(
      ServerReq.dynamicToolCall,
      callParams({ tool: 'nope' }),
    );

    expect(responded).toBe(true);
    expect(result).toMatchObject({ success: false });
    expect((result as DynamicToolCallResponse).contentItems[0]).toMatchObject({
      type: 'inputText',
    });
    // 即便未知工具，dispatcher 仍把它交给 registry 决策（不在自身预判）。
    expect(registry.dispatched[0]?.tool).toBe('nope');
  });

  it('非 item/tool/call 的 method（审批请求）：不 respond、不 dispatch', async () => {
    const { client, registry } = makeDispatcher();

    const { responded } = await client.emitServerRequest(
      ServerReq.commandExecutionRequestApproval,
      { whatever: true },
    );

    expect(responded).toBe(false);
    expect(registry.dispatched).toHaveLength(0);
  });

  it('threadId 透传：getThreadId 的返回值注入到 ToolContext.threadId', async () => {
    const registry = new FakeRegistry();
    let seenThreadId: string | null = 'UNSET';
    let seenFolder = '';
    registry.register(
      makeTool('ctx_probe', async (_args, ctx) => {
        seenThreadId = ctx.threadId;
        seenFolder = ctx.groupFolder;
        return toolTextResult('ok', true);
      }),
    );
    const { client } = makeDispatcher({
      registry,
      groupFolder: 'home-42',
      getThreadId: () => 'th_x',
    });

    await client.emitServerRequest(
      ServerReq.dynamicToolCall,
      callParams({ tool: 'ctx_probe' }),
    );

    expect(seenThreadId).toBe('th_x');
    expect(seenFolder).toBe('home-42');
  });

  it('threadId 尚未就绪：getThreadId 返回 null 也照常透传', async () => {
    const registry = new FakeRegistry();
    let seenThreadId: string | null = 'UNSET';
    registry.register(
      makeTool('ctx_probe', async (_args, ctx) => {
        seenThreadId = ctx.threadId;
        return toolTextResult('ok', true);
      }),
    );
    const { client } = makeDispatcher({ registry, getThreadId: () => null });

    await client.emitServerRequest(
      ServerReq.dynamicToolCall,
      callParams({ tool: 'ctx_probe' }),
    );

    expect(seenThreadId).toBeNull();
  });

  it('handler 抛错：registry 兜底为 success:false（dispatcher 不崩）', async () => {
    const registry = new FakeRegistry();
    registry.register(
      makeTool('boom', async () => {
        throw new Error('kaboom');
      }),
    );
    const { client } = makeDispatcher({ registry });

    const { responded, result } = await client.emitServerRequest(
      ServerReq.dynamicToolCall,
      callParams({ tool: 'boom' }),
    );

    expect(responded).toBe(true);
    expect(result).toMatchObject({ success: false });
  });

  it('#9 handler 永不 settle → 超时后 respond 必达且 success:false（解开 turn 死锁）', async () => {
    vi.useFakeTimers();
    try {
      // handler 返回永不 settle 的 Promise（模拟阻塞 fd / FIFO readFile）。
      const client = new FakeClient();
      const registry = new FakeRegistry();
      registry.register(makeTool('hang', () => new Promise<never>(() => {})));
      new ToolDispatcher(client, registry, {
        groupFolder: 'g',
        bridge: new FakeToolBridge(),
        getThreadId: () => 'th',
        dispatchTimeoutMs: 1000,
      });

      let responded = false;
      let result: unknown;
      const respond = (r: unknown): void => {
        responded = true;
        result = r;
      };
      // 直接触发 client 已注册的 handler。
      await client.emitServerRequestRaw(
        ServerReq.dynamicToolCall,
        callParams({ tool: 'hang' }),
        respond,
      );

      expect(responded).toBe(false); // 超时前未结算
      await vi.advanceTimersByTimeAsync(1000); // 跨过看门狗
      expect(responded).toBe(true);
      expect(result).toMatchObject({ success: false });
      expect((result as DynamicToolCallResponse).contentItems[0]).toMatchObject({ type: 'inputText' });
      const text = (result as DynamicToolCallResponse).contentItems[0] as { text: string };
      expect(text.text).toMatch(/timeout/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('#9 dispatchTimeoutMs<=0 关闭看门狗：永挂 handler 不会被超时收口', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      const registry = new FakeRegistry();
      registry.register(makeTool('hang', () => new Promise<never>(() => {})));
      new ToolDispatcher(client, registry, {
        groupFolder: 'g',
        bridge: new FakeToolBridge(),
        getThreadId: () => 'th',
        dispatchTimeoutMs: 0,
      });

      let responded = false;
      await client.emitServerRequestRaw(
        ServerReq.dynamicToolCall,
        callParams({ tool: 'hang' }),
        () => {
          responded = true;
        },
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(responded).toBe(false); // 关闭超时 → 永挂（语义保留）
    } finally {
      vi.useRealTimers();
    }
  });

  it('#24 install_skill 看门狗默认 130s（> bridge 120s poll）：60s 不抢答，普通工具仍 60s 收口', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      const registry = new FakeRegistry();
      registry.register(makeTool('install_skill', () => new Promise<never>(() => {})));
      registry.register(makeTool('hang', () => new Promise<never>(() => {})));
      // 不传 dispatchTimeoutMs → 默认看门狗：普通工具 60s，install_skill 130s。
      new ToolDispatcher(client, registry, {
        groupFolder: 'g',
        bridge: new FakeToolBridge(),
        getThreadId: () => 'th',
      });

      let installResponded = false;
      let installResult: unknown;
      await client.emitServerRequestRaw(
        ServerReq.dynamicToolCall,
        callParams({ tool: 'install_skill' }),
        (r) => {
          installResponded = true;
          installResult = r;
        },
      );
      let hangResponded = false;
      await client.emitServerRequestRaw(
        ServerReq.dynamicToolCall,
        callParams({ tool: 'hang' }),
        () => {
          hangResponded = true;
        },
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(hangResponded).toBe(true); // 普通工具：60s 默认看门狗照常收口
      expect(installResponded).toBe(false); // install_skill：不被 60s 假失败抢答

      await vi.advanceTimersByTimeAsync(70_000); // 累计 130s，跨过 install 专属看门狗
      expect(installResponded).toBe(true);
      expect(installResult).toMatchObject({ success: false });
      const text = (installResult as DynamicToolCallResponse).contentItems[0] as { text: string };
      expect(text.text).toMatch(/timeout.*130000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('#24 安装在 60s-130s 间完成（bridge poll 120s 上限内）→ 真实成功回执胜出，不被假失败抢答', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      const registry = new FakeRegistry();
      // 模拟 bridge pollIpcResult 在 90s 时读到主进程成功回执。
      registry.register(
        makeTool(
          'install_skill',
          () =>
            new Promise<DynamicToolCallResponse>((resolve) => {
              setTimeout(() => resolve(toolTextResult('Skill "x/y" 已安装', true)), 90_000);
            }),
        ),
      );
      new ToolDispatcher(client, registry, {
        groupFolder: 'g',
        bridge: new FakeToolBridge(),
        getThreadId: () => 'th',
      });

      let responded = false;
      let result: unknown;
      await client.emitServerRequestRaw(
        ServerReq.dynamicToolCall,
        callParams({ tool: 'install_skill' }),
        (r) => {
          responded = true;
          result = r;
        },
      );

      await vi.advanceTimersByTimeAsync(89_000);
      expect(responded).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000); // 90s：真实回执先于 130s 看门狗
      expect(responded).toBe(true);
      expect(result).toMatchObject({ success: true });
    } finally {
      vi.useRealTimers();
    }
  });

  // 语义更新（CR#13）：原用例「显式 dispatchTimeoutMs 统一拍平所有工具（含 install_skill）」
  // 被不变量校验取代——低于 bridge poll 上限 + 余量的显式值对 install_skill 是 #24 复发路径，
  // 构造期 warn + clamp 到 130s；普通工具仍按显式值拍平。
  it('#13 显式 dispatchTimeoutMs 低于 install 不变量 → warn + install_skill 钳到 130s，普通工具仍拍平', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = new FakeClient();
      const registry = new FakeRegistry();
      registry.register(makeTool('install_skill', () => new Promise<never>(() => {})));
      registry.register(makeTool('hang', () => new Promise<never>(() => {})));
      new ToolDispatcher(client, registry, {
        groupFolder: 'g',
        bridge: new FakeToolBridge(),
        getThreadId: () => 'th',
        dispatchTimeoutMs: 1000,
      });
      // 构造期不变量校验：违反即 warn（一次）。
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/install_skill/);

      let installResponded = false;
      let installResult: unknown;
      await client.emitServerRequestRaw(
        ServerReq.dynamicToolCall,
        callParams({ tool: 'install_skill' }),
        (r) => {
          installResponded = true;
          installResult = r;
        },
      );
      let hangResponded = false;
      await client.emitServerRequestRaw(
        ServerReq.dynamicToolCall,
        callParams({ tool: 'hang' }),
        () => {
          hangResponded = true;
        },
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(hangResponded).toBe(true); // 普通工具：显式值照常拍平
      expect(installResponded).toBe(false); // install_skill：不被 1s 假失败抢答（钳到 130s）

      await vi.advanceTimersByTimeAsync(129_000); // 累计 130s
      expect(installResponded).toBe(true);
      expect(installResult).toMatchObject({ success: false });
      const text = (installResult as DynamicToolCallResponse).contentItems[0] as { text: string };
      expect(text.text).toMatch(/timeout.*130000ms/);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('#13 显式 dispatchTimeoutMs ≥ 不变量（200s）→ 统一拍平含 install_skill，不 warn 不 clamp', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = new FakeClient();
      const registry = new FakeRegistry();
      registry.register(makeTool('install_skill', () => new Promise<never>(() => {})));
      new ToolDispatcher(client, registry, {
        groupFolder: 'g',
        bridge: new FakeToolBridge(),
        getThreadId: () => 'th',
        dispatchTimeoutMs: 200_000,
      });
      expect(warnSpy).not.toHaveBeenCalled();

      let responded = false;
      await client.emitServerRequestRaw(
        ServerReq.dynamicToolCall,
        callParams({ tool: 'install_skill' }),
        () => {
          responded = true;
        },
      );
      await vi.advanceTimersByTimeAsync(130_000);
      expect(responded).toBe(false); // 显式 200s 生效（未被回落到 130s）
      await vi.advanceTimersByTimeAsync(70_000); // 累计 200s
      expect(responded).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('#13 dispatchTimeoutMs<=0 关闭看门狗对 install_skill 同样生效（不 clamp、不 warn）', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = new FakeClient();
      const registry = new FakeRegistry();
      registry.register(makeTool('install_skill', () => new Promise<never>(() => {})));
      new ToolDispatcher(client, registry, {
        groupFolder: 'g',
        bridge: new FakeToolBridge(),
        getThreadId: () => 'th',
        dispatchTimeoutMs: 0,
      });
      expect(warnSpy).not.toHaveBeenCalled();

      let responded = false;
      await client.emitServerRequestRaw(
        ServerReq.dynamicToolCall,
        callParams({ tool: 'install_skill' }),
        () => {
          responded = true;
        },
      );
      await vi.advanceTimersByTimeAsync(300_000);
      expect(responded).toBe(false); // 关闭超时语义保留
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('dispose() 取消订阅：之后的 item/tool/call 不再触发 handler', async () => {
    const { client, registry, dispatcher } = makeDispatcher();
    registry.register(makeTool('echo', async () => toolTextResult('ok', true)));

    dispatcher.dispose();
    expect(client.unsubscribeCount).toBe(1);

    const { responded } = await client.emitServerRequest(
      ServerReq.dynamicToolCall,
      callParams({ tool: 'echo' }),
    );

    expect(responded).toBe(false);
    expect(registry.dispatched).toHaveLength(0);
  });
});
