/**
 * StreamEvent —— happycodex 对外的流式事件类型（单一真相源）。
 *
 * A0 契约对齐（决策#1）：字段名对齐 HappyClaw 上游 canonical `shared/stream-event.ts`，
 * 让后续搬来的前端 / IM 卡片 / 主进程消费端近乎零改。映射决策：
 *
 *   字段名（旧 happycodex → 新，对齐上游）：
 *     type    → eventType
 *     scope   → agentScope（联合扩为上游全集 'main'|'task'|'subagent'|'system'；
 *               codex 侧目前只产 'main'/'subagent'，'task'/'system' 仅为向前兼容保留）
 *     itemId  → toolUseId
 *     status  → statusText
 *   上游同名字段（逐字对齐，无需改）：
 *     text / toolName / toolInputSummary / turnId / usage / subagentType /
 *     hookEvent / hookOutcome / hookName
 *   happycodex 扩展（上游无对应字段，保留原名）：
 *     ok / subtype / threadId / sourceKind / compactReason
 *
 *   eventType 取值（对照上游 StreamEventType 的实际取值集合）：
 *     对齐上游：init / text_delta / thinking_delta / tool_use_start / tool_use_end /
 *               tool_progress / task_start / status / usage
 *     （task_start 语义=上游 SDK Task（子代理）启动；codex 侧当前**无生产者**——
 *       turn/started 只是轮次边界、不映射成 task_start（W2 线报①），子代理生命周期走
 *       tool_use_start/end(collabAgentToolCall)。成员保留供上游消费端兼容。）
 *     happycodex 扩展（上游无）：result（turn 终态）、compact_partial（压缩局部摘要；
 *               上游的 compact_boundary 语义不同——只标边界、不携带 flush 文本，故不映射）
 *
 * codex app-server 通知 → StreamEvent 的映射在 `src/runtime/stream-mapper.ts`。
 */

export type StreamEventType =
  | 'init'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_end'
  | 'tool_progress'
  | 'task_start'
  | 'status'
  | 'usage'
  /** happycodex 扩展：本轮成败终态（上游用 SDK result message，无此 eventType）。 */
  | 'result'
  /** happycodex 扩展（B1）：上下文压缩（context compaction）的局部摘要文本。 */
  | 'compact_partial';

/** 事件归属的执行作用域（对齐上游 StreamAgentScope 全集）。
 *  codex 侧暂不产 'task' / 'system'：codex 无 Task 概念，目前只产 'main' / 'subagent'；
 *  扩联合仅为与上游消费端（前端 / IM 卡片）向前兼容。 */
export type StreamAgentScope = 'main' | 'task' | 'subagent' | 'system';

export interface StreamEvent {
  eventType: StreamEventType;

  /** text_delta / thinking_delta / tool_progress 的增量文本。 */
  text?: string;

  /** 工具相关事件的工具标识（命令 / mcp server·tool / dynamic tool）。 */
  toolName?: string;
  /** 关联的 item id（tool_use_start/end/progress 用于配对；对齐上游 toolUseId）。 */
  toolUseId?: string;
  /** 工具输入摘要（已脱敏；tool_use_start）。 */
  toolInputSummary?: string;
  /** happycodex 扩展：工具是否成功（tool_use_end；上游无对应字段）。 */
  ok?: boolean;

  /** happycodex 扩展：result 事件的本轮成败 subtype（completed / interrupted / failed）。 */
  subtype?: 'completed' | 'interrupted' | 'failed';

  /** status 事件：线程/turn 状态文本（对齐上游 statusText）。 */
  statusText?: string;

  /** usage 事件：token 用量。mapper 已归一化为上游结构化形状（W2 线报③）：
   *  { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
   *    costUSD, durationMs, numTurns }——token 取 codex tokenUsage.last 增量、
   *  costUSD 恒 0（billing token-only）。类型保持宽松 Record 以兼容防御性消费端。 */
  usage?: Record<string, unknown>;

  /** 关联标识，便于前端按 turn 聚合。 */
  turnId?: string;
  /** happycodex 扩展：codex thread id（上游无 thread 概念，对应上游 sessionId 维度但语义不同）。 */
  threadId?: string;

  // ─────────────── 冻结契约 delta（Stage 5/B；全部可选，仅挂新 case） ───────────────
  // 不变量 (i)：compact_partial 的文本累积发生在【有状态的 session 层】（takeAccumulatedText），
  //   绝不进 mapper —— mapper 必须保持纯无状态，逐条通知映射，不持有跨事件缓冲。
  // 不变量 (ii)：agentScope 的注入发生在 session.decorateScope，不在 mapper —— mapper 不感知
  //   main/subagent 维度，由有状态的 session 层在出栈前打标。

  /** happycodex 扩展（B1）：compact_partial 事件的子来源标识。codex 同时发 thread/compacted 通知与
   *  contextCompaction item；本字段标注事件由压缩流程产生。 */
  sourceKind?: 'compact_partial';
  /** happycodex 扩展（B1）：本次压缩触发原因 —— manual（thread/compact/start）或 auto（token 上限自动压缩）。 */
  compactReason?: 'manual' | 'auto';

  /** B2：横切维度，事件归属的执行作用域（对齐上游 agentScope）。codex 侧只产 main/subagent。 */
  agentScope?: StreamAgentScope;
  /** B2：子代理类型名（code-reviewer / web-researcher 等），agentScope='subagent' 时填充（对齐上游同名字段）。 */
  subagentType?: string;

  /** B3：Hook 事件名（完整集，对齐 codex HookEventName 的 10 个成员；上游同名字段）。MVP 暂不使用，一次性定义。 */
  hookEvent?: string;
  /** B3：Hook 运行结果（上游同名字段，类型为 string；此处保留更窄联合，可安全赋值）。MVP 暂不使用，一次性定义。 */
  hookOutcome?: 'completed' | 'failed' | 'blocked' | 'stopped';
  /** B3：Hook 名称 / 标识（上游同名字段）。MVP 暂不使用，一次性定义。 */
  hookName?: string;
}

/** OUTPUT_MARKER 协议 —— 新模型下协议两端都归 happycodex 所有（A1 解析端用同一对 marker），不改。
 *  agent runner 把每个 StreamEvent 用这对 marker 包裹后写 stdout。 */
export const OUTPUT_START_MARKER = '<<<HAPPYCODEX_OUTPUT_START>>>';
export const OUTPUT_END_MARKER = '<<<HAPPYCODEX_OUTPUT_END>>>';

/** text_delta 缓冲阈值（字符）—— 对齐 HappyClaw 的 200 字符刷新，避免高频小包。 */
export const TEXT_FLUSH_CHARS = 200;
