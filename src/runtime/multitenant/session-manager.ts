/**
 * SessionManager —— Stage 4 多租户编排器（实现 ISessionManager）。
 *
 * 把 Stage 0-3 的单会话运行时扩成"一进程编排 N 个 folder"：
 * - 每 folder 一个隔离 CODEX_HOME（provisioner）→ 每 folder 一个 AppServerClient（=每会话一 app-server）。
 * - folder→threadId 持久化（store）：有则 thread/resume 续接，无则 thread/start 并存 id。
 * - per-folder 串行队列（queue）做单写者闸门，防 rollout 无锁并发损坏。
 * - 生命周期池：idle 超时自动关 app-server；超 maxConcurrent 时 LRU 关最久空闲的。
 * - 可选 per-folder 工具层（Stage 3）：IpcToolBridge + 12 工具 + dispatcher。
 * - ApprovalResponder 安全网：审批请求自动应答，杜绝 turn 死锁。默认 approvalPolicy='never'。
 *
 * 生命周期/并发健壮性（code-review 修复）：
 * - liveness 以"在飞 turn + 队列在途"为准（isFolderBusy），不再仅看 SerialQueue.isBusy
 *   （后者在 turn 仍流式时已归零，会把活跃会话误判空闲而 mid-turn 回收）。#1/#8
 * - create() 全程 try/catch：任一步抛错（如陈旧 threadId 的 thread/resume 被拒）都清理已建的
 *   client/订阅，不泄漏 app-server 子进程。#4/#6
 * - client.onClose 自愈：app-server 意外退出 → 自动从 entries 摘除，下次 getOrCreate 重建。#7
 * - shuttingDown 闸 + 等待在飞 create：shutdownAll 不漏掉正在创建的会话。#3
 * - 驱逐只挑"用过且当前空闲"的会话（未用过的新句柄由 idle timer 回收，不被驱逐抢关）；
 *   容量计 entries+creating，防并发突发超额 spawn。#5/#10
 */

import os from 'node:os';
import path from 'node:path';

import type {
  ISessionManager,
  ManagedSessionHandle,
  SessionManagerOptions,
  ISessionStore,
  ICodexHomeProvisioner,
  ISerialQueue,
} from './types.js';
import type { AppServerClientOptions, IAppServerClient, ThreadSessionConfig } from '../../contracts.js';
import type { StreamEvent } from '../../shared/stream-event.js';

import { AppServerClient } from '../../appserver/client.js';
import { ThreadSession } from '../session.js';
import { ApprovalResponder } from '../approval-responder.js';
import { SessionStore } from './session-store.js';
import { FsCodexHomeProvisioner } from './codex-home.js';
import { SerialQueue } from './serial-queue.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBuiltinTools } from '../tools/builtin.js';
import { IpcToolBridge } from '../tools/ipc-bridge.js';
import { ToolDispatcher } from '../tools/dispatcher.js';

export interface SessionManagerDeps {
  store?: ISessionStore;
  provisioner?: ICodexHomeProvisioner;
  queue?: ISerialQueue;
  /** 创建 AppServerClient 的工厂（测试可注入替身）。 */
  clientFactory?: (opts: AppServerClientOptions) => IAppServerClient;
}

interface Entry {
  readonly folder: string;
  readonly codexHome: string;
  readonly client: IAppServerClient;
  readonly session: ThreadSession;
  readonly dispatcher: ToolDispatcher | null;
  readonly approvalResponder: ApprovalResponder;
  readonly handle: ManagedSessionHandle;
  readonly offTurnStarted: () => void;
  readonly offTurnCompleted: () => void;
  offClose: () => void;
  lastActiveSeq: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 在飞 turn 数（onTurnStarted++ / onTurnCompleted--）。 */
  activeTurns: number;
  /** 是否被实际用过（至少 send 过一次）。未用过的新句柄不应被 LRU 驱逐抢关。 */
  usedOnce: boolean;
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function defaultSharedCodexHome(): string {
  return process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
}

export class SessionManager implements ISessionManager {
  private readonly dataDir: string;
  private readonly codexBin: string | undefined;
  private readonly maxConcurrent: number;
  private readonly idleTimeoutMs: number;
  private readonly sessionConfig: ThreadSessionConfig;
  private readonly enableTools: boolean;

  private readonly store: ISessionStore;
  private readonly provisioner: ICodexHomeProvisioner;
  private readonly queue: ISerialQueue;
  private readonly clientFactory: (opts: AppServerClientOptions) => IAppServerClient;

  private readonly entries = new Map<string, Entry>();
  /** 同一 folder 并发 getOrCreate 去重。 */
  private readonly creating = new Map<string, Promise<Entry>>();
  private seq = 0;
  private shuttingDown = false;

  constructor(opts: SessionManagerOptions, deps: SessionManagerDeps = {}) {
    this.dataDir = opts.dataDir;
    this.codexBin = opts.codexBin;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sessionConfig = opts.sessionConfig ?? {};
    this.enableTools = opts.enableTools ?? false;

    const sharedCodexHome = opts.sharedCodexHome ?? defaultSharedCodexHome();
    this.store = deps.store ?? new SessionStore(path.join(this.dataDir, 'sessions', 'index.json'));
    this.provisioner =
      deps.provisioner ?? new FsCodexHomeProvisioner({ dataDir: this.dataDir, sharedCodexHome });
    this.queue = deps.queue ?? new SerialQueue();
    this.clientFactory = deps.clientFactory ?? ((o) => new AppServerClient(o));
  }

  async getOrCreate(folder: string): Promise<ManagedSessionHandle> {
    if (this.shuttingDown) throw new Error('SessionManager is shutting down');
    const existing = this.entries.get(folder);
    if (existing) {
      this.touch(existing);
      return existing.handle;
    }
    const inflight = this.creating.get(folder);
    if (inflight) return (await inflight).handle;

    const promise = this.create(folder);
    this.creating.set(folder, promise);
    try {
      const entry = await promise;
      return entry.handle;
    } finally {
      this.creating.delete(folder);
    }
  }

  activeFolders(): string[] {
    return [...this.entries.keys()];
  }

  async shutdown(folder: string): Promise<void> {
    const entry = this.entries.get(folder);
    if (!entry) return;
    this.entries.delete(folder);
    this.teardownEntry(entry);
    await entry.client.close().catch(() => {});
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    // 等待在飞 create 结算（它们要么已登记进 entries、要么因 shuttingDown 自行清理）。
    await Promise.allSettled([...this.creating.values()]);
    await Promise.all([...this.entries.keys()].map((f) => this.shutdown(f)));
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async create(folder: string): Promise<Entry> {
    await this.evictIfNeeded();

    let client: IAppServerClient | null = null;
    let session: ThreadSession | null = null;
    let dispatcher: ToolDispatcher | null = null;
    let approvalResponder: ApprovalResponder | null = null;
    try {
      const codexHome = await this.provisioner.provision(folder);
      client = this.clientFactory({ codexBin: this.codexBin, env: { CODEX_HOME: codexHome } });
      await client.start();
      // 审批安全网（始终装，防死锁）。
      approvalResponder = new ApprovalResponder(client);

      const resumeThreadId = this.store.getThreadId(folder) ?? undefined;
      const config: ThreadSessionConfig = {
        // 自治运行时默认 never（无人工审批 UI）；调用方可显式覆盖。
        approvalPolicy: this.sessionConfig.approvalPolicy ?? 'never',
        ...this.sessionConfig,
        resumeThreadId,
      };

      if (this.enableTools) {
        const registry = new ToolRegistry();
        for (const def of createBuiltinTools()) registry.register(def);
        const bridge = new IpcToolBridge({
          ipcDir: path.join(this.dataDir, 'ipc'),
          memoryDir: path.join(this.dataDir, 'memory'),
        });
        config.dynamicTools = registry.specs();
        const s = new ThreadSession(client, config);
        session = s;
        dispatcher = new ToolDispatcher(client, registry, {
          groupFolder: folder,
          bridge,
          getThreadId: () => s.state.threadId,
        });
      } else {
        session = new ThreadSession(client, config);
      }

      await session.start();
      const tid = session.state.threadId;
      if (tid) this.store.setThreadId(folder, tid);

      if (this.shuttingDown) throw new Error('SessionManager is shutting down');
      return this.registerEntry(folder, codexHome, client, session, dispatcher, approvalResponder);
    } catch (err) {
      // 清理半成品资源，避免泄漏 app-server 子进程 / 订阅。
      try {
        approvalResponder?.dispose();
      } catch {
        /* ignore */
      }
      try {
        dispatcher?.dispose();
      } catch {
        /* ignore */
      }
      try {
        session?.dispose();
      } catch {
        /* ignore */
      }
      if (client) await client.close().catch(() => {});
      throw err;
    }
  }

  private registerEntry(
    folder: string,
    codexHome: string,
    client: IAppServerClient,
    session: ThreadSession,
    dispatcher: ToolDispatcher | null,
    approvalResponder: ApprovalResponder,
  ): Entry {
    const entry: Entry = {
      folder,
      codexHome,
      client,
      session,
      dispatcher,
      approvalResponder,
      handle: undefined as unknown as ManagedSessionHandle,
      offTurnStarted: session.onTurnStarted(() => {
        entry.activeTurns += 1;
      }),
      offTurnCompleted: session.onTurnCompleted(() => {
        if (entry.activeTurns > 0) entry.activeTurns -= 1;
      }),
      offClose: () => {},
      lastActiveSeq: ++this.seq,
      idleTimer: null,
      activeTurns: 0,
      usedOnce: false,
    };
    // app-server 意外退出 → 自愈摘除。
    entry.offClose = client.onClose(() => this.handleUnexpectedClose(folder, entry));

    (entry as { handle: ManagedSessionHandle }).handle = {
      folder,
      codexHome,
      get threadId() {
        return session.state.threadId;
      },
      send: (text: string) =>
        this.queue.run(folder, async () => {
          const e = this.entries.get(folder);
          if (e) {
            e.usedOnce = true;
            this.touch(e);
          }
          await session.sendUserMessage(text);
        }),
      onStreamEvent: (h: (ev: StreamEvent) => void) => session.onStreamEvent(h),
      onTurnCompleted: (h) => session.onTurnCompleted(h),
    };

    this.entries.set(folder, entry);
    this.armIdleTimer(entry);
    return entry;
  }

  /** 拆除一个 entry 的订阅/计时器/工具（不含 client.close，由调用方决定）。 */
  private teardownEntry(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    try {
      entry.offClose(); // 先摘 onClose，避免 close() 触发自愈重入
    } catch {
      /* ignore */
    }
    try {
      entry.offTurnStarted();
      entry.offTurnCompleted();
    } catch {
      /* ignore */
    }
    try {
      entry.dispatcher?.dispose();
    } catch {
      /* ignore */
    }
    try {
      entry.approvalResponder.dispose();
    } catch {
      /* ignore */
    }
    try {
      entry.session.dispose();
    } catch {
      /* ignore */
    }
  }

  /** app-server 进程意外退出时自愈：摘除该 entry（client 已死，无需再 close）。 */
  private handleUnexpectedClose(folder: string, entry: Entry): void {
    if (this.entries.get(folder) !== entry) return;
    this.entries.delete(folder);
    this.teardownEntry(entry);
  }

  private touch(entry: Entry): void {
    entry.lastActiveSeq = ++this.seq;
    this.armIdleTimer(entry);
  }

  /** folder 是否"活跃"：有在途 send 或在飞 turn（后者 SerialQueue.isBusy 反映不到）。 */
  private isFolderBusy(folder: string): boolean {
    if (this.queue.isBusy(folder)) return true;
    const e = this.entries.get(folder);
    return e ? e.activeTurns > 0 : false;
  }

  private armIdleTimer(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.idleTimeoutMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      if (this.isFolderBusy(entry.folder)) {
        this.armIdleTimer(entry); // 仍活跃，重新计时（不 mid-turn 回收）
        return;
      }
      void this.shutdown(entry.folder);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  /** 超容量时驱逐一个"用过且当前空闲"的会话（未用过的新句柄/在飞会话不抢关）。 */
  private async evictIfNeeded(): Promise<void> {
    // 计入在飞 create，避免并发突发各自跳过驱逐而超额 spawn。
    const load = this.entries.size + this.creating.size;
    if (load < this.maxConcurrent) return;
    let victim: Entry | null = null;
    for (const e of this.entries.values()) {
      if (!e.usedOnce) continue; // 未用过 → 留给 idle timer 回收，不驱逐
      if (this.isFolderBusy(e.folder)) continue; // 在飞 turn / 在途 send → 不动
      if (!victim || e.lastActiveSeq < victim.lastActiveSeq) victim = e;
    }
    if (victim) await this.shutdown(victim.folder);
    // 无可驱逐者（全在飞/全未用过）→ 允许临时软超额，由 idle timer 后续回收。
  }
}
