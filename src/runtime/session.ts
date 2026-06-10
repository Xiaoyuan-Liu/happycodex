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
  InjectedImage,
  IStreamMapper,
  IThreadSession,
  ThreadSessionConfig,
  ThreadSessionState,
} from '../contracts.js';
import type { StreamEvent } from '../shared/stream-event.js';
import { RpcError } from '../appserver/client.js';
import {
  ERR_SERVER_OVERLOADED,
  Method,
  ServerNotif,
  textInput,
  type AgentMessageDeltaNotification,
  type CollabAgentState,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type Thread,
  type ThreadCompactStartParams,
  type ThreadForkParams,
  type ThreadForkResponse,
  type ThreadItem,
  type ThreadResumeParams,
  type ThreadStartParams,
  type TurnCompletedNotification,
  type TurnStartParams,
  type TurnStartResponse,
  type TurnStartedNotification,
  type TurnSteerParams,
  type TurnSteerResponse,
  type TurnInterruptParams,
  type UserInput,
} from '../appserver/protocol.js';
import { detectImageMimeTypeFromBase64Strict } from '../image-detector.js';
import { StreamMapper } from './stream-mapper.js';

type StreamEventHandler = (ev: StreamEvent) => void;
type TurnStartedHandler = (info: { turnId: string }) => void;
type TurnCompletedHandler = (info: { turnId: string; subtype: string }) => void;
type CompactedHandler = (reason: 'manual' | 'auto') => void;

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
    isSubAgent: false,
  };

  /** B1：本轮可见正文累积（agentMessage delta 累加，turnCompleted 清空）。绝不进 mapper。 */
  private accumText = '';

  /**
   * B2：已登记的子代理 thread（receiverThreadId → 元数据）。来源：collabAgentToolCall item 的
   * receiverThreadIds。decorateScope 据此把事件标 agentScope='subagent'（+subagentType）。
   * 【agentScope 注入只在 session 层，绝不进 mapper】
   */
  private readonly childThreads = new Map<string, { subagentType?: string }>();

  /** 在飞 turn 集合（server 已开、尚未 completed）。activeTurnId 为其中最近一个。 */
  private readonly inFlightTurns = new Set<string>();

  private readonly streamHandlers = new Set<StreamEventHandler>();
  private readonly turnStartedHandlers = new Set<TurnStartedHandler>();
  private readonly turnCompletedHandlers = new Set<TurnCompletedHandler>();
  private readonly compactedHandlers = new Set<CompactedHandler>();
  /** 已触发过 onCompacted 的 contextCompaction item id 集合（按 id 去重，避免 started 重复触发）。 */
  private readonly compactedItemIds = new Set<string>();
  /** 本会话是否刚主动调过 compact()：用于区分 contextCompaction item 是 manual 还是内核 auto-compact。 */
  private pendingManualCompact = false;
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
      const params: ThreadResumeParams = {
        threadId: this.config.resumeThreadId,
        // 会话动态上下文（context-resolver 每次会话重新生成）在 resume 时也要刷新：
        // ThreadResumeParams 支持配置覆盖；不传则沿用 thread/start 时的陈旧值。
        ...(this.config.developerInstructions !== undefined
          ? { developerInstructions: this.config.developerInstructions }
          : {}),
      };
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
      dynamicTools: this.config.dynamicTools ?? null,
      config: this.buildStartConfig(),
    };
    const res = await this.client.request<ThreadEnvelopeResponse>(Method.threadStart, params);
    this.adoptThread(res?.thread);
  }

  /**
   * B2：构造 thread/start.config（snake_case，对齐 codex Config）。
   * 合并 config.webSearch（→ web_search，web-researcher 子代理依赖 'live'）与 config.config 直透。
   * 两者都缺省时返回 null（保持现状：不带 config 字段）。webSearch 优先于 config.web_search。
   */
  private buildStartConfig(): Record<string, unknown> | null {
    const base = this.config.config;
    const webSearch = this.config.webSearch;
    if (!base && !webSearch) return null;
    const merged: Record<string, unknown> = { ...(base ?? {}) };
    if (webSearch) merged['web_search'] = webSearch;
    return merged;
  }

  async sendUserMessage(text: string, images?: InjectedImage[]): Promise<void> {
    const threadId = this._state.threadId;
    if (!threadId) {
      throw new Error('ThreadSession.sendUserMessage: thread not started (call start() first)');
    }
    const input = buildTurnInput(text, images);

    const activeTurnId = this._state.activeTurnId;
    if (activeTurnId) {
      const params: TurnSteerParams = {
        threadId,
        input,
        expectedTurnId: activeTurnId,
      };
      try {
        await this.client.request<TurnSteerResponse>(Method.turnSteer, params);
        return;
      } catch (err) {
        // 仅"服务端语义拒绝"（expectedTurnId 失配 / turn 已结束）才 reconcile 旧 turn 并回退
        // turn/start 开新一轮，避免注入消息静默丢失。
        // 传输类失败（-32001 重试耗尽 / 连接关闭 / 超时 / stdin 不可写 / 进程退出）服务端那个
        // turn 可能仍在跑：不能伪造 turn 完成、不能动 inFlightTurns/activeTurnId、不能再开第二个
        // turn（违反单写者），原样透传给调用方。
        if (!isServerTurnEndedRejection(err)) {
          throw err;
        }
        this.completeTurn(activeTurnId, 'interrupted');
      }
    }

    const params: TurnStartParams = {
      threadId,
      input,
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

  /**
   * B1：主动触发上下文压缩（thread/compact/start）。响应是空对象，忽略。
   * codex 0.137.0 只发 contextCompaction item（item/started），不发 thread/compacted 通知；
   * 真正的"压缩完成"信号通过 onCompacted 订阅（key off contextCompaction item）。
   */
  async compact(): Promise<void> {
    const threadId = this._state.threadId;
    if (!threadId) {
      throw new Error('ThreadSession.compact: thread not started (call start() first)');
    }
    const params: ThreadCompactStartParams = { threadId };
    // 标记本次压缩为主动触发；fireCompacted 据此把 compact_partial 标 manual（auto-compact 标 auto）。
    this.pendingManualCompact = true;
    await this.client.request(Method.threadCompactStart, params);
  }

  /** B1：取出并清空本轮累积的可见正文（compact_partial flush 用）。 */
  takeAccumulatedText(): string {
    const t = this.accumText;
    this.accumText = '';
    return t;
  }

  /**
   * B2：分叉本会话 thread（thread/fork），上下文继承。返回新 thread 标识。
   * 不改本会话状态（本会话仍指向 base thread）；调用方拿到新 threadId 后可另建 ThreadSession
   * （resumeThreadId）驱动分叉路径。PoC 实测：fork 出的 sessionId 与 base 不同。
   */
  async fork(): Promise<{ threadId: string; forkedFromId: string | null; sessionId: string | null }> {
    const threadId = this._state.threadId;
    if (!threadId) {
      throw new Error('ThreadSession.fork: thread not started (call start() first)');
    }
    const params: ThreadForkParams = { threadId };
    const res = await this.client.request<ThreadForkResponse>(Method.threadFork, params);
    const thread = res?.thread;
    if (!thread?.id) {
      throw new Error('ThreadSession.fork: thread/fork 响应缺 thread.id');
    }
    return {
      threadId: thread.id,
      forkedFromId: thread.forkedFromId ?? thread.parentThreadId ?? null,
      sessionId: thread.sessionId ?? null,
    };
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

  /**
   * B1：上下文压缩完成回调。仅监听 contextCompaction item（item/started），
   * 不监听 thread/compacted（0.137.0 不发该通知）。同一 item id 只触发一次（去重）。
   */
  onCompacted(handler: CompactedHandler): () => void {
    this.compactedHandlers.add(handler);
    return () => {
      this.compactedHandlers.delete(handler);
    };
  }

  /** 释放对 client 通知的订阅（CodexRunner.shutdown 后调用，避免泄漏）。 */
  dispose(): void {
    this.unsubscribeNotification();
    this.streamHandlers.clear();
    this.turnStartedHandlers.clear();
    this.turnCompletedHandlers.clear();
    this.compactedHandlers.clear();
    this.compactedItemIds.clear();
    this.pendingManualCompact = false;
    this.childThreads.clear();
  }

  // ───────────────────────── 内部 ─────────────────────────

  private handleNotification(method: string, params: unknown): void {
    // 1) 先更新生命周期状态（threadId / 在飞 turn / B1 文本累积 + 压缩信号 / B2 子代理登记）。
    switch (method) {
      case ServerNotif.threadStarted: {
        const p = params as { thread?: Thread } | undefined;
        this.adoptThread(p?.thread);
        break;
      }
      case ServerNotif.turnStarted: {
        const p = params as TurnStartedNotification | undefined;
        // B2 单写者保护：只认主 threadId 的 turn。子代理 thread 的 turn 不参与主线程轮次记账，
        // 仅在出栈时由 decorateScope 打标（见 emitStreamEvent），避免污染单写者状态机。
        if (this.isMainThreadNotif(p?.threadId)) this.registerTurnStart(p?.turn?.id);
        break;
      }
      case ServerNotif.turnCompleted: {
        const p = params as TurnCompletedNotification | undefined;
        // B2 单写者保护：忽略子代理 thread 的 turn/completed（不动主线程在飞集合 / 累积正文）。
        if (this.isMainThreadNotif(p?.threadId)) {
          // B1：一轮结束 → 清空本轮累积正文（compact_partial 只 flush 压缩前未完成那轮的缓冲）。
          this.accumText = '';
          this.completeTurn(p?.turn?.id, deriveTurnSubtype(p?.turn?.status));
        }
        break;
      }
      case ServerNotif.agentMessageDelta: {
        // B1：累积本轮可见正文。【仅在 session 层，绝不进 mapper】
        // 仅累积主线程正文：子代理的 delta 不应混入主会话的 compact_partial flush。
        const p = params as AgentMessageDeltaNotification | undefined;
        if (p?.delta && this.isMainThreadNotif(p.threadId)) this.accumText += p.delta;
        break;
      }
      case ServerNotif.itemStarted: {
        const p = params as ItemStartedNotification | undefined;
        const item = p?.item;
        // B1：contextCompaction item → 压缩完成信号（0.137.0 不发 thread/compacted 通知）。
        if (item && item.type === 'contextCompaction') this.fireCompacted(item.id);
        // B2：collabAgentToolCall item → 登记子代理 receiverThreadIds。
        if (item) this.registerCollabAgents(item);
        break;
      }
      case ServerNotif.itemCompleted: {
        // B2：collabAgentToolCall 在 item/completed 才带齐 receiverThreadIds/agentsStates 时也登记。
        const p = params as ItemCompletedNotification | undefined;
        if (p?.item) this.registerCollabAgents(p.item);
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

  /** B1：触发一次 onCompacted（同一 contextCompaction item id 去重，避免重复编排归档/trim）。 */
  private fireCompacted(itemId: string): void {
    if (this.compactedItemIds.has(itemId)) return;
    this.compactedItemIds.add(itemId);
    // manual（本会话调过 compact()）vs auto（codex 内核按 token 上限自动压缩）：contextCompaction
    // item 形状相同、无 reason 字段，故由本地 pending 标志区分，读后即清。
    const reason: 'manual' | 'auto' = this.pendingManualCompact ? 'manual' : 'auto';
    this.pendingManualCompact = false;
    for (const handler of this.compactedHandlers) {
      handler(reason);
    }
  }

  /** 从 thread/start | thread/resume 响应或 thread/started 通知吸收 thread 标识（兜底，不覆盖已有值）。 */
  private adoptThread(thread: Thread | null | undefined): void {
    if (!thread) return;
    if (thread.id) this._state.threadId = thread.id;
    if (thread.sessionId) this._state.sessionId = thread.sessionId;
    if (thread.path != null) this._state.rolloutPath = thread.path;
    // B1：parentThreadId != null → 子代理 thread（compact 副作用跳过）。一旦判定为子代理则不回退，
    // 避免后续兜底 adoptThread 缺该字段时把已确认的子代理误判回主线程。
    if (thread.parentThreadId != null) this._state.isSubAgent = true;
  }

  /**
   * B2 单写者保护：通知是否属于主线程（本会话 thread）。
   * 主 threadId 尚未确立（启动早期）时，缺省按主线程处理——此时还没有子代理（子代理由本会话
   * spawn 后才出现），不会误判；threadId 缺省（通知未带）的也保守按主线程，避免漏记主线程 turn。
   */
  private isMainThreadNotif(threadId: string | null | undefined): boolean {
    const main = this._state.threadId;
    if (main == null) return true;
    if (threadId == null) return true;
    return threadId === main;
  }

  /**
   * B2：从 collabAgentToolCall item 登记/更新子代理 thread（receiverThreadIds）。
   * subagentType 尽量从 prompt / agentsStates message / agentRole 解析，解析不到留空。
   * 非 collabAgentToolCall item 直接忽略。已登记的 thread 仅在能补到 subagentType 时回填。
   */
  private registerCollabAgents(item: ThreadItem): void {
    if (item.type !== 'collabAgentToolCall') return;
    const receivers = item.receiverThreadIds;
    if (!Array.isArray(receivers)) return;
    for (const childThreadId of receivers) {
      if (typeof childThreadId !== 'string' || childThreadId === '') continue;
      const subagentType = deriveSubagentType(item, childThreadId);
      const existing = this.childThreads.get(childThreadId);
      if (existing) {
        // 仅补全：已有 subagentType 不被空值覆盖。
        if (!existing.subagentType && subagentType) existing.subagentType = subagentType;
      } else {
        this.childThreads.set(childThreadId, subagentType ? { subagentType } : {});
      }
    }
  }

  /**
   * B2：在事件出栈前注入 agentScope 维度。【agentScope 注入只在 session 层，不进 mapper】
   * ev.threadId ∈ childThreads → agentScope='subagent'(+subagentType)；否则 'main'。
   * threadId 缺省的事件（无 threadId 字段，如部分 status/result）默认归 'main'。
   */
  decorateScope(ev: StreamEvent): StreamEvent {
    const tid = ev.threadId;
    if (tid != null) {
      const child = this.childThreads.get(tid);
      if (child) {
        return { ...ev, agentScope: 'subagent', ...(child.subagentType ? { subagentType: child.subagentType } : {}) };
      }
    }
    return { ...ev, agentScope: 'main' };
  }

  private emitStreamEvent(ev: StreamEvent): void {
    const decorated = this.decorateScope(ev);
    for (const handler of this.streamHandlers) {
      handler(decorated);
    }
  }
}

/**
 * A4：把 text + 可选图片附件构造成 turn/start | turn/steer 的 input 数组。
 *
 * 图片走 UserInput 的 `{type:'image', url}` 变体（protocol/ts/v2/UserInput.ts），url 用
 * data URL（`data:<mime>;base64,<data>`）——codex 内核对 `localImage` 变体的处理就是读盘后
 * 转成同样的 data URL 再进模型 input，二者等价；data URL 形式免去临时文件落盘与清理。
 * mimeType 缺省时按 magic bytes 检测（detectImageMimeTypeFromBase64Strict），仍不可识别则
 * 兜底 image/png（与主进程 send_image 消费端的缺省一致）。
 * data 为空串的条目跳过（无内容可发，避免构造非法 data URL）。
 */
export function buildTurnInput(text: string, images?: InjectedImage[]): UserInput[] {
  const input: UserInput[] = [textInput(text)];
  if (!images) return input;
  for (const img of images) {
    if (typeof img?.data !== 'string' || img.data.length === 0) continue;
    const mime =
      (img.mimeType && img.mimeType.trim()) ||
      detectImageMimeTypeFromBase64Strict(img.data) ||
      'image/png';
    input.push({ type: 'image', url: `data:${mime};base64,${img.data}` });
  }
  return input;
}

/**
 * 判定 turn/steer 的 reject 是否属于"服务端语义性拒绝"（该 turn 确已结束 / expectedTurnId 失配）。
 *
 * 只有这一类才应触发 reconcile（completeTurn）+ 回退 turn/start。其余一律视为传输/瞬时失败：
 *   - 普通 Error（连接关闭 / 超时 / stdin 不可写 / 进程退出）→ 非 RpcError → false
 *   - -32001（ERR_SERVER_OVERLOADED）背压重试耗尽 → 是 RpcError 但服务端从未受理该 steer，
 *     原 turn 仍在跑 → false
 *   - 其它 JSON-RPC error code → 服务端已对该 steer 作出语义裁决（含失配/已结束）→ true
 */
export function isServerTurnEndedRejection(err: unknown): boolean {
  if (!(err instanceof RpcError)) return false;
  return err.code !== ERR_SERVER_OVERLOADED;
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

/**
 * B2：从 collabAgentToolCall item 推断某子代理 thread 的类型名（code-reviewer / web-researcher 等）。
 *
 * codex 不在 collabAgentToolCall 里给一个干净的 agent 类型字段；按可得信号尽力解析：
 *   1) agentsStates[childThreadId].message 里若引用了已知 agent 名（如 "code-reviewer"）→ 取之；
 *   2) prompt 里若提及 "agent named X" / 已知 agent 名 → 取之；
 * 解析不到返回 undefined（留空，不臆造）。
 */
export function deriveSubagentType(
  item: {
    prompt?: string | null;
    agentsStates?: { [k: string]: CollabAgentState | undefined } | null;
    [k: string]: unknown;
  },
  childThreadId: string,
): string | undefined {
  const state = item.agentsStates?.[childThreadId];
  const fromState = state && typeof state.message === 'string' ? state.message : undefined;
  const prompt = typeof item.prompt === 'string' ? item.prompt : undefined;
  const candidates = [fromState, prompt];
  for (const text of candidates) {
    const name = matchKnownAgentName(text);
    if (name) return name;
  }
  return undefined;
}

/** 已知预定义子代理名（与 multitenant/agent-defs.ts 的 TOML 名一致）。 */
const KNOWN_AGENT_NAMES = ['code-reviewer', 'web-researcher'] as const;

/** 在自由文本里匹配已知 agent 名（大小写不敏感，子串包含匹配）。命中返回规范名，否则 undefined。 */
function matchKnownAgentName(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  for (const name of KNOWN_AGENT_NAMES) {
    if (lower.includes(name)) return name;
  }
  return undefined;
}
