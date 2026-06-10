/**
 * 桥接文件（A0 搬迁断开点）。
 *
 * 上游 HappyClaw 的 src/stream-event.types.ts 是 shared/stream-event.ts 经
 * `make sync-types` 生成的副本；happycodex 的单一真相源是 src/shared/stream-event.ts
 * （已做 codex 契约对齐：字段名与上游一致，eventType 取值为 codex 实际产出集合）。
 * 本文件保留上游文件名，让忠实搬迁的 types.ts 等模块的 import 路径与上游逐字一致，
 * 便于日后与上游对照人工同步。
 */
export type { StreamEvent, StreamEventType, StreamAgentScope } from './shared/stream-event.js';

/** 上游 StreamDisplayLevel（happycodex 的 StreamEvent 暂无 displayLevel 字段，
 *  此联合仅供搬迁来的消费端类型（如 types.ts 的 WsMessageOut.stream_snapshot）引用）。 */
export type StreamDisplayLevel = 'primary' | 'detail' | 'debug';
