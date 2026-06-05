/**
 * ThreadSession —— 单个会话的 thread/turn 生命周期 + 注入循环（实现 IThreadSession）。
 *
 * 职责：
 * - 订阅 client.onNotification，按通知维护 ThreadSessionState（threadId / sessionId /
 *   rolloutPath / activeTurnId）以及内部在飞 turn 集合 inFlightTurns。
 * - start()：resumeThreadId 有值 → thread/resume，否则 thread/start；从响应 thread 兜底取
 *   id/sessionId/path（thread/started 通知可能也会带相同信息）。
 * - sendUserMessage()：有 active turn → turn/steer（运行中注入），否则 turn/start（新一轮）。
 * - interrupt()：turn/interrupt。
 * - 每条通知经 mapper.map(method, params) → 逐个 onStreamEvent 吐出。
 *
 * 关键时序设计（修正历史竞态）：
 * - turn/start 与 turn/steer 的**响应同步带回 turn id**（TurnStartResponse.turn.id /
 *   TurnSteerResponse.turnId）。因此 sendUserMessage 在请求 resolve 时即用响应里的 id 注册 turn
 *   （registerTurnStart），**不依赖异步的 turn/started 通知**。这保证 `await sendUserMessage()`
 *   返回后 activeTurnId 已就绪，连续两次发送能正确走 steer，且下游（CodexRunner）能在请求 resolve
 *   前就把该 turn 计入在飞集合。turn/started 通知到达时按 id 去重（registerTurnStart 幂等）。
 * - turn/completed 只对 inFlightTurns 中的 id 触发一次 onTurnCompleted（忽略陈旧/重复完成）。
 * - turn/steer 被服务端拒绝（expectedTurnId 失配 / turn 已结束）时，不静默丢弃：先把陈旧 turn
 *   reconcile 掉（completeTurn），再回退为 turn/start 开新一轮，确保注入消息不丢。
 */

import type {
  IAppServerClient,
  IStreamMapper,
  IThreadSession,
  ThreadSessionConfig,
  ThreadSessionState,
} from '../contracts.js';
import type { StreamEvent } from '../shared/stream-event.js';
import {
  Method,
  ServerNotif,
  textInput,
  type Thread,
  type ThreadResumeParams,
  type ThreadStartParams,
  type TurnCompletedNotification,
  type TurnStartParams,
  type TurnStartResponse,
  type TurnStartedNotification,
  type TurnSteerParams,
  type TurnSteerResponse,
  type TurnInterruptParams,
} from '../appserver/protocol.js';
import { StreamMapper } from './stream-mapper.js';

type StreamEventHandler = (ev: StreamEvent) => void;
type TurnStartedHandler = (info: { turnId: string }) => void;
type TurnCompletedHandler = (info: { turnId: string; subtype: string }) => void;

/** thread/start 与 thread/resume 响应的公共形状（只取我们关心的 thread 字段）。 */
interface ThreadEnvelopeResponse {
  thread?: Thread | null;
}

export class ThreadSession implements IThreadSession {
  private readonly client: IAppServerClient;
  private readonly config: ThreadSessionConfig;
  private readonly mapper: IStreamMapper;

  private readonly _state: ThreadSessionState = {
    threadId: null,
    sessionId: null,
    activeTurnId: null,
    rolloutPath: null,
  };

  /** 在飞 turn 集合（server 已开、尚未 completed）。activeTurnId 为其中最近一个。 */
  private readonly inFlightTurns = new Set<string>();

  private readonly streamHandlers = new Set<StreamEventHandler>();
  private readonly turnStartedHandlers = new Set<TurnStartedHandler>();
  private readonly turnCompletedHandlers = new Set<TurnCompletedHandler>();
  private readonly unsubscribeNotification: () => void;

  constructor(client: IAppServerClient, config: ThreadSessionConfig, mapper?: IStreamMapper) {
    this.client = client;
    this.config = config;
    this.mapper = mapper ?? new StreamMapper();
    this.unsubscribeNotification = this.client.onNotification((method, params) => {
      this.handleNotification(method, params);
    });
  }

  get state(): ThreadSessionState {
    return this._state;
  }

  async start(): Promise<void> {
    if (this.config.resumeThreadId) {
      const params: ThreadResumeParams = { threadId: this.config.resumeThreadId };
      const res = await this.client.request<ThreadEnvelopeResponse>(Method.threadResume, params);
      this.adoptThread(res?.thread);
      return;
    }

    const params: ThreadStartParams = {
      model: this.config.model ?? null,
      cwd: this.config.cwd ?? null,
      approvalPolicy: this.config.approvalPolicy ?? null,
      sandbox: this.config.sandbox ?? null,
      baseInstructions: this.config.baseInstructions ?? null,
      developerInstructions: this.config.developerInstructions ?? null,
    };
    const res = await this.client.request<ThreadEnvelopeResponse>(Method.threadStart, params);
    this.adoptThread(res?.thread);
  }

  async sendUserMessage(text: string): Promise<void> {
    const threadId = this._state.threadId;
    if (!threadId) {
      throw new Error('ThreadSession.sendUserMessage: thread not started (call start() first)');
    }

    const activeTurnId = this._state.activeTurnId;
    if (activeTurnId) {
      const params: TurnSteerParams = {
        threadId,
        input: [textInput(text)],
        expectedTurnId: activeTurnId,
      };
      try {
        await this.client.request<TurnSteerResponse>(Method.turnSteer, params);
        return;
      } catch {
        // steer 被拒（turn 已结束 / expectedTurnId 失配）：把陈旧 turn reconcile 掉，
        // 然后回退为 turn/start 开新一轮，避免注入消息静默丢失。
        this.completeTurn(activeTurnId, 'interrupted');
      }
    }

    const params: TurnStartParams = {
      threadId,
      input: [textInput(text)],
    };
    const res = await this.client.request<TurnStartResponse>(Method.turnStart, params);
    // 同步用响应里的 turn id 注册，不等 turn/started 通知。
    this.registerTurnStart(res?.turn?.id);
  }

  async interrupt(): Promise<void> {
    const threadId = this._state.threadId;
    if (!threadId) {
      throw new Error('ThreadSession.interrupt: thread not started (call start() first)');
    }
    const params: TurnInterruptParams = { threadId };
    await this.client.request(Method.turnInterrupt, params);
  }

  onStreamEvent(handler: StreamEventHandler): () => void {
    this.streamHandlers.add(handler);
    return () => {
      this.streamHandlers.delete(handler);
    };
  }

  onTurnStarted(handler: TurnStartedHandler): () => void {
    this.turnStartedHandlers.add(handler);
    return () => {
      this.turnStartedHandlers.delete(handler);
    };
  }

  onTurnCompleted(handler: TurnCompletedHandler): () => void {
    this.turnCompletedHandlers.add(handler);
    return () => {
      this.turnCompletedHandlers.delete(handler);
    };
  }

  /** 释放对 client 通知的订阅（CodexRunner.shutdown 后调用，避免泄漏）。 */
  dispose(): void {
    this.unsubscribeNotification();
    this.streamHandlers.clear();
    this.turnStartedHandlers.clear();
    this.turnCompletedHandlers.clear();
  }

  // ───────────────────────── 内部 ─────────────────────────

  private handleNotification(method: string, params: unknown): void {
    // 1) 先更新生命周期状态（threadId / 在飞 turn）。
    switch (method) {
      case ServerNotif.threadStarted: {
        const p = params as { thread?: Thread } | undefined;
        this.adoptThread(p?.thread);
        break;
      }
      case ServerNotif.turnStarted: {
        const p = params as TurnStartedNotification | undefined;
        this.registerTurnStart(p?.turn?.id);
        break;
      }
      case ServerNotif.turnCompleted: {
        const p = params as TurnCompletedNotification | undefined;
        this.completeTurn(p?.turn?.id, deriveTurnSubtype(p?.turn?.status));
        break;
      }
      default:
        break;
    }

    // 2) 再把通知交给 mapper → 逐个 onStreamEvent 吐出。
    const events = this.mapper.map(method, params);
    for (const ev of events) {
      this.emitStreamEvent(ev);
    }
  }

  /** 注册一个新开的 turn（按 id 幂等）。来源：turn/start 响应（同步）或 turn/started 通知。 */
  private registerTurnStart(turnId: string | undefined | null): void {
    if (!turnId) return;
    if (this.inFlightTurns.has(turnId)) return;
    this.inFlightTurns.add(turnId);
    this._state.activeTurnId = turnId;
    for (const handler of this.turnStartedHandlers) {
      handler({ turnId });
    }
  }

  /** 结束一个 turn（仅对在飞集合中的 id 生效一次，忽略陈旧/重复完成）。 */
  private completeTurn(turnId: string | undefined | null, subtype: string): void {
    if (!turnId) return;
    if (!this.inFlightTurns.has(turnId)) return;
    this.inFlightTurns.delete(turnId);
    if (this._state.activeTurnId === turnId) {
      // 回退到剩余最近一个在飞 turn（正常只有 0 或 1 个）。
      let next: string | null = null;
      for (const id of this.inFlightTurns) next = id;
      this._state.activeTurnId = next;
    }
    for (const handler of this.turnCompletedHandlers) {
      handler({ turnId, subtype });
    }
  }

  /** 从 thread/start | thread/resume 响应或 thread/started 通知吸收 thread 标识（兜底，不覆盖已有值）。 */
  private adoptThread(thread: Thread | null | undefined): void {
    if (!thread) return;
    if (thread.id) this._state.threadId = thread.id;
    if (thread.sessionId) this._state.sessionId = thread.sessionId;
    if (thread.path != null) this._state.rolloutPath = thread.path;
  }

  private emitStreamEvent(ev: StreamEvent): void {
    for (const handler of this.streamHandlers) {
      handler(ev);
    }
  }
}

/**
 * 从 Turn.status 推断 turn/completed 的 subtype。
 * TurnStatus = "completed" | "interrupted" | "failed" | "inProgress"。
 * 缺省（未带 status）按 'completed' 处理；'inProgress' 不应出现在 turn/completed，保守归为 'completed'。
 */
export function deriveTurnSubtype(status: string | undefined | null): string {
  switch (status) {
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'failed';
    case 'completed':
    case 'inProgress':
    case undefined:
    case null:
      return 'completed';
    default:
      return status;
  }
}
