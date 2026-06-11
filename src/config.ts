import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'HappyClaw';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();

// Mount security: allowlist in project config/ directory
export const MOUNT_ALLOWLIST_PATH = path.resolve(
  PROJECT_ROOT,
  'config',
  'mount-allowlist.json',
);
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const STORE_DIR = path.join(DATA_DIR, 'db');
export const GROUPS_DIR = path.join(DATA_DIR, 'groups');
export const MAIN_GROUP_FOLDER = 'main';

// codex 替换：镜像改名 happycodex（container/Dockerfile 构建产物）。
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'happycodex-agent:latest';
// Timezone for scheduled tasks (cron expressions, etc.)
// Uses TZ env var with Asia/Shanghai fallback
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';

// Web server configuration
export const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);

// Cookie configuration
// When accessed over HTTPS: use __Host- prefix (requires Secure; Path=/; no Domain)
// When accessed over HTTP (localhost dev or no TLS): use plain name
// Determined per-request via isSecureRequest(), not at startup
//
// happycodex 专属 cookie 名（不沿用上游 happyclaw_session）：localhost 上 cookie 不区分端口，
// 与同机另一端口跑的 happyclaw 共用 `happyclaw_session` 会互相覆盖 → 登录一个把另一个顶下线。
// 改用 happycodex_session 后两者各自独立，可同机并存。
export const SESSION_COOKIE_NAME_SECURE = '__Host-happycodex_session';
export const SESSION_COOKIE_NAME_PLAIN = 'happycodex_session';
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'config', 'session-secret.key');

function getOrCreateSessionSecret(): string {
  // 1. Environment variable (highest priority — allows container/operator override)
  if (process.env.WEB_SESSION_SECRET) {
    return process.env.WEB_SESSION_SECRET;
  }

  // 2. File-persisted secret (survives restarts)
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      const stored = fs.readFileSync(SESSION_SECRET_FILE, 'utf-8').trim();
      if (stored) return stored;
    }
  } catch {
    // ignore read errors, fall through
  }

  // 3. Generate and persist
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true });
    fs.writeFileSync(SESSION_SECRET_FILE, generated + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // non-fatal: secret works for this process, just won't survive restart
  }
  return generated;
}

export const WEB_SESSION_SECRET = getOrCreateSessionSecret();

// Ensure WeChat iLink API domains bypass HTTP proxy.
// These Chinese domestic services are unreachable through most overseas proxies.
const WECHAT_NO_PROXY_DOMAINS = [
  'ilinkai.weixin.qq.com',
  'novac2c.cdn.weixin.qq.com',
];

/** Add or remove WeChat domains from NO_PROXY based on bypassProxy flag. */
export function updateWeChatNoProxy(bypassProxy: boolean): void {
  const current = process.env.NO_PROXY || process.env.no_proxy || '';
  const existing = new Set(current.split(',').map((s) => s.trim()).filter(Boolean));

  if (bypassProxy) {
    const toAdd = WECHAT_NO_PROXY_DOMAINS.filter((d) => !existing.has(d));
    if (toAdd.length) {
      const updated = current ? `${current},${toAdd.join(',')}` : toAdd.join(',');
      process.env.NO_PROXY = updated;
      process.env.no_proxy = updated;
    }
  } else {
    for (const d of WECHAT_NO_PROXY_DOMAINS) existing.delete(d);
    const updated = [...existing].join(',');
    process.env.NO_PROXY = updated;
    process.env.no_proxy = updated;
  }
}

/** Check if WeChat domains are currently in NO_PROXY. */
export function isWeChatBypassingProxy(): boolean {
  const current = process.env.NO_PROXY || process.env.no_proxy || '';
  const existing = new Set(current.split(',').map((s) => s.trim()).filter(Boolean));
  return WECHAT_NO_PROXY_DOMAINS.every((d) => existing.has(d));
}

// Proxy trust configuration
// Set TRUST_PROXY=true when behind a reverse proxy (nginx, Cloudflare, etc.)
export const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// Docker availability check (cached for the lifetime of the process)
const execFileAsync = promisify(execFile);
let _dockerAvailable: boolean | null = null;

export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    await execFileAsync('docker', ['info'], { timeout: 10000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}
