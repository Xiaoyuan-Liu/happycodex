/**
 * SessionManager —— Stage 4 多租户编排器（实现 ISessionManager）。
 *
 * 把 Stage 0-3 的单会话运行时扩成"一进程编排 N 个 folder"：
 * - 每 folder 一个隔离 CODEX_HOME（provisioner）→ 每 folder 一个 AppServerClient（=每会话一 app-server）。
 * - folder→threadId 持久化（store）：有则 thread/resume 续接，无则 thread/start 并存 id。
 * - per-folder 串行队列（queue）做单写者闸门，防 rollout 无锁并发损坏。
 * - 生命周期池：idle 超时自动关 app-server；超 maxConcurrent 时 LRU 关最久空闲的。
 * - 可选 per-folder 工具层（Stage 3）：IpcToolBridge + 12 工具 + dispatcher。
 *
 * 依赖可注入（deps）以便测试用替身；默认用真实实现。
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
  readonly handle: ManagedSessionHandle;
  lastActiveSeq: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
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
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      entry.dispatcher?.dispose();
    } catch {
      /* ignore */
    }
    try {
      entry.session.dispose();
    } catch {
      /* ignore */
    }
    await entry.client.close().catch(() => {});
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((f) => this.shutdown(f)));
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async create(folder: string): Promise<Entry> {
    await this.evictIfNeeded();

    const codexHome = await this.provisioner.provision(folder);
    const client = this.clientFactory({
      codexBin: this.codexBin,
      env: { CODEX_HOME: codexHome },
    });
    await client.start();

    const resumeThreadId = this.store.getThreadId(folder) ?? undefined;
    const config: ThreadSessionConfig = { ...this.sessionConfig, resumeThreadId };

    let dispatcher: ToolDispatcher | null = null;
    if (this.enableTools) {
      const registry = new ToolRegistry();
      for (const def of createBuiltinTools()) registry.register(def);
      const bridge = new IpcToolBridge({
        ipcDir: path.join(this.dataDir, 'ipc'),
        memoryDir: path.join(this.dataDir, 'memory'),
      });
      config.dynamicTools = registry.specs();
      // dispatcher 在 session 创建后挂（需 getThreadId）；先建 session。
      const session = new ThreadSession(client, config);
      dispatcher = new ToolDispatcher(client, registry, {
        groupFolder: folder,
        bridge,
        getThreadId: () => session.state.threadId,
      });
      return this.startSession(folder, codexHome, client, session, dispatcher);
    }

    const session = new ThreadSession(client, config);
    return this.startSession(folder, codexHome, client, session, null);
  }

  private async startSession(
    folder: string,
    codexHome: string,
    client: IAppServerClient,
    session: ThreadSession,
    dispatcher: ToolDispatcher | null,
  ): Promise<Entry> {
    await session.start();
    // thread/start | thread/resume 响应已带回 threadId → 持久化（resume 时幂等）。
    const tid = session.state.threadId;
    if (tid) this.store.setThreadId(folder, tid);

    const handle: ManagedSessionHandle = {
      folder,
      codexHome,
      get threadId() {
        return session.state.threadId;
      },
      send: (text: string) =>
        this.queue.run(folder, async () => {
          const entry = this.entries.get(folder);
          if (entry) this.touch(entry);
          await session.sendUserMessage(text);
        }),
      onStreamEvent: (h: (ev: StreamEvent) => void) => session.onStreamEvent(h),
      onTurnCompleted: (h) => session.onTurnCompleted(h),
    };

    const entry: Entry = {
      folder,
      codexHome,
      client,
      session,
      dispatcher,
      handle,
      lastActiveSeq: ++this.seq,
      idleTimer: null,
    };
    this.entries.set(folder, entry);
    this.armIdleTimer(entry);
    return entry;
  }

  private touch(entry: Entry): void {
    entry.lastActiveSeq = ++this.seq;
    this.armIdleTimer(entry);
  }

  private armIdleTimer(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.idleTimeoutMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      // 仅在空闲（无在跑/排队 turn）时回收；否则重新计时。
      if (this.queue.isBusy(entry.folder)) {
        this.armIdleTimer(entry);
        return;
      }
      void this.shutdown(entry.folder);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  /** 超过并发上限时，关闭最久未活跃且不忙的会话。 */
  private async evictIfNeeded(): Promise<void> {
    if (this.entries.size < this.maxConcurrent) return;
    let victim: Entry | null = null;
    for (const entry of this.entries.values()) {
      if (this.queue.isBusy(entry.folder)) continue;
      if (!victim || entry.lastActiveSeq < victim.lastActiveSeq) victim = entry;
    }
    if (victim) await this.shutdown(victim.folder);
    // 全忙时不强制驱逐：允许临时超过软上限，避免打断在跑的 turn。
  }
}
