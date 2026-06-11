/**
 * tests/session-manager-standalone-poll.test.ts —— CR#7 回归：standalone 编排下
 * SessionManager 构造的 IpcToolBridge 必须显式传短 pollTimeoutMs（≈3s）。
 *
 * 背景：SessionManager 自身就是顶层进程，没有 HappyClaw 主进程消费 {dataDir}/ipc 的
 * 请求文件——请求-响应工具（list_tasks 等）永远等不到回执。若回退到上游默认 30s
 * （install 120s），每次调用都会把 turn 阻塞到 dispatcher 看门狗边缘。
 *
 * 测法（行为观测，真实时钟）：enableTools=true + fake client 捕获 server 请求 handler，
 * 发一次 list_tasks 工具调用。短 poll（3s）下 listTasks 超时降级本地快照、几秒内诚实
 * 返回 success；若回归为默认 30s，该用例会撞 vitest 用例超时（10s）失败。
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type {
  IAppServerClient,
  AppServerClientOptions,
  IncomingServerRequest,
  ServerNotificationHandler,
  ServerRequestHandler,
} from '../src/contracts.js';
import type { InitializeResponse } from '../src/appserver/protocol.js';
import { ServerReq } from '../src/appserver/protocol.js';
import type { ISessionStore, ICodexHomeProvisioner } from '../src/runtime/multitenant/types.js';
import { SessionManager } from '../src/runtime/multitenant/session-manager.js';

class FakeClient implements IAppServerClient {
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>();

  constructor(_opts: AppServerClientOptions) {}
  async start(): Promise<InitializeResponse> {
    return { userAgent: 'f', codexHome: '', platformFamily: 'unix', platformOs: 'darwin' };
  }
  async request<T = unknown>(method: string): Promise<T> {
    if (method === 'thread/start') {
      return { thread: { id: 'th_1', sessionId: 's', path: null } } as T;
    }
    return {} as T;
  }
  notify(): void {}
  onNotification(_h: ServerNotificationHandler): () => void {
    return () => {};
  }
  onServerRequest(h: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(h);
    return () => this.serverRequestHandlers.delete(h);
  }
  onClose(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}

  /** 模拟 server→client 工具调用，返回 respond 结果的 Promise。 */
  callTool(tool: string): Promise<unknown> {
    return new Promise((resolve) => {
      const req: IncomingServerRequest = {
        id: 1,
        method: ServerReq.dynamicToolCall,
        params: { threadId: 'th_1', turnId: 't1', callId: 'c1', namespace: null, tool, arguments: {} },
      };
      for (const h of this.serverRequestHandlers) h(req, resolve);
    });
  }
}

class FakeStore implements ISessionStore {
  private readonly map = new Map<string, string>();
  getThreadId(f: string): string | null {
    return this.map.get(f) ?? null;
  }
  setThreadId(f: string, t: string): void {
    this.map.set(f, t);
  }
  deleteThreadId(f: string): void {
    this.map.delete(f);
  }
  all(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

class FakeProvisioner implements ICodexHomeProvisioner {
  async provision(folder: string): Promise<string> {
    return `/fake/sessions/${folder}/.codex`;
  }
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(nodePath.join(os.tmpdir(), 'happycodex-sm-poll-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('SessionManager — CR#7 standalone 短 poll 超时', () => {
  it(
    'enableTools 下 list_tasks 无主进程应答：3s 短 poll 即降级快照诚实返回（默认 30s 会撞用例超时）',
    { timeout: 10_000 },
    async () => {
      const clients: FakeClient[] = [];
      const mgr = new SessionManager(
        { dataDir, idleTimeoutMs: 0, enableTools: true },
        {
          store: new FakeStore(),
          provisioner: new FakeProvisioner(),
          clientFactory: (o) => {
            const c = new FakeClient(o);
            clients.push(c);
            return c;
          },
        },
      );
      try {
        await mgr.getOrCreate('home-poll');
        const client = clients[0]!;

        const started = Date.now();
        const result = (await client.callTool('list_tasks')) as {
          success?: boolean;
          contentItems?: Array<{ text?: string }>;
        };
        const elapsed = Date.now() - started;

        // 降级快照路径：诚实 success（空任务列表），而非 30s 阻塞 / 看门狗假失败。
        expect(result.success).toBe(true);
        expect(result.contentItems?.[0]?.text).toMatch(/共 0 个任务/);
        // 短 poll 上界（3s + 轮询间隔/IO 余量）；回归为 30s 默认时这里必然超过。
        expect(elapsed).toBeLessThan(8_000);
        expect(elapsed).toBeGreaterThanOrEqual(2_500); // 确实走了 poll 超时而非提前抛错
      } finally {
        await mgr.shutdownAll();
      }
    },
  );
});
