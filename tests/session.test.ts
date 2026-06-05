/**
 * tests/session.test.ts —— ThreadSession 生命周期 + 注入循环 + CodexRunner 单测。
 *
 * 用 FakeAppServerClient（implements IAppServerClient）记录 request 调用，并暴露 emit() 模拟
 * server→client 通知，从而无需真实 codex app-server 即可验证 thread/turn 状态机。
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  IAppServerClient,
  IStreamMapper,
  ServerNotificationHandler,
  ServerRequestHandler,
} from '../src/contracts.js';
import type { InitializeResponse } from '../src/appserver/protocol.js';
import type { StreamEvent } from '../src/shared/stream-event.js';
import {
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
} from '../src/shared/stream-event.js';
import { ThreadSession, deriveTurnSubtype } from '../src/runtime/session.js';
import { CodexRunner, wrapStreamEvent } from '../src/runtime/codex-runner.js';
import { ToolRegistry } from '../src/runtime/tools/registry.js';
import { toolTextResult, type DynamicToolSpec } from '../src/appserver/protocol.js';
import { FakeToolBridge } from './helpers/fake-tool-bridge.js';

// ───────────────────────── FakeAppServerClient ─────────────────────────

interface RecordedRequest {
  method: string;
  params: unknown;
}

class FakeAppServerClient implements IAppServerClient {
  readonly requests: RecordedRequest[] = [];
  private notificationHandlers = new Set<ServerNotificationHandler>();
  closed = false;

  /** 每个 method 的下一次响应；缺省返回 {}。 */
  responses: Record<string, unknown> = {};
  /** 命中则该次 request 抛错一次（用于测试 steer 被拒回退）。 */
  failOnce = new Set<string>();
  /** 命中则 request 在该 promise resolve 前挂起（用于测试在途注入门控）。 */
  gate: Record<string, Promise<void>> = {};

  async start(): Promise<InitializeResponse> {
    return {
      userAgent: 'fake',
      codexHome: '/tmp/codex',
      platformFamily: 'unix',
      platformOs: 'darwin',
    };
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (this.failOnce.has(method)) {
      this.failOnce.delete(method);
      throw new Error(`fake rpc rejected: ${method}`);
    }
    const g = this.gate[method];
    if (g) await g;
    return (this.responses[method] ?? {}) as T;
  }

  notify(_method: string, _params?: unknown): void {
    /* no-op */
  }

  onNotification(handler: ServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(_handler: ServerRequestHandler): () => void {
    return () => {};
  }

  onClose(_handler: (info: { code: number | null; signal: string | null; error?: Error }) => void): () => void {
    return () => {};
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** 测试辅助：模拟 server→client 通知。 */
  emit(method: string, params: unknown): void {
    for (const h of this.notificationHandlers) h(method, params);
  }

  /** 测试辅助：取最近一次 request 的 method。 */
  lastMethod(): string | undefined {
    return this.requests.at(-1)?.method;
  }

  methods(): string[] {
    return this.requests.map((r) => r.method);
  }
}

/** 一个简单的假 mapper：把任意通知映射成单个 status StreamEvent，便于断言“通知经 mapper → onStreamEvent”。 */
class FakeMapper implements IStreamMapper {
  map(method: string, _params: unknown): StreamEvent[] {
    return [{ type: 'status', status: method }];
  }
}

// ───────────────────────── ThreadSession ─────────────────────────

describe('ThreadSession.start', () => {
  it('无 resumeThreadId → thread/start，并从响应吸收 threadId/sessionId/path', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = {
      thread: { id: 'th_1', sessionId: 'sess_1', path: '/rollout/th_1.jsonl' },
    };
    const session = new ThreadSession(client, { model: 'gpt-5', cwd: '/work' });

    await session.start();

    expect(client.lastMethod()).toBe('thread/start');
    const params = client.requests[0]!.params as Record<string, unknown>;
    expect(params.model).toBe('gpt-5');
    expect(params.cwd).toBe('/work');
    expect(session.state.threadId).toBe('th_1');
    expect(session.state.sessionId).toBe('sess_1');
    expect(session.state.rolloutPath).toBe('/rollout/th_1.jsonl');
  });

  it('有 resumeThreadId → thread/resume，params.threadId 透传', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/resume'] = {
      thread: { id: 'th_resumed', sessionId: 'sess_r', path: null },
    };
    const session = new ThreadSession(client, { resumeThreadId: 'th_resumed' });

    await session.start();

    expect(client.lastMethod()).toBe('thread/resume');
    const params = client.requests[0]!.params as Record<string, unknown>;
    expect(params.threadId).toBe('th_resumed');
    expect(session.state.threadId).toBe('th_resumed');
  });

  it('thread/started 通知也能兜底吸收 thread 标识', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = {}; // 响应不带 thread
    const session = new ThreadSession(client, {});

    await session.start();
    expect(session.state.threadId).toBeNull();

    client.emit('thread/started', {
      thread: { id: 'th_late', sessionId: 'sess_late', path: '/p.jsonl' },
    });
    expect(session.state.threadId).toBe('th_late');
    expect(session.state.sessionId).toBe('sess_late');
    expect(session.state.rolloutPath).toBe('/p.jsonl');
  });
});

describe('ThreadSession.sendUserMessage (turn/start vs turn/steer)', () => {
  async function startedSession(): Promise<{ client: FakeAppServerClient; session: ThreadSession }> {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_1', sessionId: 's', path: null } };
    const session = new ThreadSession(client, {});
    await session.start();
    return { client, session };
  }

  it('无 active turn → turn/start，input 为 textInput', async () => {
    const { client, session } = await startedSession();
    await session.sendUserMessage('hello');

    expect(client.lastMethod()).toBe('turn/start');
    const params = client.requests.at(-1)!.params as Record<string, unknown>;
    expect(params.threadId).toBe('th_1');
    expect(params.input).toEqual([{ type: 'text', text: 'hello', text_elements: [] }]);
    expect(params.expectedTurnId).toBeUndefined();
  });

  it('收到 turn/started 后 → turn/steer，且 expectedTurnId 为 active turn id', async () => {
    const { client, session } = await startedSession();

    client.emit('turn/started', { threadId: 'th_1', turn: { id: 'turn_1' } });
    expect(session.state.activeTurnId).toBe('turn_1');

    await session.sendUserMessage('steer me');
    expect(client.lastMethod()).toBe('turn/steer');
    const params = client.requests.at(-1)!.params as Record<string, unknown>;
    expect(params.expectedTurnId).toBe('turn_1');
    expect(params.input).toEqual([{ type: 'text', text: 'steer me', text_elements: [] }]);
  });

  it('turn/completed 清空 activeTurnId 并触发 onTurnCompleted；之后 sendUserMessage 回到 turn/start', async () => {
    const { client, session } = await startedSession();
    const completed: Array<{ turnId: string; subtype: string }> = [];
    session.onTurnCompleted((info) => completed.push(info));

    client.emit('turn/started', { threadId: 'th_1', turn: { id: 'turn_1' } });
    expect(session.state.activeTurnId).toBe('turn_1');

    client.emit('turn/completed', { threadId: 'th_1', turn: { id: 'turn_1', status: 'completed' } });
    expect(session.state.activeTurnId).toBeNull();
    expect(completed).toEqual([{ turnId: 'turn_1', subtype: 'completed' }]);

    await session.sendUserMessage('again');
    expect(client.lastMethod()).toBe('turn/start');
  });

  it('未 start 时 sendUserMessage 抛错', async () => {
    const client = new FakeAppServerClient();
    const session = new ThreadSession(client, {});
    await expect(session.sendUserMessage('x')).rejects.toThrow(/thread not started/);
  });
});

describe('ThreadSession 鲁棒 turn 跟踪（回归 #3/#4/#5）', () => {
  async function started(turnStartId?: string): Promise<{ client: FakeAppServerClient; session: ThreadSession }> {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_1', sessionId: 's', path: null } };
    if (turnStartId) client.responses['turn/start'] = { turn: { id: turnStartId } };
    const session = new ThreadSession(client, {});
    await session.start();
    return { client, session };
  }

  it('#3 turn/start 响应同步带回 turn id → activeTurnId 立即就绪，下一条直接走 turn/steer（无需 turn/started 通知）', async () => {
    const { client, session } = await started('turn_sync');

    await session.sendUserMessage('first'); // turn/start，响应带 turn_sync
    expect(client.lastMethod()).toBe('turn/start');
    expect(session.state.activeTurnId).toBe('turn_sync'); // 未发任何 turn/started 通知即就绪

    await session.sendUserMessage('second'); // 应走 steer
    expect(client.lastMethod()).toBe('turn/steer');
    expect((client.requests.at(-1)!.params as Record<string, unknown>).expectedTurnId).toBe('turn_sync');
  });

  it('#5 未知 turn id 的 turn/completed 被忽略：不清空 active turn、不触发 onTurnCompleted', async () => {
    const { client, session } = await started('turn_live');
    const completed: Array<{ turnId: string; subtype: string }> = [];
    session.onTurnCompleted((i) => completed.push(i));

    await session.sendUserMessage('go');
    expect(session.state.activeTurnId).toBe('turn_live');

    client.emit('turn/completed', { threadId: 'th_1', turn: { id: 'turn_ghost', status: 'completed' } });
    expect(session.state.activeTurnId).toBe('turn_live'); // 未被陈旧/重复完成清掉
    expect(completed).toEqual([]);

    client.emit('turn/completed', { threadId: 'th_1', turn: { id: 'turn_live', status: 'completed' } });
    expect(session.state.activeTurnId).toBeNull();
    expect(completed).toEqual([{ turnId: 'turn_live', subtype: 'completed' }]);
  });

  it('#4 turn/steer 被拒 → reconcile 旧 turn 并回退 turn/start，注入不丢', async () => {
    const { client, session } = await started('turn_a');
    const completed: Array<{ turnId: string; subtype: string }> = [];
    session.onTurnCompleted((i) => completed.push(i));

    await session.sendUserMessage('open'); // active = turn_a
    expect(session.state.activeTurnId).toBe('turn_a');

    client.failOnce.add('turn/steer'); // 下一次 steer 被拒
    client.responses['turn/start'] = { turn: { id: 'turn_b' } };
    await session.sendUserMessage('inject'); // steer 失败 → 回退 turn/start

    expect(client.methods().filter((m) => m === 'turn/start').length).toBe(2);
    expect(session.state.activeTurnId).toBe('turn_b');
    expect(completed).toEqual([{ turnId: 'turn_a', subtype: 'interrupted' }]); // 旧 turn reconcile
  });

  it('turn/started 通知与响应注册同一 turn 时只触发一次 onTurnStarted（按 id 去重）', async () => {
    const { client, session } = await started('turn_dup');
    const started2: string[] = [];
    session.onTurnStarted(({ turnId }) => started2.push(turnId));

    await session.sendUserMessage('x'); // 响应注册 turn_dup（1 次）
    client.emit('turn/started', { threadId: 'th_1', turn: { id: 'turn_dup' } }); // 通知重复 → 去重
    expect(started2).toEqual(['turn_dup']);
  });
});

describe('ThreadSession.interrupt', () => {
  it('→ turn/interrupt，params.threadId 透传', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_1', sessionId: 's', path: null } };
    const session = new ThreadSession(client, {});
    await session.start();

    await session.interrupt();
    expect(client.lastMethod()).toBe('turn/interrupt');
    const params = client.requests.at(-1)!.params as Record<string, unknown>;
    expect(params.threadId).toBe('th_1');
  });
});

describe('ThreadSession stream mapping', () => {
  it('通知经 mapper.map → onStreamEvent 逐个吐出（假 mapper）', () => {
    const client = new FakeAppServerClient();
    const session = new ThreadSession(client, {}, new FakeMapper());
    const events: StreamEvent[] = [];
    session.onStreamEvent((ev) => events.push(ev));

    client.emit('item/agentMessage/delta', { delta: 'hi' });
    client.emit('turn/started', { threadId: 'th', turn: { id: 't1' } });

    // 每条通知都过 mapper（FakeMapper 把 method 放进 status）。
    expect(events).toEqual([
      { type: 'status', status: 'item/agentMessage/delta' },
      { type: 'status', status: 'turn/started' },
    ]);
  });

  it('使用真实 StreamMapper（默认）时，agentMessage delta → text_delta', () => {
    const client = new FakeAppServerClient();
    const session = new ThreadSession(client, {}); // 默认 StreamMapper
    const events: StreamEvent[] = [];
    session.onStreamEvent((ev) => events.push(ev));

    client.emit('item/agentMessage/delta', {
      threadId: 'th',
      turnId: 't1',
      itemId: 'i1',
      delta: 'token',
    });

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas[0]!.text).toBe('token');
  });

  it('onStreamEvent 返回取消函数，取消后不再收到事件', () => {
    const client = new FakeAppServerClient();
    const session = new ThreadSession(client, {}, new FakeMapper());
    const events: StreamEvent[] = [];
    const off = session.onStreamEvent((ev) => events.push(ev));

    client.emit('x', {});
    off();
    client.emit('y', {});

    expect(events).toEqual([{ type: 'status', status: 'x' }]);
  });
});

describe('deriveTurnSubtype', () => {
  it('映射 TurnStatus → subtype', () => {
    expect(deriveTurnSubtype('completed')).toBe('completed');
    expect(deriveTurnSubtype('interrupted')).toBe('interrupted');
    expect(deriveTurnSubtype('failed')).toBe('failed');
    expect(deriveTurnSubtype('inProgress')).toBe('completed');
    expect(deriveTurnSubtype(undefined)).toBe('completed');
    expect(deriveTurnSubtype(null)).toBe('completed');
  });
});

// ───────────────────────── CodexRunner ─────────────────────────

describe('wrapStreamEvent', () => {
  it('用 OUTPUT_MARKER 包裹成一行 JSON', () => {
    const ev: StreamEvent = { type: 'text_delta', text: 'hi' };
    const line = wrapStreamEvent(ev);
    expect(line.startsWith(OUTPUT_START_MARKER)).toBe(true);
    expect(line.endsWith(`${OUTPUT_END_MARKER}\n`)).toBe(true);
    const inner = line.slice(OUTPUT_START_MARKER.length, line.length - OUTPUT_END_MARKER.length - 1);
    expect(JSON.parse(inner)).toEqual(ev);
  });
});

describe('CodexRunner.run', () => {
  it('start → 初始 prompt 走 turn/start，turn/completed 后 run() resolve；stream 事件经 sink 包裹', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_run', sessionId: 's', path: null } };
    const lines: string[] = [];
    const runner = new CodexRunner({
      client,
      config: { model: 'gpt-5' },
      sink: (line) => lines.push(line),
      mapper: new FakeMapper(),
    });

    const input = { prompt: 'do it', groupFolder: 'home-1', session: { cwd: '/work' } };
    const runPromise = runner.run(input);

    // 等待 start() + sendUserMessage() 的微任务排空。
    await vi.waitFor(() => {
      expect(client.methods()).toContain('turn/start');
    });

    // 模拟服务端：turn 开始 → 推流 → 完成。
    client.emit('turn/started', { threadId: 'th_run', turn: { id: 'turn_1' } });
    client.emit('item/agentMessage/delta', { delta: 'partial' });
    client.emit('turn/completed', { threadId: 'th_run', turn: { id: 'turn_1', status: 'completed' } });

    await runPromise; // 应当 resolve

    // config 合并：init params 应含 model（来自 deps.config）+ cwd（来自 input.session）。
    const startParams = client.requests.find((r) => r.method === 'thread/start')!.params as Record<string, unknown>;
    expect(startParams.model).toBe('gpt-5');
    expect(startParams.cwd).toBe('/work');

    // sink 收到 OUTPUT_MARKER 包裹的事件行（至少 turn/started、delta、turn/completed 三条）。
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.every((l) => l.startsWith(OUTPUT_START_MARKER) && l.endsWith(`${OUTPUT_END_MARKER}\n`))).toBe(true);
  });
});

describe('CodexRunner.inject', () => {
  it('有 active turn → steer；注入未结束时 turn/completed 不提前 resolve', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_inj', sessionId: 's', path: null } };
    const runner = new CodexRunner({ client, config: {}, sink: () => {}, mapper: new FakeMapper() });

    const runPromise = runner.run({ prompt: 'p', groupFolder: 'g', session: {} });
    await vi.waitFor(() => expect(client.methods()).toContain('turn/start'));

    client.emit('turn/started', { threadId: 'th_inj', turn: { id: 'turn_1' } });
    runner.inject('mid-turn message');

    await vi.waitFor(() => expect(client.methods()).toContain('turn/steer'));
    const steer = client.requests.find((r) => r.method === 'turn/steer')!.params as Record<string, unknown>;
    expect(steer.expectedTurnId).toBe('turn_1');

    client.emit('turn/completed', { threadId: 'th_inj', turn: { id: 'turn_1', status: 'completed' } });
    await runPromise;
    expect(client.methods()).toContain('turn/steer');
  });

  it('#1/#2 在途注入未完成时，turn/completed 不提前结束 run()（在飞 turn + 队列门控）', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th', sessionId: 's', path: null } };
    client.responses['turn/start'] = { turn: { id: 'turn_1' } }; // prompt turn 同步注册
    // 让注入的 steer 请求挂起，模拟“注入在途未完成”。
    let releaseSteer!: () => void;
    client.gate['turn/steer'] = new Promise<void>((r) => {
      releaseSteer = r;
    });

    const runner = new CodexRunner({ client, config: {}, sink: () => {}, mapper: new FakeMapper() });
    let resolved = false;
    const runPromise = runner.run({ prompt: 'p', groupFolder: 'g', session: {} }).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(client.methods()).toContain('turn/start'));
    // 此刻 activeTurnId=turn_1（响应同步注册），runner inFlight={turn_1}。

    runner.inject('mid'); // queued=1；steer 发出但被 gate 挂起
    await vi.waitFor(() => expect(client.methods()).toContain('turn/steer'));

    client.emit('turn/completed', { threadId: 'th', turn: { id: 'turn_1', status: 'completed' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false); // 注入仍在途（queued>0）→ 不提前结束

    releaseSteer();
    await runPromise;
    expect(resolved).toBe(true); // 注入完成 + 无在飞 turn → 结束
  });
});

describe('CodexRunner + tools（Stage 3 wiring）', () => {
  it('提供 tools 时，thread/start 注入 registry.specs() 的 dynamicTools', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_t', sessionId: 's', path: null } };
    client.responses['turn/start'] = { turn: { id: 'turn_1' } };

    const registry = new ToolRegistry();
    const spec: DynamicToolSpec = {
      name: 'ping',
      description: 'ping tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    };
    registry.register({ spec, handler: async () => toolTextResult('pong') });
    const bridge = new FakeToolBridge();

    const runner = new CodexRunner({
      client,
      config: {},
      sink: () => {},
      mapper: new FakeMapper(),
      tools: { registry, bridge },
    });

    const runPromise = runner.run({ prompt: 'p', groupFolder: 'home-x', session: {} });
    // 等到 turn/start 发出（turn_1 已由响应同步注册），再发完成，避免被当陈旧完成忽略。
    await vi.waitFor(() => expect(client.methods()).toContain('turn/start'));

    const startParams = client.requests.find((r) => r.method === 'thread/start')!.params as Record<string, unknown>;
    expect(startParams.dynamicTools).toEqual([spec]);

    client.emit('turn/completed', { threadId: 'th_t', turn: { id: 'turn_1', status: 'completed' } });
    await runPromise;
  });
});

describe('CodexRunner.shutdown', () => {
  it('interrupt + client.close，并 resolve run()', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_sd', sessionId: 's', path: null } };
    const runner = new CodexRunner({ client, config: {}, sink: () => {}, mapper: new FakeMapper() });

    const runPromise = runner.run({ prompt: 'p', groupFolder: 'g', session: {} });
    await vi.waitFor(() => expect(client.methods()).toContain('turn/start'));

    runner.shutdown();
    await runPromise; // shutdown 应触发 resolve

    expect(client.methods()).toContain('turn/interrupt');
    expect(client.closed).toBe(true);
  });
});
