/**
 * codex app-server JSON-RPC 协议 —— 手工策展的子集。
 *
 * 单一真相源：`codex app-server generate-ts --experimental`（见 `protocol/ts/`），
 * 基线版本 **codex-cli 0.137.0**。本文件只收录 happycodex 实际用到的方法 / 通知 /
 * 参数形状，逐字对齐生成产物，避免编译时拉进 600+ 个生成文件。
 *
 * 升级 codex 后：`npm run protocol:regen` 重新生成 `protocol/`，再对照本文件 diff。
 *
 * ⚠️ 实验门控：`turn/steer`、`thread/start.dynamicTools` 等需要在 `initialize` 时声明
 *    `capabilities.experimentalApi = true`，否则方法不可见。
 */

// ───────────────────────── JSON-RPC 信封 ─────────────────────────
// 注意：codex app-server 的线上格式**省略** `"jsonrpc":"2.0"` 头（newline-delimited JSON）。

export type RequestId = number | string;

export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseOk {
  id: RequestId;
  result: unknown;
}

export interface JsonRpcResponseErr {
  id: RequestId;
  error: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

/** 收到的任意一行（请求 / 响应 / 通知），靠字段在运行时判别。 */
export type JsonRpcInbound =
  | JsonRpcRequest
  | JsonRpcResponseOk
  | JsonRpcResponseErr
  | JsonRpcNotification;

/** ingress 队列满时服务端返回该错误码，要求指数退避 + jitter 重试。 */
export const ERR_SERVER_OVERLOADED = -32001;

// ───────────────────────── 方法名常量（client→server 请求） ─────────────────────────
export const Method = {
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadFork: 'thread/fork',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  threadCompactStart: 'thread/compact/start',
} as const;

/** client→server 通知 */
export const ClientNotif = {
  initialized: 'initialized',
} as const;

// ───────────────────────── server→client 通知名常量（流式事件） ─────────────────────────
export const ServerNotif = {
  threadStarted: 'thread/started',
  threadClosed: 'thread/closed',
  threadStatusChanged: 'thread/status/changed',
  threadTokenUsageUpdated: 'thread/tokenUsage/updated',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  commandExecutionOutputDelta: 'item/commandExecution/outputDelta',
  /** B1：上下文压缩完成（DEPRECATED，见 ContextCompactedNotification 注释）。 */
  threadCompacted: 'thread/compacted',
  /** B3：Hook 开始执行。 */
  hookStarted: 'hook/started',
  /** B3：Hook 执行完成。 */
  hookCompleted: 'hook/completed',
} as const;

/** server→client 请求名常量（审批回环 + dynamicTools 调用；turn 会阻塞直到客户端回复）。 */
export const ServerReq = {
  commandExecutionRequestApproval: 'item/commandExecution/requestApproval',
  fileChangeRequestApproval: 'item/fileChange/requestApproval',
  permissionsRequestApproval: 'item/permissions/requestApproval',
  /** dynamicTools：模型调用客户端注册的自定义工具时，server 发来的请求。 */
  dynamicToolCall: 'item/tool/call',
} as const;

// ───────────────────────── 握手 ─────────────────────────
export interface ClientInfo {
  name: string;
  version: string;
  title?: string | null;
}

export interface InitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
  optOutNotificationMethods?: string[] | null;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ───────────────────────── thread / turn ─────────────────────────
export type AskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** UserInput 联合（turn/start 与 turn/steer 的 input 元素）。
 *  ⚠️ text 变体的 `text_elements` 字段是必填（生成类型为 `Array<TextElement>`，传 `[]` 即可）。*/
export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string; detail?: unknown }
  | { type: 'localImage'; path: string; detail?: unknown };

/** 便捷构造一条纯文本输入。 */
export function textInput(text: string): UserInput {
  return { type: 'text', text, text_elements: [] };
}

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  /** 实验：客户端代理执行的自定义工具 schema（对应 HappyClaw 的 12 个 MCP 工具，R3 路 A）。 */
  dynamicTools?: DynamicToolSpec[] | null;
  config?: Record<string, unknown> | null;
}

// ───────────────────────── dynamicTools（R3 路 A，experimental）─────────────────────────

/** 在 thread/start.dynamicTools 注册的工具 schema。 */
export interface DynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  /** 入参 JSON Schema（对象）。 */
  inputSchema: unknown;
  deferLoading?: boolean;
}

/** server→client 请求 item/tool/call 的 params：模型调用某 dynamic tool。 */
export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

/** dynamic tool 输出内容项（回填给模型）。 */
export type DynamicToolContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

/** item/tool/call 的响应：回填执行结果。 */
export interface DynamicToolCallResponse {
  contentItems: DynamicToolContentItem[];
  success: boolean;
}

/** 便捷构造一条纯文本工具结果。 */
export function toolTextResult(text: string, success = true): DynamicToolCallResponse {
  return { contentItems: [{ type: 'inputText', text }], success };
}

/** 子代理来源（对齐 protocol/ts/SubAgentSource.ts）。
 *  `thread_spawn` 携带父线程 / 深度 / agent 元数据；`review`/`compact` 为内置子代理流程。 */
export type SubAgentSource =
  | 'review'
  | 'compact'
  | 'memory_consolidation'
  | {
      thread_spawn: {
        parent_thread_id: string;
        depth: number;
        agent_path: string | null;
        agent_nickname: string | null;
        agent_role: string | null;
      };
    }
  | { other: string };

/** 线程来源（对齐 protocol/ts/v2/SessionSource.ts）。
 *  app-server 自身建的线程为 'appServer'；子代理走 { subAgent: SubAgentSource }。 */
export type SessionSource =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'unknown'
  | { custom: string }
  | { subAgent: SubAgentSource };

/** Thread 子集（完整见 protocol/ts/v2/Thread.ts）。 */
export interface Thread {
  id: string;
  /** 同一 session tree 共享的 session id（fork 子 thread 继承）。 */
  sessionId: string;
  /** [UNSTABLE] rollout 文件磁盘路径。 */
  path: string | null;
  /** 线程来源（可判别 union；对齐 SessionSource）。 */
  source: SessionSource;
  ephemeral: boolean;
  cwd: string;
  cliVersion: string;
  /** 子代理的父线程 id（仅子代理 thread 有值）。 */
  parentThreadId?: string | null;
  /** fork 时的源线程 id（仅 fork 出来的线程有值）。 */
  forkedFromId?: string | null;
  /** 子代理随机昵称（仅 AgentControl 派生子代理有值）。 */
  agentNickname?: string | null;
  /** 子代理角色 agent_role（仅 AgentControl 派生子代理有值）。 */
  agentRole?: string | null;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
}

/** Turn 子集（完整见 protocol/ts/v2/Turn.ts）。关键字段：id。 */
export interface Turn {
  id: string;
  threadId?: string;
  status?: string;
}

export interface TurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  outputSchema?: unknown | null;
}

export interface TurnSteerParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  /** 必填：当前 active turn id。与实际 active turn 不符则请求失败。 */
  expectedTurnId: string;
}

/** turn/start 响应 —— **同步**带回新 turn（含 turn.id），无需等 turn/started 通知。 */
export interface TurnStartResponse {
  turn: Turn;
}

/** turn/steer 响应 —— 带回被注入的 turn id。 */
export interface TurnSteerResponse {
  turnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
}

export interface ThreadResumeParams {
  /** 必填（对齐真实 codex 0.137.0；生成产物 ThreadResumeParams.threadId 为 string，非可选）。 */
  threadId: string;
  /** [UNSTABLE] 直接按 rollout 路径恢复；非运行线程 path 优先于 threadId。 */
  path?: string;
}

/** thread/fork 参数子集（B2 子代理 fork 包装；完整见 protocol/ts/v2/ThreadForkParams.ts）。
 *  方法名常量见 Method.threadFork。PoC 实测：返回新 thread.id + forkedFromId，上下文继承，
 *  fork 的 sessionId 与 base 不同。 */
export interface ThreadForkParams {
  /** 源线程 id（非空 path 时被忽略；优先用 threadId）。 */
  threadId: string;
  /** [UNSTABLE] 指定 rollout 路径来 fork（空串视为缺省）。 */
  path?: string | null;
  cwd?: string | null;
  model?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  config?: Record<string, unknown> | null;
}

/** thread/fork 响应子集（只取我们关心的 thread；完整见 protocol/ts/v2/ThreadForkResponse.ts）。 */
export interface ThreadForkResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
}

// ───────────────────────── 通知 payload ─────────────────────────
export interface ThreadStartedNotification {
  thread: Thread;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

/** item/agentMessage/delta —— token 级文本增量（→ StreamEvent.text_delta）。 */
export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/** item/reasoning/textDelta —— 原始 reasoning 增量（→ thinking_delta）。 */
export interface ReasoningTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  contentIndex: number;
}

/** item/reasoning/summaryTextDelta —— reasoning 摘要增量（原始不可用时回退到此）。 */
export interface ReasoningSummaryTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/** item/commandExecution/outputDelta —— 命令 stdout/stderr 增量（→ tool_progress）。
 *  ⚠️ 待验证：部分版本 delta 可能为 base64（见 docs/CODEX-PORT-PLAN.md §9）。 */
export interface CommandExecutionOutputDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

// ───────────────────────── B2：CollabAgentTool（子代理协同信号源）─────────────────────────
//
// PoC 实测：子代理不经 thread/started.source 暴露。模型调内置 CollabAgentTool 派生，运行时信号是
// ThreadItem 的 collabAgentToolCall。B2 的 scope='subagent' 注入据 sender/receiver threadId 判定，
// 不是 thread/started.source。

/** 内置协同工具名（对齐 protocol/ts/v2/CollabAgentTool.ts）。 */
export type CollabAgentTool = 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent';

/** collabAgentToolCall item 的状态（对齐 protocol/ts/v2/CollabAgentToolCallStatus.ts）。 */
export type CollabAgentToolCallStatus = 'inProgress' | 'completed' | 'failed';

/** 目标子代理生命周期状态（对齐 protocol/ts/v2/CollabAgentStatus.ts）。 */
export type CollabAgentStatus =
  | 'pendingInit'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound';

/** 单个目标子代理的最近已知状态（对齐 protocol/ts/v2/CollabAgentState.ts）。 */
export interface CollabAgentState {
  status: CollabAgentStatus;
  message: string | null;
}

/** ThreadItem 子集（item/started、item/completed 携带）。完整见 protocol/ts/v2/ThreadItem.ts。 */
export type ThreadItem =
  | { type: 'userMessage'; id: string; content: UserInput[] }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      status: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: string;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      tool: string;
      status: string;
    }
  | { type: 'webSearch'; id: string; query: string }
  /** B2：子代理协同 item —— scope='subagent' 注入的运行时信号源（对齐 protocol/ts/v2/ThreadItem.ts）。
   *  senderThreadId=发起方（父）；receiverThreadIds=接收方（spawn 时为新建子代理）。
   *  generated 产物里 prompt/agentsStates 总是存在（可为 null/空对象）；此处放宽为可选以便消费侧防御性读取。 */
  | {
      type: 'collabAgentToolCall';
      id: string;
      tool: CollabAgentTool;
      status: CollabAgentToolCallStatus;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt?: string | null;
      agentsStates?: { [childThreadId: string]: CollabAgentState | undefined };
    }
  /** B1：上下文压缩 item（推荐监听此 item 而非 DEPRECATED 的 thread/compacted 通知）。 */
  | { type: 'contextCompaction'; id: string }
  | { type: string; id: string; [k: string]: unknown };

export interface ItemStartedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  startedAtMs: number;
}

export interface ItemCompletedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
  completedAtMs: number;
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  [k: string]: unknown;
}

// ───────────────────────── B1：上下文压缩（context compaction）─────────────────────────

/** thread/compacted 通知 payload（对齐 protocol/ts/v2/ContextCompactedNotification.ts）。
 *  ⚠️ DEPRECATED：codex 同时发一个 contextCompaction item（见 ThreadItem），推荐监听 item 而非本通知。 */
export interface ContextCompactedNotification {
  threadId: string;
  turnId: string;
}

/** thread/compact/start 参数（手动触发上下文压缩；对齐 protocol/ts/v2/ThreadCompactStartParams.ts）。
 *  方法名常量见 Method.threadCompactStart。 */
export interface ThreadCompactStartParams {
  threadId: string;
}

/** thread/compact/start 响应 —— 空对象（对齐 protocol/ts/v2/ThreadCompactStartResponse.ts）。 */
export type ThreadCompactStartResponse = Record<string, never>;

// ───────────────────────── B3：Hooks（子集；MVP 暂不消费，一次性定义）─────────────────────────

/** Hook 事件名（对齐 protocol/ts/v2/HookEventName.ts 的 10 个成员）。 */
export type HookEventName =
  | 'preToolUse'
  | 'permissionRequest'
  | 'postToolUse'
  | 'preCompact'
  | 'postCompact'
  | 'sessionStart'
  | 'userPromptSubmit'
  | 'subagentStart'
  | 'subagentStop'
  | 'stop';

/** Hook 运行状态（对齐 protocol/ts/v2/HookRunStatus.ts）。 */
export type HookRunStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'stopped';

/** Hook 作用域（对齐 protocol/ts/v2/HookScope.ts）。 */
export type HookScope = 'thread' | 'turn';

/** HookRunSummary 子集（完整见 protocol/ts/v2/HookRunSummary.ts）。
 *  只收录 happycodex 需要的字段；完整产物含 handlerType/executionMode/source/entries 等。 */
export interface HookRunSummary {
  eventName: HookEventName;
  status: HookRunStatus;
  statusMessage?: string | null;
  scope?: HookScope;
  /** 运行时长（毫秒）。完整产物为 bigint，此处放宽为 number（JSON 反序列化后形态）。 */
  durationMs?: number | null;
}

/** hook/started 通知 payload（对齐 protocol/ts/v2/HookStartedNotification.ts）。 */
export interface HookStartedNotification {
  threadId: string;
  turnId: string | null;
  run: HookRunSummary;
}

/** hook/completed 通知 payload（对齐 protocol/ts/v2/HookCompletedNotification.ts）。 */
export interface HookCompletedNotification {
  threadId: string;
  turnId: string | null;
  run: HookRunSummary;
}
