// Utility functions

import fs from 'fs';
import path from 'path';

import { DATA_DIR, TRUST_PROXY } from './config.js';

/**
 * Strip agent-internal XML tags from output text.
 * Removes `<internal>...</internal>` and `<process>...</process>` blocks
 * that the agent uses for internal reasoning / process tracking.
 */
export function stripAgentInternalTags(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<process>[\s\S]*?<\/process>/g, '')
    .trim();
}

/**
 * Detect whether an agent output is system-maintenance noise that should
 * be suppressed from IM delivery when sourceKind is 'auto_continue'.
 *
 * These are short acknowledgements that the agent generates when its session
 * transcript contains memory-flush / CLAUDE.md-update context from the
 * compaction pipeline (issue #275). Substantive user-facing continuations
 * (task resumption, actual replies) are NOT noise and must pass through.
 *
 * Heuristic: text is "noise" if it is short (<= 30 chars) AND matches a
 * known system-acknowledgement pattern after normalisation.
 */
const NOISE_PATTERNS = [
  /^ok[.。!！]?$/,
  /^好的[.。!！]?$/,
  /^已更新/,
  /^已完成/,
  /^已刷新/,
  /^记忆已/,
  /^claude\.md\s*已/,
  /^memory\s*(flush|updated)/i,
];

export function isSystemMaintenanceNoise(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length > 30) return false;
  return NOISE_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Strip virtual JID suffixes (#task:xxx, #agent:xxx) to get the base JID.
 */
export function stripVirtualJidSuffix(jid: string): string {
  const taskSep = jid.indexOf('#task:');
  if (taskSep >= 0) return jid.slice(0, taskSep);
  const agentSep = jid.indexOf('#agent:');
  if (agentSep >= 0) return jid.slice(0, agentSep);
  return jid;
}

export function getClientIp(c: any): string {
  if (TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const firstIp = xff.split(',')[0]?.trim();
      if (firstIp) return firstIp;
    }
    const realIp = c.req.header('x-real-ip');
    if (realIp) return realIp;
  }
  // Fallback: connection remote address (Hono + Node.js adapter)
  // Hono Node.js adapter 将 IncomingMessage 存于 c.env.incoming
  const connInfo =
    c.env?.incoming?.socket?.remoteAddress ||
    c.env?.remoteAddr ||
    c.req.raw?.socket?.remoteAddress;
  return connInfo || 'unknown';
}

/** Detect if the current request arrived over HTTPS (direct or behind proxy) */
export function isSecureRequest(c: any): boolean {
  if (TRUST_PROXY) {
    const proto = c.req.header('x-forwarded-proto');
    if (proto === 'https') return true;
  }
  try {
    const url = new URL(c.req.url, 'http://localhost');
    if (url.protocol === 'https:') return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * 原子写文件（tmp + rename），继承 runtime-config.writeSecretFile 的两层防御：
 * 1. stale-tmp：Node 的 mode 仅在 on-create 时生效——残留 tmp 会让本次写入复用旧
 *    mode，故写前先 unlink（非 ENOENT 的 unlink 失败上抛，避免静默落错权限）；
 * 2. chmod：传入 mode 时 rename 后再 chmod 一次，防御 APFS 上 mode 不跟随 inode
 *    的边角情况。
 * 不传 mode 时按 Node 默认（0o666 经 umask），与 fs.writeFileSync 行为一致。
 */
export function writeFileAtomic(
  targetPath: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const tmp = `${targetPath}.tmp`;
  try {
    fs.unlinkSync(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  // fd 路径强制 mode 创建：fs.openSync 的 mode 在 O_CREAT 时一定生效，
  // fs.writeFileSync(fd, ...) 内部循环处理 short-write。
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    opts.mode ?? 0o666,
  );
  try {
    fs.writeFileSync(fd, data);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  fs.renameSync(tmp, targetPath);
  if (opts.mode !== undefined) {
    try {
      fs.chmodSync(targetPath, opts.mode);
    } catch {
      /* best effort */
    }
  }
}

/**
 * 防符号链接的原子写（O_NOFOLLOW + O_EXCL）。
 *
 * 与 writeFileAtomic 的区别：后者 unlink+O_CREAT，在 unlink 与 open 之间仍有"重新预放
 * symlink"竞态窗口，O_CREAT 会跟随它写到目标外。当写入路径位于**不可信方可写**的目录
 * （如 agent 容器内 bind-mount 的工作区）时，恶意方可预放 `<target>` 或 `<target>.tmp`
 * 为符号链接，把 host 进程的写引到 root 外/他人文件。本函数：
 *   1) 先 lstat 目标，若已是 symlink 直接拒绝（不覆写、不跟随）；
 *   2) tmp 用 O_WRONLY|O_CREAT|O_TRUNC|O_EXCL|O_NOFOLLOW 创建——已存在或为 symlink 即失败，
 *      杜绝预放；写完 rename 覆盖目标（目录项替换，不跟随目标 symlink）；
 *   3) 任何失败都 unlink tmp，避免下次 O_EXCL 永久 EEXIST 锁死。
 * Windows 无 O_NOFOLLOW → 退回 'wx'（O_EXCL）创建 + 前置 lstat 守 leaf。
 * 源范式见 src/routes/files.ts PUT；供需要在不可信目录安全落盘的调用方复用。
 */
export function writeFileAtomicNoFollow(
  targetPath: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const mode = opts.mode ?? 0o644;
  // 目标若已是符号链接 → 拒绝（不覆写其本体所指）。ENOENT（不存在）正常放行。
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new Error('Refusing to write through a symbolic link');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${targetPath}.tmp`;
  const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  let renameOk = false;
  try {
    if (noFollow !== undefined) {
      const flags =
        fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        fs.constants.O_EXCL |
        noFollow;
      // 首次创建失败若是 EEXIST（残留 tmp：上次写入崩溃遗留的普通文件）或 ELOOP（tmp 是预放的
      // 符号链接，被 O_NOFOLLOW 拒绝）→ unlink 后重试一次：unlink 移除残留/预放物（不跟随），
      // 重试仍用 O_EXCL|O_NOFOLLOW 创建全新 regular tmp。攻击者若在窗口内再次预放 symlink，
      // 重试仍被 O_NOFOLLOW 拒 → fail-closed。与 Windows 分支的自愈一致，避免崩溃残留 tmp 把
      // 下一次合法写入永久锁在 EEXIST。
      let fd: number | null = null;
      try {
        try {
          fd = fs.openSync(tmp, flags, mode);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST' && code !== 'ELOOP') throw err;
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
          fd = fs.openSync(tmp, flags, mode);
        }
        fs.writeFileSync(fd, data);
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    } else {
      // Windows fallback：'wx' = O_EXCL，避免覆写预放的 tmp；残留 tmp 删后重试一次。
      try {
        fs.writeFileSync(tmp, data, { flag: 'wx', mode });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          fs.unlinkSync(tmp);
          fs.writeFileSync(tmp, data, { flag: 'wx', mode });
        } else {
          throw err;
        }
      }
    }
    fs.renameSync(tmp, targetPath);
    renameOk = true;
  } finally {
    if (!renameOk) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Create IPC directories for an agent. */
export function ensureAgentDirectories(
  folder: string,
  agentId: string,
): string {
  const agentIpcDir = path.join(DATA_DIR, 'ipc', folder, 'agents', agentId);
  fs.mkdirSync(path.join(agentIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'tasks'), { recursive: true });
  // tombstone（happycodex）：上游此处预建 per-agent `.claude` 会话目录
  // （sessions/{folder}/agents/{agentId}/.claude）；codex 侧 per-agent 会话目录是
  // `{folder}/agents/{agentId}/.codex`，由 provisionCodexHome（FsCodexHomeProvisioner
  // .provision 的 recursive mkdir）在 spawn 时创建并承载完整 provision 语义
  // （auth.json 复制 / config.toml / agents 物化），此处不预建以免掩盖 provision 失败。
  return agentIpcDir;
}
