/**
 * StreamEvent —— happycodex 对外的流式事件类型（单一真相源）。
 *
 * 对齐 HappyClaw `shared/stream-event.ts` 的语义，使 codex app-server 的增量通知能映射到
 * HappyClaw 现有的 OUTPUT_MARKER → WebSocket `stream_event` 管道，前端 chat store 无需改动。
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
  | 'result'
  /** B1：上下文压缩（context compaction）的局部摘要文本。scope/hook 维度复用既有 type，不新增成员。 */
  | 'compact_partial';

export interface StreamEvent {
  type: StreamEventType;

  /** text_delta / thinking_delta / tool_progress 的增量文本。 */
  text?: string;

  /** 工具相关事件的工具标识（命令 / mcp server·tool / dynamic tool）。 */
  toolName?: string;
  /** 关联的 item id（tool_use_start/end/progress 用于配对）。 */
  itemId?: string;
  /** 工具输入摘要（已脱敏；tool_use_start）。 */
  toolInputSummary?: string;
  /** 工具是否成功（tool_use_end）。 */
  ok?: boolean;

  /** result 事件：本轮成败 subtype（completed / interrupted / failed）。 */
  subtype?: 'completed' | 'interrupted' | 'failed';

  /** status 事件：线程/turn 状态文本。 */
  status?: string;

  /** usage 事件：token 用量（结构透传，不强约束）。 */
  usage?: Record<string, unknown>;

  /** 关联标识，便于前端按 turn 聚合。 */
  turnId?: string;
  threadId?: string;

  // ─────────────── 冻结契约 delta（Stage 5/B；全部可选，仅挂新 case） ───────────────
  // 不变量 (i)：compact_partial 的文本累积发生在【有状态的 session 层】（takeAccumulatedText），
  //   绝不进 mapper —— mapper 必须保持纯无状态，逐条通知映射，不持有跨事件缓冲。
  // 不变量 (ii)：scope 的注入发生在 session.decorateScope，不在 mapper —— mapper 不感知
  //   main/subagent 维度，由有状态的 session 层在出栈前打标。

  /** B1：compact_partial 事件的子来源标识。codex 同时发 thread/compacted 通知与
   *  contextCompaction item；本字段标注事件由压缩流程产生。 */
  sourceKind?: 'compact_partial';
  /** B1：本次压缩触发原因 —— manual（thread/compact/start）或 auto（token 上限自动压缩）。 */
  compactReason?: 'manual' | 'auto';

  /** B2：横切维度，事件归属的执行作用域。codex 无 Task 概念，故仅两态：
   *  'main'（主线程）/ 'subagent'（子代理，如 code-reviewer / web-researcher）；
   *  不含 HappyClaw 的 'task' / 'system'。 */
  scope?: 'main' | 'subagent';
  /** B2：子代理类型名（code-reviewer / web-researcher 等），scope='subagent' 时填充。 */
  subagentType?: string;

  /** B3：Hook 事件名（完整集，对齐 codex HookEventName 的 10 个成员）。MVP 暂不使用，一次性定义。 */
  hookEvent?: string;
  /** B3：Hook 运行结果。MVP 暂不使用，一次性定义。 */
  hookOutcome?: 'completed' | 'failed' | 'blocked' | 'stopped';
  /** B3：Hook 名称 / 标识。MVP 暂不使用，一次性定义。 */
  hookName?: string;
}

/** OUTPUT_MARKER 协议 —— 与 HappyClaw container-runner 解析端一致。
 *  agent runner 把每个 StreamEvent 用这对 marker 包裹后写 stdout。 */
export const OUTPUT_START_MARKER = '<<<HAPPYCODEX_OUTPUT_START>>>';
export const OUTPUT_END_MARKER = '<<<HAPPYCODEX_OUTPUT_END>>>';

/** text_delta 缓冲阈值（字符）—— 对齐 HappyClaw 的 200 字符刷新，避免高频小包。 */
export const TEXT_FLUSH_CHARS = 200;
