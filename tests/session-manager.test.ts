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
  /** 置 true 时 thread/resume 抛错（模拟陈旧 threadId 被拒）。 */
  failResume = false;
  lastTurnId: string | null = null;
  private notif = new Set<ServerNotificationHandler>();
  private closeHandlers = new Set<(info: { code: number | null; signal: string | null; error?: Error }) => void>();

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
      if (this.failResume) throw new Error('resume rejected: stale thread');
      const tid = (params as { threadId: string }).threadId;
      return { thread: { id: tid, sessionId: 's', path: null } } as T;
    }
    if (method === 'turn/start') {
      this.lastTurnId = `turn_${++threadCounter}`;
      return { turn: { id: this.lastTurnId } } as T;
    }
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
  onClose(h: (info: { code: number | null; signal: string | null; error?: Error }) => void): () => void {
    this.closeHandlers.add(h);
    return () => this.closeHandlers.delete(h);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  methods(): string[] {
    return this.requests.map((r) => r.method);
  }
  /** 测试辅助：模拟 server 通知。 */
  emit(method: string, params: unknown): void {
    for (const h of this.notif) h(method, params);
  }
  /** 测试辅助：模拟 app-server 进程退出。 */
  emitClose(): void {
    for (const h of this.closeHandlers) h({ code: 1, signal: null });
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

interface MkOpts {
  store?: FakeStore;
  maxConcurrent?: number;
  configure?: (c: FakeClient) => void;
}

function mk(arg: FakeStore | MkOpts = {}) {
  const opts: MkOpts = arg instanceof FakeStore ? { store: arg } : arg;
  const store = opts.store ?? new FakeStore();
  const clients: FakeClient[] = [];
  const provisioner = new FakeProvisioner();
  const mgr = new SessionManager(
    { dataDir: '/fake', idleTimeoutMs: 0, maxConcurrent: opts.maxConcurrent },
    {
      store,
      provisioner,
      clientFactory: (o) => {
        const c = new FakeClient(o);
        opts.configure?.(c);
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

  // ───────────────────────── code-review 回归 ─────────────────────────

  it('#1/#8 在飞 turn 的 folder 不被 LRU 驱逐（liveness 看 activeTurns 而非仅 queue.isBusy）', async () => {
    const { mgr, clients } = mk({ maxConcurrent: 1 });
    const a = await mgr.getOrCreate('home-a');
    await a.send('go'); // turn/start 响应同步注册 turn → activeTurns=1（未发 turn/completed）

    // maxConcurrent=1 下创建 b：a 仍在飞 turn → 不应被驱逐（软超额）。
    await mgr.getOrCreate('home-b');
    expect(mgr.activeFolders().sort()).toEqual(['home-a', 'home-b']);

    // a 的 turn 完成 → 变空闲；再创建 c 时 a 可被驱逐。
    clients[0]!.emit('turn/completed', { threadId: 'x', turn: { id: clients[0]!.lastTurnId, status: 'completed' } });
    await mgr.getOrCreate('home-c');
    expect(mgr.activeFolders()).not.toContain('home-a'); // 空闲后被驱逐
    await mgr.shutdownAll();
  });

  it('#5 未用过的新会话不被驱逐（留给 idle timer 回收）', async () => {
    const { mgr } = mk({ maxConcurrent: 2 });
    await mgr.getOrCreate('home-a');
    await mgr.getOrCreate('home-b');
    await mgr.getOrCreate('home-c'); // 超 cap，但 a/b 都未 send 过 → 不驱逐
    expect(mgr.activeFolders().sort()).toEqual(['home-a', 'home-b', 'home-c']);
    await mgr.shutdownAll();
  });

  it('#4/#6 create 中途失败（resume 被拒）→ getOrCreate 抛错且 client 被关闭（不泄漏）', async () => {
    const store = new FakeStore();
    store.setThreadId('home-a', 'th_stale');
    const { mgr, clients } = mk({ store, configure: (c) => (c.failResume = true) });
    await expect(mgr.getOrCreate('home-a')).rejects.toThrow(/resume rejected/);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.closed).toBe(true); // 半成品 client 已清理
    expect(mgr.activeFolders()).toEqual([]);
  });

  it('#7 app-server 意外退出 → 自愈摘除 entry，下次 getOrCreate 重建', async () => {
    const { mgr, clients } = mk();
    await mgr.getOrCreate('home-a');
    expect(mgr.activeFolders()).toEqual(['home-a']);
    clients[0]!.emitClose(); // 模拟进程退出
    expect(mgr.activeFolders()).toEqual([]); // 自愈摘除
    await mgr.getOrCreate('home-a');
    expect(clients).toHaveLength(2); // 重建了新 client
    await mgr.shutdownAll();
  });

  it('shutdownAll 后 getOrCreate 抛错（不再创建）', async () => {
    const { mgr } = mk();
    await mgr.getOrCreate('home-a');
    await mgr.shutdownAll();
    await expect(mgr.getOrCreate('home-b')).rejects.toThrow(/shutting down/);
  });
});
