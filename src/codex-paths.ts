/**
 * 共享 codex home 路径解析 + 认证状态读取 —— 单一真相源。
 *
 * 此前 sharedCodexHomeDir 在 routes/config.ts / container-runner.ts /
 * sdk-query.ts / routes/mcp-servers.ts 各有一份同义副本（解析顺序相同），
 * readCodexAuthStatus 住在 routes/config.ts 并被 routes/auth.ts 与
 * routes/bug-report.ts 横向 import（route→route 依赖）。统一下沉到本模块：
 * 副本消除，路由层与引擎层都只依赖这里。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';

/** codex 原生凭据文件名（~/.codex/auth.json，明文）。per-user 目录同名。 */
export const CODEX_AUTH_FILE = 'auth.json';

/**
 * 共享 codex home（已 `codex login` 的单账号凭据源）。
 * 优先级：HAPPYCODEX_SHARED_CODEX_HOME > CODEX_HOME > ~/.codex。
 */
export function sharedCodexHomeDir(): string {
  return (
    process.env.HAPPYCODEX_SHARED_CODEX_HOME ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), '.codex')
  );
}

/**
 * per-user codex home 根目录基。与 runtime-config 的 userImDir 同基目录
 * （DATA_DIR/config/user-im/{userId}），per-user codex 凭据落其下 codex/ 子目录。
 */
const USER_IM_CONFIG_DIR = path.join(DATA_DIR, 'config', 'user-im');

/**
 * per-user codex home 目录：`{DATA_DIR}/config/user-im/{userId}/codex`。
 * userId 做与 sessions folder 同款的严格逃逸校验（拒 .. / 路径分隔 / 空段），
 * 与 runtime-config.userImDir 同规则——单一允许集，从源头杜绝目录穿越。
 */
export function userCodexHomeDir(userId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error('Invalid userId');
  }
  return path.join(USER_IM_CONFIG_DIR, userId, 'codex');
}

/**
 * per-user codex 凭据是否存在（userCodexHomeDir(userId)/auth.json 存在性）。
 * 非法 userId 由 userCodexHomeDir 抛错（调用方先行校验或捕获）。
 */
export function hasUserCodexAuth(userId: string): boolean {
  return fs.existsSync(path.join(userCodexHomeDir(userId), CODEX_AUTH_FILE));
}

/**
 * HAPPYCODEX_PERUSER_AUTH_FALLBACK 开关：缺省 / "true" = per-user 缺失时回退共享账号；
 * "false"（大小写不敏感）= 无 per-user 凭据则 provision 失败（强制每人自登）。
 */
export function perUserAuthFallbackEnabled(): boolean {
  const raw = process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK;
  if (raw === undefined) return true;
  return raw.trim().toLowerCase() !== 'false';
}

export type CodexAuthMethod = 'chatgpt' | 'api_key' | 'unknown';

export interface CodexAuthStatus {
  /** auth.json 是否存在（无参=共享；传 userId=该用户解析出的 home） */
  loggedIn: boolean;
  /** 认证方式：chatgpt（OAuth tokens）/ api_key（OPENAI_API_KEY）/ unknown */
  method: CodexAuthMethod | null;
  /** tokens.last_refresh（仅 chatgpt 方式，安全字段，不含凭据） */
  lastRefresh: string | null;
  /** 读取所用的 CODEX_HOME 路径（admin 可见，便于定位） */
  codexHome: string;
  /** 未登录时的操作指引 */
  loginHint: string;
  /**
   * per-user 模式专属：该用户自己的 auth.json 是否存在（便于前端区分"用自己的"）。
   * 仅传 userId 时填充；无参（共享态）下省略。
   */
  hasUserAuth?: boolean;
  /**
   * per-user 模式专属：本次状态是否来自回退共享账号（per-user 缺失 + fallback 开启）。
   * 仅传 userId 时填充；无参（共享态）下省略。
   */
  usingShared?: boolean;
}

/**
 * 从给定 codexHome 读 auth.json 的方式/刷新时间（纯读，不含路径策略）。
 */
function readAuthAt(codexHome: string): {
  loggedIn: boolean;
  method: CodexAuthMethod | null;
  lastRefresh: string | null;
} {
  const authPath = path.join(codexHome, CODEX_AUTH_FILE);
  if (!fs.existsSync(authPath)) {
    return { loggedIn: false, method: null, lastRefresh: null };
  }
  let method: CodexAuthMethod = 'unknown';
  let lastRefresh: string | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
      OPENAI_API_KEY?: string | null;
      tokens?: { last_refresh?: string } | null;
      last_refresh?: string;
    };
    if (raw.tokens) {
      method = 'chatgpt';
      lastRefresh = raw.tokens.last_refresh ?? raw.last_refresh ?? null;
    } else if (raw.OPENAI_API_KEY) {
      method = 'api_key';
    }
  } catch {
    // 非 JSON / 读取失败 → unknown（存在即视为已登录，由 codex 自行校验有效性）
  }
  return { loggedIn: true, method, lastRefresh };
}

/**
 * 读取 codex 认证状态（auth.json 存在性 + 方式判定）。
 *
 * - 无参（向后兼容）：读共享 CODEX_HOME。现有无参消费方
 *   （routes/config GET /codex/auth + api-key 写入护栏、routes/auth buildSetupStatus、
 *   routes/bug-report AI 能力门控）签名不变。返回结构不含 hasUserAuth/usingShared。
 * - 传 userId：优先读该用户 userCodexHomeDir(userId)/auth.json；该用户未登录且
 *   fallback 开启时回退共享态（usingShared=true）。hasUserAuth 反映用户自己的凭据存在性。
 *   非法 userId 由 userCodexHomeDir 抛错。
 */
export function readCodexAuthStatus(userId?: string): CodexAuthStatus {
  if (userId === undefined) {
    const codexHome = sharedCodexHomeDir();
    const authPath = path.join(codexHome, CODEX_AUTH_FILE);
    const loginHint =
      `在服务端运行 \`codex login\`（或 \`codex login --api-key <key>\`）完成认证；` +
      `凭据写入 ${authPath} 后即对所有工作区生效（新会话 provision 时复制）。`;
    const read = readAuthAt(codexHome);
    return { ...read, codexHome, loginHint };
  }

  const userHome = userCodexHomeDir(userId);
  const userRead = readAuthAt(userHome);
  if (userRead.loggedIn) {
    // 用户已自登：用自己的凭据。
    return {
      ...userRead,
      codexHome: userHome,
      loginHint: `已使用你自己的 codex 凭据（${path.join(userHome, CODEX_AUTH_FILE)}）。`,
      hasUserAuth: true,
      usingShared: false,
    };
  }

  // 用户未登录：fallback 开启则回退共享态供查看；否则呈现"需自登"。
  if (perUserAuthFallbackEnabled()) {
    const shared = sharedCodexHomeDir();
    const sharedRead = readAuthAt(shared);
    return {
      ...sharedRead,
      codexHome: shared,
      loginHint: sharedRead.loggedIn
        ? `当前回退到共享账号；如需用自己的账号，请在配置页登录 codex。`
        : `共享账号未登录，且你尚未登录自己的 codex；请在配置页完成登录。`,
      hasUserAuth: false,
      usingShared: true,
    };
  }
  return {
    loggedIn: false,
    method: null,
    lastRefresh: null,
    codexHome: userHome,
    loginHint: `请在配置页登录自己的 codex 账号（fallback 已关闭，不会回退共享账号）。`,
    hasUserAuth: false,
    usingShared: false,
  };
}
