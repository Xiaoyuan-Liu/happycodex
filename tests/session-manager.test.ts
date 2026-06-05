/**
 * tests/session-manager.test.ts —— SessionManager 多租户编排单测（注入 fake client/store/provisioner）。
 * 锁定关键接线：per-folder CODEX_HOME、新建 thread/start + 持久化、resume、幂等、隔离、shutdown。
 */
import { describe, it, expect } from 'vitest';
import type {
  IAppServerClient,
  AppServerClientOptions,
  ServerNotificationHandler,
  ServerRequestHandler,
} from '../src/contracts.js';
import type { InitializeResponse } from '../src/appserver/protocol.js';
import type { ISessionStore, ICodexHomeProvisioner } from '../src/runtime/multitenant/types.js';
import { SessionManager } from '../src/runtime/multitenant/session-manager.js';

let threadCounter = 0;

class FakeClient implements IAppServerClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly env: Record<string, string>;
  closed = false;
  private notif = new Set<ServerNotificationHandler>();

  constructor(opts: AppServerClientOptions) {
    this.env = opts.env ?? {};
  }
  async start(): Promise<InitializeResponse> {
    return { userAgent: 'f', codexHome: this.env['CODEX_HOME'] ?? '', platformFamily: 'unix', platformOs: 'darwin' };
  }
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: `th_${++threadCounter}`, sessionId: 's', path: null } } as T;
    if (method === 'thread/resume') {
      const tid = (params as { threadId: string }).threadId;
      return { thread: { id: tid, sessionId: 's', path: null } } as T;
    }
    if (method === 'turn/start') return { turn: { id: `turn_${++threadCounter}` } } as T;
    return {} as T;
  }
  notify(): void {}
  onNotification(h: ServerNotificationHandler): () => void {
    this.notif.add(h);
    return () => this.notif.delete(h);
  }
  onServerRequest(_h: ServerRequestHandler): () => void {
    return () => {};
  }
  onClose(): () => void {
    return () => {};
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  methods(): string[] {
    return this.requests.map((r) => r.method);
  }
}

class FakeStore implements ISessionStore {
  map = new Map<string, string>();
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
  readonly provisioned: string[] = [];
  async provision(folder: string): Promise<string> {
    this.provisioned.push(folder);
    return `/fake/sessions/${folder}/.codex`;
  }
}

function mk(store: FakeStore = new FakeStore()) {
  const clients: FakeClient[] = [];
  const provisioner = new FakeProvisioner();
  const mgr = new SessionManager(
    { dataDir: '/fake', idleTimeoutMs: 0 },
    {
      store,
      provisioner,
      clientFactory: (o) => {
        const c = new FakeClient(o);
        clients.push(c);
        return c;
      },
    },
  );
  return { mgr, clients, store, provisioner };
}

describe('SessionManager', () => {
  it('新 folder → provision CODEX_HOME + thread/start + 持久化 threadId', async () => {
    const { mgr, clients, store, provisioner } = mk();
    const h = await mgr.getOrCreate('home-alice');

    expect(provisioner.provisioned).toEqual(['home-alice']);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.env['CODEX_HOME']).toBe('/fake/sessions/home-alice/.codex');
    expect(clients[0]!.methods()).toContain('thread/start');
    expect(h.threadId).toBeTruthy();
    expect(store.getThreadId('home-alice')).toBe(h.threadId);
    await mgr.shutdownAll();
  });

  it('同 folder 再次 getOrCreate → 复用同一会话（不新建 client）', async () => {
    const { mgr, clients } = mk();
    const h1 = await mgr.getOrCreate('home-alice');
    const h2 = await mgr.getOrCreate('home-alice');
    expect(clients).toHaveLength(1);
    expect(h2.threadId).toBe(h1.threadId);
    await mgr.shutdownAll();
  });

  it('并发 getOrCreate 同 folder → 去重为一个 client', async () => {
    const { mgr, clients } = mk();
    const [a, b] = await Promise.all([mgr.getOrCreate('home-x'), mgr.getOrCreate('home-x')]);
    expect(clients).toHaveLength(1);
    expect(a.threadId).toBe(b.threadId);
    await mgr.shutdownAll();
  });

  it('不同 folder → 不同 client + 不同 threadId（隔离）', async () => {
    const { mgr, clients } = mk();
    const a = await mgr.getOrCreate('home-a');
    const b = await mgr.getOrCreate('home-b');
    expect(clients).toHaveLength(2);
    expect(a.threadId).not.toBe(b.threadId);
    expect(mgr.activeFolders().sort()).toEqual(['home-a', 'home-b']);
    await mgr.shutdownAll();
  });

  it('store 已有 threadId → 走 thread/resume（不 thread/start）', async () => {
    const store = new FakeStore();
    store.setThreadId('home-c', 'th_existing_42');
    const { mgr, clients } = mk(store);
    const h = await mgr.getOrCreate('home-c');
    expect(clients[0]!.methods()).toContain('thread/resume');
    expect(clients[0]!.methods()).not.toContain('thread/start');
    expect(h.threadId).toBe('th_existing_42');
    const resumeReq = clients[0]!.requests.find((r) => r.method === 'thread/resume')!;
    expect((resumeReq.params as { threadId: string }).threadId).toBe('th_existing_42');
    await mgr.shutdownAll();
  });

  it('send → turn/start 发出（经 per-folder 队列）', async () => {
    const { mgr, clients } = mk();
    const h = await mgr.getOrCreate('home-a');
    await h.send('hello');
    expect(clients[0]!.methods()).toContain('turn/start');
    const turnReq = clients[0]!.requests.find((r) => r.method === 'turn/start')!;
    expect((turnReq.params as { input: unknown[] }).input).toEqual([
      { type: 'text', text: 'hello', text_elements: [] },
    ]);
    await mgr.shutdownAll();
  });

  it('shutdown → 关闭 client、移出 activeFolders、保留 store 中的 threadId', async () => {
    const { mgr, clients, store } = mk();
    const h = await mgr.getOrCreate('home-a');
    const tid = h.threadId;
    await mgr.shutdown('home-a');
    expect(clients[0]!.closed).toBe(true);
    expect(mgr.activeFolders()).toEqual([]);
    expect(store.getThreadId('home-a')).toBe(tid); // 持久化保留，可再 resume
  });

  it('shutdown 后再 getOrCreate → 用保留的 threadId resume（跨重启续接）', async () => {
    const { mgr, clients } = mk();
    const h1 = await mgr.getOrCreate('home-a');
    const tid = h1.threadId;
    await mgr.shutdown('home-a');
    const h2 = await mgr.getOrCreate('home-a');
    expect(clients).toHaveLength(2); // 第二个 client
    expect(clients[1]!.methods()).toContain('thread/resume');
    expect(h2.threadId).toBe(tid);
    await mgr.shutdownAll();
  });
});
