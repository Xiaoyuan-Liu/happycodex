/**
 * Stage 4 多租户层契约（冻结）。
 *
 * 目标：让 happycodex 能安全地同时服务 N 个 folder（用户/群），忠实对齐 HappyClaw 的隔离模型：
 *   HappyClaw  CLAUDE_CONFIG_DIR=data/sessions/{folder}/.claude  +  全局共享 provider 凭据
 *   happycodex CODEX_HOME       =data/sessions/{folder}/.codex   +  共享单 codex 账号（auth 复制进各 home）
 *
 * 架构（standalone，不碰 HappyClaw 主仓）：
 * - 每 folder 一个 CODEX_HOME（隔离 sessions/rollout）→ 因 CODEX_HOME 是进程级，故每 folder 一个
 *   AppServerClient（=每会话一 app-server，天然崩溃隔离）。
 * - SessionStore 持久化 folder→threadId（映射 HappyClaw sessions 表），重连 thread/resume。
 * - 每 folder 串行队列（单写者）防 rollout 无锁并发损坏（互操作调研 P0）。
 * - 工具层（Stage 3）per-folder：IpcToolBridge 指向 data/ipc/{folder} + data/memory/{folder}。
 *
 * 已知 standalone 限制：共享单账号、N 个 CODEX_HOME 各自 refresh token 可能竞争（codex refresh 是
 * auth.json + .bak 原子改写）。PoC 阶段可容忍；生产应集中一个 refresh owner（留待"接主仓"阶段）。
 */

import type { StreamEvent } from '../../shared/stream-event.js';
import type { ThreadSessionConfig } from '../../contracts.js';

/** folder → threadId 的持久化映射（对应 HappyClaw sessions 表）。 */
export interface ISessionStore {
  getThreadId(folder: string): string | null;
  setThreadId(folder: string, threadId: string): void;
  deleteThreadId(folder: string): void;
  all(): Record<string, string>;
}

/** 为 folder 准备隔离的 CODEX_HOME（含共享 auth）。 */
export interface ICodexHomeProvisioner {
  /** 确保 data/sessions/{folder}/.codex 存在并带 auth（从共享源复制），返回其绝对路径。幂等。 */
  provision(folder: string): Promise<string>;
}

/** 按 key 串行执行（单写者）：同一 key 的任务排队，不同 key 并发。 */
export interface ISerialQueue {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** 某 key 是否有在跑/排队的任务。 */
  isBusy(key: string): boolean;
}

/** 一个被托管的 folder 会话句柄。 */
export interface ManagedSessionHandle {
  readonly folder: string;
  readonly codexHome: string;
  readonly threadId: string | null;
  /** 发送用户消息（经 per-folder 串行队列，自动 turn/start vs turn/steer）。 */
  send(text: string): Promise<void>;
  onStreamEvent(handler: (ev: StreamEvent) => void): () => void;
  onTurnCompleted(handler: (info: { turnId: string; subtype: string }) => void): () => void;
}

export interface SessionManagerOptions {
  /** 运行时数据根目录（sessions/ipc/memory 都在其下）。 */
  dataDir: string;
  /** 共享 auth 源目录（默认 codex-paths.sharedCodexHomeDir()：
   *  HAPPYCODEX_SHARED_CODEX_HOME > CODEX_HOME > ~/.codex）。 */
  sharedCodexHome?: string;
  /** codex 可执行文件名，默认 'codex'。 */
  codexBin?: string;
  /** 最大并发活跃 app-server 数（超出时 LRU 关闭最久空闲的）。默认 8。 */
  maxConcurrent?: number;
  /** 会话空闲多久后自动关闭其 app-server（毫秒）。默认 30min。0=不自动关。 */
  idleTimeoutMs?: number;
  /** 每个会话的默认配置（approvalPolicy/sandbox 等）。 */
  sessionConfig?: ThreadSessionConfig;
  /** 是否给每个 folder 挂 Stage 3 工具层（IpcToolBridge + 12 工具）。默认 false。 */
  enableTools?: boolean;
  /**
   * B3：是否给每个 folder 注入 SessionStart + Stop hook（hooks.json + [features] hooks=true
   * + 首启信任注入 trusted_hash）。默认 false。开启后 hook 触发 → hook/started|completed 通知
   * → mapper → StreamEvent。
   */
  enableHooks?: boolean;
}

/** 多租户会话编排器。 */
export interface ISessionManager {
  /** 取得（或懒创建并 resume/start）folder 的会话句柄。 */
  getOrCreate(folder: string): Promise<ManagedSessionHandle>;
  /** 当前活跃（已加载 app-server）的 folder 列表。 */
  activeFolders(): string[];
  /** 关闭某 folder 的会话（保留其持久化 threadId，可再 resume）。 */
  shutdown(folder: string): Promise<void>;
  /** 关闭全部。 */
  shutdownAll(): Promise<void>;
}
