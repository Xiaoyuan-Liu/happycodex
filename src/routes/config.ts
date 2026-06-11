// Configuration management routes

import { randomBytes } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import QRCode from 'qrcode';
import { Hono } from 'hono';
import { updateWeChatNoProxy } from '../config.js';
import type { Variables } from '../web-context.js';
import { canAccessGroup, canModifyGroup, getWebDeps } from '../web-context.js';
import { getChannelType } from '../im-channel.js';
// codex 适配：Telegram 渠道当前为 stub（src/telegram.ts），测试连接/配置响应需诚实降级。
import {
  TELEGRAM_CHANNEL_STUBBED,
  STUB_MESSAGE as TELEGRAM_STUB_MESSAGE,
} from '../telegram.js';
import {
  deleteRegisteredGroup,
  deleteChatHistory,
  getRegisteredGroup,
  setRegisteredGroup,
  updateChatName,
  getAgent,
  clearSenderAllowlist,
  VALID_ACTIVATION_MODES,
} from '../db.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import {
  FeishuConfigSchema,
  TelegramConfigSchema,
  QQConfigSchema,
  WeChatConfigSchema,
  DingTalkConfigSchema,
  DiscordConfigSchema,
  WhatsAppConfigSchema,
  RegistrationConfigSchema,
  AppearanceConfigSchema,
  SystemSettingsSchema,
} from '../schemas.js';
// tombstone（happycodex）：上游另从 schemas.js 导入 ClaudeCustomEnvSchema +
// UnifiedProvider{Create,Patch,Secrets}Schema + BalancingConfigSchema，从
// runtime-config.js 导入 provider CRUD/均衡/OAuth 用量全套（getClaudeProviderConfig /
// getProviders / updateProvider / parseOAuthUsageBucket 等）——随 /claude provider
// 路由段（见下方 Codex 替换段 tombstone）一并删除。
import {
  appendClaudeConfigAudit,
  getFeishuProviderConfig,
  getFeishuProviderConfigWithSource,
  toPublicFeishuProviderConfig,
  saveFeishuProviderConfig,
  getTelegramProviderConfig,
  getTelegramProviderConfigWithSource,
  toPublicTelegramProviderConfig,
  saveTelegramProviderConfig,
  getRegistrationConfig,
  saveRegistrationConfig,
  getAppearanceConfig,
  saveAppearanceConfig,
  getSystemSettings,
  getEffectiveExternalDir,
  saveSystemSettings,
  getUserFeishuConfig,
  saveUserFeishuConfig,
  getUserTelegramConfig,
  saveUserTelegramConfig,
  getUserQQConfig,
  saveUserQQConfig,
  getUserWeChatConfig,
  saveUserWeChatConfig,
  getUserDingTalkConfig,
  saveUserDingTalkConfig,
  getUserDiscordConfig,
  saveUserDiscordConfig,
  getUserWhatsAppConfig,
  saveUserWhatsAppConfig,
  appendImConfigAudit,
} from '../runtime-config.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  checkImChannelLimit,
  isBillingEnabled,
  clearBillingEnabledCache,
} from '../billing.js';
// tombstone（happycodex）：上游 `import { providerPool } from '../provider-pool.js'`
// —— provider-pool 已作废（用户决策），整模块不搬。
import fs from 'fs';
import os from 'os';
import path from 'path';

const configRoutes = new Hono<{ Variables: Variables }>();

/**
 * Count how many IM channels are currently enabled for a user, excluding the given channel.
 * Used for billing limit checks when enabling a new channel.
 */
function countOtherEnabledImChannels(
  userId: string,
  excludeChannel:
    | 'feishu'
    | 'telegram'
    | 'qq'
    | 'wechat'
    | 'dingtalk'
    | 'discord'
    | 'whatsapp',
): number {
  let count = 0;
  if (excludeChannel !== 'feishu' && getUserFeishuConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'telegram' && getUserTelegramConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'wechat' && getUserWeChatConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'qq' && getUserQQConfig(userId)?.enabled) count++;
  if (excludeChannel !== 'dingtalk' && getUserDingTalkConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'discord' && getUserDiscordConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'whatsapp' && getUserWhatsAppConfig(userId)?.enabled)
    count++;
  return count;
}

// Inject deps at runtime
let deps: any = null;
export function injectConfigDeps(d: any) {
  deps = d;
}

function createTelegramApiAgent(proxyUrl?: string): HttpsAgent | ProxyAgent {
  if (proxyUrl && proxyUrl.trim()) {
    const fixedProxyUrl = proxyUrl.trim();
    return new ProxyAgent({
      getProxyForUrl: () => fixedProxyUrl,
    });
  }
  return new HttpsAgent({ keepAlive: false, family: 4 });
}

function destroyTelegramApiAgent(agent: HttpsAgent | ProxyAgent): void {
  agent.destroy();
}

// ─── Codex 认证状态（happycodex 替换段）──────────────────────────
//
// tombstone（happycodex）：上游此处是 Claude provider 体系（routes/config.ts:161-908）：
//   - applyClaudeConfigToAllGroups（改配置后全量停容器重启）
//   - GET /claude + GET/POST/PATCH/DELETE /claude/providers* （provider CRUD + secrets）
//   - POST /claude/providers/:id/toggle | reset-health、GET /claude/providers/health
//   - GET /claude/providers/:id/usage（OAuth 用量条）
//   - PUT /claude/balancing（provider-pool 负载均衡）
//   - POST /claude/apply、POST /claude/oauth/start|callback（Anthropic OAuth PKCE）
//   - PUT /claude/custom-env（写第一个启用 provider 的 customEnv）
// 整段随 provider failover 作废删除（用户决策：provider-pool 已作废，billing token-only）。
// codex 是单账号引擎：凭据 = 共享 CODEX_HOME 的 auth.json（由 `codex login` 产生，
// per-folder CODEX_HOME 在 provision 时复制），无池化/均衡/切换概念。
// 前端对应面（ClaudeProviderSection/SetupProvidersPage）已改为占位页，不调用以上端点。
//
// 替换为最小 codex 配置面：
//   - GET  /codex/auth          → 共享 auth.json 是否存在/认证方式/login 指引
//   - POST /codex/auth/api-key  → 写入 API-key 形态的 auth.json（codex login --api-key 等价）

/**
 * 共享 codex home（已 `codex login` 的单账号凭据源）。
 * 与 src/container-runner.ts 的 sharedCodexHomeDir() 同一优先级链：
 * HAPPYCODEX_SHARED_CODEX_HOME > CODEX_HOME > ~/.codex。
 */
function sharedCodexHomeDir(): string {
  return (
    process.env.HAPPYCODEX_SHARED_CODEX_HOME ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), '.codex')
  );
}

type CodexAuthMethod = 'chatgpt' | 'api_key' | 'unknown';

interface CodexAuthStatus {
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

// export：routes/auth.ts 的 buildSetupStatus 复用同一判定（codex 单账号引擎，
// setupStatus 以共享 auth.json 存在性为准）。
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

configRoutes.get(
  '/codex/auth',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      return c.json(readCodexAuthStatus());
    } catch (err) {
      logger.error({ err }, 'Failed to read codex auth status');
      return c.json({ error: 'Failed to read codex auth status' }, 500);
    }
  },
);

configRoutes.post(
  '/codex/auth/api-key',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const force = body.force === true;
    if (!apiKey) {
      return c.json({ error: 'apiKey is required' }, 400);
    }
    // 安全护栏：已有 ChatGPT OAuth 登录态时拒绝静默覆盖（需 force=true），
    // 因为共享 CODEX_HOME 可能就是宿主机真实 ~/.codex。
    const current = readCodexAuthStatus();
    if (current.loggedIn && current.method === 'chatgpt' && !force) {
      return c.json(
        {
          error:
            '已存在 ChatGPT 登录态（auth.json 含 OAuth tokens）。如确认要替换为 API key，请传 force=true。',
        },
        409,
      );
    }
    try {
      const codexHome = sharedCodexHomeDir();
      fs.mkdirSync(codexHome, { recursive: true });
      const authPath = path.join(codexHome, 'auth.json');
      // 原子写 + 0600（对齐 codex login --api-key 的产物形状）
      const tmpPath = `${authPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ OPENAI_API_KEY: apiKey }), {
        mode: 0o600,
      });
      fs.renameSync(tmpPath, authPath);
      const user = c.get('user') as AuthUser;
      appendClaudeConfigAudit(user.username, 'codex_auth_api_key_set', [
        'auth.json',
      ]);
      return c.json({ success: true, status: readCodexAuthStatus() });
    } catch (err) {
      logger.error({ err }, 'Failed to write codex auth.json');
      return c.json({ error: 'Failed to write codex auth.json' }, 500);
    }
  },
);


// ─── Helpers ────────────────────────────────────────────────────

const _deprecationLogged = new Set<string>();
function logDeprecationOnce(endpoint: string, replacement: string): void {
  if (_deprecationLogged.has(endpoint)) return;
  logger.warn(`Deprecated: ${endpoint} — use ${replacement} instead`);
  _deprecationLogged.add(endpoint);
}

function resolveProxyInfo(
  userProxy: string,
  sysProxy: string,
): { effectiveProxyUrl: string; proxySource: 'user' | 'system' | 'none' } {
  return {
    effectiveProxyUrl: userProxy || sysProxy,
    proxySource: userProxy ? 'user' : sysProxy ? 'system' : 'none',
  };
}

/** Persist a RegisteredGroup update and sync to the in-memory cache. */
function applyBindingUpdate(imJid: string, updated: RegisteredGroup): void {
  setRegisteredGroup(imJid, updated);
  const webDeps = getWebDeps();
  if (webDeps) {
    const groups = webDeps.getRegisteredGroups();
    if (groups[imJid]) groups[imJid] = updated;
    webDeps.clearImFailCounts?.(imJid);
  }
}

configRoutes.get('/feishu', authMiddleware, systemConfigMiddleware, (c) => {
  logDeprecationOnce(
    'GET /api/config/feishu',
    'GET /api/config/user-im/feishu',
  );
  try {
    const { config, source } = getFeishuProviderConfigWithSource();
    const pub = toPublicFeishuProviderConfig(config, source);
    const connected = deps?.isFeishuConnected?.() ?? false;
    return c.json({ ...pub, connected });
  } catch (err) {
    logger.error({ err }, 'Failed to load Feishu config');
    return c.json({ error: 'Failed to load Feishu config' }, 500);
  }
});

configRoutes.put(
  '/feishu',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = FeishuConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const current = getFeishuProviderConfig();
    const next = { ...current };
    if (typeof validation.data.appId === 'string') {
      next.appId = validation.data.appId;
    }
    if (typeof validation.data.appSecret === 'string') {
      next.appSecret = validation.data.appSecret;
    } else if (validation.data.clearAppSecret === true) {
      next.appSecret = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    }

    try {
      const saved = saveFeishuProviderConfig({
        appId: next.appId,
        appSecret: next.appSecret,
        enabled: next.enabled,
      });

      // Hot-reload: reconnect/disconnect Feishu channel
      let connected = false;
      if (deps?.reloadFeishuConnection) {
        try {
          connected = await deps.reloadFeishuConnection(saved);
        } catch (err: unknown) {
          logger.warn({ err }, 'Failed to reload Feishu connection');
        }
      }

      return c.json({
        ...toPublicFeishuProviderConfig(saved, 'runtime'),
        connected,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Feishu config payload';
      logger.warn({ err }, 'Invalid Feishu config payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Telegram config ─────────────────────────────────────────────

/**
 * codex 适配（与上游有意分叉）：Telegram 渠道为 stub 时，配置「已启用 + 有 token
 * 但永不连接」——在 GET/PUT 配置响应中附加 lastError，前端 TelegramChannelCard
 * 据此解释灰点。整体搬迁上游 telegram.ts 后随 TELEGRAM_CHANNEL_STUBBED 一并删除。
 */
function telegramStubLastError(
  pub: { enabled: boolean; hasBotToken: boolean },
  connected: boolean,
): { lastError?: string } {
  return TELEGRAM_CHANNEL_STUBBED && pub.enabled && pub.hasBotToken && !connected
    ? { lastError: TELEGRAM_STUB_MESSAGE }
    : {};
}

configRoutes.get('/telegram', authMiddleware, systemConfigMiddleware, (c) => {
  logDeprecationOnce(
    'GET /api/config/telegram',
    'GET /api/config/user-im/telegram',
  );
  try {
    const { config, source } = getTelegramProviderConfigWithSource();
    const pub = toPublicTelegramProviderConfig(config, source);
    const connected = deps?.isTelegramConnected?.() ?? false;
    return c.json({ ...pub, connected });
  } catch (err) {
    logger.error({ err }, 'Failed to load Telegram config');
    return c.json({ error: 'Failed to load Telegram config' }, 500);
  }
});

configRoutes.put(
  '/telegram',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = TelegramConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const current = getTelegramProviderConfig();
    const next = { ...current };
    if (typeof validation.data.botToken === 'string') {
      next.botToken = validation.data.botToken;
    } else if (validation.data.clearBotToken === true) {
      next.botToken = '';
    }
    if (typeof validation.data.proxyUrl === 'string') {
      next.proxyUrl = validation.data.proxyUrl;
    } else if (validation.data.clearProxyUrl === true) {
      next.proxyUrl = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    }

    try {
      const saved = saveTelegramProviderConfig({
        botToken: next.botToken,
        proxyUrl: next.proxyUrl,
        enabled: next.enabled,
      });

      // Hot-reload: reconnect/disconnect Telegram channel
      let connected = false;
      if (deps?.reloadTelegramConnection) {
        try {
          connected = await deps.reloadTelegramConnection(saved);
        } catch (err: unknown) {
          logger.warn({ err }, 'Failed to reload Telegram connection');
        }
      }

      const pub = toPublicTelegramProviderConfig(saved, 'runtime');
      return c.json({
        ...pub,
        connected,
        ...telegramStubLastError(pub, connected),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Telegram config payload';
      logger.warn({ err }, 'Invalid Telegram config payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.post(
  '/telegram/test',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    // codex 适配：渠道为 stub —— 真 token 校验会制造「测试成功但渠道永不可连」
    // 的假成功信号，诚实返回 501（复用 routes/plugins.ts 的 501+说明模式）。
    if (TELEGRAM_CHANNEL_STUBBED) {
      return c.json({ error: TELEGRAM_STUB_MESSAGE }, 501);
    }
    const config = getTelegramProviderConfig();
    if (!config.botToken) {
      return c.json({ error: 'Telegram bot token not configured' }, 400);
    }

    const agent = createTelegramApiAgent(config.proxyUrl);
    try {
      const { Bot } = await import('grammy');
      const testBot = new Bot(config.botToken, {
        client: {
          timeoutSeconds: 15,
          baseFetchConfig: {
            agent,
          },
        },
      });

      let me: { username?: string; id: number; first_name: string } | null =
        null;
      let lastErr: unknown = null;
      for (let i = 0; i < 3; i++) {
        try {
          me = await testBot.api.getMe();
          break;
        } catch (err) {
          lastErr = err;
          // Small retry window for intermittent network timeouts.
          if (i < 2) await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      if (!me) {
        throw lastErr instanceof Error
          ? lastErr
          : new Error('Telegram API request failed');
      }

      return c.json({
        success: true,
        bot_username: me.username,
        bot_id: me.id,
        bot_name: me.first_name,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to connect to Telegram';
      logger.warn({ err }, 'Failed to test Telegram connection');
      return c.json({ error: message }, 400);
    } finally {
      destroyTelegramApiAgent(agent);
    }
  },
);

// ─── Registration config ─────────────────────────────────────────

configRoutes.get(
  '/registration',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      return c.json(getRegistrationConfig());
    } catch (err) {
      logger.error({ err }, 'Failed to load registration config');
      return c.json({ error: 'Failed to load registration config' }, 500);
    }
  },
);

configRoutes.put(
  '/registration',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = RegistrationConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    try {
      const actor = (c.get('user') as AuthUser).username;
      const saved = saveRegistrationConfig(validation.data);
      appendClaudeConfigAudit(actor, 'update_registration_config', [
        'allowRegistration',
        'requireInviteCode',
      ]);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid registration config payload';
      logger.warn({ err }, 'Invalid registration config payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Appearance config ────────────────────────────────────────────

configRoutes.get('/appearance', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json(getAppearanceConfig());
  } catch (err) {
    logger.error({ err }, 'Failed to load appearance config');
    return c.json({ error: 'Failed to load appearance config' }, 500);
  }
});

configRoutes.put(
  '/appearance',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = AppearanceConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    try {
      const saved = saveAppearanceConfig(validation.data);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid appearance config payload';
      logger.warn({ err }, 'Invalid appearance config payload');
      return c.json({ error: message }, 400);
    }
  },
);

// Public endpoint — no auth required (like /api/auth/status)
configRoutes.get('/appearance/public', (c) => {
  try {
    const config = getAppearanceConfig();
    return c.json({
      appName: config.appName,
      aiName: config.aiName,
      aiAvatarEmoji: config.aiAvatarEmoji,
      aiAvatarColor: config.aiAvatarColor,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load public appearance config');
    return c.json({ error: 'Failed to load appearance config' }, 500);
  }
});

// ─── System settings ───────────────────────────────────────────────

configRoutes.get('/system', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json(getSystemSettings());
  } catch (err) {
    logger.error({ err }, 'Failed to load system settings');
    return c.json({ error: 'Failed to load system settings' }, 500);
  }
});

configRoutes.put(
  '/system',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = SystemSettingsSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    // 启用「禁用 HappyClaw 记忆层」开关前必须给 admin 主容器配 customCwd，
    // 否则 agent 仍跑在 per-folder 工作区：memory 工具与 WORKSPACE_GLOBAL/MEMORY
    // env 被关掉后，只剩 CODEX_HOME/AGENTS.md 的全局注入、没有自己项目的
    // AGENTS.md/CLAUDE.md 上下文，近乎空白沙箱。
    // （文案 codex 化：上游此处描述 CLAUDE_CONFIG_DIR/SDK 读 ~/.claude/ 的语义。）
    if (validation.data.disableMemoryLayerForAdminHost === true) {
      const adminMain = getRegisteredGroup('web:main');
      if (!adminMain || !adminMain.customCwd) {
        return c.json(
          {
            error:
              '启用前请先给 admin 主容器（web:main）配置 customCwd，否则关掉记忆层后 codex 既没有 HappyClaw 记忆工具，也读不到你自己项目的 AGENTS.md/CLAUDE.md，会是空白沙箱。',
          },
          400,
        );
      }
    }

    try {
      const saved = saveSystemSettings(validation.data);
      clearBillingEnabledCache();
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid system settings payload';
      logger.warn({ err }, 'Invalid system settings payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── External Claude resources (admin only) ─────────────────────────

configRoutes.get('/external-resources', authMiddleware, systemConfigMiddleware, (c) => {
  // 仅 admin 可查看宿主机资源，普通用户不允许看到宿主机任何内容
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') {
    return c.json({ dir: '', rules: [], claudeMd: null });
  }
  const effectiveDir = getEffectiveExternalDir();

  const result: {
    dir: string;
    rules: Array<{ name: string; size: number }>;
    claudeMd: string | null;
  } = { dir: effectiveDir, rules: [], claudeMd: null };

  // Rules
  const rulesDir = path.join(effectiveDir, 'rules');
  try {
    if (fs.existsSync(rulesDir)) {
      for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        try {
          const st = fs.statSync(path.join(rulesDir, entry.name));
          result.rules.push({ name: entry.name, size: st.size });
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }

  // CLAUDE.md
  const claudeMdPath = path.join(effectiveDir, 'CLAUDE.md');
  try {
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      result.claudeMd = content.length > 10000 ? content.slice(0, 10000) + '\n...(截断)' : content;
    }
  } catch { /* ignore */ }

  return c.json(result);
});

// Read a single rule file content (admin only)
configRoutes.get('/external-resources/rule', authMiddleware, systemConfigMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') {
    return c.text('Forbidden', 403);
  }
  const name = c.req.query('name');
  if (!name || name.includes('/') || name.includes('..')) {
    return c.text('Invalid name', 400);
  }
  const effectiveDir = getEffectiveExternalDir();
  const filePath = path.join(effectiveDir, 'rules', name);
  try {
    const resolved = fs.realpathSync(filePath);
    // 确保解析后的路径仍在 rules 目录内
    if (!resolved.startsWith(fs.realpathSync(path.join(effectiveDir, 'rules')))) {
      return c.text('Forbidden', 403);
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    return c.text(content);
  } catch {
    return c.text('Not found', 404);
  }
});

// ─── Per-user IM connection status ──────────────────────────────────

configRoutes.get('/user-im/status', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({
    feishu: deps?.isUserFeishuConnected?.(user.id) ?? false,
    telegram: deps?.isUserTelegramConnected?.(user.id) ?? false,
    qq: deps?.isUserQQConnected?.(user.id) ?? false,
    wechat: deps?.isUserWeChatConnected?.(user.id) ?? false,
    dingtalk: deps?.isUserDingTalkConnected?.(user.id) ?? false,
    discord: deps?.isUserDiscordConnected?.(user.id) ?? false,
  });
});

// ─── Per-user IM config (all logged-in users) ─────────────────────

configRoutes.get('/user-im/feishu', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserFeishuConfig(user.id);
    const connected = deps?.isUserFeishuConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        appId: '',
        hasAppSecret: false,
        appSecretMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
        autoIsolateContext: false,
      });
    }
    return c.json({
      ...toPublicFeishuProviderConfig(config, 'runtime'),
      connected,
      autoIsolateContext: config.autoIsolateContext ?? false,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user Feishu config');
    return c.json({ error: 'Failed to load user Feishu config' }, 500);
  }
});

configRoutes.put('/user-im/feishu', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = FeishuConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentFeishu = getUserFeishuConfig(user.id);
    if (!currentFeishu?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'feishu'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserFeishuConfig(user.id);
  const next: Record<string, unknown> = {
    appId: current?.appId || '',
    appSecret: current?.appSecret || '',
    enabled: current?.enabled ?? true,
    updatedAt: current?.updatedAt || null,
    autoIsolateContext: current?.autoIsolateContext ?? false,
  };
  if (typeof validation.data.appId === 'string') {
    const appId = validation.data.appId.trim();
    if (appId) next.appId = appId;
  }
  if (typeof validation.data.appSecret === 'string') {
    const appSecret = validation.data.appSecret.trim();
    if (appSecret) next.appSecret = appSecret;
  } else if (validation.data.clearAppSecret === true) {
    next.appSecret = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && (next.appId || next.appSecret)) {
    // First-time config with credentials should connect immediately.
    next.enabled = true;
  }
  if (typeof validation.data.autoIsolateContext === 'boolean') {
    next.autoIsolateContext = validation.data.autoIsolateContext;
  }

  try {
    const saved = saveUserFeishuConfig(user.id, {
      appId: next.appId as string,
      appSecret: next.appSecret as string,
      enabled: next.enabled as boolean | undefined,
      autoIsolateContext: next.autoIsolateContext as boolean | undefined,
    });
    appendImConfigAudit(user.username, 'feishu', 'update', Object.keys(validation.data), {
      userId: user.id,
    });

    // Migrate existing Feishu chats when autoIsolateContext toggle changes
    const oldAutoIsolate = current?.autoIsolateContext ?? false;
    const newAutoIsolate = saved.autoIsolateContext ?? false;
    if (oldAutoIsolate !== newAutoIsolate && deps?.applyAutoIsolateContext) {
      const migrated = deps.applyAutoIsolateContext(user.id, newAutoIsolate);
      logger.info(
        { userId: user.id, enable: newAutoIsolate, migrated },
        'Applied autoIsolateContext to existing Feishu chats',
      );
    }

    // Hot-reload: reconnect user's Feishu channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'feishu');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user Feishu connection',
        );
      }
    }

    const connected = deps?.isUserFeishuConnected?.(user.id) ?? false;
    return c.json({
      ...toPublicFeishuProviderConfig(saved, 'runtime'),
      connected,
      autoIsolateContext: saved.autoIsolateContext ?? false,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid Feishu config payload';
    logger.warn({ err }, 'Invalid user Feishu config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.get('/user-im/telegram', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserTelegramConfig(user.id);
    const connected = deps?.isUserTelegramConnected?.(user.id) ?? false;
    const globalConfig = getTelegramProviderConfig();
    const userProxy = config?.proxyUrl || '';
    const sysProxy = globalConfig.proxyUrl || '';
    const proxy = resolveProxyInfo(userProxy, sysProxy);
    if (!config) {
      return c.json({
        hasBotToken: false,
        botTokenMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
        proxyUrl: '',
        ...proxy,
      });
    }
    const pub = toPublicTelegramProviderConfig(config, 'runtime');
    return c.json({
      ...pub,
      connected,
      proxyUrl: userProxy,
      ...proxy,
      ...telegramStubLastError(pub, connected),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user Telegram config');
    return c.json({ error: 'Failed to load user Telegram config' }, 500);
  }
});

configRoutes.put('/user-im/telegram', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = TelegramConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentTg = getUserTelegramConfig(user.id);
    if (!currentTg?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'telegram'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserTelegramConfig(user.id);
  const next = {
    botToken: current?.botToken || '',
    proxyUrl: current?.proxyUrl || '',
    enabled: current?.enabled ?? true,
    updatedAt: current?.updatedAt || null,
  };
  if (typeof validation.data.botToken === 'string') {
    const botToken = validation.data.botToken.trim();
    if (botToken) next.botToken = botToken;
  } else if (validation.data.clearBotToken === true) {
    next.botToken = '';
  }
  if (typeof validation.data.proxyUrl === 'string') {
    next.proxyUrl = validation.data.proxyUrl.trim();
  } else if (validation.data.clearProxyUrl === true) {
    next.proxyUrl = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && next.botToken) {
    // First-time config with token should connect immediately.
    next.enabled = true;
  }

  try {
    const saved = saveUserTelegramConfig(user.id, {
      botToken: next.botToken,
      proxyUrl: next.proxyUrl || undefined,
      enabled: next.enabled,
    });
    appendImConfigAudit(user.username, 'telegram', 'update', Object.keys(validation.data), { userId: user.id });

    // Hot-reload: reconnect user's Telegram channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'telegram');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user Telegram connection',
        );
      }
    }

    const connected = deps?.isUserTelegramConnected?.(user.id) ?? false;
    const userProxy = saved.proxyUrl || '';
    const sysProxy = getTelegramProviderConfig().proxyUrl || '';
    const pub = toPublicTelegramProviderConfig(saved, 'runtime');
    return c.json({
      ...pub,
      connected,
      proxyUrl: userProxy,
      ...resolveProxyInfo(userProxy, sysProxy),
      ...telegramStubLastError(pub, connected),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid Telegram config payload';
    logger.warn({ err }, 'Invalid user Telegram config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/telegram/test', authMiddleware, async (c) => {
  // codex 适配：渠道为 stub —— 真 token 校验会制造「测试成功但渠道永不可连」
  // 的假成功信号，诚实返回 501（前端 handleTest 经 getErrorMessage toast 该说明）。
  if (TELEGRAM_CHANNEL_STUBBED) {
    return c.json({ error: TELEGRAM_STUB_MESSAGE }, 501);
  }
  const user = c.get('user') as AuthUser;
  const config = getUserTelegramConfig(user.id);
  if (!config?.botToken) {
    return c.json({ error: 'Telegram bot token not configured' }, 400);
  }

  const globalTelegramConfig = getTelegramProviderConfig();
  const effectiveProxy = config.proxyUrl || globalTelegramConfig.proxyUrl;
  const agent = createTelegramApiAgent(effectiveProxy);
  try {
    const { Bot } = await import('grammy');
    const testBot = new Bot(config.botToken, {
      client: {
        timeoutSeconds: 15,
        baseFetchConfig: {
          agent,
        },
      },
    });
    const me = await testBot.api.getMe();
    return c.json({
      success: true,
      bot_username: me.username,
      bot_id: me.id,
      bot_name: me.first_name,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to connect to Telegram';
    logger.warn({ err }, 'Failed to test user Telegram connection');
    return c.json({ error: message }, 400);
  } finally {
    destroyTelegramApiAgent(agent);
  }
});

configRoutes.post(
  '/user-im/telegram/pairing-code',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const config = getUserTelegramConfig(user.id);
    if (!config?.botToken) {
      return c.json({ error: 'Telegram bot token not configured' }, 400);
    }

    try {
      const { generatePairingCode } = await import('../telegram-pairing.js');
      const result = generatePairingCode(user.id);
      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate pairing code';
      logger.warn({ err }, 'Failed to generate pairing code');
      return c.json({ error: message }, 500);
    }
  },
);

// List Telegram paired chats for the current user
configRoutes.get('/user-im/telegram/paired-chats', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const groups = (deps?.getRegisteredGroups() ?? {}) as Record<
    string,
    { name: string; added_at: string; created_by?: string }
  >;
  const chats: Array<{ jid: string; name: string; addedAt: string }> = [];
  for (const [jid, group] of Object.entries(groups)) {
    if (jid.startsWith('telegram:') && group.created_by === user.id) {
      chats.push({ jid, name: group.name, addedAt: group.added_at });
    }
  }
  return c.json({ chats });
});

// Remove (unpair) a Telegram chat
configRoutes.delete(
  '/user-im/telegram/paired-chats/:jid',
  authMiddleware,
  (c) => {
    const user = c.get('user') as AuthUser;
    const jid = decodeURIComponent(c.req.param('jid'));

    if (!jid.startsWith('telegram:')) {
      return c.json({ error: 'Invalid Telegram chat JID' }, 400);
    }

    const groups = deps?.getRegisteredGroups() ?? {};
    const group = groups[jid];
    if (!group) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    if (group.created_by !== user.id) {
      return c.json({ error: 'Not authorized to remove this chat' }, 403);
    }

    deleteRegisteredGroup(jid);
    deleteChatHistory(jid);
    delete groups[jid];
    logger.info({ jid, userId: user.id }, 'Telegram chat unpaired');
    return c.json({ success: true });
  },
);

// ─── QQ User IM Config ──────────────────────────────────────────

function maskQQAppSecret(secret: string): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return '***';
  return secret.slice(0, 4) + '***' + secret.slice(-4);
}

configRoutes.get('/user-im/qq', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserQQConfig(user.id);
    const connected = deps?.isUserQQConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        appId: '',
        hasAppSecret: false,
        appSecretMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      appId: config.appId,
      hasAppSecret: !!config.appSecret,
      appSecretMasked: maskQQAppSecret(config.appSecret),
      enabled: config.enabled ?? false,
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user QQ config');
    return c.json({ error: 'Failed to load user QQ config' }, 500);
  }
});

configRoutes.put('/user-im/qq', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = QQConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentQQ = getUserQQConfig(user.id);
    if (!currentQQ?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'qq'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserQQConfig(user.id);
  const next = {
    appId: current?.appId || '',
    appSecret: current?.appSecret || '',
    enabled: current?.enabled ?? true,
  };
  if (typeof validation.data.appId === 'string') {
    next.appId = validation.data.appId.trim();
  }
  if (typeof validation.data.appSecret === 'string') {
    const appSecret = validation.data.appSecret.trim();
    if (appSecret) next.appSecret = appSecret;
  } else if (validation.data.clearAppSecret === true) {
    next.appSecret = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && next.appId && next.appSecret) {
    next.enabled = true;
  }

  try {
    const saved = saveUserQQConfig(user.id, {
      appId: next.appId,
      appSecret: next.appSecret,
      enabled: next.enabled,
    });
    appendImConfigAudit(user.username, 'qq', 'update', Object.keys(validation.data), { userId: user.id });

    // Hot-reload: reconnect user's QQ channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'qq');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user QQ connection',
        );
      }
    }

    const connected = deps?.isUserQQConnected?.(user.id) ?? false;
    return c.json({
      appId: saved.appId,
      hasAppSecret: !!saved.appSecret,
      appSecretMasked: maskQQAppSecret(saved.appSecret),
      enabled: saved.enabled ?? false,
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid QQ config payload';
    logger.warn({ err }, 'Invalid user QQ config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/qq/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserQQConfig(user.id);
  if (!config?.appId || !config?.appSecret) {
    return c.json({ error: 'QQ App ID and App Secret not configured' }, 400);
  }

  try {
    // Test by fetching access token
    const https = await import('node:https');
    const body = JSON.stringify({
      appId: config.appId,
      clientSecret: config.appSecret,
    });

    const result = await new Promise<{
      access_token?: string;
      expires_in?: number;
    }>((resolve, reject) => {
      const url = new URL('https://bots.qq.com/app/getAppAccessToken');
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          },
          timeout: 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch (err) {
              reject(err);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });
      req.write(body);
      req.end();
    });

    if (!result.access_token) {
      return c.json(
        {
          error:
            'Failed to obtain access token. Please check App ID and App Secret.',
        },
        400,
      );
    }

    return c.json({
      success: true,
      expires_in: result.expires_in,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to connect to QQ';
    logger.warn({ err }, 'Failed to test user QQ connection');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/qq/pairing-code', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserQQConfig(user.id);
  if (!config?.appId || !config?.appSecret) {
    return c.json({ error: 'QQ App ID and App Secret not configured' }, 400);
  }

  try {
    const { generatePairingCode } = await import('../telegram-pairing.js');
    const result = generatePairingCode(user.id);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to generate pairing code';
    logger.warn({ err }, 'Failed to generate QQ pairing code');
    return c.json({ error: message }, 500);
  }
});

// List QQ paired chats for the current user
configRoutes.get('/user-im/qq/paired-chats', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const groups = (deps?.getRegisteredGroups() ?? {}) as Record<
    string,
    { name: string; added_at: string; created_by?: string }
  >;
  const chats: Array<{ jid: string; name: string; addedAt: string }> = [];
  for (const [jid, group] of Object.entries(groups)) {
    if (jid.startsWith('qq:') && group.created_by === user.id) {
      chats.push({ jid, name: group.name, addedAt: group.added_at });
    }
  }
  return c.json({ chats });
});

// Rename a QQ paired chat
configRoutes.put('/user-im/qq/paired-chats/:jid', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const jid = decodeURIComponent(c.req.param('jid'));

  if (!jid.startsWith('qq:')) {
    return c.json({ error: 'Invalid QQ chat JID' }, 400);
  }

  const groups = deps?.getRegisteredGroups() ?? {};
  const group = groups[jid];
  if (!group) {
    return c.json({ error: 'Chat not found' }, 404);
  }
  if (group.created_by !== user.id) {
    return c.json({ error: 'Not authorized to rename this chat' }, 403);
  }

  const body = await c.req
    .json<{ name?: unknown }>()
    .catch(() => ({} as { name?: unknown }));
  const rawName = typeof body.name === 'string' ? body.name : '';
  const name = rawName.trim();
  if (!name) {
    return c.json({ error: 'Name is required' }, 400);
  }
  if (name.length > 256) {
    return c.json({ error: 'Name too long (max 256 chars)' }, 400);
  }

  group.name = name;
  setRegisteredGroup(jid, group);
  updateChatName(jid, name);
  logger.info({ jid, name, userId: user.id }, 'QQ chat renamed');
  return c.json({ success: true });
});

// Remove (unpair) a QQ chat
configRoutes.delete('/user-im/qq/paired-chats/:jid', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = decodeURIComponent(c.req.param('jid'));

  if (!jid.startsWith('qq:')) {
    return c.json({ error: 'Invalid QQ chat JID' }, 400);
  }

  const groups = deps?.getRegisteredGroups() ?? {};
  const group = groups[jid];
  if (!group) {
    return c.json({ error: 'Chat not found' }, 404);
  }
  if (group.created_by !== user.id) {
    return c.json({ error: 'Not authorized to remove this chat' }, 403);
  }

  deleteRegisteredGroup(jid);
  deleteChatHistory(jid);
  delete groups[jid];
  logger.info({ jid, userId: user.id }, 'QQ chat unpaired');
  return c.json({ success: true });
});

// ─── Per-user DingTalk IM config ──────────────────────────────────

configRoutes.get('/user-im/dingtalk', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserDingTalkConfig(user.id);
    const connected = deps?.isUserDingTalkConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        clientId: '',
        hasClientSecret: false,
        clientSecretMasked: null,
        enabled: false,
        streamingMode: 'card',
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      clientId: config.clientId,
      hasClientSecret: !!config.clientSecret,
      clientSecretMasked: config.clientSecret
        ? config.clientSecret.slice(0, 4) +
          '***' +
          config.clientSecret.slice(-4)
        : null,
      enabled: config.enabled ?? false,
      streamingMode: config.streamingMode ?? 'card',
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user DingTalk config');
    return c.json({ error: 'Failed to load DingTalk config' }, 500);
  }
});

configRoutes.put('/user-im/dingtalk', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = DingTalkConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const current = getUserDingTalkConfig(user.id);
    if (!current?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'dingtalk'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserDingTalkConfig(user.id);
  const next = {
    clientId: current?.clientId || '',
    clientSecret: current?.clientSecret || '',
    enabled: current?.enabled ?? true,
    streamingMode: current?.streamingMode ?? 'card',
  };

  if (typeof validation.data.clientId === 'string') {
    next.clientId = validation.data.clientId.trim();
  }
  if (typeof validation.data.clientSecret === 'string') {
    const secret = validation.data.clientSecret.trim();
    if (secret) next.clientSecret = secret;
  } else if (validation.data.clearClientSecret === true) {
    next.clientSecret = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && (next.clientId || next.clientSecret)) {
    next.enabled = true;
  }
  if (typeof validation.data.streamingMode === 'string') {
    next.streamingMode = validation.data.streamingMode;
  }

  try {
    const saved = saveUserDingTalkConfig(user.id, next);
    appendImConfigAudit(user.username, 'dingtalk', 'update', Object.keys(validation.data), { userId: user.id });

    // Hot-reload: reconnect user's DingTalk channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'dingtalk');
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to hot-reload DingTalk');
      }
    }

    const connected = deps?.isUserDingTalkConnected?.(user.id) ?? false;
    return c.json({
      clientId: saved.clientId,
      hasClientSecret: !!saved.clientSecret,
      clientSecretMasked: saved.clientSecret
        ? saved.clientSecret.slice(0, 4) + '***' + saved.clientSecret.slice(-4)
        : null,
      enabled: saved.enabled ?? false,
      streamingMode: saved.streamingMode ?? 'card',
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid config';
    logger.warn({ err }, 'Invalid DingTalk config');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/dingtalk/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserDingTalkConfig(user.id);

  if (!config?.clientId || !config?.clientSecret) {
    return c.json({ error: 'DingTalk credentials not configured' }, 400);
  }

  try {
    // Test by initializing a client and getting access token
    const { DWClient } = await import('dingtalk-stream');
    const testClient = new DWClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    // Try to get access token
    const token = await testClient.getAccessToken();
    if (!token) {
      testClient.disconnect?.();
      return c.json({ error: 'Failed to obtain access token' }, 400);
    }

    testClient.disconnect?.();
    return c.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Connection test failed';
    logger.warn({ err }, 'DingTalk connection test failed');
    return c.json({ error: message }, 400);
  }
});

// ─── Per-user Discord IM config ──────────────────────────────────

configRoutes.get('/user-im/discord', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserDiscordConfig(user.id);
    const connected = deps?.isUserDiscordConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        hasBotToken: false,
        botTokenMasked: null,
        enabled: false,
        streamingMode: 'off',
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      hasBotToken: !!config.botToken,
      botTokenMasked: config.botToken
        ? config.botToken.slice(0, 4) + '***' + config.botToken.slice(-4)
        : null,
      enabled: config.enabled ?? false,
      streamingMode: config.streamingMode ?? 'off',
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user Discord config');
    return c.json({ error: 'Failed to load Discord config' }, 500);
  }
});

configRoutes.put('/user-im/discord', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = DiscordConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const current = getUserDiscordConfig(user.id);
    if (!current?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'discord'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserDiscordConfig(user.id);
  const next = {
    botToken: current?.botToken || '',
    enabled: current?.enabled ?? true,
    streamingMode: current?.streamingMode ?? ('off' as const),
  };

  if (typeof validation.data.botToken === 'string') {
    const token = validation.data.botToken.trim();
    if (token) next.botToken = token;
  } else if (validation.data.clearBotToken === true) {
    next.botToken = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && next.botToken) {
    next.enabled = true;
  }
  if (typeof validation.data.streamingMode === 'string') {
    next.streamingMode = validation.data.streamingMode;
  }

  try {
    const saved = saveUserDiscordConfig(user.id, next);
    appendImConfigAudit(user.username, 'discord', 'update', Object.keys(validation.data), { userId: user.id });

    // Hot-reload: reconnect user's Discord channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'discord');
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to hot-reload Discord');
      }
    }

    const connected = deps?.isUserDiscordConnected?.(user.id) ?? false;
    return c.json({
      hasBotToken: !!saved.botToken,
      botTokenMasked: saved.botToken
        ? saved.botToken.slice(0, 4) + '***' + saved.botToken.slice(-4)
        : null,
      enabled: saved.enabled ?? false,
      streamingMode: saved.streamingMode ?? 'off',
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid config';
    logger.warn({ err }, 'Invalid Discord config');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/discord/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserDiscordConfig(user.id);

  if (!config?.botToken) {
    return c.json({ error: 'Discord Bot Token not configured' }, 400);
  }

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    // Test by creating a temporary Client and logging in
    const { Client, GatewayIntentBits } = await import('discord.js');
    const testClient = new Client({ intents: [GatewayIntentBits.Guilds] });

    const result = await Promise.race([
      new Promise<{ success: true; bot_username: string; bot_name: string }>(
        (resolve, reject) => {
          testClient.once('ready', () => {
            const username = testClient.user?.username || 'unknown';
            const name = testClient.user?.displayName || username;
            testClient.destroy();
            resolve({ success: true, bot_username: username, bot_name: name });
          });
          testClient.once('error', (err) => {
            testClient.destroy();
            reject(err);
          });
          testClient.login(config.botToken).catch((err) => {
            testClient.destroy();
            reject(err);
          });
        },
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          testClient.destroy();
          reject(new Error('Connection test timed out (10s)'));
        }, 10000);
      }),
    ]);

    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Connection test failed';
    logger.warn({ err }, 'Discord connection test failed');
    return c.json({ error: message }, 400);
  } finally {
    // Defense-in-depth: clear the race timer in both success and failure paths
    // so the process doesn't keep an active handle for up to 10s after the test.
    if (timeoutId) clearTimeout(timeoutId);
  }
});

// ─── Per-user WeChat IM config ──────────────────────────────────

const WECHAT_API_BASE = 'https://ilinkai.weixin.qq.com';
const WECHAT_QR_BOT_TYPE = '3';

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function maskBotToken(token: string | undefined): string | null {
  if (!token) return null;
  if (token.length <= 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

configRoutes.get('/user-im/wechat', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserWeChatConfig(user.id);
    const connected = deps?.isUserWeChatConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        ilinkBotId: '',
        hasBotToken: false,
        botTokenMasked: null,
        bypassProxy: true,
        enabled: false,
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      ilinkBotId: config.ilinkBotId || '',
      hasBotToken: !!config.botToken,
      botTokenMasked: maskBotToken(config.botToken),
      bypassProxy: config.bypassProxy ?? true,
      enabled: config.enabled ?? false,
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user WeChat config');
    return c.json({ error: 'Failed to load user WeChat config' }, 500);
  }
});

configRoutes.put('/user-im/wechat', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = WeChatConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentWc = getUserWeChatConfig(user.id);
    if (!currentWc?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'wechat'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserWeChatConfig(user.id);
  const next = {
    botToken: current?.botToken || '',
    ilinkBotId: current?.ilinkBotId || '',
    baseUrl: current?.baseUrl,
    cdnBaseUrl: current?.cdnBaseUrl,
    getUpdatesBuf: current?.getUpdatesBuf,
    bypassProxy: current?.bypassProxy ?? true,
    enabled: current?.enabled ?? false,
  };

  if (validation.data.clearBotToken === true) {
    next.botToken = '';
    next.ilinkBotId = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  }
  if (typeof validation.data.bypassProxy === 'boolean') {
    next.bypassProxy = validation.data.bypassProxy;
  }

  try {
    const saved = saveUserWeChatConfig(user.id, next);
    appendImConfigAudit(user.username, 'wechat', 'update', Object.keys(validation.data), { userId: user.id });

    // Update NO_PROXY based on bypassProxy setting
    updateWeChatNoProxy(saved.bypassProxy ?? true);

    // Hot-reload: reconnect user's WeChat channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'wechat');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user WeChat connection',
        );
      }
    }

    const connected = deps?.isUserWeChatConnected?.(user.id) ?? false;
    return c.json({
      ilinkBotId: saved.ilinkBotId || '',
      hasBotToken: !!saved.botToken,
      botTokenMasked: maskBotToken(saved.botToken),
      bypassProxy: saved.bypassProxy ?? true,
      enabled: saved.enabled ?? false,
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid WeChat config payload';
    logger.warn({ err }, 'Invalid user WeChat config payload');
    return c.json({ error: message }, 400);
  }
});

// Generate QR code for WeChat iLink login
configRoutes.post('/user-im/wechat/qrcode', authMiddleware, async (c) => {
  try {
    const url = `${WECHAT_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WECHAT_QR_BOT_TYPE)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ status: res.status, body }, 'WeChat QR code fetch failed');
      return c.json({ error: `Failed to fetch QR code: ${res.status}` }, 502);
    }
    const data = (await res.json()) as {
      qrcode?: string;
      qrcode_img_content?: string;
    };
    if (!data.qrcode) {
      return c.json({ error: 'No QR code in response' }, 502);
    }

    // qrcode_img_content is a URL string (WeChat deep link) to be encoded
    // INTO a QR code image, not an image URL itself.
    let qrcodeDataUri = '';
    if (data.qrcode_img_content) {
      try {
        qrcodeDataUri = await QRCode.toDataURL(data.qrcode_img_content, {
          width: 512,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
      } catch (qrErr) {
        logger.warn({ err: qrErr }, 'Failed to generate QR code image');
      }
    }

    return c.json({
      qrcode: data.qrcode,
      qrcodeUrl: qrcodeDataUri,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to generate QR code';
    logger.error({ err }, 'WeChat QR code generation failed');
    return c.json({ error: message }, 500);
  }
});

// Poll QR code scan status
configRoutes.get('/user-im/wechat/qrcode-status', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const qrcode = c.req.query('qrcode');
  if (!qrcode) {
    return c.json({ error: 'qrcode query parameter required' }, 400);
  }

  try {
    const url = `${WECHAT_API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const headers: Record<string, string> = {
      'iLink-App-ClientVersion': '1',
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        return c.json({ status: 'wait' });
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return c.json(
        { error: `QR status poll failed: ${res.status}`, body },
        502,
      );
    }

    const data = (await res.json()) as {
      status?: 'wait' | 'scaned' | 'confirmed' | 'expired';
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
    };

    if (data.status === 'confirmed' && data.bot_token && data.ilink_bot_id) {
      // Auto-save credentials and connect
      const saved = saveUserWeChatConfig(user.id, {
        botToken: data.bot_token,
        ilinkBotId: data.ilink_bot_id.replace(/[^a-zA-Z0-9@._-]/g, ''),
        baseUrl: data.baseurl || undefined,
        enabled: true,
      });
    appendImConfigAudit(user.username, 'wechat', 'oauth_qr_confirmed', ['botToken', 'ilinkBotId', 'baseUrl', 'enabled'], { userId: user.id });

      // Note: ilink_user_id (the QR scanner) is NOT auto-paired here.
      // The scanner needs to send a message to the bot and use /pair <code>
      // to complete pairing, same as QQ/Telegram flow.
      // This ensures proper group registration via buildOnNewChat/registerGroup.

      // Hot-reload: connect WeChat
      if (deps?.reloadUserIMConfig) {
        try {
          await deps.reloadUserIMConfig(user.id, 'wechat');
        } catch (err) {
          logger.warn(
            { err, userId: user.id },
            'Failed to hot-reload WeChat after QR login',
          );
        }
      }

      return c.json({
        status: 'confirmed',
        ilinkBotId: saved.ilinkBotId,
      });
    }

    return c.json({
      status: data.status || 'wait',
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'QR status poll failed';
    logger.error({ err }, 'WeChat QR status poll failed');
    return c.json({ error: message }, 500);
  }
});

// Disconnect WeChat and clear token
configRoutes.post('/user-im/wechat/disconnect', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const current = getUserWeChatConfig(user.id);
    if (current) {
      saveUserWeChatConfig(user.id, {
        botToken: '',
        ilinkBotId: '',
        enabled: false,
        getUpdatesBuf: current.getUpdatesBuf,
      });
    }

    // Disconnect
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'wechat');
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to disconnect WeChat');
      }
    }

    return c.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to disconnect WeChat';
    logger.error({ err }, 'WeChat disconnect failed');
    return c.json({ error: message }, 500);
  }
});

// ─── WhatsApp (Baileys-based, M1: QR login + connection state) ──

configRoutes.get('/user-im/whatsapp', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserWhatsAppConfig(user.id);
    const connected = deps?.isUserWhatsAppConnected?.(user.id) ?? false;
    const state = deps?.getUserWhatsAppState?.(user.id) ?? {
      status: 'disconnected' as const,
    };
    if (!config) {
      return c.json({
        accountId: 'default',
        phoneNumber: '',
        enabled: false,
        paired: false,
        updatedAt: null,
        connected,
        state,
      });
    }
    return c.json({
      accountId: config.accountId || 'default',
      phoneNumber: config.phoneNumber || '',
      enabled: config.enabled ?? false,
      paired: config.paired ?? false,
      updatedAt: config.updatedAt,
      connected,
      state,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user WhatsApp config');
    return c.json({ error: 'Failed to load user WhatsApp config' }, 500);
  }
});

configRoutes.put('/user-im/whatsapp', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = WhatsAppConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentWa = getUserWhatsAppConfig(user.id);
    if (!currentWa?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'whatsapp'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserWhatsAppConfig(user.id);
  const next = {
    accountId: current?.accountId || 'default',
    phoneNumber: current?.phoneNumber || '',
    enabled: current?.enabled ?? false,
    paired: current?.paired ?? false,
  };

  if (typeof validation.data.accountId === 'string') {
    next.accountId = validation.data.accountId.trim() || 'default';
  }
  if (typeof validation.data.phoneNumber === 'string') {
    next.phoneNumber = validation.data.phoneNumber.trim();
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  }
  // paired 已从 schema 移除：由 saveUserWhatsAppConfig 在 Baileys 登录回调
  // 中写入，前端 PUT 不再接受该字段（防止用户伪装扫码完成）。

  try {
    const saved = saveUserWhatsAppConfig(user.id, next);
    appendImConfigAudit(user.username, 'whatsapp', 'update', Object.keys(validation.data), { userId: user.id });

    // Hot-reload: reconnect user's WhatsApp channel (skeleton always returns false)
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'whatsapp');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user WhatsApp connection',
        );
      }
    }

    const connected = deps?.isUserWhatsAppConnected?.(user.id) ?? false;
    const state = deps?.getUserWhatsAppState?.(user.id) ?? {
      status: 'disconnected' as const,
    };
    return c.json({
      accountId: saved.accountId,
      phoneNumber: saved.phoneNumber,
      enabled: saved.enabled ?? false,
      paired: saved.paired ?? false,
      updatedAt: saved.updatedAt,
      connected,
      state,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid WhatsApp config payload';
    logger.warn({ err }, 'Invalid WhatsApp config');
    return c.json({ error: message }, 400);
  }
});

/**
 * Hard logout: tell WhatsApp servers, drop the socket, wipe local auth state,
 * and persist `enabled=false`/`paired=false`. Next enable forces a fresh QR.
 *
 * Distinct from PUT /user-im/whatsapp { enabled: false }, which only stops the
 * socket but keeps the noise/Signal pre-keys on disk for silent reconnect.
 */
configRoutes.post('/user-im/whatsapp/logout', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const current = getUserWhatsAppConfig(user.id);
  const accountId = current?.accountId || 'default';

  if (deps?.logoutUserWhatsApp) {
    try {
      await deps.logoutUserWhatsApp(user.id, accountId);
    } catch (err) {
      logger.warn(
        { err, userId: user.id },
        'WhatsApp logout deps call failed',
      );
    }
  }

  try {
    const saved = saveUserWhatsAppConfig(user.id, {
      accountId,
      phoneNumber: current?.phoneNumber || '',
      enabled: false,
      paired: false,
    });
    appendImConfigAudit(user.username, 'whatsapp', 'logout', ['enabled', 'paired'], { userId: user.id, accountId });
    const state = deps?.getUserWhatsAppState?.(user.id) ?? {
      status: 'logged_out' as const,
    };
    return c.json({
      accountId: saved.accountId,
      phoneNumber: saved.phoneNumber,
      enabled: saved.enabled ?? false,
      paired: saved.paired ?? false,
      updatedAt: saved.updatedAt,
      connected: false,
      state,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to persist WhatsApp logout state');
    return c.json({ error: 'Failed to save logout state' }, 500);
  }
});

// ─── IM Binding management (bindings panoramic page) ────────────

configRoutes.put('/user-im/bindings/:imJid', authMiddleware, async (c) => {
  const imJid = decodeURIComponent(c.req.param('imJid'));
  const user = c.get('user') as AuthUser;

  // Validate IM JID
  const channelType = getChannelType(imJid);
  if (!channelType) {
    return c.json({ error: 'Invalid IM JID' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  // IM-binding 改的是 imGroup 行（target_agent_id / target_main_jid /
  // activation_mode 等），与 agents.ts 的 4 个 IM-binding 路由对齐：
  // 非成员用 access 检查隐藏存在性（404），成员但非 owner 拒绝写（403）。
  // 否则共享工作区里的 member 可以劫持 owner 的 IM 路由到自己 agent。
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));

  // Unbind mode
  if (body.unbind === true) {
    const updated: RegisteredGroup = {
      ...imGroup,
      target_main_jid: undefined,
      target_agent_id: undefined,
    };
    applyBindingUpdate(imJid, updated);
    logger.info({ imJid, userId: user.id }, 'IM group unbound (bindings page)');
    return c.json({ success: true });
  }

  // Bind to agent
  if (typeof body.target_agent_id === 'string' && body.target_agent_id.trim()) {
    const agentId = body.target_agent_id.trim();
    const agent = getAgent(agentId);
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    if (agent.kind !== 'conversation') {
      return c.json(
        { error: 'Only conversation agents can bind IM groups' },
        400,
      );
    }
    // Check user can access the workspace that owns this agent
    const ownerGroup = getRegisteredGroup(agent.chat_jid);
    if (
      !ownerGroup ||
      !canAccessGroup(user, { ...ownerGroup, jid: agent.chat_jid })
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const force = body.force === true;
    const replyPolicy =
      body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
    const hasConflict =
      (imGroup.target_agent_id && imGroup.target_agent_id !== agentId) ||
      !!imGroup.target_main_jid;
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }

    const updated: RegisteredGroup = {
      ...imGroup,
      target_agent_id: agentId,
      target_main_jid: undefined,
      reply_policy: replyPolicy,
    };
    applyBindingUpdate(imJid, updated);
    logger.info(
      { imJid, agentId, userId: user.id },
      'IM group bound to agent (bindings page)',
    );
    return c.json({ success: true });
  }

  // Parse activation_mode for activation-only update
  const rawActivationMode = body.activation_mode;
  const activationMode =
    typeof rawActivationMode === 'string' &&
    VALID_ACTIVATION_MODES.has(rawActivationMode)
      ? (rawActivationMode as typeof rawActivationMode &
          'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled')
      : undefined;

  // Parse owner_im_id for owner_mentioned mode
  const ownerImId =
    typeof body.owner_im_id === 'string' && body.owner_im_id.trim()
      ? body.owner_im_id.trim()
      : undefined;

  // Bind to workspace main conversation
  if (typeof body.target_main_jid === 'string' && body.target_main_jid.trim()) {
    const targetMainJid = body.target_main_jid.trim();
    const targetGroup = getRegisteredGroup(targetMainJid);
    if (!targetGroup) {
      return c.json({ error: 'Target workspace not found' }, 404);
    }
    if (!canAccessGroup(user, { ...targetGroup, jid: targetMainJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (targetGroup.is_home) {
      return c.json(
        { error: 'Home workspace main conversation uses default IM routing' },
        400,
      );
    }

    const force = body.force === true;
    const replyPolicy =
      body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
    const legacyMainJid = `web:${targetGroup.folder}`;
    const hasConflict =
      !!imGroup.target_agent_id ||
      (imGroup.target_main_jid &&
        imGroup.target_main_jid !== targetMainJid &&
        imGroup.target_main_jid !== legacyMainJid);
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }

    const updated: RegisteredGroup = {
      ...imGroup,
      target_main_jid: targetMainJid,
      target_agent_id: undefined,
      reply_policy: replyPolicy,
      ...(activationMode !== undefined ? { activation_mode: activationMode } : {}),
      ...(ownerImId !== undefined ? { owner_im_id: ownerImId } : {}),
    };
    applyBindingUpdate(imJid, updated);
    logger.info(
      { imJid, targetMainJid, userId: user.id },
      'IM group bound to workspace (bindings page)',
    );
    return c.json({ success: true });
  }

  // Activation-only update (no target, just update activation_mode and/or owner_im_id)
  if (activationMode !== undefined || ownerImId !== undefined) {
    const updated: RegisteredGroup = {
      ...imGroup,
      ...(activationMode !== undefined ? { activation_mode: activationMode } : {}),
      ...(ownerImId !== undefined ? { owner_im_id: ownerImId } : {}),
    };
    applyBindingUpdate(imJid, updated);
    logger.info(
      { imJid, activationMode, ownerImId, userId: user.id },
      'IM group activation_mode updated (bindings page)',
    );
    return c.json({ success: true });
  }

  return c.json(
    { error: 'Must provide target_main_jid, target_agent_id, activation_mode, or unbind' },
    400,
  );
});

// Reset sender_allowlist to NULL (unrestricted) — escape hatch for the
// "owner-locked trap" where buildOnNewChat registered the group with `[]`
// because the Feishu owner had not DM'd the bot yet. After reset, anyone
// in the group can trigger the bot.
configRoutes.post(
  '/user-im/bindings/:imJid/reset-allowlist',
  authMiddleware,
  (c) => {
    const imJid = decodeURIComponent(c.req.param('imJid'));
    const user = c.get('user') as AuthUser;

    const channelType = getChannelType(imJid);
    if (!channelType) {
      return c.json({ error: 'Invalid IM JID' }, 400);
    }
    if (channelType !== 'feishu') {
      return c.json({ error: 'Only Feishu groups are supported' }, 400);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (imGroup.created_by !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (
      !Array.isArray(imGroup.sender_allowlist) ||
      imGroup.sender_allowlist.length !== 0
    ) {
      return c.json({ error: 'Group is not in locked allowlist state' }, 400);
    }

    clearSenderAllowlist(imJid);

    const updated = { ...imGroup, sender_allowlist: undefined };
    const webDeps = getWebDeps();
    if (webDeps) {
      const groups = webDeps.getRegisteredGroups();
      if (groups[imJid]) groups[imJid] = updated;
    }

    logger.info(
      { imJid, userId: user.id },
      'Sender allowlist cleared (manual reset from bindings page)',
    );
    return c.json({ success: true });
  },
);

export default configRoutes;
