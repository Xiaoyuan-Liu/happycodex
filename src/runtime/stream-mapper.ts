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
  type ErrorNotification,
  type AgentMessageDeltaNotification,
  type CommandExecutionOutputDeltaNotification,
  type ContextCompactedNotification,
  type HookCompletedNotification,
  type HookEventName,
  type HookRunStatus,
  type HookStartedNotification,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type ReasoningSummaryTextDeltaNotification,
  type ReasoningTextDeltaNotification,
  type ThreadItem,
  type ThreadStartedNotification,
  type ThreadStatusChangedNotification,
  type ThreadTokenUsageUpdatedNotification,
  type TurnCompletedNotification,
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
            eventType: 'text_delta',
            text: n.delta ?? '',
            toolUseId: n.itemId,
            turnId: n.turnId,
            threadId: n.threadId,
          },
        ];
      }

      case ServerNotif.error: {
        const n = p as unknown as Partial<ErrorNotification>;
        const statusText = formatTurnError(n.error);
        if (n.willRetry) {
          return [
            {
              eventType: 'status',
              statusText: statusText ? `retrying:${statusText}` : 'retrying',
              turnId: n.turnId,
              threadId: n.threadId,
              willRetry: true,
            },
          ];
        }
        // App-server can still send turn/completed after an error notification.
        // Downstream keeps hadError sticky and clears accumulated text on this
        // failed result, so a later empty completed event cannot wash it to success.
        return [
          {
            eventType: 'result',
            subtype: 'failed',
            statusText: statusText || 'agent failed',
            turnId: n.turnId,
            threadId: n.threadId,
            willRetry: false,
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
            eventType: 'thinking_delta',
            text: n.delta ?? '',
            toolUseId: n.itemId,
            turnId: n.turnId,
            threadId: n.threadId,
          },
        ];
      }

      case ServerNotif.commandExecutionOutputDelta: {
        const n = p as unknown as CommandExecutionOutputDeltaNotification;
        return [
          {
            eventType: 'tool_progress',
            text: n.delta ?? '',
            toolUseId: n.itemId,
            threadId: n.threadId,
          },
        ];
      }

      case ServerNotif.itemStarted: {
        const n = p as unknown as ItemStartedNotification;
        const item = n.item;
        if (!item || !isToolItem(item)) return [];
        return [
          {
            eventType: 'tool_use_start',
            toolName: extractToolName(item),
            toolUseId: item.id,
            toolInputSummary: extractToolInputSummary(item),
            threadId: n.threadId,
          },
        ];
      }

      case ServerNotif.itemCompleted: {
        const n = p as unknown as ItemCompletedNotification;
        const item = n.item;
        if (!item) return [];
        // (b) contextCompaction item —— codex 推荐的压缩完成信号（优于 DEPRECATED 的 thread/compacted）。
        //     与 (a) 等价：产 statusText:'compacted'，按 (threadId,turnId) 语义。两来源去重留给第二棒 session 层。
        if (item.type === 'contextCompaction') {
          return [
            {
              eventType: 'status',
              statusText: 'compacted',
              threadId: n.threadId,
              turnId: n.turnId,
            },
          ];
        }
        if (!isToolItem(item)) return [];
        return [
          {
            eventType: 'tool_use_end',
            toolName: extractToolName(item),
            toolUseId: item.id,
            ok: extractToolOk(item),
            threadId: n.threadId,
          },
        ];
      }

      case ServerNotif.threadStarted: {
        const n = p as unknown as ThreadStartedNotification;
        const thread = n.thread;
        return [
          {
            eventType: 'init',
            threadId: thread?.id,
          },
        ];
      }

      // 契约对齐（W2 线报①）：上游 task_start 语义 = Claude SDK Task（子代理）启动；
      // codex 的 turn/started 只是主线程轮次边界，若映射成 task_start 会让前端每轮
      // 推一条「Task 启动」噪声 trace/时间线。轮次生命周期由 session 层直接消费原始
      // 通知（registerTurnStart，见 session.handleNotification），子代理面板由
      // tool_use_start(collabAgentToolCall) 驱动，turn 终态仍走 turnCompleted→result，
      // 故此处不产任何事件。task_start 仍保留在冻结契约中（上游兼容；codex 侧无生产者）。
      case ServerNotif.turnStarted:
        return [];

      case ServerNotif.turnCompleted: {
        const n = p as unknown as TurnCompletedNotification;
        return [
          {
            eventType: 'result',
            subtype: mapTurnStatus(n.turn?.status),
            turnId: n.turn?.id,
            ...(n.threadId ? { threadId: n.threadId } : {}),
          },
        ];
      }

      case ServerNotif.threadStatusChanged: {
        const n = p as unknown as Partial<ThreadStatusChangedNotification>;
        return [
          {
            eventType: 'status',
            // ThreadStatus 是 tagged union：notLoaded | idle | systemError | active。
            // 'idle' 是上游前端清流式残留的关键信号（W2 线报②），按 .type 字符串化透传。
            statusText: stringifyStatus(n.status),
            // threadId 透传：decorateScope 据此把子代理 thread 的 status（含 idle）标
            // subagent，避免子代理空闲被消费端误当主会话 idle 提前清掉流式 UI。
            ...(n.threadId ? { threadId: n.threadId } : {}),
          },
        ];
      }

      case ServerNotif.threadTokenUsageUpdated: {
        const n = p as unknown as Partial<ThreadTokenUsageUpdatedNotification>;
        return [
          {
            eventType: 'usage',
            // 契约对齐（W2 线报③）：归一化成上游 shared/stream-event.ts 的结构化 usage
            // 形状（inputTokens/outputTokens/cacheReadInputTokens/...），前端
            // （chat store ⑤.5 usage → token_usage）与主进程（readStreamUsage →
            // usage_records/billing）直接消费，不再透传 codex 原始通知形状。
            usage: normalizeTokenUsage(n.tokenUsage),
            // turnId/threadId 透传：turnId 供前端按 turn 绑定 token_usage 到对应回复；
            // threadId 供 decorateScope 标注子代理用量（计费仍全量累加，不按 scope 过滤）。
            ...(n.turnId ? { turnId: n.turnId } : {}),
            ...(n.threadId ? { threadId: n.threadId } : {}),
          },
        ];
      }

      // (a) thread/compacted —— 上下文压缩完成边界（非文本）。compact_partial 文本 flush 不在 mapper 做
      //     （不变量 (i)：文本累积在有状态 session 层 takeAccumulatedText）。
      //     DEPRECATED：与 (b) contextCompaction item 等价，去重逻辑留给第二棒 session 层。
      case ServerNotif.threadCompacted: {
        const n = p as unknown as ContextCompactedNotification;
        return [
          {
            eventType: 'status',
            statusText: 'compacted',
            threadId: n.threadId,
            turnId: n.turnId,
          },
        ];
      }

      // (c) hook/started、hook/completed —— hook 通知量大，仅在与压缩相关（preCompact/postCompact）
      //     或异常终态（blocked/failed）时产出 status，其余产 []（过滤噪声）。
      case ServerNotif.hookStarted:
      case ServerNotif.hookCompleted: {
        const n = p as unknown as HookStartedNotification | HookCompletedNotification;
        const eventName = extractHookEventName(n.run);
        const status = extractHookStatus(n.run);
        if (!isNotableHook(eventName, status)) return [];
        return [
          {
            eventType: 'status',
            statusText: `hook:${eventName}:${status}`,
          },
        ];
      }

      default:
        return [];
    }
  }
}

// ───────────────────────── helpers（导出便于单测） ─────────────────────────

export function formatTurnError(error: Partial<ErrorNotification['error']> | null | undefined): string {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const additional =
    typeof error?.additionalDetails === 'string' ? error.additionalDetails.trim() : '';
  if (message && additional && !message.includes(additional)) {
    return `${message}\n\n${additional}`;
  }
  return message || additional;
}

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

/**
 * thread/tokenUsage/updated 的 tokenUsage → 上游结构化 usage 形状（W2 线报③）。
 *
 * token 取 tokenUsage.last（最近一次模型调用的**增量**）而非 total（线程累计）：
 * codex 一轮内可发多次 usage 通知，下游 usage_records/billing 是增量累加语义，
 * 取 total 会按累计值重复计数；各事件 last 之和 ≈ 本轮总量，与上游「每轮一条
 * usage」的累加结果对齐（与 index.ts readStreamUsage 既有决策同口径）。
 * cacheReadInputTokens ← last.cachedInputTokens（字段名归一）；
 * cacheCreationInputTokens/costUSD/durationMs/numTurns 无 codex 数据源
 * （billing token-only 决策，costUSD 恒 0），恒 0。
 * 防御：tokenUsage/last 缺失或字段非有限数字时各项回退 0（不抛）。
 */
export function normalizeTokenUsage(tokenUsage: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
} {
  const last =
    typeof tokenUsage === 'object' && tokenUsage !== null
      ? (tokenUsage as Record<string, unknown>)['last']
      : undefined;
  return {
    inputTokens: readNum(last, 'inputTokens'),
    outputTokens: readNum(last, 'outputTokens'),
    cacheReadInputTokens: readNum(last, 'cachedInputTokens'),
    cacheCreationInputTokens: 0,
    costUSD: 0,
    durationMs: 0,
    numTurns: 0,
  };
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

/** Hook 事件名提取（容错：run 缺失 / 非字符串时回退空串）。 */
export function extractHookEventName(run: unknown): string {
  return readString(run, 'eventName');
}

/** Hook 运行状态提取（容错：run 缺失 / 非字符串时回退空串）。 */
export function extractHookStatus(run: unknown): string {
  return readString(run, 'status');
}

/** hook 是否值得产出 status：会话生命周期（sessionStart/stop，B3 MVP 端到端）、
 *  与压缩相关（preCompact/postCompact）或异常终态（blocked/failed）。
 *  其余（preToolUse/postToolUse 等高频 hook）过滤为噪声。 */
const NOTABLE_HOOK_EVENTS = new Set<HookEventName>([
  'sessionStart',
  'stop',
  'preCompact',
  'postCompact',
]);
const NOTABLE_HOOK_STATUSES = new Set<HookRunStatus>(['blocked', 'failed']);
function isNotableHook(eventName: string, status: string): boolean {
  return (
    NOTABLE_HOOK_EVENTS.has(eventName as HookEventName) ||
    NOTABLE_HOOK_STATUSES.has(status as HookRunStatus)
  );
}

function readString(obj: unknown, key: string): string {
  const v = (obj as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'string' ? v : '';
}

function readNum(obj: unknown, key: string): number {
  if (typeof obj !== 'object' || obj === null) return 0;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
