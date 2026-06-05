/**
 * tests/approval-responder.test.ts —— 审批安全网（code-review #2）。
 * 验证每个审批请求都被应答（默认拒绝/不授权），非审批请求不应答，dispose 后取消订阅。
 */
import { describe, it, expect } from 'vitest';
import type {
  IAppServerClient,
  ServerNotificationHandler,
  ServerRequestHandler,
} from '../src/contracts.js';
import type { InitializeResponse } from '../src/appserver/protocol.js';
import { ServerReq } from '../src/appserver/protocol.js';
import { ApprovalResponder } from '../src/runtime/approval-responder.js';

class FakeReqClient implements IAppServerClient {
  private handler: ServerRequestHandler | null = null;
  async start(): Promise<InitializeResponse> {
    return { userAgent: 'f', codexHome: '', platformFamily: 'unix', platformOs: 'darwin' };
  }
  async request<T = unknown>(): Promise<T> {
    return {} as T;
  }
  notify(): void {}
  onNotification(_h: ServerNotificationHandler): () => void {
    return () => {};
  }
  onServerRequest(h: ServerRequestHandler): () => void {
    this.handler = h;
    return () => {
      this.handler = null;
    };
  }
  onClose(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}

  /** 模拟收到 server→client 请求，返回是否被应答 + 应答内容。 */
  emitReq(method: string, params: unknown = {}): { responded: boolean; result: unknown } {
    let responded = false;
    let result: unknown;
    this.handler?.({ id: 1, method, params }, (r) => {
      responded = true;
      result = r;
    });
    return { responded, result };
  }
}

describe('ApprovalResponder', () => {
  it('命令执行审批 → 应答 decline', () => {
    const client = new FakeReqClient();
    new ApprovalResponder(client);
    const { responded, result } = client.emitReq(ServerReq.commandExecutionRequestApproval);
    expect(responded).toBe(true);
    expect(result).toEqual({ decision: 'decline' });
  });

  it('文件改动审批 → 应答 decline', () => {
    const client = new FakeReqClient();
    new ApprovalResponder(client);
    const { responded, result } = client.emitReq(ServerReq.fileChangeRequestApproval);
    expect(responded).toBe(true);
    expect(result).toEqual({ decision: 'decline' });
  });

  it('权限升级审批 → 授予空 profile（等效拒绝升级）', () => {
    const client = new FakeReqClient();
    new ApprovalResponder(client);
    const { responded, result } = client.emitReq(ServerReq.permissionsRequestApproval);
    expect(responded).toBe(true);
    expect(result).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('非审批请求（item/tool/call）→ 不应答（交给别的 handler）', () => {
    const client = new FakeReqClient();
    new ApprovalResponder(client);
    const { responded } = client.emitReq(ServerReq.dynamicToolCall);
    expect(responded).toBe(false);
  });

  it('decision: accept → 命令审批应答 accept', () => {
    const client = new FakeReqClient();
    new ApprovalResponder(client, { decision: 'accept' });
    const { result } = client.emitReq(ServerReq.commandExecutionRequestApproval);
    expect(result).toEqual({ decision: 'accept' });
  });

  it('dispose 后取消订阅（不再应答）', () => {
    const client = new FakeReqClient();
    const r = new ApprovalResponder(client);
    r.dispose();
    const { responded } = client.emitReq(ServerReq.commandExecutionRequestApproval);
    expect(responded).toBe(false);
  });
});
