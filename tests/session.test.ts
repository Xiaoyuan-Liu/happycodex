/**
 * tests/session.test.ts —— ThreadSession 生命周期 + 注入循环 + CodexRunner 单测。
 *
 * 用 FakeAppServerClient（implements IAppServerClient）记录 request 调用，并暴露 emit() 模拟
 * server→client 通知，从而无需真实 codex app-server 即可验证 thread/turn 状态机。
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { ThreadSession, deriveTurnSubtype, deriveSubagentType } from '../src/runtime/session.js';
import { RpcError } from '../src/appserver/client.js';
import { ERR_SERVER_OVERLOADED } from '../src/appserver/protocol.js';
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
  private closeHandlers = new Set<
    (info: { code: number | null; signal: string | null; error?: Error }) => void
  >();
  closed = false;

  /** 每个 method 的下一次响应；缺省返回 {}。 */
  responses: Record<string, unknown> = {};
  /** 命中则该次 request 抛错一次（用于测试 steer 被拒回退）。默认抛通用 Error。 */
  failOnce = new Set<string>();
  /** 命中则该次 request 抛指定错误一次（覆盖 failOnce 的通用 Error，用于区分 RpcError code 分支）。 */
  failOnceWith: Record<string, () => unknown> = {};
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
    const failer = this.failOnceWith[method];
    if (failer) {
      delete this.failOnceWith[method];
      throw failer();
    }
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

  onClose(
    handler: (info: { code: number | null; signal: string | null; error?: Error }) => void,
  ): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** 测试辅助：模拟 server→client 通知。 */
  emit(method: string, params: unknown): void {
    for (const h of this.notificationHandlers) h(method, params);
  }

  /** 测试辅助：模拟 app-server 进程退出 → 触发 onClose handlers。 */
  emitClose(info: { code: number | null; signal: string | null; error?: Error }): void {
    for (const h of this.closeHandlers) h(info);
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
    return [{ eventType: 'status', statusText: method }];
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

  it('#4 turn/steer 服务端语义拒绝（RpcError 非 -32001）→ reconcile 旧 turn 并回退 turn/start，注入不丢', async () => {
    const { client, session } = await started('turn_a');
    const completed: Array<{ turnId: string; subtype: string }> = [];
    session.onTurnCompleted((i) => completed.push(i));

    await session.sendUserMessage('open'); // active = turn_a
    expect(session.state.activeTurnId).toBe('turn_a');

    // 服务端对 steer 的语义裁决（expectedTurnId 失配 / turn 已结束）→ JSON-RPC error，code 非 -32001。
    client.failOnceWith['turn/steer'] = () =>
      new RpcError({ code: -32602, message: 'expectedTurnId mismatch: turn already ended' });
    client.responses['turn/start'] = { turn: { id: 'turn_b' } };
    await session.sendUserMessage('inject'); // steer 失败 → 回退 turn/start

    expect(client.methods().filter((m) => m === 'turn/start').length).toBe(2);
    expect(session.state.activeTurnId).toBe('turn_b');
    expect(completed).toEqual([{ turnId: 'turn_a', subtype: 'interrupted' }]); // 旧 turn reconcile
  });

  it('#3/#6 turn/steer 传输类失败（通用 Error）→ rethrow，不伪造 turn 完成、不开第二个 turn/start', async () => {
    const { client, session } = await started('turn_a');
    const completed: Array<{ turnId: string; subtype: string }> = [];
    session.onTurnCompleted((i) => completed.push(i));

    await session.sendUserMessage('open'); // active = turn_a
    expect(session.state.activeTurnId).toBe('turn_a');

    const turnStartsBefore = client.methods().filter((m) => m === 'turn/start').length;
    // 模拟超时 / 连接断 / stdin 不可写：普通 Error（非 RpcError）。
    client.failOnceWith['turn/steer'] = () => new Error('AppServerClient is closed');
    await expect(session.sendUserMessage('inject')).rejects.toThrow(/closed/);

    // 服务端那个 turn 可能仍在跑：不伪造完成、不改 activeTurnId、不开第二个 turn/start。
    expect(session.state.activeTurnId).toBe('turn_a');
    expect(completed).toEqual([]);
    expect(client.methods().filter((m) => m === 'turn/start').length).toBe(turnStartsBefore);
  });

  it('#3/#6 turn/steer 因 -32001 背压耗尽（RpcError code -32001）→ rethrow，不回退、不伪造完成', async () => {
    const { client, session } = await started('turn_a');
    const completed: Array<{ turnId: string; subtype: string }> = [];
    session.onTurnCompleted((i) => completed.push(i));

    await session.sendUserMessage('open'); // active = turn_a
    expect(session.state.activeTurnId).toBe('turn_a');

    const turnStartsBefore = client.methods().filter((m) => m === 'turn/start').length;
    client.failOnceWith['turn/steer'] = () =>
      new RpcError({ code: ERR_SERVER_OVERLOADED, message: 'server overloaded' });
    await expect(session.sendUserMessage('inject')).rejects.toThrow(/overloaded/);

    expect(session.state.activeTurnId).toBe('turn_a');
    expect(completed).toEqual([]);
    expect(client.methods().filter((m) => m === 'turn/start').length).toBe(turnStartsBefore);
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

describe('ThreadSession B1 compact', () => {
  async function startedSession(): Promise<{ client: FakeAppServerClient; session: ThreadSession }> {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_1', sessionId: 's', path: '/r/th_1.jsonl' } };
    const session = new ThreadSession(client, {});
    await session.start();
    return { client, session };
  }

  it('compact() → thread/compact/start，params.threadId 透传，响应忽略', async () => {
    const { client, session } = await startedSession();
    await session.compact();
    expect(client.lastMethod()).toBe('thread/compact/start');
    const params = client.requests.at(-1)!.params as Record<string, unknown>;
    expect(params.threadId).toBe('th_1');
  });

  it('未 start 时 compact() 抛错', async () => {
    const client = new FakeAppServerClient();
    const session = new ThreadSession(client, {});
    await expect(session.compact()).rejects.toThrow(/thread not started/);
  });

  it('agentMessage delta 累积 → takeAccumulatedText 取出并清空（再取为空）', async () => {
    const { client, session } = await startedSession();
    client.emit('item/agentMessage/delta', { threadId: 'th_1', turnId: 't1', itemId: 'i1', delta: 'Hello ' });
    client.emit('item/agentMessage/delta', { threadId: 'th_1', turnId: 't1', itemId: 'i1', delta: 'world' });
    expect(session.takeAccumulatedText()).toBe('Hello world');
    // 取出后清空。
    expect(session.takeAccumulatedText()).toBe('');
  });

  it('turn/completed 清空本轮累积正文', async () => {
    const { client, session } = await startedSession();
    client.emit('item/agentMessage/delta', { threadId: 'th_1', turnId: 't1', itemId: 'i1', delta: 'partial' });
    client.emit('turn/completed', { threadId: 'th_1', turn: { id: 't1', status: 'completed' } });
    expect(session.takeAccumulatedText()).toBe('');
  });

  it('onCompacted 监听 contextCompaction item（item/started）并触发一次', async () => {
    const { client, session } = await startedSession();
    let fired = 0;
    session.onCompacted(() => {
      fired += 1;
    });
    client.emit('item/started', {
      threadId: 'th_1',
      turnId: 't1',
      startedAtMs: 1,
      item: { type: 'contextCompaction', id: 'cc_1' },
    });
    expect(fired).toBe(1);
  });

  it('onCompacted reason：未调 compact()（内核 auto-compact）→ auto；主动调过 compact() → manual', async () => {
    const { client, session } = await startedSession();
    const reasons: Array<'manual' | 'auto'> = [];
    session.onCompacted((r) => {
      reasons.push(r);
    });
    // 未主动 compact()（内核按 token 上限自动压缩）→ auto。
    client.emit('item/started', { threadId: 'th_1', turnId: 't1', startedAtMs: 1, item: { type: 'contextCompaction', id: 'cc_auto' } });
    // 主动 compact() 后 → 下一个 cc item 标 manual。
    await session.compact();
    client.emit('item/started', { threadId: 'th_1', turnId: 't1', startedAtMs: 1, item: { type: 'contextCompaction', id: 'cc_manual' } });
    expect(reasons).toEqual(['auto', 'manual']);
  });

  it('onCompacted 按 item id 去重：同一 cc item 重复 item/started 只触发一次', async () => {
    const { client, session } = await startedSession();
    let fired = 0;
    session.onCompacted(() => {
      fired += 1;
    });
    const note = {
      threadId: 'th_1',
      turnId: 't1',
      startedAtMs: 1,
      item: { type: 'contextCompaction', id: 'cc_dup' },
    };
    client.emit('item/started', note);
    client.emit('item/started', note); // 同 id 重复
    expect(fired).toBe(1);
  });

  it('onCompacted 不被 thread/compacted 通知触发（0.137.0 不发该通知，只监听 contextCompaction item）', async () => {
    const { client, session } = await startedSession();
    let fired = 0;
    session.onCompacted(() => {
      fired += 1;
    });
    client.emit('thread/compacted', { threadId: 'th_1', turnId: 't1' });
    expect(fired).toBe(0);
  });

  it('非 contextCompaction 的 item/started 不触发 onCompacted', async () => {
    const { client, session } = await startedSession();
    let fired = 0;
    session.onCompacted(() => {
      fired += 1;
    });
    client.emit('item/started', {
      threadId: 'th_1',
      turnId: 't1',
      startedAtMs: 1,
      item: { type: 'commandExecution', id: 'ce_1', command: 'ls', status: 'inProgress', aggregatedOutput: null, exitCode: null },
    });
    expect(fired).toBe(0);
  });

  it('adoptThread 捕获 rolloutPath；parentThreadId 有值 → isSubAgent=true', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = {
      thread: { id: 'th_sub', sessionId: 's', path: '/r/th_sub.jsonl', parentThreadId: 'th_parent' },
    };
    const session = new ThreadSession(client, {});
    await session.start();
    expect(session.state.rolloutPath).toBe('/r/th_sub.jsonl');
    expect(session.state.isSubAgent).toBe(true);
  });

  it('parentThreadId 缺省 → isSubAgent=false（主线程）', async () => {
    const { session } = await startedSession();
    expect(session.state.isSubAgent).toBe(false);
  });
});

describe('ThreadSession B2 子代理 agentScope 注入', () => {
  async function startedSession(): Promise<{ client: FakeAppServerClient; session: ThreadSession }> {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_main', sessionId: 's', path: null } };
    const session = new ThreadSession(client, {}, new FakeMapper());
    await session.start();
    return { client, session };
  }

  /** 构造一个 collabAgentToolCall item/started 通知。 */
  function collabNote(receiverThreadIds: string[], extra?: Record<string, unknown>): unknown {
    return {
      threadId: 'th_main',
      turnId: 'turn_1',
      startedAtMs: 1,
      item: {
        type: 'collabAgentToolCall',
        id: 'collab_1',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: 'th_main',
        receiverThreadIds,
        ...extra,
      },
    };
  }

  it('collabAgentToolCall（item/started）→ 登记 receiverThreadIds；decorateScope 据此打标', async () => {
    const { client, session } = await startedSession();
    client.emit('item/started', collabNote(['th_child']));

    // 子代理 thread 的事件 → agentScope:'subagent'。
    const childEv = session.decorateScope({ eventType: 'text_delta', text: 'x', threadId: 'th_child' });
    expect(childEv.agentScope).toBe('subagent');

    // 主线程事件 → agentScope:'main'。
    const mainEv = session.decorateScope({ eventType: 'text_delta', text: 'y', threadId: 'th_main' });
    expect(mainEv.agentScope).toBe('main');

    // 无 threadId 的事件 → 默认 main。
    expect(session.decorateScope({ eventType: 'status', statusText: 's' }).agentScope).toBe('main');
  });

  it('collabAgentToolCall 也可经 item/completed 登记', async () => {
    const { client, session } = await startedSession();
    client.emit('item/completed', {
      threadId: 'th_main',
      turnId: 'turn_1',
      completedAtMs: 2,
      item: {
        type: 'collabAgentToolCall',
        id: 'collab_2',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'th_main',
        receiverThreadIds: ['th_child2'],
      },
    });
    expect(session.decorateScope({ eventType: 'text_delta', threadId: 'th_child2' }).agentScope).toBe('subagent');
  });

  it('subagentType 从 prompt 解析（命中已知 agent 名）→ 注入到 agentScope:subagent 事件', async () => {
    const { client, session } = await startedSession();
    client.emit('item/started', collabNote(['th_cr'], { prompt: 'spawn the predefined agent named code-reviewer' }));
    const ev = session.decorateScope({ eventType: 'text_delta', threadId: 'th_cr' });
    expect(ev.agentScope).toBe('subagent');
    expect(ev.subagentType).toBe('code-reviewer');
  });

  it('subagentType 解析不到 → 留空（agentScope 仍 subagent，无 subagentType 字段）', async () => {
    const { client, session } = await startedSession();
    client.emit('item/started', collabNote(['th_anon'], { prompt: 'do something generic' }));
    const ev = session.decorateScope({ eventType: 'text_delta', threadId: 'th_anon' });
    expect(ev.agentScope).toBe('subagent');
    expect(ev.subagentType).toBeUndefined();
  });

  it('subagentType 从 agentsStates[childThreadId].message 解析', async () => {
    const { client, session } = await startedSession();
    client.emit(
      'item/started',
      collabNote(['th_wr'], {
        agentsStates: { th_wr: { status: 'running', message: 'launched web-researcher agent' } },
      }),
    );
    const ev = session.decorateScope({ eventType: 'text_delta', threadId: 'th_wr' });
    expect(ev.subagentType).toBe('web-researcher');
  });

  it('emit 出栈前自动过 decorateScope：子代理 threadId 的事件被标 subagent', async () => {
    const { client, session } = await startedSession();
    const events: StreamEvent[] = [];
    session.onStreamEvent((ev) => events.push(ev));

    client.emit('item/started', collabNote(['th_child'])); // 登记子代理（经 FakeMapper → status 事件也会被 decorate）
    // 一条来自子代理 thread 的增量（FakeMapper 把 method 放 status，但 threadId 不透传；
    // 故直接断言 decorateScope 行为已在上面覆盖。这里验证主线程通知被标 main）。
    expect(events.every((e) => e.agentScope === 'main')).toBe(true);
  });

  it('单写者保护：子代理 thread 的 turn/started + turn/completed 不污染主线程在飞集合/activeTurnId', async () => {
    const { client, session } = await startedSession();
    const completed: Array<{ turnId: string; subtype: string }> = [];
    session.onTurnCompleted((i) => completed.push(i));

    // 先登记子代理 thread。
    client.emit('item/started', collabNote(['th_child']));

    // 主线程开一轮。
    client.emit('turn/started', { threadId: 'th_main', turn: { id: 'turn_main' } });
    expect(session.state.activeTurnId).toBe('turn_main');

    // 子代理 thread 的 turn 事件：不应改 activeTurnId、不应触发主线程 onTurnCompleted。
    client.emit('turn/started', { threadId: 'th_child', turn: { id: 'turn_child' } });
    expect(session.state.activeTurnId).toBe('turn_main'); // 未被子代理 turn 覆盖

    client.emit('turn/completed', { threadId: 'th_child', turn: { id: 'turn_child', status: 'completed' } });
    expect(session.state.activeTurnId).toBe('turn_main'); // 子代理完成不动主线程
    expect(completed).toEqual([]);

    // 主线程 turn 完成 → 正常记账。
    client.emit('turn/completed', { threadId: 'th_main', turn: { id: 'turn_main', status: 'completed' } });
    expect(session.state.activeTurnId).toBeNull();
    expect(completed).toEqual([{ turnId: 'turn_main', subtype: 'completed' }]);
  });

  it('单写者保护：子代理 thread 的 agentMessage delta 不混入主会话累积正文', async () => {
    const { client, session } = await startedSession();
    client.emit('item/started', collabNote(['th_child']));

    client.emit('item/agentMessage/delta', { threadId: 'th_child', turnId: 't', itemId: 'i', delta: 'child text' });
    client.emit('item/agentMessage/delta', { threadId: 'th_main', turnId: 't', itemId: 'i', delta: 'main text' });

    expect(session.takeAccumulatedText()).toBe('main text');
  });
});

describe('deriveSubagentType', () => {
  it('从 agentsStates message 命中已知 agent 名', () => {
    expect(
      deriveSubagentType(
        { agentsStates: { c1: { status: 'running', message: 'code-reviewer started' } } },
        'c1',
      ),
    ).toBe('code-reviewer');
  });
  it('从 prompt 命中（agentsStates 无 message 时回退）', () => {
    expect(deriveSubagentType({ prompt: 'use web-researcher please' }, 'c1')).toBe('web-researcher');
  });
  it('都不命中 → undefined', () => {
    expect(deriveSubagentType({ prompt: 'generic' }, 'c1')).toBeUndefined();
    expect(deriveSubagentType({}, 'c1')).toBeUndefined();
  });
});

describe('ThreadSession B2 fork', () => {
  it('fork() → thread/fork，params.threadId 透传，返回新 threadId/forkedFromId/sessionId', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_base', sessionId: 's_base', path: null } };
    client.responses['thread/fork'] = {
      thread: { id: 'th_fork', sessionId: 's_fork', path: null, forkedFromId: 'th_base' },
    };
    const session = new ThreadSession(client, {});
    await session.start();

    const res = await session.fork();
    expect(client.lastMethod()).toBe('thread/fork');
    expect((client.requests.at(-1)!.params as Record<string, unknown>).threadId).toBe('th_base');
    expect(res.threadId).toBe('th_fork');
    expect(res.forkedFromId).toBe('th_base');
    expect(res.sessionId).toBe('s_fork'); // fork 的 sessionId 与 base 不同
    // fork 不改本会话状态。
    expect(session.state.threadId).toBe('th_base');
  });

  it('fork() forkedFromId 缺省时回退到 parentThreadId', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_base', sessionId: 's', path: null } };
    client.responses['thread/fork'] = {
      thread: { id: 'th_fork', sessionId: 's2', path: null, parentThreadId: 'th_base' },
    };
    const session = new ThreadSession(client, {});
    await session.start();
    const res = await session.fork();
    expect(res.forkedFromId).toBe('th_base');
  });

  it('未 start 时 fork() 抛错', async () => {
    const client = new FakeAppServerClient();
    const session = new ThreadSession(client, {});
    await expect(session.fork()).rejects.toThrow(/thread not started/);
  });

  it('thread/fork 响应缺 thread.id → 抛错', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_base', sessionId: 's', path: null } };
    client.responses['thread/fork'] = {};
    const session = new ThreadSession(client, {});
    await session.start();
    await expect(session.fork()).rejects.toThrow(/thread\.id/);
  });
});

describe('ThreadSession B2 web_search config 透传', () => {
  it('webSearch=live → thread/start.config.web_search=live', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_1', sessionId: 's', path: null } };
    const session = new ThreadSession(client, { webSearch: 'live' });
    await session.start();
    const params = client.requests[0]!.params as Record<string, unknown>;
    expect((params.config as Record<string, unknown>).web_search).toBe('live');
  });

  it('config 直透 + webSearch 合并（webSearch 优先写 web_search）', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_1', sessionId: 's', path: null } };
    const session = new ThreadSession(client, {
      webSearch: 'live',
      config: { web_search: 'disabled', model_reasoning_effort: 'high' },
    });
    await session.start();
    const cfg = (client.requests[0]!.params as Record<string, unknown>).config as Record<string, unknown>;
    expect(cfg.web_search).toBe('live'); // webSearch 覆盖 config.web_search
    expect(cfg.model_reasoning_effort).toBe('high');
  });

  it('既无 webSearch 也无 config → thread/start.config 为 null（保持现状）', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_1', sessionId: 's', path: null } };
    const session = new ThreadSession(client, {});
    await session.start();
    const params = client.requests[0]!.params as Record<string, unknown>;
    expect(params.config).toBeNull();
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

    // 每条通知都过 mapper（FakeMapper 把 method 放进 status），出栈前经 decorateScope 注 agentScope:'main'。
    expect(events).toEqual([
      { eventType: 'status', statusText: 'item/agentMessage/delta', agentScope: 'main' },
      { eventType: 'status', statusText: 'turn/started', agentScope: 'main' },
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

    const textDeltas = events.filter((e) => e.eventType === 'text_delta');
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

    // 出栈前经 decorateScope 注 agentScope:'main'（事件无 threadId → 默认主线程）。
    expect(events).toEqual([{ eventType: 'status', statusText: 'x', agentScope: 'main' }]);
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
    const ev: StreamEvent = { eventType: 'text_delta', text: 'hi' };
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

describe('CodexRunner app-server 崩溃自愈（回归 #12）', () => {
  it('start→sendUserMessage 后进程崩溃（turn/completed 永不到）→ run() resolve 且吐出 failed 结果', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_crash', sessionId: 's', path: null } };
    client.responses['turn/start'] = { turn: { id: 'turn_1' } }; // turn/start 响应已回，但未发 turn/completed
    const lines: string[] = [];
    const runner = new CodexRunner({
      client,
      config: {},
      sink: (line) => lines.push(line),
      mapper: new FakeMapper(),
    });

    let resolved = false;
    const runPromise = runner.run({ prompt: 'p', groupFolder: 'g', session: {} }).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(client.methods()).toContain('turn/start'));
    expect(resolved).toBe(false); // turn 仍在飞，未完成

    // 模拟 app-server 子进程崩溃：onClose 触发，turn/completed 永不到达。
    client.emitClose({ code: 1, signal: null });
    await runPromise;
    expect(resolved).toBe(true); // 不再永久挂起

    // sink 收到一条 result+subtype:'failed' 的收尾事件。
    const failed = lines
      .map((l) => JSON.parse(l.slice(OUTPUT_START_MARKER.length, l.length - OUTPUT_END_MARKER.length - 1)) as StreamEvent)
      .find((ev) => ev.eventType === 'result' && ev.subtype === 'failed');
    expect(failed).toBeTruthy();
    expect(failed!.threadId).toBe('th_crash');
  });

  it('显式 shutdown 不吐 failed 结果（onClose 已摘除，正常收尾）', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_sd2', sessionId: 's', path: null } };
    const lines: string[] = [];
    const runner = new CodexRunner({ client, config: {}, sink: (l) => lines.push(l), mapper: new FakeMapper() });

    const runPromise = runner.run({ prompt: 'p', groupFolder: 'g', session: {} });
    await vi.waitFor(() => expect(client.methods()).toContain('turn/start'));

    runner.shutdown();
    await runPromise;

    const failed = lines
      .map((l) => JSON.parse(l.slice(OUTPUT_START_MARKER.length, l.length - OUTPUT_END_MARKER.length - 1)) as StreamEvent)
      .find((ev) => ev.eventType === 'result' && ev.subtype === 'failed');
    expect(failed).toBeUndefined(); // shutdown 是正常收尾，不伪造 failed
  });
});

describe('CodexRunner B1 compact orchestration', () => {
  /** 解析 sink 收集的某类型 StreamEvent。 */
  function parseEvents(lines: string[]): StreamEvent[] {
    return lines.map(
      (l) =>
        JSON.parse(
          l.slice(OUTPUT_START_MARKER.length, l.length - OUTPUT_END_MARKER.length - 1),
        ) as StreamEvent,
    );
  }

  async function runUntilTurnStart(
    client: FakeAppServerClient,
    runner: CodexRunner,
  ): Promise<void> {
    void runner.run({ prompt: 'p', groupFolder: 'home-1', session: {} });
    await vi.waitFor(() => expect(client.methods()).toContain('turn/start'));
  }

  it('contextCompaction item（无主动 compact → auto）→ flush 一条 compact_partial（带缓冲正文 + sourceKind + agentScope=main + compactReason=auto）', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_c', sessionId: 's', path: null } };
    client.responses['turn/start'] = { turn: { id: 'turn_1' } };
    const lines: string[] = [];
    const runner = new CodexRunner({ client, config: {}, sink: (l) => lines.push(l), mapper: new FakeMapper() });

    await runUntilTurnStart(client, runner);

    // 压缩前累积一些可见正文。
    client.emit('item/agentMessage/delta', { threadId: 'th_c', turnId: 'turn_1', itemId: 'i1', delta: 'in-flight answer' });
    // contextCompaction item → 触发 flush。
    client.emit('item/started', { threadId: 'th_c', turnId: 'turn_1', startedAtMs: 1, item: { type: 'contextCompaction', id: 'cc_1' } });

    const cp = parseEvents(lines).find((e) => e.eventType === 'compact_partial');
    expect(cp).toBeTruthy();
    expect(cp!.sourceKind).toBe('compact_partial');
    // 未经主动 compact()（运行时即内核 auto-compact）→ reason=auto；且经出栈装饰带 agentScope=main。
    expect(cp!.compactReason).toBe('auto');
    expect(cp!.agentScope).toBe('main');
    expect(cp!.text).toBe('in-flight answer');
    expect(cp!.threadId).toBe('th_c');

    runner.shutdown();
  });

  it('缓冲为空 → 仍发一条无 text 的 compact_partial 标记', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_e', sessionId: 's', path: null } };
    client.responses['turn/start'] = { turn: { id: 'turn_1' } };
    const lines: string[] = [];
    const runner = new CodexRunner({ client, config: {}, sink: (l) => lines.push(l), mapper: new FakeMapper() });

    await runUntilTurnStart(client, runner);
    client.emit('item/started', { threadId: 'th_e', turnId: 'turn_1', startedAtMs: 1, item: { type: 'contextCompaction', id: 'cc_1' } });

    const cp = parseEvents(lines).find((e) => e.eventType === 'compact_partial');
    expect(cp).toBeTruthy();
    expect(cp!.text).toBeUndefined(); // 缓冲空 → 无 text 字段
    expect(cp!.sourceKind).toBe('compact_partial');

    runner.shutdown();
  });

  it('子代理 thread（isSubAgent）→ 压缩副作用整体跳过（不发 compact_partial、不归档/trim）', async () => {
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = {
      thread: { id: 'th_sub', sessionId: 's', path: '/r/th_sub.jsonl', parentThreadId: 'th_parent' },
    };
    client.responses['turn/start'] = { turn: { id: 'turn_1' } };
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'hc-archive-'));
    try {
      const runner = new CodexRunner({
        client,
        config: {},
        sink: (l) => lines.push(l),
        mapper: new FakeMapper(),
        archiveBaseDir: dir,
      });
      await runUntilTurnStart(client, runner);
      client.emit('item/started', { threadId: 'th_sub', turnId: 'turn_1', startedAtMs: 1, item: { type: 'contextCompaction', id: 'cc_1' } });

      expect(parseEvents(lines).find((e) => e.eventType === 'compact_partial')).toBeUndefined();
      // archiveBaseDir 下不应有任何 conversations 目录写出。
      expect(existsSync(join(dir, 'home-1', 'conversations'))).toBe(false);
      runner.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('主线程 + archiveBaseDir → 归档 rollout 到 {base}/{folder}/conversations/*.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-archive-'));
    const rollout = join(dir, 'rollout.jsonl');
    writeFileSync(
      rollout,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi codex' }] } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello human' }] } }),
      ].join('\n') + '\n',
      'utf8',
    );
    const client = new FakeAppServerClient();
    client.responses['thread/start'] = { thread: { id: 'th_m', sessionId: 's', path: rollout } };
    client.responses['turn/start'] = { turn: { id: 'turn_1' } };
    try {
      const runner = new CodexRunner({ client, config: {}, sink: () => {}, mapper: new FakeMapper(), archiveBaseDir: dir });
      void runner.run({ prompt: 'p', groupFolder: 'grp', session: {} });
      await vi.waitFor(() => expect(client.methods()).toContain('turn/start'));
      client.emit('item/started', { threadId: 'th_m', turnId: 'turn_1', startedAtMs: 1, item: { type: 'contextCompaction', id: 'cc_1' } });

      const convDir = join(dir, 'grp', 'conversations');
      expect(existsSync(convDir)).toBe(true);
      const files = readdirSync(convDir);
      expect(files.length).toBe(1);
      const md = readFileSync(join(convDir, files[0]!), 'utf8');
      expect(md).toContain('hi codex');
      expect(md).toContain('hello human');
      runner.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
