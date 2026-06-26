/**
 * CodexRunner —— agent-runner 等价物（实现 ICodexRunner）。
 *
 * 消费初始输入 + IPC/队列注入源，驱动 ThreadSession，把每个 StreamEvent 用 OUTPUT_MARKER 包裹后
 * 写到 sink（默认 process.stdout）。
 *
 * 生命周期：
 * - run(input)：new ThreadSession → 订阅 onTurnStarted/onTurnCompleted/onStreamEvent → start()
 *   → 发送初始 prompt → await 一个“未结束”Promise，直到**所有在飞 turn 完成且无待注入消息**时
 *   resolve（或 shutdown 触发）。
 * - inject(text, images?)：把后续用户消息（可带图片附件）排队，串行 await session.sendUserMessage
 *   （有 active turn → steer，否则 → 新 turn）。同一时间只处理一条注入。
 * - shutdown()：session.interrupt().catch(()=>{}) → client.close() → resolve run()。
 *
 * 完成门控（修正历史竞态）：以**在飞 turn 集合**（由 session 的 onTurnStarted/onTurnCompleted 驱动，
 * 按 turnId 计数）为准，而非“在途请求数”。因为 session 在 turn/start 响应 resolve 时即同步触发
 * onTurnStarted，注入打开的新 turn 会在 sendUserMessage 返回前进入在飞集合，所以早先 turn 的
 * turn/completed 不会在注入 turn 仍在飞时误判整体完成。
 */

import type {
  IAppServerClient,
  ICodexRunner,
  InjectContext,
  InjectedImage,
  IStreamMapper,
  CodexRunnerInput,
  ThreadSessionConfig,
} from '../contracts.js';
import {
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  type StreamEvent,
} from '../shared/stream-event.js';
import { ThreadSession } from './session.js';
import { ToolDispatcher } from './tools/dispatcher.js';
import { ApprovalResponder } from './approval-responder.js';
import { archiveRollout, trimRollout } from './rollout-archive.js';
import type { IToolRegistry, ToolBridge } from './tools/types.js';

export interface CodexRunnerDeps {
  client: IAppServerClient;
  config: ThreadSessionConfig;
  /** 每个 StreamEvent 包裹成一行后的输出宿 sink。默认写 process.stdout。 */
  sink?: (line: string) => void;
  mapper?: IStreamMapper;
  /**
   * Stage 3：dynamicTools 工具层。提供则 run() 会把 registry.specs() 注入 thread/start，
   * 并挂一个 ToolDispatcher 处理 item/tool/call（用 bridge 执行）。
   */
  tools?: { registry: IToolRegistry; bridge: ToolBridge };
  /**
   * B1：上下文压缩归档基目录（如 data/memory）。提供则 onCompacted 时把 rollout 归档到
   * {archiveBaseDir}/{folder}/conversations/ 并 trim；缺省则只 flush compact_partial、不落盘归档。
   */
  archiveBaseDir?: string;
}

/** 把单个 StreamEvent 包裹成 OUTPUT_MARKER 协议的一行（与 HappyClaw container-runner 解析端一致）。 */
export function wrapStreamEvent(ev: StreamEvent): string {
  return `${OUTPUT_START_MARKER}${JSON.stringify(ev)}${OUTPUT_END_MARKER}\n`;
}

const defaultSink = (line: string): void => {
  process.stdout.write(line);
};

export class CodexRunner implements ICodexRunner {
  private readonly client: IAppServerClient;
  private readonly config: ThreadSessionConfig;
  private readonly sink: (line: string) => void;
  private readonly mapper: IStreamMapper | undefined;
  private readonly tools: { registry: IToolRegistry; bridge: ToolBridge } | undefined;
  private readonly archiveBaseDir: string | undefined;

  private session: ThreadSession | null = null;
  private toolDispatcher: ToolDispatcher | null = null;
  private approvalResponder: ApprovalResponder | null = null;

  /** run() 返回的“未结束”Promise 的 resolver；shutdown / 全部 turn 完成且无待注入时调用。 */
  private finishResolve: (() => void) | null = null;
  private finished = false;
  /** client.onClose 退订函数；崩溃/正常完成/显式 shutdown 三条收尾路径统一摘除，防泄漏。 */
  private offClose: (() => void) | null = null;

  /** 注入串行化锁：保证同一时间只 await 一条 sendUserMessage。 */
  private injectChain: Promise<void> = Promise.resolve();
  /** 已排队但尚未发送完成的注入条数（>0 时不应提前 resolve）。 */
  private queuedInjections = 0;
  /** 在飞 turn 的 id 集合（由 session.onTurnStarted/onTurnCompleted 驱动）。 */
  private readonly inFlightTurns = new Set<string>();
  /**
   * #F1r：最近一条注入消息携带、等待绑定到「它即将开启的新 turn」的上下文。inject 在 injectChain
   * 链节内、调 sendUserMessage 之前置位；onTurnStarted（仅新 turn 触发）消费它写入 bridge，随即清空。
   * steer（并入 active turn，不 fire onTurnStarted）不消费 → 该 turn 保留自己开启时的上下文。
   * undefined = 无上下文注入（如测试 inject(text) / cold prompt 经构造函数 seed），onTurnStarted 不改 bridge。
   */
  private pendingInjectCtx: InjectContext | undefined = undefined;
  /** 是否已至少开过一轮（避免首条 prompt 之前误判完成）。 */
  private hadAnyTurn = false;
  /** 是否已被 shutdown，避免关闭后继续注入 / 重复关闭。 */
  private shuttingDown = false;
  /**
   * 本轮（最近一次 turn 开始以来）是否已有主线程终态 result 事件经 sink 流出。
   * idle 兜底完成的去重依据：真实 turn/completed（即便 turn.id / threadId 失配，mapper 仍**无
   * 条件**产 result 事件）已给出终态时，idle reconcile 不再合成第二条，避免双终态把已报的
   * 失败/中断洗成 success（见 issue #1 加固）。onTurnStarted 重置、真实 result 出栈时置位。
   */
  private mainTerminalSeenThisTurn = false;

  constructor(deps: CodexRunnerDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.sink = deps.sink ?? defaultSink;
    this.mapper = deps.mapper;
    this.tools = deps.tools;
    this.archiveBaseDir = deps.archiveBaseDir;
  }

  async run(input: CodexRunnerInput): Promise<void> {
    const mergedConfig: ThreadSessionConfig = {
      // 自治运行时默认 never（无人工审批 UI）；调用方可显式覆盖。
      approvalPolicy: this.config.approvalPolicy ?? input.session.approvalPolicy ?? 'never',
      ...this.config,
      ...input.session,
    };
    // Stage 3：把已注册工具的 schema 注入 thread/start.dynamicTools。
    if (this.tools) {
      mergedConfig.dynamicTools = this.tools.registry.specs();
    }
    // 审批安全网：杜绝审批请求无人应答导致的 turn 死锁。
    this.approvalResponder = new ApprovalResponder(this.client);
    const session = new ThreadSession(this.client, mergedConfig, this.mapper);
    this.session = session;

    // 工具调用回环：item/tool/call → registry.dispatch（用 bridge 执行）。
    if (this.tools) {
      this.toolDispatcher = new ToolDispatcher(this.client, this.tools.registry, {
        groupFolder: input.groupFolder,
        bridge: this.tools.bridge,
        getThreadId: () => session.state.threadId,
      });
    }

    session.onStreamEvent((ev) => {
      // 观测真实主线程终态 result（mapper 从 turn/completed 产出，含 id/threadId 失配的"幽灵"
      // turn）：用于 idle 兜底完成去重，避免双终态。子代理 result 不计（非主轮终态）。
      if (ev.eventType === 'result' && ev.agentScope !== 'subagent') {
        this.mainTerminalSeenThisTurn = true;
      }
      this.sink(wrapStreamEvent(ev));
    });

    session.onTurnStarted(({ turnId }) => {
      this.hadAnyTurn = true;
      this.inFlightTurns.add(turnId);
      // 新一轮开始：重置终态观测（去重只针对"本轮"）。
      this.mainTerminalSeenThisTurn = false;
      // #F1r：把开启本 turn 的注入消息的上下文（taskId/sourceJid）钉到 bridge，整个 turn 稳定可读。
      // 仅新 turn 走到这（steer 不 fire onTurnStarted），故并发到达的下一条消息无法覆写本 turn 上下文。
      if (this.pendingInjectCtx !== undefined) {
        this.tools?.bridge.setTurnContext?.(this.pendingInjectCtx);
        this.pendingInjectCtx = undefined;
      }
    });

    session.onTurnCompleted(({ turnId, subtype }) => {
      this.inFlightTurns.delete(turnId);
      // 兜底完成（issue #1）：idle reconcile 的 turn 无对应 turn/completed 通知，mapper 未产
      // 终态 result 事件 → 下游拿不到 success 终态信封（仅流式 text_delta + status:idle），
      // 且 success(含正文) 才会提交游标。补发一条 result(completed)，使其与正常 turn/completed
      // 路径等价（携本轮累积正文 → success + 提交游标）。三重收窄（见 issue #1 对抗 review）：
      //   1) 本轮已有真实终态 result 流出（turn/completed 即便 id/threadId 失配，mapper 仍无条件
      //      产 result）→ 不再合成，避免双终态把已报的失败/中断洗成 success。
      //   2) shuttingDown/finished → 不合成，避免 teardown 期一条游离 idle 伪造 success。
      // 残留：turn/completed 完全丢失、该轮真失败、且服务端仍干净 idle（非 systemError）的极少数
      // 情形会被乐观判 completed —— 无终态信号可恢复真状态，且与 issue 期望"emit the final success
      // result"一致（服务端可知的失败走 systemError，不在 idle 分支）。
      if (
        subtype === 'idle' &&
        !this.mainTerminalSeenThisTurn &&
        !this.shuttingDown &&
        !this.finished
      ) {
        this.mainTerminalSeenThisTurn = true; // 多 turn 同时 reconcile 时也只补一条
        this.sink(
          wrapStreamEvent({
            eventType: 'result',
            subtype: 'completed',
            agentScope: 'main',
            ...(turnId ? { turnId } : {}),
            ...(session.state.threadId ? { threadId: session.state.threadId } : {}),
          }),
        );
      }
      this.maybeFinish();
    });

    // B1：上下文压缩完成（contextCompaction item）→ flush compact_partial + 归档 + trim。
    // 子代理 thread 跳过（避免归档/trim 主 transcript 的无关副本，对齐 HappyClaw PreCompact）。
    session.onCompacted((reason) => {
      this.onCompacted(session, input.groupFolder, reason);
    });

    // app-server 崩溃自愈：进程意外退出时 turn/completed 永不到达，inFlightTurns 永不清空，
    // maybeFinish 永远 return → run() 的 await finishPromise 永久挂起。订阅 onClose 把异常退出
    // 转成幂等 resolveFinish + 一条 failed result 事件（StreamEvent 无 'error' 类型，复用
    // result+subtype:'failed' 表达异常收尾，调用方据此区分非正常完成）。#12
    this.offClose = this.client.onClose((info) => {
      if (this.finished) return;
      this.shuttingDown = true; // 阻断后续 inject / maybeFinish 误判
      this.sink(
        wrapStreamEvent({
          eventType: 'result',
          subtype: 'failed',
          statusText: `app-server closed (code=${String(info.code)} signal=${String(info.signal)})`,
          ...(this.session?.state.threadId ? { threadId: this.session.state.threadId } : {}),
        }),
      );
      this.resolveFinish();
    });

    const finishPromise = new Promise<void>((resolve) => {
      this.finishResolve = resolve;
    });

    await session.start();
    await session.sendUserMessage(input.prompt, input.images);

    await finishPromise;
  }

  inject(text: string, images?: InjectedImage[], ctx?: InjectContext): void {
    if (this.shuttingDown) return;
    const session = this.session;
    if (!session) {
      // run() 尚未驱动 session：丢弃（调用方应在 run() 之后再注入）。
      return;
    }
    this.queuedInjections += 1;
    // 串行排队：保证有序、同一时间只处理一条。
    this.injectChain = this.injectChain
      .then(() => {
        if (this.shuttingDown) return;
        // #F1r：在 sendUserMessage 之前置 pendingInjectCtx，使其开启的新 turn 的 onTurnStarted
        // （同步在 sendUserMessage 内 registerTurnStart 时触发）消费到本条消息的上下文。injectChain
        // 串行 → 下一条注入要等本条 sendUserMessage resolve 后才置位，不会抢在本 turn 绑定前覆写。
        this.pendingInjectCtx = ctx;
        // sendUserMessage 在请求 resolve 时同步注册新 turn（onTurnStarted），
        // 因此该 await 返回前，注入打开的 turn 已进入 inFlightTurns，maybeFinish 不会误判。
        return session.sendUserMessage(text, images);
      })
      .catch(() => {
        // 注入失败不影响后续条目，已通过 stream 事件/日志体现，这里吞掉避免 unhandled rejection。
      })
      .finally(() => {
        this.queuedInjections -= 1;
        this.maybeFinish();
      });
  }

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    void this.doShutdown();
  }

  private async doShutdown(): Promise<void> {
    // 先摘 onClose：显式 shutdown 是正常收尾，避免 client.close() 触发的 onClose 误吐 failed 事件。
    if (this.offClose) {
      this.offClose();
      this.offClose = null;
    }
    try {
      if (this.session) {
        await this.session.interrupt().catch(() => {});
      }
    } finally {
      try {
        this.toolDispatcher?.dispose();
      } catch {
        /* ignore */
      }
      try {
        this.approvalResponder?.dispose();
      } catch {
        /* ignore */
      }
      try {
        this.session?.dispose();
      } catch {
        /* ignore */
      }
      await this.client.close().catch(() => {});
      this.resolveFinish();
    }
  }

  /**
   * B1 压缩副作用编排：
   *   - 子代理 thread → 直接跳过（不归档/trim 主 transcript 的无关副本）。
   *   - 否则 (a) flush：把压缩前 session 缓冲的可见正文一次性吐成 compact_partial（缓冲为空也发标记）；
   *           (b) archiveRollout（归档）；(c) trimRollout（归档之后再删边界前历史）。
   * archive/trim 仅在配置了 archiveBaseDir 时执行；其文件操作自身 try/catch 不抛。
   */
  private onCompacted(session: ThreadSession, folder: string, reason: 'manual' | 'auto'): void {
    if (session.state.isSubAgent) return;

    // (a) flush compact_partial。
    const text = session.takeAccumulatedText();
    const threadId = session.state.threadId;
    this.sink(
      wrapStreamEvent({
        eventType: 'compact_partial',
        sourceKind: 'compact_partial',
        compactReason: reason,
        agentScope: 'main',
        ...(text.trim() ? { text } : {}),
        ...(threadId ? { threadId } : {}),
      }),
    );

    // (b)+(c) 归档后 trim（需 archiveBaseDir；rollout-archive 内部对 null path / 越界 / I/O 失败兜底）。
    if (this.archiveBaseDir) {
      const rolloutPath = session.state.rolloutPath;
      archiveRollout(rolloutPath, folder, this.archiveBaseDir);
      trimRollout(rolloutPath);
    }
  }

  /** 全部 turn 完成且无排队注入 → run() 视为完成。shutdown 走 resolveFinish 直接收尾。 */
  private maybeFinish(): void {
    if (this.shuttingDown) return;
    if (!this.hadAnyTurn) return;
    if (this.inFlightTurns.size > 0) return;
    if (this.queuedInjections > 0) return;
    this.resolveFinish();
  }

  private resolveFinish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.offClose) {
      this.offClose();
      this.offClose = null;
    }
    const resolve = this.finishResolve;
    this.finishResolve = null;
    if (resolve) resolve();
  }
}
