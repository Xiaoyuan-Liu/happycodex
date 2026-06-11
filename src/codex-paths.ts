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

export type CodexAuthMethod = 'chatgpt' | 'api_key' | 'unknown';

export interface CodexAuthStatus {
  /** 共享 auth.json 是否存在 */
  loggedIn: boolean;
  /** 认证方式：chatgpt（OAuth tokens）/ api_key（OPENAI_API_KEY）/ unknown */
  method: CodexAuthMethod | null;
  /** tokens.last_refresh（仅 chatgpt 方式，安全字段，不含凭据） */
  lastRefresh: string | null;
  /** 共享 CODEX_HOME 路径（admin 可见，便于定位） */
  codexHome: string;
  /** 未登录时的操作指引 */
  loginHint: string;
}

/**
 * 读取共享 CODEX_HOME 的认证状态（auth.json 存在性 + 方式判定）。
 * 消费方：routes/config（GET /codex/auth + api-key 写入护栏）、
 * routes/auth（buildSetupStatus）、routes/bug-report（AI 能力门控）。
 */
export function readCodexAuthStatus(): CodexAuthStatus {
  const codexHome = sharedCodexHomeDir();
  const authPath = path.join(codexHome, 'auth.json');
  const loginHint =
    `在服务端运行 \`codex login\`（或 \`codex login --api-key <key>\`）完成认证；` +
    `凭据写入 ${authPath} 后即对所有工作区生效（新会话 provision 时复制）。`;
  if (!fs.existsSync(authPath)) {
    return {
      loggedIn: false,
      method: null,
      lastRefresh: null,
      codexHome,
      loginHint,
    };
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
  return { loggedIn: true, method, lastRefresh, codexHome, loginHint };
}
