/**
 * tests/session-manager.test.ts —— SessionManager 多租户编排单测（注入 fake client/store/provisioner）。
 * 锁定关键接线：per-folder CODEX_HOME、新建 thread/start + 持久化、resume、幂等、隔离、shutdown。
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type {
  IAppServerClient,
  AppServerClientOptions,
  ServerNotificationHandler,
  ServerRequestHandler,
} from '../src/contracts.js';
import type { InitializeResponse } from '../src/appserver/protocol.js';
import type { ISessionStore, ICodexHomeProvisioner } from '../src/runtime/multitenant/types.js';
import { SessionManager } from '../src/runtime/multitenant/session-manager.js';
import { FsCodexHomeProvisioner } from '../src/runtime/multitenant/codex-home.js';

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
  idleTimeoutMs?: number;
  configure?: (c: FakeClient) => void;
}

function mk(arg: FakeStore | MkOpts = {}) {
  const opts: MkOpts = arg instanceof FakeStore ? { store: arg } : arg;
  const store = opts.store ?? new FakeStore();
  const clients: FakeClient[] = [];
  const provisioner = new FakeProvisioner();
  const mgr = new SessionManager(
    { dataDir: '/fake', idleTimeoutMs: opts.idleTimeoutMs ?? 0, maxConcurrent: opts.maxConcurrent },
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
    // 单写者保护：turn/completed 须带主线程 threadId（真实 codex 如此），否则被当子代理 turn 忽略。
    clients[0]!.emit('turn/completed', { threadId: a.threadId, turn: { id: clients[0]!.lastTurnId, status: 'completed' } });
    await mgr.getOrCreate('home-c');
    expect(mgr.activeFolders()).not.toContain('home-a'); // 空闲后被驱逐
    await mgr.shutdownAll();
  });

  it('#4 idleTimeoutMs<=0 + 突发预热：超 cap 的未用过会话仍按 LRU 回收（cap 硬上限生效）', async () => {
    // 原行为：未用过会话永久豁免驱逐 + idleTimeoutMs=0 无 idle timer → cap 形同虚设、app-server 无界。
    // 修复后：无"用过且空闲"victim 时回退到 LRU 未用过会话，强制不超 cap。
    const { mgr, clients } = mk({ maxConcurrent: 2 }); // mk 默认 idleTimeoutMs:0
    for (const f of ['home-a', 'home-b', 'home-c', 'home-d', 'home-e']) {
      await mgr.getOrCreate(f); // 连建 5 个、从不 send
    }
    expect(mgr.activeFolders().length).toBeLessThanOrEqual(2);
    // 被驱逐的会话其 client 已 close（不泄漏 app-server）。
    expect(clients.filter((c) => c.closed).length).toBeGreaterThanOrEqual(3);
    await mgr.shutdownAll();
  });

  it('#4 in-flight 会话即便超 cap 也绝不被驱逐（无可安全回收者 → 软超额）', async () => {
    const { mgr, clients } = mk({ maxConcurrent: 1 });
    const a = await mgr.getOrCreate('home-a');
    await a.send('go'); // a 在飞 turn（未发 turn/completed）

    // maxConcurrent=1 下再建 b：唯一候选 a 在飞 → 不可驱逐 → 软超额。
    await mgr.getOrCreate('home-b');
    expect(mgr.activeFolders().sort()).toEqual(['home-a', 'home-b']);
    expect(clients[0]!.closed).toBe(false); // 在飞会话未被关
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

  it('#5 纯轮询（getOrCreate 命中但从不 send）不续命 → idle timer 如期回收', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, clients } = mk({ idleTimeoutMs: 1000 });
      await mgr.getOrCreate('home-a');
      // 反复轮询同一 folder，但从不 send：不应重置 idle timer。
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(100); // 推进到 500ms，仍 < idleTimeoutMs
        await mgr.getOrCreate('home-a');
      }
      expect(mgr.activeFolders()).toEqual(['home-a']);

      vi.advanceTimersByTime(1000); // 跨过初始 armIdleTimer 的截止
      await Promise.resolve(); // 让 shutdown 的微任务排空
      expect(mgr.activeFolders()).toEqual([]); // 纯轮询未续命 → 被 idle 回收
      expect(clients[0]!.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('#5 send 过的会话再次 getOrCreate 会续命（usedOnce → touch 重置 idle timer，不被回收）', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, clients } = mk({ idleTimeoutMs: 1000 });
      const h = await mgr.getOrCreate('home-a');
      await h.send('go'); // usedOnce=true，touch 重置 idle timer
      // turn 完成 → 空闲，idle timer 开始计时。
      // 单写者保护：turn/completed 须带主线程 threadId（真实 codex 如此），否则被当子代理 turn 忽略。
      clients[0]!.emit('turn/completed', {
        threadId: h.threadId,
        turn: { id: clients[0]!.lastTurnId, status: 'completed' },
      });
      vi.advanceTimersByTime(900); // < idleTimeoutMs
      await mgr.getOrCreate('home-a'); // usedOnce=true → touch 续命，重置 idle timer
      vi.advanceTimersByTime(900); // 距上次续命仅 900ms < 1000ms → 不应被回收
      await Promise.resolve();
      expect(mgr.activeFolders()).toEqual(['home-a']); // 续命成功，仍存活
      await mgr.shutdownAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shutdownAll 后 getOrCreate 抛错（不再创建）', async () => {
    const { mgr } = mk();
    await mgr.getOrCreate('home-a');
    await mgr.shutdownAll();
    await expect(mgr.getOrCreate('home-b')).rejects.toThrow(/shutting down/);
  });
});

// ───────────────────────── B3：enableHooks 信任注入 + 首启重启 ─────────────────────────

/** 会回应 hooks/list 的 FakeClient（其余行为同基类）。currentHash 取自 hooks.json 的 sessionStart/stop。 */
class HooksFakeClient extends FakeClient {
  override async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method === 'hooks/list') {
      this.requests.push({ method, params });
      const home = this.env['CODEX_HOME'] ?? '';
      const hooksPath = nodePath.join(home, 'hooks.json');
      return {
        data: [
          {
            cwd: home,
            hooks: [
              { key: `${hooksPath}:session_start:0:0`, eventName: 'sessionStart', currentHash: 'sha256:ss', trustStatus: 'untrusted', sourcePath: hooksPath },
              { key: `${hooksPath}:stop:0:0`, eventName: 'stop', currentHash: 'sha256:st', trustStatus: 'untrusted', sourcePath: hooksPath },
            ],
          },
        ],
      } as T;
    }
    return super.request<T>(method, params);
  }
}

describe('SessionManager — B3 enableHooks', () => {
  let dataDir: string;
  let sharedCodexHome: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(nodePath.join(os.tmpdir(), 'happycodex-sm-data-'));
    sharedCodexHome = await mkdtemp(nodePath.join(os.tmpdir(), 'happycodex-sm-shared-'));
    await writeFile(nodePath.join(sharedCodexHome, 'auth.json'), '{"tokens":{}}', 'utf8');
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(sharedCodexHome, { recursive: true, force: true });
  });

  function mkHooks() {
    const clients: HooksFakeClient[] = [];
    const provisioner = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome, enableHooks: true });
    const mgr = new SessionManager(
      { dataDir, idleTimeoutMs: 0, enableHooks: true },
      {
        provisioner,
        clientFactory: (o) => {
          const c = new HooksFakeClient(o);
          clients.push(c);
          return c;
        },
      },
    );
    return { mgr, clients };
  }

  it('首启：hooks/list → 写 trusted_hash → 重启 app-server（第二个 client 起来）', async () => {
    const { mgr, clients } = mkHooks();
    await mgr.getOrCreate('home-hk');

    // 首次信任写入 → 关旧 client、起新 client（共 2 个）。
    expect(clients).toHaveLength(2);
    expect(clients[0]!.closed).toBe(true); // 旧 client 已关
    expect(clients[1]!.closed).toBe(false); // 新 client 在用
    // 第一个 client 调过 hooks/list，第二个没有（已信任，二次会 list 但返回 0 写入→不重启）。
    expect(clients[0]!.methods()).toContain('hooks/list');

    // config.toml 落了 trusted_hash。
    const cfg = await readFile(
      nodePath.join(dataDir, 'sessions', 'home-hk', '.codex', 'config.toml'),
      'utf8',
    );
    expect(cfg).toContain('trusted_hash = "sha256:ss"');
    expect(cfg).toContain('trusted_hash = "sha256:st"');
    await mgr.shutdownAll();
  });

  it('第二个 folder 复用同一 shared，但各自独立信任（隔离 CODEX_HOME）', async () => {
    const { mgr, clients } = mkHooks();
    await mgr.getOrCreate('home-a');
    await mgr.getOrCreate('home-b');
    // 每 folder 首启都重启一次 → 2 folder × 2 client = 4。
    expect(clients).toHaveLength(4);
    await mgr.shutdownAll();
  });

  it('已信任则零重启：预置 trusted_hash 后再创建 → 不重启（仅 1 个 client）', async () => {
    // 先跑一次写入 trusted_hash。
    const first = mkHooks();
    await first.mgr.getOrCreate('home-warm');
    await first.mgr.shutdownAll();

    // 再创建同 folder（trusted_hash 已在）→ hooks/list 返回 0 新写入 → 不重启。
    const second = mkHooks();
    await second.mgr.getOrCreate('home-warm');
    expect(second.clients).toHaveLength(1);
    expect(second.clients[0]!.closed).toBe(false);
    await second.mgr.shutdownAll();
  });

  it('enableHooks=false（默认）→ 不调 hooks/list、不重启', async () => {
    const clients: HooksFakeClient[] = [];
    const mgr = new SessionManager(
      { dataDir, idleTimeoutMs: 0 }, // enableHooks 缺省 false
      {
        provisioner: new FsCodexHomeProvisioner({ dataDir, sharedCodexHome }),
        clientFactory: (o) => {
          const c = new HooksFakeClient(o);
          clients.push(c);
          return c;
        },
      },
    );
    await mgr.getOrCreate('home-noh');
    expect(clients).toHaveLength(1);
    expect(clients[0]!.methods()).not.toContain('hooks/list');
    await mgr.shutdownAll();
  });
});
