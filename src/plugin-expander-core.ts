/**
 * 【A5 stub / tombstone】plugin-* 全家不在本棒搬迁范围（用户决策：A5 再做）。
 *
 * 上游 src/plugin-expander-core.ts（~700 行）是 plugin 斜杠命令展开核心：
 * 解析 `/mp:plugin:cmd args`、渲染命令模板、执行 inline `!` bash、批量
 * 展开（expandMessagesIfNeeded）等。依赖 plugin-catalog / plugin-utils /
 * plugin-command-index 等 plugin 运行时（全部属 A5）。
 *
 * 本 stub 只保留 web.ts / index.ts 消费的最小面：
 *   - ExpansionResult / ExpandableMessage / BatchExpansionOutcome /
 *     ResolveContextFn / ExpandOverrides 类型（与上游逐字一致）
 *   - expandPluginSlashCommandIfNeeded()：恒返回 { kind: 'miss' }
 *     ——即「不是 plugin 命令」，消息按普通文本进入 agent 管道。
 *     这是禁用 plugin 时的正确降级语义（上游在用户无任何 enabled plugin
 *     时同样走 miss 路径），不会吞消息、不会产生副作用。
 *   - expandMessagesIfNeeded()：批量入口（index.ts 三处消费）。stub 语义 =
 *     全部 miss → toSend 原样透传、replies 恒空（与上游在 core 恒 miss 时的
 *     行为逐字一致：persisted-sentinel 回放与 persistExpansion 路径均不可达）。
 *
 * A5 搬迁 plugin 全家时以上游真版整体替换本文件。
 */

import type { ExpandContext } from './plugin-expander-context.js';
import type { PersistExpansionFn } from './plugin-expander-sentinel.js';

export type ExpansionResult =
  | { kind: 'miss' }
  | {
      kind: 'expanded';
      prompt: string;
      /** True iff inline `!` commands ran and all succeeded（上游语义）。 */
      inlineExecuted: boolean;
    }
  | { kind: 'reply'; text: string };

export async function expandPluginSlashCommandIfNeeded(
  _ctx: ExpandContext,
  _content: string,
  _overrides?: ExpandOverrides,
): Promise<ExpansionResult> {
  // plugin 系统未搬迁（A5）：恒 miss → 消息按原文进入 agent 管道
  return { kind: 'miss' };
}

// --- Batch helper（上游同名导出面；类型与上游逐字一致） ---------------------

/** Single message row used by the batch helper — minimal subset of NewMessage. */
export interface ExpandableMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  /** Stringified JSON; may carry image entries and/or a plugin-expansion sentinel. */
  attachments?: string;
}

export interface BatchExpansionOutcome<M extends ExpandableMessage> {
  /** Messages to forward to the agent — miss (unchanged) + expanded (prompt content). */
  toSend: M[];
  /** In-band system replies. Caller stores + broadcasts each per-route. */
  replies: Array<{ originalMsg: M; text: string }>;
}

/** Override seam for tests. Production callers must not pass this.
 *  【A5 stub】上游为 { buildIndex?/execHost?/execDocker? }（plugin 运行时注入点，
 *  全部属 A5 未搬模块）；stub 不消费，保留空对象形状让调用面零改。 */
export interface ExpandOverrides {
  [key: string]: unknown;
}

/** Per-message ExpandContext resolver（上游同名类型）。 */
export type ResolveContextFn<M extends ExpandableMessage> = (
  msg: M,
) => ExpandContext | null;

/**
 * 批量展开入口（上游同签名）。stub 下 expandPluginSlashCommandIfNeeded 恒 miss，
 * 故所有消息原样进入 toSend、replies 恒空 —— 与上游"无 enabled plugin"路径
 * 的行为一致；persistExpansion / persisted-sentinel 回放路径在 stub 下不可达。
 */
export async function expandMessagesIfNeeded<M extends ExpandableMessage>(
  messages: M[],
  ctxOrResolver: ExpandContext | ResolveContextFn<M> | null,
  overrides?: ExpandOverrides,
  _persistExpansion?: PersistExpansionFn,
): Promise<BatchExpansionOutcome<M>> {
  const toSend: M[] = [];
  const replies: Array<{ originalMsg: M; text: string }> = [];

  const resolveCtx: ResolveContextFn<M> =
    typeof ctxOrResolver === 'function'
      ? (ctxOrResolver as ResolveContextFn<M>)
      : () => ctxOrResolver;

  for (const msg of messages) {
    const ctx = resolveCtx(msg);
    if (!ctx) {
      // No resolvable owner / context for this message → pass-through.
      toSend.push(msg);
      continue;
    }
    const result = await expandPluginSlashCommandIfNeeded(
      ctx,
      msg.content,
      overrides,
    );
    if (result.kind === 'miss') {
      toSend.push(msg);
    } else if (result.kind === 'expanded') {
      toSend.push({ ...msg, content: result.prompt });
    } else {
      replies.push({ originalMsg: msg, text: result.text });
    }
  }

  return { toSend, replies };
}
