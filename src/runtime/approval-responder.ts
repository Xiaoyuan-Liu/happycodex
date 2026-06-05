/**
 * ApprovalResponder —— server→client 审批请求的安全网兜底。
 *
 * 背景（code-review #2）：app-server 的审批请求（item/commandExecution|fileChange|permissions/requestApproval）
 * 是会**阻塞 turn** 的 server→client 请求——turn 一直等到客户端回复才继续。ToolDispatcher 只应答
 * item/tool/call，对审批请求 return 而不 respond；若它是唯一的 onServerRequest 订阅者，审批请求就
 * 永不被应答 → turn 死锁、onTurnCompleted 永不触发、等待方永久挂起。
 *
 * 设计：自治多租户运行时没有人工审批 UI，正确默认是 approvalPolicy='never'（SessionManager/CodexRunner
 * 已默认）。本类作为**防御**：即使调用方设了会触发审批的策略，也确保每个审批请求都被应答（默认拒绝），
 * 杜绝死锁。真正的人工审批留待"接 HappyClaw 主仓"阶段（有 UI）。
 *
 * 与 ToolDispatcher 共存：onServerRequest 会广播给所有 handler；各自只应答自己认得的 method，
 * 不认得的 return（不 respond）。client.respond 幂等防重复。两者 method 集合不相交。
 */

import type { IAppServerClient, IncomingServerRequest } from '../contracts.js';
import { ServerReq } from '../appserver/protocol.js';
import type { IToolDispatcher } from './tools/types.js';

export interface ApprovalResponderOptions {
  /** 命令/文件改动审批的默认决定。默认 'decline'（安全：不放行需审批的操作）。 */
  decision?: 'decline' | 'accept';
  logger?: (msg: string, req: IncomingServerRequest) => void;
}

/** 实现 IToolDispatcher 的 dispose 形状，便于 SessionManager 统一管理生命周期。 */
export class ApprovalResponder implements IToolDispatcher {
  private readonly off: () => void;

  constructor(client: IAppServerClient, opts: ApprovalResponderOptions = {}) {
    const decision = opts.decision ?? 'decline';
    this.off = client.onServerRequest((req, respond) => {
      switch (req.method) {
        case ServerReq.commandExecutionRequestApproval:
        case ServerReq.fileChangeRequestApproval:
          opts.logger?.(`auto-${decision} approval`, req);
          respond({ decision });
          break;
        case ServerReq.permissionsRequestApproval:
          // permissions 无 decline 变体；授予空 profile = 不放行任何升级（等效拒绝）。
          opts.logger?.('auto-deny permission escalation', req);
          respond({ permissions: {}, scope: 'turn' });
          break;
        default:
          // 非审批请求（如 item/tool/call）交给别的 handler，不 respond。
          break;
      }
    });
  }

  dispose(): void {
    this.off();
  }
}
