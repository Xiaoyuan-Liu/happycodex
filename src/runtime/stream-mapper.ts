/**
 * StreamMapper —— 把单条 app-server 通知（method + params）映射成 0..N 个 StreamEvent。
 *
 * 纯函数、无 I/O、无副作用，便于单测。文本缓冲（200 字符刷新）由调用方/runner 负责，
 * 这里只做形状转换。
 *
 * 协议常量与通知类型来自 `../appserver/protocol.js`（codex-cli 0.137.0 子集），
 * StreamEvent 类型来自 `../shared/stream-event.js`。
 */

import {
  ServerNotif,
  type AgentMessageDeltaNotification,
  type CommandExecutionOutputDeltaNotification,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type ReasoningSummaryTextDeltaNotification,
  type ReasoningTextDeltaNotification,
  type ThreadItem,
  type ThreadStartedNotification,
  type TurnCompletedNotification,
  type TurnStartedNotification,
} from '../appserver/protocol.js';
import type { IStreamMapper } from '../contracts.js';
import type { StreamEvent } from '../shared/stream-event.js';

/** item.type 中被视为「工具调用」的集合（其余如 agentMessage/reasoning/plan/userMessage 由增量覆盖）。 */
const TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'fileChange',
  'webSearch',
]);

/** toolInputSummary 截断长度（命令等可能很长，保持简短）。 */
const TOOL_SUMMARY_MAX = 80;

export class StreamMapper implements IStreamMapper {
  map(method: string, params: unknown): StreamEvent[] {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case ServerNotif.agentMessageDelta: {
        const n = p as unknown as AgentMessageDeltaNotification;
        return [
          {
            type: 'text_delta',
            text: n.delta ?? '',
            itemId: n.itemId,
            turnId: n.turnId,
            threadId: n.threadId,
          },
        ];
      }

      case ServerNotif.reasoningTextDelta:
      case ServerNotif.reasoningSummaryTextDelta: {
        const n = p as unknown as
          | ReasoningTextDeltaNotification
          | ReasoningSummaryTextDeltaNotification;
        return [
          {
            type: 'thinking_delta',
            text: n.delta ?? '',
            itemId: n.itemId,
            turnId: n.turnId,
            threadId: n.threadId,
          },
        ];
      }

      case ServerNotif.commandExecutionOutputDelta: {
        const n = p as unknown as CommandExecutionOutputDeltaNotification;
        return [
          {
            type: 'tool_progress',
            text: n.delta ?? '',
            itemId: n.itemId,
          },
        ];
      }

      case ServerNotif.itemStarted: {
        const n = p as unknown as ItemStartedNotification;
        const item = n.item;
        if (!item || !isToolItem(item)) return [];
        return [
          {
            type: 'tool_use_start',
            toolName: extractToolName(item),
            itemId: item.id,
            toolInputSummary: extractToolInputSummary(item),
          },
        ];
      }

      case ServerNotif.itemCompleted: {
        const n = p as unknown as ItemCompletedNotification;
        const item = n.item;
        if (!item || !isToolItem(item)) return [];
        return [
          {
            type: 'tool_use_end',
            toolName: extractToolName(item),
            itemId: item.id,
            ok: extractToolOk(item),
          },
        ];
      }

      case ServerNotif.threadStarted: {
        const n = p as unknown as ThreadStartedNotification;
        const thread = n.thread;
        return [
          {
            type: 'init',
            threadId: thread?.id,
          },
        ];
      }

      case ServerNotif.turnStarted: {
        const n = p as unknown as TurnStartedNotification;
        return [
          {
            type: 'task_start',
            turnId: n.turn?.id,
          },
        ];
      }

      case ServerNotif.turnCompleted: {
        const n = p as unknown as TurnCompletedNotification;
        return [
          {
            type: 'result',
            subtype: mapTurnStatus(n.turn?.status),
            turnId: n.turn?.id,
          },
        ];
      }

      case ServerNotif.threadStatusChanged: {
        return [
          {
            type: 'status',
            status: stringifyStatus((p as { status?: unknown }).status),
          },
        ];
      }

      case ServerNotif.threadTokenUsageUpdated: {
        return [
          {
            type: 'usage',
            usage: p,
          },
        ];
      }

      default:
        return [];
    }
  }
}

// ───────────────────────── helpers（导出便于单测） ─────────────────────────

export function isToolItem(item: ThreadItem): boolean {
  return TOOL_ITEM_TYPES.has(item.type);
}

/** 工具名提取：command(截断) / `${server}.${tool}` / dynamic tool / apply_patch / web_search。 */
export function extractToolName(item: ThreadItem): string {
  switch (item.type) {
    case 'commandExecution': {
      const cmd = readString(item, 'command');
      return truncate(cmd, TOOL_SUMMARY_MAX);
    }
    case 'mcpToolCall': {
      const server = readString(item, 'server');
      const tool = readString(item, 'tool');
      return `${server}.${tool}`;
    }
    case 'dynamicToolCall':
      return readString(item, 'tool');
    case 'fileChange':
      return 'apply_patch';
    case 'webSearch':
      return 'web_search';
    default:
      return item.type;
  }
}

/** 工具输入摘要：短且不回显敏感内容（命令截断即可）。 */
export function extractToolInputSummary(item: ThreadItem): string {
  switch (item.type) {
    case 'commandExecution':
      return truncate(readString(item, 'command'), TOOL_SUMMARY_MAX);
    case 'mcpToolCall':
      return truncate(`${readString(item, 'server')}.${readString(item, 'tool')}`, TOOL_SUMMARY_MAX);
    case 'dynamicToolCall':
      return truncate(readString(item, 'tool'), TOOL_SUMMARY_MAX);
    case 'fileChange':
      return 'apply_patch';
    case 'webSearch':
      return truncate(readString(item, 'query'), TOOL_SUMMARY_MAX);
    default:
      return '';
  }
}

/** 成功判定：commandExecution → exitCode===0 或 status==='completed'；其它 → status ∈ {completed,success}。 */
export function extractToolOk(item: ThreadItem): boolean {
  const status = readString(item, 'status');
  if (item.type === 'commandExecution') {
    const exitCode = (item as { exitCode?: unknown }).exitCode;
    if (typeof exitCode === 'number') return exitCode === 0;
    return status === 'completed';
  }
  return status === 'completed' || status === 'success';
}

/** turn.status → result subtype（completed / interrupted / failed），未知 / inProgress 给 'completed'。 */
export function mapTurnStatus(status: unknown): 'completed' | 'interrupted' | 'failed' {
  switch (status) {
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'failed';
    case 'completed':
    case 'inProgress':
    default:
      return 'completed';
  }
}

/** thread/status/changed 的 status 字符串化：tagged object 取 .type，否则 String()。 */
export function stringifyStatus(status: unknown): string {
  if (status == null) return '';
  if (typeof status === 'string') return status;
  if (typeof status === 'object') {
    const t = (status as { type?: unknown }).type;
    if (typeof t === 'string') return t;
  }
  return String(status);
}

function readString(obj: unknown, key: string): string {
  const v = (obj as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'string' ? v : '';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
