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
} as const;

/** server→client 请求名常量（审批回环；turn 会阻塞直到客户端回复）。 */
export const ServerReq = {
  commandExecutionRequestApproval: 'item/commandExecution/requestApproval',
  fileChangeRequestApproval: 'item/fileChange/requestApproval',
  permissionsRequestApproval: 'item/permissions/requestApproval',
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
  dynamicTools?: unknown[] | null;
  config?: Record<string, unknown> | null;
}

/** Thread 子集（完整见 protocol/ts/v2/Thread.ts）。 */
export interface Thread {
  id: string;
  /** 同一 session tree 共享的 session id（fork 子 thread 继承）。 */
  sessionId: string;
  /** [UNSTABLE] rollout 文件磁盘路径。 */
  path: string | null;
  /** 线程来源：cli / vscode / exec / app-server 等。 */
  source: string;
  ephemeral: boolean;
  cwd: string;
  cliVersion: string;
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
  threadId?: string;
  /** [UNSTABLE] 直接按 rollout 路径恢复。 */
  path?: string;
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
