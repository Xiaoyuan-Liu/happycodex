/**
 * per-user codex device-auth 子进程编排管理器（单一职责）。
 *
 * 以 env CODEX_HOME=userCodexHomeDir(userId) spawn `codex login --device-auth`，
 * 从 stdout/stderr 抽取 verification URI + user code 推给 onUpdate；进程退出码 0
 * 即视为 auth.json 已落 per-user 目录（authorized），非 0 / 解析超时 → error，
 * 15min 总超时 → kill 进程树 + expired。
 *
 * 生命周期对标 happyclaw WhatsApp 连接工厂：同一 userId 只允许一个 in-flight，
 * 再次 start 先 kill 旧的；getState(userId) 供 WS 重连恢复；进程 + 定时器全清理，
 * 无僵尸。
 *
 * 安全：token 经子进程落盘（codex 自己写 auth.json），本模块不读 token、不打印
 * 明文凭据到日志——只抓取公开的 verification URI / 短码（device-auth 设计本就给
 * 用户在浏览器里看的）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';
import { userCodexHomeDir, CODEX_AUTH_FILE } from './codex-paths.js';

/** WS 事件 `codex_device_auth` 的 payload（与 WsMessageOut 成员同构）。 */
export interface CodexDeviceAuthState {
  status: 'pending' | 'authorized' | 'expired' | 'error';
  verificationUri?: string;
  userCode?: string;
  expiresInSec?: number;
  error?: string;
}

export type CodexDeviceAuthUpdate = (state: CodexDeviceAuthState) => void;

/** device-auth 总超时（15min，与 codex device flow 的码有效期对齐）。 */
const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

/** pending 推送里的 expiresInSec（contract 固定 900s）。 */
const DEVICE_AUTH_EXPIRES_SEC = 900;

/**
 * 从一段输出里抓 verification URL + 紧邻的 user code。
 * codex 0.137.0 device-auth 打印形如 `https://auth.openai.com/codex/device` +
 * 一个短码（如 `ABCD-1234`）。用宽松正则：先抓首个 https URL，再抓一个看起来像
 * 短码的 token（4-12 个 [A-Z0-9-]，含至少一个字母或连字符，避免误抓纯数字端口/时间）。
 */
function parseVerification(text: string): {
  verificationUri?: string;
  userCode?: string;
} {
  const out: { verificationUri?: string; userCode?: string } = {};
  const urlMatch = text.match(/https?:\/\/[^\s'"]+/);
  if (urlMatch) {
    // 去掉尾随标点（句号 / 逗号 / 右括号）。
    let u = urlMatch[0].replace(/[.,);'"]+$/, '');
    // 只保留 origin+pathname，剥去 query/fragment：防止 codex 万一把凭据带进 URL 被原样
    // 转发到前端/WS（device-auth 只需 device 端点 URL；user code 已单独提取展示）。
    try {
      const parsed = new URL(u);
      u = parsed.origin + parsed.pathname;
    } catch {
      /* 非法 URL → 退回清理后的原串 */
    }
    out.verificationUri = u;
  }
  // 短码：优先匹配带连字符的 XXXX-XXXX 形态，退化到一段 6-10 位大写字母数字。
  const dashCode = text.match(/\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/);
  if (dashCode) {
    out.userCode = dashCode[0];
  } else {
    const bareCode = text.match(/\b(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,10}\b/);
    if (bareCode) out.userCode = bareCode[0];
  }
  return out;
}

interface InFlight {
  child: ChildProcess;
  state: CodexDeviceAuthState;
  timer: NodeJS.Timeout;
  onUpdate: CodexDeviceAuthUpdate;
  /** 是否已抓到并推过 pending（避免重复推 verification）。 */
  sawPending: boolean;
  /** 终结（authorized/expired/error）后置位，幂等防多次清理。 */
  done: boolean;
}

/** userId → 进行中的 device-auth 流程。 */
const inflight = new Map<string, InFlight>();

/**
 * 杀进程树（detached 启动 → 负 PID 杀整组），失败退化到直接 kill。
 * 与 container-runner.killProcessTree 同语义，本模块自带一份以保持零耦合
 * （codex-device-auth 是纯子进程编排，不反向依赖 runner 层）。
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    /* 进程组不存在 / 已退出 → 退化到直接 kill */
  }
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

/**
 * 启动（或复用）某 userId 的 device-auth 流程。
 *
 * - 同一 userId 已有 in-flight：kill 旧进程后重新 start（用户重试时不残留僵尸）。
 * - 非法 userId 由 userCodexHomeDir 抛错（调用方应已校验或捕获）。
 * - onUpdate 推送序列：pending（抓到 URL/码后）→ authorized | error | expired。
 */
export function startDeviceAuth(
  userId: string,
  onUpdate: CodexDeviceAuthUpdate,
  opts: { codexBin?: string } = {},
): void {
  // 复用 / 抢占：先终结旧流程（不向旧 onUpdate 再推，直接清理）。
  const existing = inflight.get(userId);
  if (existing && !existing.done) {
    existing.done = true;
    clearTimeout(existing.timer);
    killTree(existing.child, 'SIGKILL');
    inflight.delete(userId);
  }

  const codexHome = userCodexHomeDir(userId);
  const codexBin = opts.codexBin ?? 'codex';

  let child: ChildProcess;
  try {
    child = spawn(codexBin, ['login', '--device-auth'], {
      // CODEX_HOME 指向 per-user 目录：device-auth 成功后 codex 直接把 auth.json
      // 写进这里。detached 方便超时时杀整个进程树。
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    logger.warn({ err, userId }, 'codex device-auth: failed to spawn');
    onUpdate({ status: 'error', error: 'Failed to start codex login' });
    return;
  }

  const record: InFlight = {
    child,
    state: { status: 'pending' },
    timer: setTimeout(() => {}, 0), // 占位，下面立即覆盖
    onUpdate,
    sawPending: false,
    done: false,
  };
  clearTimeout(record.timer);

  /** 统一终结：置 done、清定时器、从表移除、推一次终态。 */
  const finalize = (state: CodexDeviceAuthState): void => {
    if (record.done) return;
    record.done = true;
    clearTimeout(record.timer);
    inflight.delete(userId);
    record.state = state;
    try {
      onUpdate(state);
    } catch (err) {
      logger.warn({ err, userId }, 'codex device-auth: onUpdate threw on finalize');
    }
  };

  record.timer = setTimeout(() => {
    logger.warn({ userId }, 'codex device-auth: timed out, killing');
    killTree(child, 'SIGKILL');
    finalize({ status: 'expired', error: 'Device authorization timed out' });
  }, DEVICE_AUTH_TIMEOUT_MS);

  // stdout/stderr 都可能承载 verification 信息（不同 codex 版本输出流不一）。
  // 安全：只抓 URL + 短码（公开信息），绝不记录原始输出（可能含 token 回显）。
  const onChunk = (chunk: Buffer): void => {
    if (record.done || record.sawPending) return;
    const text = chunk.toString();
    const { verificationUri, userCode } = parseVerification(text);
    if (verificationUri) {
      record.sawPending = true;
      const state: CodexDeviceAuthState = {
        status: 'pending',
        verificationUri,
        userCode,
        expiresInSec: DEVICE_AUTH_EXPIRES_SEC,
      };
      record.state = state;
      try {
        onUpdate(state);
      } catch (err) {
        logger.warn({ err, userId }, 'codex device-auth: onUpdate threw on pending');
      }
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  child.on('error', (err) => {
    logger.warn({ err: err.message, userId }, 'codex device-auth: spawn error');
    finalize({ status: 'error', error: 'codex login process error' });
  });

  child.on('close', (code) => {
    if (record.done) return;
    // 退出码 0 ≠ 成功：必须确认 auth.json 真的落了 per-user CODEX_HOME。codex 某些退出
    // 路径（用户放弃授权但 poll 循环干净退出 / 未来版本 exit 0 on cancel / 写到别处）可能
    // exit 0 却没写凭据——若仅凭退出码报 authorized，下一次 provision 会"缺 auth.json"或
    // （fallback 开时）静默退回共享账号，与 WS 报的"已登录"矛盾。
    if (code === 0 && fs.existsSync(path.join(codexHome, CODEX_AUTH_FILE))) {
      finalize({ status: 'authorized' });
    } else if (code === 0) {
      logger.warn({ userId }, 'codex device-auth: exited 0 but no auth.json written');
      finalize({ status: 'error', error: 'codex login 已退出但未写入凭据，请重试' });
    } else {
      logger.warn({ code, userId }, 'codex device-auth: exited non-zero');
      finalize({ status: 'error', error: 'codex login failed' });
    }
  });

  inflight.set(userId, record);
}

/**
 * 取某 userId 当前 device-auth 状态（供 WS 重连恢复）。无 in-flight → undefined。
 */
export function getDeviceAuthState(
  userId: string,
): CodexDeviceAuthState | undefined {
  return inflight.get(userId)?.state;
}

/**
 * 主动取消某 userId 的 device-auth（如用户关闭弹窗）。无 in-flight → no-op。
 * 不推终态（取消是用户意图，不需要再回 expired/error 噪声）。
 */
export function cancelDeviceAuth(userId: string): void {
  const record = inflight.get(userId);
  if (!record || record.done) return;
  record.done = true;
  clearTimeout(record.timer);
  killTree(record.child, 'SIGKILL');
  inflight.delete(userId);
}

/** 关闭时清理所有 in-flight 进程（避免僵尸）。供测试 / 优雅退出调用。 */
export function shutdownAllDeviceAuth(): void {
  for (const [userId, record] of inflight) {
    if (record.done) continue;
    record.done = true;
    clearTimeout(record.timer);
    killTree(record.child, 'SIGKILL');
    logger.info({ userId }, 'codex device-auth: killed in-flight on shutdown');
  }
  inflight.clear();
}
