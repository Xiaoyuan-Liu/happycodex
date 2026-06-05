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
 * - inject(text)：把后续用户消息排队，串行 await session.sendUserMessage（有 active turn → steer，
 *   否则 → 新 turn）。同一时间只处理一条注入。
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

  private session: ThreadSession | null = null;
  private toolDispatcher: ToolDispatcher | null = null;

  /** run() 返回的“未结束”Promise 的 resolver；shutdown / 全部 turn 完成且无待注入时调用。 */
  private finishResolve: (() => void) | null = null;
  private finished = false;

  /** 注入串行化锁：保证同一时间只 await 一条 sendUserMessage。 */
  private injectChain: Promise<void> = Promise.resolve();
  /** 已排队但尚未发送完成的注入条数（>0 时不应提前 resolve）。 */
  private queuedInjections = 0;
  /** 在飞 turn 的 id 集合（由 session.onTurnStarted/onTurnCompleted 驱动）。 */
  private readonly inFlightTurns = new Set<string>();
  /** 是否已至少开过一轮（避免首条 prompt 之前误判完成）。 */
  private hadAnyTurn = false;
  /** 是否已被 shutdown，避免关闭后继续注入 / 重复关闭。 */
  private shuttingDown = false;

  constructor(deps: CodexRunnerDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.sink = deps.sink ?? defaultSink;
    this.mapper = deps.mapper;
    this.tools = deps.tools;
  }

  async run(input: CodexRunnerInput): Promise<void> {
    const mergedConfig: ThreadSessionConfig = { ...this.config, ...input.session };
    // Stage 3：把已注册工具的 schema 注入 thread/start.dynamicTools。
    if (this.tools) {
      mergedConfig.dynamicTools = this.tools.registry.specs();
    }
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
      this.sink(wrapStreamEvent(ev));
    });

    session.onTurnStarted(({ turnId }) => {
      this.hadAnyTurn = true;
      this.inFlightTurns.add(turnId);
    });

    session.onTurnCompleted(({ turnId }) => {
      this.inFlightTurns.delete(turnId);
      this.maybeFinish();
    });

    const finishPromise = new Promise<void>((resolve) => {
      this.finishResolve = resolve;
    });

    await session.start();
    await session.sendUserMessage(input.prompt);

    await finishPromise;
  }

  inject(text: string): void {
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
        // sendUserMessage 在请求 resolve 时同步注册新 turn（onTurnStarted），
        // 因此该 await 返回前，注入打开的 turn 已进入 inFlightTurns，maybeFinish 不会误判。
        return session.sendUserMessage(text);
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
        this.session?.dispose();
      } catch {
        /* ignore */
      }
      await this.client.close().catch(() => {});
      this.resolveFinish();
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
    const resolve = this.finishResolve;
    this.finishResolve = null;
    if (resolve) resolve();
  }
}
