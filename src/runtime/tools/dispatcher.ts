/**
 * ToolDispatcher —— 把 codex app-server 的 server→client 请求 `item/tool/call`
 * 桥接到 ToolRegistry。
 *
 * 机制（见 types.ts / protocol.ts）：
 * 1. 构造时订阅 client.onServerRequest，保存取消函数。
 * 2. handler 只认 `item/tool/call`（ServerReq.dynamicToolCall）。命中时把 params 当作
 *    DynamicToolCallParams，构造 ToolContext（groupFolder + 当前 threadId + bridge），
 *    await registry.dispatch(tool, arguments, ctx) → respond(result)。
 * 3. 其它 method（审批回环等）一律不处理、不 respond —— 留给别的 handler。
 *
 * registry.dispatch 契约保证不抛（未知工具 / handler 异常都回 success:false），
 * 但这里仍 try/catch 兜底，避免任何意外让 turn 永久阻塞在等待 respond。
 */

import type { IAppServerClient, IncomingServerRequest } from '../../contracts.js';
import {
  ServerReq,
  toolTextResult,
  type DynamicToolCallParams,
} from '../../appserver/protocol.js';
import { INSTALL_SKILL_POLL_TIMEOUT_MS } from './types.js';
import type { IToolDispatcher, IToolRegistry, ToolContext } from './types.js';

/** tool dispatch 看门狗默认值：handler/bridge 永挂时让 respond 必达，解开客户端侧 turn 死锁。 */
const DEFAULT_DISPATCH_TIMEOUT_MS = 60_000;

/**
 * install_skill 例外（#24）：bridge 侧 pollIpcResult 上限 120s（INSTALL_SKILL_POLL_TIMEOUT_MS，
 * 安装可能很慢），看门狗须给足余量——否则 60s 默认看门狗会以「tool dispatch timeout」假失败
 * 抢答仍在进行的安装，真实回执到达后 reply 已 settled 被丢弃。
 */
const INSTALL_SKILL_DISPATCH_TIMEOUT_MS = INSTALL_SKILL_POLL_TIMEOUT_MS + 10_000;

export interface ToolDispatcherContext {
  /** 调用方会话 folder（透传进每个 ToolContext）。 */
  groupFolder: string;
  /** 副作用边界。 */
  bridge: ToolContext['bridge'];
  /** 惰性获取当前 thread id（thread/start 完成后才有值）。 */
  getThreadId: () => string | null;
  /**
   * 单次 tool dispatch 超时（毫秒）。缺省按默认值：60000（install_skill 例外 130000，
   * 须长于其 bridge 侧 120s poll）；显式设置则统一覆盖所有工具（对齐 IpcToolBridge
   * pollTimeoutMs 的覆盖语义）；<=0 关闭超时。
   */
  dispatchTimeoutMs?: number;
}

export class ToolDispatcher implements IToolDispatcher {
  private readonly unsubscribe: () => void;
  private readonly timeoutMs: number;
  private readonly installSkillTimeoutMs: number;

  constructor(
    client: IAppServerClient,
    private readonly registry: IToolRegistry,
    private readonly ctx: ToolDispatcherContext,
  ) {
    this.timeoutMs = ctx.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    this.installSkillTimeoutMs = ctx.dispatchTimeoutMs ?? INSTALL_SKILL_DISPATCH_TIMEOUT_MS;
    this.unsubscribe = client.onServerRequest((req, respond) => {
      void this.handle(req, respond);
    });
  }

  private async handle(
    req: IncomingServerRequest,
    respond: (result: unknown) => void,
  ): Promise<void> {
    // 只处理 dynamicTools 调用；其它 server 请求（审批等）交给别的 handler，绝不 respond。
    if (req.method !== ServerReq.dynamicToolCall) return;

    const params = req.params as DynamicToolCallParams;
    const toolCtx: ToolContext = {
      groupFolder: this.ctx.groupFolder,
      threadId: this.ctx.getThreadId(),
      bridge: this.ctx.bridge,
    };

    // settled 守卫 + 单一 reply 出口：避免超时与正常返回双重 respond（client.respond 幂等是兜底）。
    let settled = false;
    const reply = (r: unknown): void => {
      if (settled) return;
      settled = true;
      respond(r);
    };

    // 看门狗：registry.dispatch 保证不抛但**不保证有限时返回**（handler/bridge 内永不 settle 的
    // await，如对 FIFO/阻塞设备的 fs 调用）→ respond 永不触发 → turn 永久死锁。超时后强制收口，
    // 让 respond 必达、turn/completed 能到、run()/activeTurns 归零、folder 可回收。#9
    // install_skill 用更长的看门狗（#24：其 bridge poll 上限 120s，60s 会假失败抢答）。
    const timeoutMs =
      params.tool === 'install_skill' ? this.installSkillTimeoutMs : this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        reply(
          toolTextResult(
            `tool dispatch timeout: ${params.tool} did not settle in ${timeoutMs}ms`,
            false,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    }

    try {
      const result = await this.registry.dispatch(params.tool, params.arguments, toolCtx);
      reply(result);
    } catch (err) {
      // registry.dispatch 已保证不抛，这里只是终极兜底，确保 turn 不会卡死。
      const message = err instanceof Error ? err.message : String(err);
      reply(toolTextResult(`tool dispatch error: ${message}`, false));
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}
