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
 * - 驱逐优先挑"用过且当前空闲"的 LRU；无则回退到任意非 busy 的 LRU（含未用过），强制 cap，
 *   不再永久豁免未用过会话（避免 idleTimeoutMs<=0/突发预热下 app-server 无界）。in-flight 绝不驱逐。
 *   纯轮询（getOrCreate 命中但从不 send）不再 touch 续命，交还 idle timer 回收；
 *   容量计 entries+creating，防并发突发超额 spawn。#4/#5/#10
 */

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
import { HOOKS_JSON_FILE, trustManagedHooks } from './hooks-config.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBuiltinTools } from '../tools/builtin.js';
import { IpcToolBridge } from '../tools/ipc-bridge.js';
import { ToolDispatcher } from '../tools/dispatcher.js';
import { sharedCodexHomeDir } from '../../codex-paths.js';

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

/**
 * CR#7：standalone 编排下 IpcToolBridge 请求-响应工具的 poll 超时。
 * 本编排器自身就是顶层进程——没有 HappyClaw 主进程消费 {dataDir}/ipc 下的请求文件，
 * list_tasks/install_skill/uninstall_skill/discord_* 永远等不到回执。短超时让 listTasks
 * 3s 即降级本地快照、其余工具 3s 诚实超时，而非按上游默认（30s / install 120s）把
 * turn 阻塞到 dispatcher 看门狗边缘。接入真实主进程消费者时应移除此覆盖、恢复上游默认。
 */
const STANDALONE_POLL_TIMEOUT_MS = 3_000;

// 委托单一真相源（codex-paths）：与 config/container-runner/sdk-query/mcp-servers
// 同一三级链 HAPPYCODEX_SHARED_CODEX_HOME > CODEX_HOME > ~/.codex（CR#5：消除最后
// 一处分叉副本，原实现仅 CODEX_HOME > ~/.codex 漏了顶层覆盖键）。
function defaultSharedCodexHome(): string {
  return sharedCodexHomeDir();
}

export class SessionManager implements ISessionManager {
  private readonly dataDir: string;
  private readonly codexBin: string | undefined;
  private readonly maxConcurrent: number;
  private readonly idleTimeoutMs: number;
  private readonly sessionConfig: ThreadSessionConfig;
  private readonly enableTools: boolean;
  private readonly enableHooks: boolean;

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
    this.enableHooks = opts.enableHooks ?? false;

    const sharedCodexHome = opts.sharedCodexHome ?? defaultSharedCodexHome();
    this.store = deps.store ?? new SessionStore(path.join(this.dataDir, 'sessions', 'index.json'));
    this.provisioner =
      deps.provisioner ??
      new FsCodexHomeProvisioner({
        dataDir: this.dataDir,
        sharedCodexHome,
        enableHooks: this.enableHooks,
      });
    this.queue = deps.queue ?? new SerialQueue();
    this.clientFactory = deps.clientFactory ?? ((o) => new AppServerClient(o));
  }

  async getOrCreate(folder: string): Promise<ManagedSessionHandle> {
    if (this.shuttingDown) throw new Error('SessionManager is shutting down');
    const existing = this.entries.get(folder);
    if (existing) {
      // 仅"真正用过"（至少 send 过一次）的会话在再次取用时续命（刷新 LRU + 重置 idle）。
      // 纯轮询（从未 send）的 getOrCreate 命中不延长寿命，交还 idle timer 回收，避免
      // usedOnce=false 免驱逐 + touch 重置 idle 双重保护造成的"永生"软超额。#5
      if (existing.usedOnce) this.touch(existing);
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

      // B3：首启信任注入 —— hooks/list 读 codex 自算的 currentHash → 写 config.toml 的
      // trusted_hash → 重启 app-server 使 trustStatus 翻 'trusted'，hook 方可执行。
      // 仅首次（trusted_hash 缺失）才重启；之后幂等命中、零重启。
      if (this.enableHooks) {
        client = await this.trustHooksAndMaybeRestart(client, codexHome);
      }

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
          // standalone 无主进程消费者：请求-响应工具用短 poll 超时（见常量注释）。
          pollTimeoutMs: STANDALONE_POLL_TIMEOUT_MS,
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

  /**
   * B3 信任注入：调 hooks/list 读 currentHash → 写 trusted_hash。
   * 若写入了新条目（首次信任），当前 client 已用旧 config 启动、感知不到信任态，
   * 故关掉它、用同一 codexHome 重启一个新 client（读到 trusted_hash → hook 可执行）。
   * 返回应继续使用的 client（重启则为新实例，否则原实例）。
   * 容错：hooks/list 失败不阻塞会话创建（hook 不触发但会话仍可用）。
   */
  private async trustHooksAndMaybeRestart(
    client: IAppServerClient,
    codexHome: string,
  ): Promise<IAppServerClient> {
    const hooksJsonPath = path.join(codexHome, HOOKS_JSON_FILE);
    let newlyTrusted = 0;
    try {
      newlyTrusted = await trustManagedHooks(client, codexHome, hooksJsonPath);
    } catch {
      return client; // hooks/list 不可用 → 跳过信任，会话照常（hook 不触发）。
    }
    if (newlyTrusted === 0) return client; // 已信任过 → 零重启。
    // 首次信任：重启 app-server 让 trusted_hash 生效。
    await client.close().catch(() => {});
    const fresh = this.clientFactory({ codexBin: this.codexBin, env: { CODEX_HOME: codexHome } });
    await fresh.start();
    return fresh;
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

  /**
   * 超容量时驱逐一个空闲会话以强制 maxConcurrent 硬上限。
   *
   * 选取顺序：优先回收"用过且空闲"的 LRU；若无，则回退到任意"非 busy"的 LRU（含未用过会话），
   * 而非永久豁免未用过会话——后者把回收安全网完全外包给 idle timer，在 idleTimeoutMs<=0
   * （永不自动关）或突发预热场景下会让 cap 失效、app-server 无界增长。#4
   *
   * 唯一允许软超额的情形：所有 entry 都 in-flight（activeTurns>0 / 队列在途），此时无可安全回收者，
   * 只能等其结束——这是无法避免且安全的。in-flight 会话绝不被驱逐。
   */
  private async evictIfNeeded(): Promise<void> {
    // 计入在飞 create，避免并发突发各自跳过驱逐而超额 spawn。
    const load = this.entries.size + this.creating.size;
    if (load < this.maxConcurrent) return;
    let preferred: Entry | null = null; // 用过且空闲：首选
    let fallback: Entry | null = null; // 任意非 busy（含未用过）：硬上限兜底
    for (const e of this.entries.values()) {
      if (this.isFolderBusy(e.folder)) continue; // 在飞 turn / 在途 send → 绝不动
      if (!fallback || e.lastActiveSeq < fallback.lastActiveSeq) fallback = e;
      if (e.usedOnce && (!preferred || e.lastActiveSeq < preferred.lastActiveSeq)) preferred = e;
    }
    const victim = preferred ?? fallback; // 优先回收用过的；否则回收 LRU 未用过的，保证不超 cap
    if (victim) await this.shutdown(victim.folder);
    // victim 仍为 null 仅当所有 entry 都 in-flight → 软超额，等其结束。
  }
}
