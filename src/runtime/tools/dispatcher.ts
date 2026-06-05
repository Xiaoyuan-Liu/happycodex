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
import type { IToolDispatcher, IToolRegistry, ToolContext } from './types.js';

export interface ToolDispatcherContext {
  /** 调用方会话 folder（透传进每个 ToolContext）。 */
  groupFolder: string;
  /** 副作用边界。 */
  bridge: ToolContext['bridge'];
  /** 惰性获取当前 thread id（thread/start 完成后才有值）。 */
  getThreadId: () => string | null;
}

export class ToolDispatcher implements IToolDispatcher {
  private readonly unsubscribe: () => void;

  constructor(
    client: IAppServerClient,
    private readonly registry: IToolRegistry,
    private readonly ctx: ToolDispatcherContext,
  ) {
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

    try {
      const result = await this.registry.dispatch(params.tool, params.arguments, toolCtx);
      respond(result);
    } catch (err) {
      // registry.dispatch 已保证不抛，这里只是终极兜底，确保 turn 不会卡死。
      const message = err instanceof Error ? err.message : String(err);
      respond(toolTextResult(`tool dispatch error: ${message}`, false));
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}
