/**
 * StreamEvent type definitions for the web frontend (happycodex adaptation).
 *
 * 上游 HappyClaw 中本文件是 `shared/stream-event.ts` 经 `make sync-types` 生成的副本；
 * happycodex 的单一真相源是 `src/shared/stream-event.ts`（主仓根目录）。
 * web 是独立的 npm/tsc 项目（tsconfig include 仅 src/），因此沿用上游"本地副本"模式，
 * 本文件 = happycodex 契约 ∪ 上游遗留成员：
 *
 *   - happycodex 契约（src/shared/stream-event.ts，后端实际产出）：
 *     eventType: init / text_delta / thinking_delta / tool_use_start / tool_use_end /
 *               tool_progress / task_start / status / usage / result / compact_partial
 *     （task_start 在契约中保留但 codex 侧当前无生产者——W2 ①：turn/started 不再
 *       映射成 task_start；子代理生命周期走 tool_use_start/end(collabAgentToolCall)。）
 *     扩展字段: ok / subtype / threadId / sourceKind / compactReason
 *   - 上游遗留成员（codex 后端暂不产出，保留供 UI 降级——chat store 等消费端分支
 *     代码原样保留，事件不出现即不触发）：
 *     tool_result / hook_* / task_progress|updated|notification / permission_denied /
 *     memory_recall / compact_boundary / notification / prompt_suggestion /
 *     raw_sdk_event / context_audit / todo_update 及对应字段。
 *
 * 修改契约时：先改 src/shared/stream-event.ts，再人工同步本文件的契约部分。
 */

export type StreamEventType =
  | 'text_delta' | 'thinking_delta'
  | 'tool_use_start' | 'tool_use_end' | 'tool_progress' | 'tool_result'
  | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'task_start' | 'task_progress' | 'task_updated' | 'task_notification'
  | 'permission_denied' | 'memory_recall' | 'compact_boundary'
  | 'notification' | 'prompt_suggestion' | 'raw_sdk_event'
  | 'context_audit'
  | 'todo_update'
  | 'usage'
  | 'status' | 'init'
  /** happycodex 扩展：本轮成败终态（codex turnCompleted）。 */
  | 'result'
  /** happycodex 扩展：上下文压缩（context compaction）的局部摘要文本。 */
  | 'compact_partial';

export type StreamAgentScope = 'main' | 'task' | 'subagent' | 'system';
export type StreamDisplayLevel = 'primary' | 'detail' | 'debug';

export interface ClaudeContextFileAudit {
  sourcePath?: string;
  runtimePath?: string;
  status: 'linked' | 'mounted' | 'missing' | 'shadowed' | 'unavailable' | 'unknown';
  tokens?: number;
  loaded?: boolean;
}

export interface ClaudeContextRulesAudit {
  sourcePath?: string;
  runtimePath?: string;
  status: 'linked' | 'mounted' | 'missing' | 'unavailable' | 'unknown';
  fileCount: number;
  loadedFileCount?: number;
  loadedFiles?: Array<{ path: string; tokens?: number }>;
}

export interface ClaudeContextSkillsSourceAudit {
  name: 'builtin' | 'external' | 'project' | 'user' | 'plugin' | 'unknown';
  sourcePath?: string;
  runtimePath?: string;
  count?: number;
  tokens?: number;
}

export interface ClaudeContextSkillsAudit {
  totalSkills?: number;
  includedSkills?: number;
  tokens?: number;
  sources: ClaudeContextSkillsSourceAudit[];
}

export interface ClaudeContextPromptAudit {
  totalBytes: number;
  files: Array<{ name: string; bytes: number }>;
}

export interface ClaudeContextAudit {
  executionMode: 'host' | 'container';
  cwd?: string;
  claudeConfigDir?: string;
  externalClaudeDir?: string;
  claudeMd: ClaudeContextFileAudit;
  rules: ClaudeContextRulesAudit;
  skills: ClaudeContextSkillsAudit;
  happyclawPrompt: ClaudeContextPromptAudit;
  warnings: string[];
}

export interface StreamEvent {
  eventType: StreamEventType;
  /** Which runtime actor produced the event. */
  agentScope?: StreamAgentScope;
  /** Correlates all stream events for a single user turn. */
  turnId?: string;
  /** SDK session identifier if known. */
  sessionId?: string;
  /** SDK message uuid if known. */
  messageUuid?: string;
  /** Reserved — whether this event was synthesized locally rather than emitted directly by SDK semantics. */
  isSynthetic?: boolean;
  /** UI priority: primary is surfaced inline, detail in trace panels, debug in developer trace. */
  displayLevel?: StreamDisplayLevel;
  text?: string;
  title?: string;
  summary?: string;
  detail?: string;
  rawType?: string;
  toolName?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  /** Tool execution result text (truncated + sanitized), carried on
   *  `tool_result` events so the card/Web can surface what a tool returned,
   *  aligning the trace with what Claude Code shows. */
  toolResult?: string;
  elapsedSeconds?: number;
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
  statusText?: string;
  taskDescription?: string;
  taskId?: string;
  taskStatus?: string;
  taskSummary?: string;
  taskPatch?: {
    status?: string;
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  subagentType?: string;
  lastToolName?: string;
  outputFile?: string;
  sdkTaskUsage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
  permissionDenied?: {
    toolName: string;
    toolUseId: string;
    agentId?: string;
    reasonType?: string;
    reason?: string;
    message: string;
  };
  isBackground?: boolean;
  isTeammate?: boolean;
  toolInput?: Record<string, unknown>;
  rawEvent?: Record<string, unknown>;
  contextAudit?: ClaudeContextAudit;
  todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  /** Token usage data emitted at query completion.
   *  happycodex 后端已在 stream-mapper 归一化为上游结构化形状（W2 ③）：
   *  token 取 codex tokenUsage.last 增量、costUSD 恒 0（billing token-only）、
   *  cacheCreation/durationMs/numTurns 无数据源恒 0；消费端字段仍按可缺省防御处理。 */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
    durationMs?: number;
    numTurns?: number;
    modelUsage?: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
    }>;
    [k: string]: unknown;
  };

  // ─── happycodex 扩展字段（对齐 src/shared/stream-event.ts） ───
  /** happycodex 扩展：工具是否成功（tool_use_end）。 */
  ok?: boolean;
  /** happycodex 扩展：result 事件的本轮成败 subtype。 */
  subtype?: 'completed' | 'interrupted' | 'failed';
  /** happycodex 扩展：codex thread id。 */
  threadId?: string;
  /** happycodex 扩展（B1）：compact_partial 事件的子来源标识。 */
  sourceKind?: 'compact_partial';
  /** happycodex 扩展（B1）：本次压缩触发原因 —— manual 或 auto。 */
  compactReason?: 'manual' | 'auto';
}
