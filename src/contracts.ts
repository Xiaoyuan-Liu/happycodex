/**
 * 跨模块契约（冻结）。各实现模块（client / session / runner / poc）均针对本文件编程，
 * 以便并行实现时互不耦合。修改这里 = 改公共 API，需同步所有实现方。
 */

import type { DynamicToolSpec, InitializeResponse, RequestId } from './appserver/protocol.js';
import type { StreamEvent } from './shared/stream-event.js';

// ───────────────────────── AppServerClient ─────────────────────────

export interface AppServerClientOptions {
  /** codex 可执行文件，默认 'codex'。 */
  codexBin?: string;
  /** 透传给 `codex app-server` 的额外参数（默认 stdio 传输）。 */
  args?: string[];
  /** 进程环境覆盖；多租户隔离用 `CODEX_HOME` 指向 per-user 目录。 */
  env?: Record<string, string>;
  /** 工作目录（spawn cwd）。 */
  cwd?: string;
  /** 单条请求看门狗超时（毫秒），默认 60000ms；显式传 0 关闭超时（永不超时）。 */
  requestTimeoutMs?: number;
  /** 结构化日志回调（可选）。 */
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

/** server→client 请求（审批回环等）。handler 必须调用 respond 恰好一次。 */
export interface IncomingServerRequest {
  id: RequestId;
  method: string;
  params: unknown;
}

export type ServerRequestHandler = (
  req: IncomingServerRequest,
  respond: (result: unknown) => void,
) => void;

export type ServerNotificationHandler = (method: string, params: unknown) => void;

/**
 * codex app-server 的 JSON-RPC over stdio 客户端。
 * 负责：spawn 进程、行分帧、id 关联、-32001 背压重试、通知/请求分发、优雅关闭。
 */
export interface IAppServerClient {
  /** spawn `codex app-server` 并完成 `initialize` + `initialized` 握手。 */
  start(): Promise<InitializeResponse>;

  /** 发送 JSON-RPC 请求并等待响应。遇 -32001 自动指数退避重试。 */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;

  /** 发送 JSON-RPC 通知（无响应）。 */
  notify(method: string, params?: unknown): void;

  /** 订阅 server→client 通知（流式事件）。返回取消订阅函数。 */
  onNotification(handler: ServerNotificationHandler): () => void;

  /** 订阅 server→client 请求（审批等）。返回取消订阅函数。 */
  onServerRequest(handler: ServerRequestHandler): () => void;

  /** 进程退出 / 致命错误回调。返回取消订阅函数（与 onNotification/onServerRequest 一致）。 */
  onClose(handler: (info: { code: number | null; signal: string | null; error?: Error }) => void): () => void;

  /** 优雅关闭子进程。 */
  close(): Promise<void>;
}

// ───────────────────────── StreamMapper ─────────────────────────

/**
 * 纯映射器：把单条 app-server 通知转成 0..N 个 StreamEvent。
 * 无副作用、无 I/O，便于单测。文本缓冲（200 字符刷新）由调用方/runner 负责，
 * 这里只做形状转换。
 */
export interface IStreamMapper {
  map(method: string, params: unknown): StreamEvent[];
}

// ───────────────────────── ThreadSession / CodexRunner ─────────────────────────

/**
 * A4：注入消息携带的图片附件（形状对齐主仓 ContainerInput.images / IPC input 文件的 images[]）。
 * data 为不带 data-URL 前缀的纯 base64；mimeType 缺省时由接收方按 magic bytes 检测兜底。
 */
export interface InjectedImage {
  data: string;
  mimeType?: string;
}

export interface ThreadSessionConfig {
  model?: string;
  cwd?: string;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  baseInstructions?: string;
  developerInstructions?: string;
  /** 既有 thread id（恢复续接）；提供则走 thread/resume，否则 thread/start。 */
  resumeThreadId?: string;
  /** Stage 3：注册给 codex 的 dynamicTools schema（在 thread/start 透传）。 */
  dynamicTools?: DynamicToolSpec[];
  /**
   * B2：网页搜索模式。透传进 thread/start.config.web_search（codex WebSearchMode）。
   * web-researcher 子代理依赖 'live'；缺省不设（用 codex 自身默认）。
   */
  webSearch?: 'disabled' | 'cached' | 'live';
  /**
   * B2：透传进 thread/start.config 的额外配置（snake_case 键，对齐 codex Config）。
   * 与 webSearch 合并：webSearch 优先写 config.web_search。
   */
  config?: Record<string, unknown>;
}

export interface ThreadSessionState {
  threadId: string | null;
  sessionId: string | null;
  /** 当前 active turn id（用于 turn/steer 的 expectedTurnId）；无活跃 turn 时为 null。 */
  activeTurnId: string | null;
  /** [UNSTABLE] rollout 文件磁盘路径（thread.path 兜底，可能 null）。B1 归档/trim 用。 */
  rolloutPath: string | null;
  /**
   * B1：本会话是否为子代理 thread（thread.parentThreadId != null）。子代理 compact 副作用应跳过，
   * 避免归档/trim 主 transcript 的无关副本（对齐 HappyClaw PreCompact 跳过 sub-agent 的逻辑）。
   */
  isSubAgent: boolean;
}

/**
 * 单个会话的 thread/turn 生命周期 + 注入循环。
 * - start()：thread/start 或 thread/resume，建立 threadId。
 * - sendUserMessage()：若有 active turn → turn/steer（运行中注入）；否则 turn/start（新轮）。
 * - interrupt()：turn/interrupt。
 * 内部订阅 client 通知维护 activeTurnId，并把通知交给 StreamMapper → 经 onStreamEvent 吐出。
 */
export interface IThreadSession {
  readonly state: ThreadSessionState;
  start(): Promise<void>;
  /** 发送一条用户消息（自动判定 turn/start vs turn/steer）。
   *  A4 契约扩展：可选 images 随同一 turn input 透传（base64 → data URL → UserInput type:'image'）。 */
  sendUserMessage(text: string, images?: InjectedImage[]): Promise<void>;
  interrupt(): Promise<void>;
  /** B1：主动触发上下文压缩（thread/compact/start）。响应为空对象、忽略。 */
  compact(): Promise<void>;
  /** B1：取出并清空本轮累积的可见正文（compact_partial flush 用）。 */
  takeAccumulatedText(): string;
  onStreamEvent(handler: (ev: StreamEvent) => void): () => void;
  /** 一轮开始回调。turnId 来自 turn/start 响应（同步）或 turn/started 通知，按 id 去重只触发一次。 */
  onTurnStarted(handler: (info: { turnId: string }) => void): () => void;
  /** 本轮结束（turn/completed）回调。仅对在飞行中的 turn 触发一次（忽略陈旧/重复完成）。 */
  onTurnCompleted(handler: (info: { turnId: string; subtype: string }) => void): () => void;
  /** B1：上下文压缩完成回调（key off contextCompaction item；同一 item id 去重只触发一次）。
   *  reason 区分主动 compact()（manual）与内核自动压缩（auto）。 */
  onCompacted(handler: (reason: 'manual' | 'auto') => void): () => void;
  /**
   * B2：分叉本会话 thread（thread/fork），上下文继承。返回新 thread.id + forkedFromId。
   * 注意：fork 出的 sessionId 与 base 不同（PoC 实测）。作为可选 review/分叉路径，不改本会话状态。
   */
  fork(): Promise<{ threadId: string; forkedFromId: string | null; sessionId: string | null }>;
}

/** CodexRunner 的初始输入（对齐 HappyClaw ContainerInput 的精简版）。 */
export interface CodexRunnerInput {
  prompt: string;
  /** A4：初始 prompt 携带的图片附件（主仓 ContainerInput.images）；随首个 turn input 透传给 codex。 */
  images?: InjectedImage[];
  groupFolder: string;
  session: ThreadSessionConfig;
  /**
   * 当前会话 chat JID（主仓 ContainerInput.chatJid）。
   * IPC 工具的路由来源：send_message 的 `chatJid`、schedule_task 的 `targetJid`
   * 都从这里取——缺失时这两个工具无法投递（bridge 抛错，模型得到诚实失败）。
   */
  chatJid?: string;
  /**
   * A4：触发本 run 的最新消息的 IM source JID（主仓 ContainerInput.currentSourceJid）。
   * per-channel 工具（discord_*）以 `currentSourceJid || chatJid` 作为初始当前聊天标识
   * （对齐上游 agent-runner mcpToolsConfig.chatJid 初始化）。
   */
  currentSourceJid?: string;
  /** A4：调用方是否 admin 主容器（主仓 ContainerInput.isAdminHome）；list_tasks IPC 请求据此 stamp。 */
  isAdminHome?: boolean;
  /** 定时任务运行标记（主仓 ContainerInput.isScheduledTask）；send_message IPC 据此 stamp。 */
  isScheduledTask?: boolean;
  /** 触发本轮的定时任务 id（主仓 ContainerInput.messageTaskId）；send_message IPC 据此 stamp taskId。 */
  messageTaskId?: string;
}

/**
 * agent-runner 等价物：消费初始输入 + IPC 注入源，驱动 ThreadSession，
 * 把 StreamEvent 以 OUTPUT_MARKER 包裹写到 sink（默认 stdout）。
 */
export interface ICodexRunner {
  run(input: CodexRunnerInput): Promise<void>;
  /** 注入后续用户消息（来自 IPC / 队列）。
   *  A4 契约扩展：可选 images（IPC input 文件的 images[]）随消息透传到 session turn input。 */
  inject(text: string, images?: InjectedImage[]): void;
  /** 请求优雅关闭（对应 HappyClaw 的 _close sentinel）。 */
  shutdown(): void;
}
