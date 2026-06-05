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
  | 'result';

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
}

/** OUTPUT_MARKER 协议 —— 与 HappyClaw container-runner 解析端一致。
 *  agent runner 把每个 StreamEvent 用这对 marker 包裹后写 stdout。 */
export const OUTPUT_START_MARKER = '<<<HAPPYCODEX_OUTPUT_START>>>';
export const OUTPUT_END_MARKER = '<<<HAPPYCODEX_OUTPUT_END>>>';

/** text_delta 缓冲阈值（字符）—— 对齐 HappyClaw 的 200 字符刷新，避免高频小包。 */
export const TEXT_FLUSH_CHARS = 200;
