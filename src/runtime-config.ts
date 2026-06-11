import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { logger } from './logger.js';

const MAX_FIELD_LENGTH = 2000;
const CURRENT_CONFIG_VERSION = 3;
const DEFAULT_THIRD_PARTY_PROFILE_ID = 'default';
const DEFAULT_THIRD_PARTY_PROFILE_NAME = '默认第三方';
const OFFICIAL_CLAUDE_PROFILE_ID = '__official__';

/**
 * 写加密 / OAuth / IM 凭据等含敏感数据的 JSON 配置文件。
 * 即便外层 AES-256-GCM 已加密 ciphertext，密文 + IV + auth tag 仍不应让
 * 同主机其他本地账号读到（旧版默认 0o644 在多租户场景下泄漏整套 IM/OAuth 凭据
 * 的 ciphertext，配合 key 文件泄漏即可解密）。统一走该 helper：tmp 文件以
 * 0o600 创建，rename 后再次 chmod 防御 APFS 上 mode 不跟随 inode 的边角情况。
 */
function writeSecretFile(targetPath: string, data: string): void {
  const tmp = `${targetPath}.tmp`;
  // 先 unlink stale tmp，避免 fs.writeFileSync 在文件已存在时复用旧 mode
  // (Node 文档：mode 仅在 on-create 时应用)。残留 0o644 会让我们这次写入
  // 落到 0o644 ciphertext，rename 后即便 chmod 0o600 也有 race 窗口。
  try {
    fs.unlinkSync(tmp);
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') {
      // 罕见路径权限错：让外层捕捉到，避免静默把 secret 落到 0o644。
      throw err;
    }
  }
  // 用 fd 路径强制 0o600 创建：fs.openSync 的 mode 在 O_CREAT 时一定生效，
  // fs.writeFileSync(fd, ...) 内部循环处理 short-write。
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  try {
    fs.writeFileSync(fd, data);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  fs.renameSync(tmp, targetPath);
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    /* best effort */
  }
}

const CLAUDE_CONFIG_DIR = path.join(DATA_DIR, 'config');
const CLAUDE_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'claude-provider.json');
const CLAUDE_CONFIG_KEY_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.key',
);
const CLAUDE_CONFIG_AUDIT_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.audit.log',
);
const CLAUDE_CUSTOM_ENV_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-custom-env.json',
);
const FEISHU_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'feishu-provider.json');
const TELEGRAM_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'telegram-provider.json',
);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_CLAUDE_ENV_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
]);
const DANGEROUS_ENV_VARS = new Set([
  // Code execution / preload attacks
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'PERL5OPT',
  // Path manipulation
  'PATH',
  'PYTHONPATH',
  'RUBYLIB',
  'PERL5LIB',
  'GIT_EXEC_PATH',
  'CDPATH',
  // Shell behavior
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'ZDOTDIR',
  // Editor / terminal (可被利用执行命令)
  'EDITOR',
  'VISUAL',
  'PAGER',
  // SSH / Git（防止凭据泄露或命令注入）
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  // Sensitive directories
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  // HappyClaw 内部路径映射
  'HAPPYCLAW_WORKSPACE_GROUP',
  'HAPPYCLAW_WORKSPACE_GLOBAL',
  'HAPPYCLAW_WORKSPACE_IPC',
  'CLAUDE_CONFIG_DIR',
]);
const MAX_CUSTOM_ENV_ENTRIES = 50;
const MAX_THIRD_PARTY_PROFILES = 20;

type ClaudeProviderMode = 'official' | 'third_party';

// Fallback scopes for .credentials.json when stored credentials lack scopes.
// Differs from OAUTH_SCOPES in routes/config.ts (the authorize-flow request):
// authorize requests org:create_api_key; credential files need user:sessions:claude_code.
const DEFAULT_CREDENTIAL_SCOPES = [
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
];

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
  scopes: string[];
  subscriptionType?: string; // e.g. 'max', 'pro' — written to .credentials.json if present
}

export interface OAuthUsageBucket {
  utilization: number; // 0-100
  resets_at: string; // ISO 8601
}

export interface OAuthUsageResponse {
  five_hour: OAuthUsageBucket | null;
  seven_day: OAuthUsageBucket | null;
  seven_day_opus: OAuthUsageBucket | null;
  seven_day_sonnet: OAuthUsageBucket | null;
}

export interface CachedOAuthUsage {
  data: OAuthUsageResponse;
  fetchedAt: number; // Unix timestamp ms
  error?: string;
}

export interface ClaudeProviderConfig {
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials: ClaudeOAuthCredentials | null;
  anthropicModel: string;
  updatedAt: string | null;
}

export interface ClaudeProviderPublicConfig {
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
}

export interface ClaudeThirdPartyProfile {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicModel: string;
  updatedAt: string | null;
  customEnv: Record<string, string>;
}

export interface ClaudeThirdPartyProfilePublic {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  customEnv: Record<string, string>;
}

export interface FeishuProviderConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type FeishuConfigSource = 'runtime' | 'env' | 'none';

export interface FeishuProviderPublicConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  updatedAt: string | null;
  source: FeishuConfigSource;
}

export interface TelegramProviderConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type TelegramConfigSource = 'runtime' | 'env' | 'none';

export interface TelegramProviderPublicConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
  proxyUrl: string;
  enabled: boolean;
  updatedAt: string | null;
  source: TelegramConfigSource;
}

interface SecretPayload {
  anthropicAuthToken: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
}

interface EncryptedSecrets {
  iv: string;
  tag: string;
  data: string;
}

interface FeishuSecretPayload {
  appSecret: string;
}

interface TelegramSecretPayload {
  botToken: string;
}

interface StoredFeishuProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  ownerOpenId?: string;
  autoIsolateContext?: boolean;
  secret: EncryptedSecrets;
}

interface StoredTelegramProviderConfigV1 {
  version: 1;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface StoredClaudeProviderConfigV2 {
  version: 2;
  anthropicBaseUrl: string;
  updatedAt: string;
  secrets: EncryptedSecrets;
}

interface StoredClaudeThirdPartyProfileV1 {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string;
  secrets: EncryptedSecrets;
  customEnv?: Record<string, string>;
}

interface StoredClaudeProviderConfigV3 {
  version: 3;
  activeProfileId: string;
  profiles: StoredClaudeThirdPartyProfileV1[];
  official: {
    updatedAt: string;
    secrets: EncryptedSecrets;
    customEnv?: Record<string, string>;
  };
}

interface StoredClaudeProviderConfigLegacy {
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  updatedAt?: string;
}

interface ClaudeStoredStateV3Resolved {
  activeProfileId: string;
  profiles: StoredClaudeThirdPartyProfileV1[];
  officialSecrets: SecretPayload;
  officialUpdatedAt: string | null;
  officialCustomEnv: Record<string, string>;
}

interface ClaudeStoredProfileResolved {
  mode: ClaudeProviderMode;
  profile: ClaudeThirdPartyProfile | null;
  officialSecrets: SecretPayload;
  officialUpdatedAt: string | null;
}

// ─── V4 统一供应商模型 ────────────────────────────────────────

export interface BalancingConfig {
  strategy: 'round-robin' | 'weighted-round-robin' | 'failover';
  unhealthyThreshold: number;
  recoveryIntervalMs: number;
}

const DEFAULT_BALANCING_CONFIG: BalancingConfig = {
  strategy: 'round-robin',
  unhealthyThreshold: 3,
  recoveryIntervalMs: 300_000,
};

/** V4 磁盘格式 — 每个供应商的 secrets 独立加密 */
interface StoredProviderV4 {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicModel: string;
  secrets: EncryptedSecrets;
  customEnv?: Record<string, string>;
  updatedAt: string;
}

interface StoredClaudeProviderConfigV4 {
  version: 4;
  providers: StoredProviderV4[];
  balancing: BalancingConfig;
  updatedAt: string;
}

/** 解密后的统一供应商运行时结构 */
export interface UnifiedProvider {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicModel: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials: ClaudeOAuthCredentials | null;
  customEnv: Record<string, string>;
  updatedAt: string;
}

/** UnifiedProvider 的公开（脱敏）版本 */
export interface UnifiedProviderPublic {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicModel: string;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  hasAnthropicApiKey: boolean;
  anthropicApiKeyMasked: string | null;
  hasClaudeCodeOauthToken: boolean;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
  customEnv: Record<string, string>;
  updatedAt: string;
}

const MAX_PROVIDERS = 20;
const POOL_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'provider-pool.json');

interface ClaudeConfigAuditEntry {
  timestamp: string;
  actor: string;
  action: string;
  changedFields: string[];
  metadata?: Record<string, unknown>;
}

function normalizeSecret(input: unknown, fieldName: string): string {
  if (typeof input !== 'string') {
    throw new Error(`Invalid field: ${fieldName}`);
  }
  // Strip ALL whitespace and non-ASCII characters — API keys/tokens are always ASCII;
  // users often paste with accidental spaces, line breaks, or smart quotes (e.g. U+2019).
  // eslint-disable-next-line no-control-regex
  const value = input.replace(/\s+/g, '').replace(/[^\x00-\x7F]/g, '');
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error(`Field too long: ${fieldName}`);
  }
  return value;
}

function normalizeBaseUrl(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: anthropicBaseUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  return value;
}

function normalizeModel(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: anthropicModel');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > 128) {
    throw new Error('Field too long: anthropicModel');
  }
  return value;
}

function normalizeFeishuAppId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: appId');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: appId');
  }
  return value;
}

function normalizeTelegramProxyUrl(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') {
    throw new Error('Invalid field: proxyUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: proxyUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: proxyUrl');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(protocol)) {
    throw new Error('Invalid field: proxyUrl');
  }
  return value;
}

function normalizeProfileName(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: name');
  }
  const value = input.trim();
  if (!value) {
    throw new Error('Invalid field: name');
  }
  if (value.length > 64) {
    throw new Error('Field too long: name');
  }
  return value;
}

function normalizeProfileId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: id');
  }
  const value = input.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new Error('Invalid field: id');
  }
  return value;
}

function sanitizeCustomEnvMap(
  input: Record<string, string>,
  options?: { skipReservedClaudeKeys?: boolean },
): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length > MAX_CUSTOM_ENV_ENTRIES) {
    throw new Error(
      `customEnv must have at most ${MAX_CUSTOM_ENV_ENTRIES} entries`,
    );
  }

  const out: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid env key: ${key}`);
    }
    if (options?.skipReservedClaudeKeys && RESERVED_CLAUDE_ENV_KEYS.has(key)) {
      continue;
    }
    out[key] = sanitizeEnvValue(
      typeof rawValue === 'string' ? rawValue : String(rawValue),
    );
  }
  return out;
}

function normalizeConfig(
  input: Omit<ClaudeProviderConfig, 'updatedAt'>,
): Omit<ClaudeProviderConfig, 'updatedAt'> {
  return {
    anthropicBaseUrl: normalizeBaseUrl(input.anthropicBaseUrl),
    anthropicAuthToken: normalizeSecret(
      input.anthropicAuthToken,
      'anthropicAuthToken',
    ),
    anthropicApiKey: normalizeSecret(input.anthropicApiKey, 'anthropicApiKey'),
    claudeCodeOauthToken: normalizeSecret(
      input.claudeCodeOauthToken,
      'claudeCodeOauthToken',
    ),
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
    anthropicModel: normalizeModel(input.anthropicModel),
  };
}

function buildConfig(
  input: Omit<ClaudeProviderConfig, 'updatedAt'>,
  updatedAt: string | null,
): ClaudeProviderConfig {
  return {
    ...normalizeConfig(input),
    updatedAt,
  };
}

function getOrCreateEncryptionKey(): Buffer {
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });

  if (fs.existsSync(CLAUDE_CONFIG_KEY_FILE)) {
    const raw = fs.readFileSync(CLAUDE_CONFIG_KEY_FILE, 'utf-8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length === 32) return key;
    throw new Error('Invalid encryption key file');
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(CLAUDE_CONFIG_KEY_FILE, key.toString('hex') + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return key;
}

// tombstone（happycodex）：上游 runtime-config.ts:604-671 的 encryptSecrets/decryptSecrets
// 仅服务 Claude provider payload（claude-provider.json 内的 secrets 字段）。codex-only
// 运行时不消费 Anthropic 凭据，provider 体系整体惰性化（见 readStoredState /
// readStoredStateV4 / writeStoredState* 各处 tombstone）——二者门控为抛错，确保任何
// 残留调用路径都不会触发 getOrCreateEncryptionKey 的加密 key 首次落盘等副作用。
// Feishu / Telegram / 用户 IM 密文走 encryptChannelSecret / decryptChannelSecret
// （与上游同一 key 文件 claude-provider.key，文件名不可改），保持活体不动。
const PROVIDER_SYSTEM_DISABLED =
  'Claude provider 配置体系在 happycodex（codex-only）已停用';

function encryptSecrets(payload: SecretPayload): EncryptedSecrets {
  void payload;
  throw new Error(PROVIDER_SYSTEM_DISABLED);
}

function decryptSecrets(secrets: EncryptedSecrets): SecretPayload {
  void secrets;
  throw new Error(PROVIDER_SYSTEM_DISABLED);
}

function encryptChannelSecret<T>(payload: T): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptChannelSecret<T>(secrets: EncryptedSecrets): T {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  return JSON.parse(decrypted) as T;
}

// tombstone（happycodex）：上游 runtime-config.ts:701-715 readLegacyConfig（无版本号
// 旧格式 claude-provider.json 解析）随 readStoredState 惰性化（恒 null）成为不可达，
// 一并删除。

function toStoredProfile(
  profile: ClaudeThirdPartyProfile,
): StoredClaudeThirdPartyProfileV1 {
  const sanitizedEnv = sanitizeCustomEnvMap(profile.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
  return {
    id: normalizeProfileId(profile.id),
    name: normalizeProfileName(profile.name),
    anthropicBaseUrl: normalizeBaseUrl(profile.anthropicBaseUrl),
    anthropicModel: normalizeModel(profile.anthropicModel),
    updatedAt: profile.updatedAt || new Date().toISOString(),
    secrets: encryptSecrets({
      anthropicAuthToken: normalizeSecret(
        profile.anthropicAuthToken,
        'anthropicAuthToken',
      ),
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    }),
    ...(Object.keys(sanitizedEnv).length > 0
      ? { customEnv: sanitizedEnv }
      : {}),
  };
}

function fromStoredProfile(
  stored: StoredClaudeThirdPartyProfileV1,
): ClaudeThirdPartyProfile {
  const secrets = decryptSecrets(stored.secrets);
  return {
    id: normalizeProfileId(stored.id),
    name: normalizeProfileName(stored.name),
    anthropicBaseUrl: normalizeBaseUrl(stored.anthropicBaseUrl),
    anthropicAuthToken: secrets.anthropicAuthToken,
    anthropicModel: normalizeModel(
      stored.anthropicModel ?? (stored as any).happyclawModel ?? '',
    ),
    updatedAt: stored.updatedAt || null,
    customEnv: sanitizeCustomEnvMap(stored.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
  };
}

function makeDefaultThirdPartyProfile(
  config: ClaudeProviderConfig,
): ClaudeThirdPartyProfile {
  return {
    id: DEFAULT_THIRD_PARTY_PROFILE_ID,
    name: DEFAULT_THIRD_PARTY_PROFILE_NAME,
    anthropicBaseUrl: config.anthropicBaseUrl,
    anthropicAuthToken: config.anthropicAuthToken,
    anthropicModel: normalizeModel(
      config.anthropicModel || process.env.ANTHROPIC_MODEL || '',
    ),
    updatedAt: config.updatedAt || new Date().toISOString(),
    customEnv: {},
  };
}

function normalizeOfficialSecrets(input: SecretPayload): SecretPayload {
  return {
    anthropicAuthToken: '',
    anthropicApiKey: normalizeSecret(
      input.anthropicApiKey ?? '',
      'anthropicApiKey',
    ),
    claudeCodeOauthToken: normalizeSecret(
      input.claudeCodeOauthToken ?? '',
      'claudeCodeOauthToken',
    ),
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
  };
}

function isOfficialClaudeMode(activeProfileId: string): boolean {
  return activeProfileId === OFFICIAL_CLAUDE_PROFILE_ID;
}

function buildOfficialClaudeProviderConfig(
  officialSecrets: SecretPayload,
  officialUpdatedAt: string | null,
): ClaudeProviderConfig {
  return buildConfig(
    {
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials: officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: '',
    },
    officialUpdatedAt,
  );
}

// tombstone（happycodex）：上游 runtime-config.ts:815-914 normalizeStoredState
// （V3 状态归一化 + claude-custom-env.json legacy customEnv 惰性迁移读写）随
// readStoredState / writeStoredState 惰性化成为不可达，一并删除。

function readStoredState(): ClaudeStoredStateV3Resolved | null {
  // tombstone（happycodex）：上游 runtime-config.ts:916-999 读取 claude-provider.json
  // （legacy/V2/V3 全版本解析 + decryptSecrets，读取期会触发加密 key 首次落盘，
  // normalizeStoredState 还会做 legacy customEnv 的惰性迁移）。codex-only 运行时
  // 不存在 Claude provider 消费方：恒返回 null（视同「无配置」），不读文件、不解密、
  // 不迁移，存量文件原样保留。下游读取函数（listClaudeThirdPartyProfiles /
  // resolveProfileToConfig / getCustomEnvForProfile 等）经各自 null 分支退化为
  // 空/禁用态，导出签名不变。
  return null;
}

function writeStoredState(state: ClaudeStoredStateV3Resolved): void {
  // tombstone（happycodex）：上游 runtime-config.ts:1001-1024 加密回写 claude-provider.json
  // （V3 格式，encryptSecrets → 加密 key 首次落盘）。provider 体系惰性化后写路径
  // 整体禁用：saveClaudeProviderConfig / saveClaudeOfficialProviderSecrets /
  // create|update|activate|delete*ThirdPartyProfile / saveOfficialCustomEnv 等
  // CRUD 导出经此抛错成为禁用态（签名不变），不再产生配置与 key 落盘。
  void state;
  throw new Error(PROVIDER_SYSTEM_DISABLED);
}

// ─── V4 统一供应商 Read / Write / CRUD ──────────────────────────

// tombstone（happycodex）：上游 runtime-config.ts:1028-1174 的 toStoredProviderV4 /
// fromStoredProviderV4（V4 provider 加解密编解码）与 migrateV3toV4（V3→V4 迁移，
// 含 provider-pool.json 读取）随 readStoredStateV4 / writeStoredStateV4 惰性化
// 成为不可达，一并删除。存量 claude-provider.json / provider-pool.json 原样保留。

/** Read V4 config — happycodex 惰性化：恒返回 null，见下方 tombstone */
function readStoredStateV4(): {
  providers: UnifiedProvider[];
  balancing: BalancingConfig;
} | null {
  // tombstone（happycodex）：上游 runtime-config.ts:1177-1223 读取 V4 配置，且对
  // V3 及更老版本在「读取期」自动迁移回写（migrateV3toV4 + writeStoredStateV4 +
  // decryptSecrets → 加密 key 首次落盘）。codex-only 运行时无 provider 消费方：
  // 恒返回 null，读旧文件零副作用（claude-provider.json / provider-pool.json
  // 原样保留，将来如需可人工迁移）。getProviders / getEnabledProviders /
  // getClaudeProviderConfig / getBalancingConfig / resolveProviderById /
  // getActiveProfileCustomEnv 等读取函数经 null 分支退化为空/禁用态，签名不变。
  return null;
}

function writeStoredStateV4(
  providers: UnifiedProvider[],
  balancing: BalancingConfig,
): void {
  // tombstone（happycodex）：上游 runtime-config.ts:1225-1238 加密回写 V4
  // claude-provider.json（toStoredProviderV4 → encryptSecrets → 加密 key 首次
  // 落盘）。provider 体系惰性化后写路径整体禁用：createProvider / updateProvider /
  // updateProviderSecrets / toggleProvider / deleteProvider / saveBalancingConfig
  // 等 V4 CRUD 导出经此抛错成为禁用态（签名不变）。
  void providers;
  void balancing;
  throw new Error(PROVIDER_SYSTEM_DISABLED);
}

// ─── V4 公开 API ─────────────────────────────────────────────

export function getProviders(): UnifiedProvider[] {
  const state = readStoredStateV4();
  return state?.providers ?? [];
}

export function getEnabledProviders(): UnifiedProvider[] {
  return getProviders().filter((p) => p.enabled);
}

export function getBalancingConfig(): BalancingConfig {
  const state = readStoredStateV4();
  return state?.balancing ?? { ...DEFAULT_BALANCING_CONFIG };
}

export function saveBalancingConfig(
  config: Partial<BalancingConfig>,
): BalancingConfig {
  const state = readStoredStateV4() || {
    providers: [],
    balancing: { ...DEFAULT_BALANCING_CONFIG },
  };
  const merged: BalancingConfig = {
    ...state.balancing,
    ...config,
  };
  writeStoredStateV4(state.providers, merged);
  return merged;
}

export function createProvider(input: {
  name: string;
  type: 'official' | 'third_party';
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicModel?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
  customEnv?: Record<string, string>;
  weight?: number;
  enabled?: boolean;
}): UnifiedProvider {
  const state = readStoredStateV4() || {
    providers: [],
    balancing: { ...DEFAULT_BALANCING_CONFIG },
  };

  if (state.providers.length >= MAX_PROVIDERS) {
    throw new Error(`最多只能创建 ${MAX_PROVIDERS} 个供应商`);
  }

  const now = new Date().toISOString();
  const provider: UnifiedProvider = {
    id: crypto.randomBytes(8).toString('hex'),
    name: normalizeProfileName(input.name),
    type: input.type,
    enabled: input.enabled ?? state.providers.length === 0,
    weight: Math.max(1, Math.min(100, input.weight ?? 1)),
    anthropicBaseUrl: input.anthropicBaseUrl
      ? normalizeBaseUrl(input.anthropicBaseUrl)
      : '',
    anthropicAuthToken: input.anthropicAuthToken
      ? normalizeSecret(input.anthropicAuthToken, 'anthropicAuthToken')
      : '',
    anthropicModel: input.anthropicModel
      ? normalizeModel(input.anthropicModel)
      : '',
    anthropicApiKey: input.anthropicApiKey
      ? normalizeSecret(input.anthropicApiKey, 'anthropicApiKey')
      : '',
    claudeCodeOauthToken: input.claudeCodeOauthToken
      ? normalizeSecret(input.claudeCodeOauthToken, 'claudeCodeOauthToken')
      : '',
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
    customEnv: sanitizeCustomEnvMap(input.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
    updatedAt: now,
  };

  state.providers.push(provider);
  writeStoredStateV4(state.providers, state.balancing);
  return provider;
}

export function updateProvider(
  id: string,
  patch: {
    name?: string;
    anthropicBaseUrl?: string;
    anthropicModel?: string;
    customEnv?: Record<string, string>;
    weight?: number;
  },
): UnifiedProvider {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  const current = state.providers[idx]!;
  const updated: UnifiedProvider = {
    ...current,
    ...(patch.name !== undefined
      ? { name: normalizeProfileName(patch.name) }
      : {}),
    ...(patch.anthropicBaseUrl !== undefined
      ? { anthropicBaseUrl: normalizeBaseUrl(patch.anthropicBaseUrl) }
      : {}),
    ...(patch.anthropicModel !== undefined
      ? { anthropicModel: normalizeModel(patch.anthropicModel) }
      : {}),
    ...(patch.customEnv !== undefined
      ? {
          customEnv: sanitizeCustomEnvMap(patch.customEnv, {
            skipReservedClaudeKeys: true,
          }),
        }
      : {}),
    ...(patch.weight !== undefined
      ? { weight: Math.max(1, Math.min(100, patch.weight)) }
      : {}),
    updatedAt: new Date().toISOString(),
  };

  state.providers[idx] = updated;
  writeStoredStateV4(state.providers, state.balancing);
  return updated;
}

export function updateProviderSecrets(
  id: string,
  secrets: {
    anthropicAuthToken?: string;
    clearAnthropicAuthToken?: boolean;
    anthropicApiKey?: string;
    clearAnthropicApiKey?: boolean;
    claudeCodeOauthToken?: string;
    clearClaudeCodeOauthToken?: boolean;
    claudeOAuthCredentials?: ClaudeOAuthCredentials;
    clearClaudeOAuthCredentials?: boolean;
  },
): UnifiedProvider {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  const current = state.providers[idx]!;
  const updated = { ...current, updatedAt: new Date().toISOString() };

  if (typeof secrets.anthropicAuthToken === 'string') {
    updated.anthropicAuthToken = normalizeSecret(
      secrets.anthropicAuthToken,
      'anthropicAuthToken',
    );
  } else if (secrets.clearAnthropicAuthToken) {
    updated.anthropicAuthToken = '';
  }

  if (typeof secrets.anthropicApiKey === 'string') {
    updated.anthropicApiKey = normalizeSecret(
      secrets.anthropicApiKey,
      'anthropicApiKey',
    );
  } else if (secrets.clearAnthropicApiKey) {
    updated.anthropicApiKey = '';
  }

  if (typeof secrets.claudeCodeOauthToken === 'string') {
    updated.claudeCodeOauthToken = normalizeSecret(
      secrets.claudeCodeOauthToken,
      'claudeCodeOauthToken',
    );
  } else if (secrets.clearClaudeCodeOauthToken) {
    updated.claudeCodeOauthToken = '';
  }

  if (secrets.claudeOAuthCredentials) {
    updated.claudeOAuthCredentials = secrets.claudeOAuthCredentials;
    // When full OAuth creds set, clear legacy single token
    updated.claudeCodeOauthToken = '';
  } else if (secrets.clearClaudeOAuthCredentials) {
    updated.claudeOAuthCredentials = null;
  }

  state.providers[idx] = updated;
  writeStoredStateV4(state.providers, state.balancing);
  return updated;
}

export function toggleProvider(id: string): UnifiedProvider {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  const provider = state.providers[idx]!;
  const newEnabled = !provider.enabled;

  // Prevent disabling the last enabled provider
  if (!newEnabled && state.providers.filter((p) => p.enabled).length <= 1) {
    throw new Error('至少需要保留一个启用的供应商');
  }

  state.providers[idx] = {
    ...provider,
    enabled: newEnabled,
    updatedAt: new Date().toISOString(),
  };
  writeStoredStateV4(state.providers, state.balancing);
  return state.providers[idx]!;
}

export function deleteProvider(id: string): void {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  if (state.providers.length <= 1) {
    throw new Error('至少需要保留一个供应商');
  }

  const wasEnabled = state.providers[idx]!.enabled;
  state.providers.splice(idx, 1);

  // If deleted provider was the only enabled one, enable the first remaining
  if (wasEnabled && !state.providers.some((p) => p.enabled)) {
    state.providers[0]!.enabled = true;
  }

  writeStoredStateV4(state.providers, state.balancing);
}

/** Convert a UnifiedProvider to the flat ClaudeProviderConfig used by container runner */
export function providerToConfig(
  provider: UnifiedProvider,
): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: provider.anthropicBaseUrl,
    anthropicAuthToken: provider.anthropicAuthToken,
    anthropicApiKey: provider.anthropicApiKey,
    claudeCodeOauthToken: provider.claudeCodeOauthToken,
    claudeOAuthCredentials: provider.claudeOAuthCredentials,
    anthropicModel: provider.anthropicModel,
    updatedAt: provider.updatedAt,
  };
}

/** Convert UnifiedProvider to public (masked) representation */
export function toPublicProvider(
  provider: UnifiedProvider,
): UnifiedProviderPublic {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    enabled: provider.enabled,
    weight: provider.weight,
    anthropicBaseUrl: provider.anthropicBaseUrl,
    anthropicModel: provider.anthropicModel,
    hasAnthropicAuthToken: !!provider.anthropicAuthToken,
    anthropicAuthTokenMasked: maskSecret(provider.anthropicAuthToken),
    hasAnthropicApiKey: !!provider.anthropicApiKey,
    anthropicApiKeyMasked: maskSecret(provider.anthropicApiKey),
    hasClaudeCodeOauthToken: !!provider.claudeCodeOauthToken,
    claudeCodeOauthTokenMasked: maskSecret(provider.claudeCodeOauthToken),
    hasClaudeOAuthCredentials: !!provider.claudeOAuthCredentials,
    claudeOAuthCredentialsExpiresAt:
      provider.claudeOAuthCredentials?.expiresAt ?? null,
    claudeOAuthCredentialsAccessTokenMasked: provider.claudeOAuthCredentials
      ? maskSecret(provider.claudeOAuthCredentials.accessToken)
      : null,
    customEnv: provider.customEnv || {},
    updatedAt: provider.updatedAt,
  };
}

/**
 * Resolve a provider by ID to { config, customEnv } in a single disk read.
 * Used by container-runner for pool-selected providers.
 */
export function resolveProviderById(providerId: string): {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
} {
  const state = readStoredStateV4();
  if (!state) return { config: defaultsFromEnv(), customEnv: {} };

  const provider = state.providers.find((p) => p.id === providerId);
  if (!provider) {
    logger.warn(
      { providerId },
      'resolveProviderById: provider not found, falling back to first enabled',
    );
    const fallback =
      state.providers.find((p) => p.enabled) || state.providers[0];
    if (!fallback) return { config: defaultsFromEnv(), customEnv: {} };
    return {
      config: providerToConfig(fallback),
      customEnv: fallback.customEnv,
    };
  }

  return {
    config: providerToConfig(provider),
    customEnv: provider.customEnv,
  };
}

// ─── V3 compat layer (used by remaining V3 code paths) ───────────

// tombstone（happycodex）：上游 runtime-config.ts:1559-1615 的 resolveActiveProfile /
// readStoredConfig（V3 active profile 解析为扁平配置）随 readStoredState 惰性化
// （恒 null）成为不可达，一并删除。

function defaultsFromEnv(): ClaudeProviderConfig {
  // tombstone（happycodex）：上游 runtime-config.ts:1617-1640 从 ANTHROPIC_BASE_URL /
  // ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN /
  // ANTHROPIC_MODEL 环境变量兜底拼装 provider 配置。codex 引擎不消费这些凭据，
  // env 兜底一并停用：恒返回全空配置，作为 getClaudeProviderConfig /
  // resolveProviderById / resolveProfileToConfig 等读取函数的「空态」。
  return {
    anthropicBaseUrl: '',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: '',
    updatedAt: null,
  };
}

function readStoredFeishuConfig(): FeishuProviderConfig | null {
  if (!fs.existsSync(FEISHU_CONFIG_FILE)) return null;
  const content = fs.readFileSync(FEISHU_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredFeishuProviderConfigV1;
  const secret = decryptChannelSecret<FeishuSecretPayload>(stored.secret);
  return {
    appId: normalizeFeishuAppId(stored.appId ?? ''),
    appSecret: secret.appSecret,
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

function defaultsFeishuFromEnv(): FeishuProviderConfig {
  const raw = {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
  };
  return {
    appId: raw.appId.trim(),
    appSecret: raw.appSecret.trim(),
    updatedAt: null,
  };
}

export function getFeishuProviderConfigWithSource(): {
  config: FeishuProviderConfig;
  source: FeishuConfigSource;
} {
  try {
    const stored = readStoredFeishuConfig();
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Feishu config, falling back to env',
    );
  }

  const fromEnv = defaultsFeishuFromEnv();
  if (fromEnv.appId || fromEnv.appSecret) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getFeishuProviderConfig(): FeishuProviderConfig {
  return getFeishuProviderConfigWithSource().config;
}

export function saveFeishuProviderConfig(
  next: Omit<FeishuProviderConfig, 'updatedAt'>,
): FeishuProviderConfig {
  const normalized: FeishuProviderConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredFeishuProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<FeishuSecretPayload>({
      appSecret: normalized.appSecret,
    }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  writeSecretFile(FEISHU_CONFIG_FILE, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

export function toPublicFeishuProviderConfig(
  config: FeishuProviderConfig,
  source: FeishuConfigSource,
): FeishuProviderPublicConfig {
  return {
    appId: config.appId,
    hasAppSecret: !!config.appSecret,
    appSecretMasked: maskSecret(config.appSecret),
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

// ========== Telegram Provider Config ==========

function readStoredTelegramConfig(): TelegramProviderConfig | null {
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) return null;
  const content = fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredTelegramProviderConfigV1;
  const secret = decryptChannelSecret<TelegramSecretPayload>(stored.secret);
  return {
    botToken: secret.botToken,
    proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

function defaultsTelegramFromEnv(): TelegramProviderConfig {
  const raw = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    proxyUrl: process.env.TELEGRAM_PROXY_URL || '',
  };
  return {
    botToken: raw.botToken.trim(),
    proxyUrl: normalizeTelegramProxyUrl(raw.proxyUrl),
    updatedAt: null,
  };
}

export function getTelegramProviderConfigWithSource(): {
  config: TelegramProviderConfig;
  source: TelegramConfigSource;
} {
  try {
    const stored = readStoredTelegramConfig();
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Telegram config, falling back to env',
    );
  }

  const fromEnv = defaultsTelegramFromEnv();
  if (fromEnv.botToken) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getTelegramProviderConfig(): TelegramProviderConfig {
  return getTelegramProviderConfigWithSource().config;
}

export function saveTelegramProviderConfig(
  next: Omit<TelegramProviderConfig, 'updatedAt'>,
): TelegramProviderConfig {
  const normalized: TelegramProviderConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizeTelegramProxyUrl(next.proxyUrl),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredTelegramProviderConfigV1 = {
    version: 1,
    proxyUrl: normalized.proxyUrl,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<TelegramSecretPayload>({
      botToken: normalized.botToken,
    }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  writeSecretFile(TELEGRAM_CONFIG_FILE, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

export function toPublicTelegramProviderConfig(
  config: TelegramProviderConfig,
  source: TelegramConfigSource,
): TelegramProviderPublicConfig {
  return {
    hasBotToken: !!config.botToken,
    botTokenMasked: maskSecret(config.botToken),
    proxyUrl: config.proxyUrl ?? '',
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

function maskSecret(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8)
    return `${'*'.repeat(Math.max(value.length - 2, 1))}${value.slice(-2)}`;
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 7, 4))}${value.slice(-4)}`;
}

export function toPublicClaudeProviderConfig(
  config: ClaudeProviderConfig,
): ClaudeProviderPublicConfig {
  return {
    anthropicBaseUrl: config.anthropicBaseUrl,
    anthropicModel: config.anthropicModel,
    updatedAt: config.updatedAt,
    hasAnthropicAuthToken: !!config.anthropicAuthToken,
    hasAnthropicApiKey: !!config.anthropicApiKey,
    hasClaudeCodeOauthToken: !!config.claudeCodeOauthToken,
    anthropicAuthTokenMasked: maskSecret(config.anthropicAuthToken),
    anthropicApiKeyMasked: maskSecret(config.anthropicApiKey),
    claudeCodeOauthTokenMasked: maskSecret(config.claudeCodeOauthToken),
    hasClaudeOAuthCredentials: !!config.claudeOAuthCredentials,
    claudeOAuthCredentialsExpiresAt:
      config.claudeOAuthCredentials?.expiresAt ?? null,
    claudeOAuthCredentialsAccessTokenMasked: config.claudeOAuthCredentials
      ? maskSecret(config.claudeOAuthCredentials.accessToken)
      : null,
  };
}

export function validateClaudeProviderConfig(
  config: ClaudeProviderConfig,
): string[] {
  const errors: string[] = [];

  if (config.anthropicAuthToken && !config.anthropicBaseUrl) {
    errors.push('使用 ANTHROPIC_AUTH_TOKEN 时必须配置 ANTHROPIC_BASE_URL');
  }

  if (config.anthropicBaseUrl) {
    try {
      const parsed = new URL(config.anthropicBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.push('ANTHROPIC_BASE_URL 必须是 http 或 https 地址');
      }
    } catch {
      errors.push('ANTHROPIC_BASE_URL 格式不正确');
    }
  }

  return errors;
}

export function getClaudeProviderConfig(): ClaudeProviderConfig {
  try {
    const state = readStoredStateV4();
    if (state) {
      const enabled =
        state.providers.find((p) => p.enabled) || state.providers[0];
      if (enabled) return providerToConfig(enabled);
    }
  } catch {
    // ignore corrupted file and use env fallback
  }
  return defaultsFromEnv();
}

export function saveClaudeProviderConfig(
  next: Omit<ClaudeProviderConfig, 'updatedAt'>,
  options?: { mode?: ClaudeProviderMode },
): ClaudeProviderConfig {
  const normalized = buildConfig(next, new Date().toISOString());
  const errors = validateClaudeProviderConfig(normalized);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  const mode =
    options?.mode ?? (normalized.anthropicBaseUrl ? 'third_party' : 'official');
  const existing = readStoredState();
  const baseState: ClaudeStoredStateV3Resolved = existing || {
    activeProfileId:
      mode === 'official'
        ? OFFICIAL_CLAUDE_PROFILE_ID
        : DEFAULT_THIRD_PARTY_PROFILE_ID,
    profiles:
      mode === 'official'
        ? []
        : [
            toStoredProfile(
              makeDefaultThirdPartyProfile({
                anthropicBaseUrl: normalized.anthropicBaseUrl,
                anthropicAuthToken: normalized.anthropicAuthToken,
                anthropicApiKey: normalized.anthropicApiKey,
                claudeCodeOauthToken: normalized.claudeCodeOauthToken,
                claudeOAuthCredentials: normalized.claudeOAuthCredentials,
                anthropicModel: normalized.anthropicModel,
                updatedAt: normalized.updatedAt,
              }),
            ),
          ],
    officialSecrets: {
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    },
    officialUpdatedAt: normalized.updatedAt,
    officialCustomEnv: {},
  };

  if (mode === 'official') {
    const officialSecrets = normalizeOfficialSecrets({
      anthropicAuthToken: '',
      anthropicApiKey: normalized.anthropicApiKey,
      claudeCodeOauthToken: normalized.claudeCodeOauthToken,
      claudeOAuthCredentials: normalized.claudeOAuthCredentials,
    });

    writeStoredState({
      ...baseState,
      activeProfileId: OFFICIAL_CLAUDE_PROFILE_ID,
      officialSecrets,
      officialUpdatedAt: normalized.updatedAt,
    });

    return buildOfficialClaudeProviderConfig(
      officialSecrets,
      normalized.updatedAt,
    );
  }

  const activeId = isOfficialClaudeMode(baseState.activeProfileId)
    ? null
    : baseState.activeProfileId;
  const activeStored =
    (activeId
      ? baseState.profiles.find((item) => item.id === activeId)
      : undefined) || baseState.profiles[0];

  const activeProfile = activeStored
    ? fromStoredProfile(activeStored)
    : makeDefaultThirdPartyProfile(normalized);

  const updatedProfile: ClaudeThirdPartyProfile = {
    ...activeProfile,
    anthropicBaseUrl: normalized.anthropicBaseUrl,
    anthropicAuthToken: normalized.anthropicAuthToken,
    anthropicModel: normalized.anthropicModel,
    updatedAt: normalized.updatedAt,
  };

  const updatedProfiles = baseState.profiles.length
    ? baseState.profiles.map((item) =>
        item.id === updatedProfile.id ? toStoredProfile(updatedProfile) : item,
      )
    : [toStoredProfile(updatedProfile)];

  writeStoredState({
    activeProfileId: updatedProfile.id,
    profiles: updatedProfiles,
    officialSecrets: normalizeOfficialSecrets({
      anthropicAuthToken: '',
      anthropicApiKey: normalized.anthropicApiKey,
      claudeCodeOauthToken: normalized.claudeCodeOauthToken,
      claudeOAuthCredentials: normalized.claudeOAuthCredentials,
    }),
    officialUpdatedAt: normalized.updatedAt,
    officialCustomEnv: baseState.officialCustomEnv,
  });

  return normalized;
}

export function saveClaudeOfficialProviderSecrets(
  next: Pick<
    ClaudeProviderConfig,
    'anthropicApiKey' | 'claudeCodeOauthToken' | 'claudeOAuthCredentials'
  >,
  options?: { activateOfficial?: boolean },
): ClaudeProviderConfig {
  const updatedAt = new Date().toISOString();
  const officialSecrets = normalizeOfficialSecrets({
    anthropicAuthToken: '',
    anthropicApiKey: next.anthropicApiKey,
    claudeCodeOauthToken: next.claudeCodeOauthToken,
    claudeOAuthCredentials: next.claudeOAuthCredentials,
  });

  const existing = readStoredState();
  const baseState: ClaudeStoredStateV3Resolved = existing || {
    activeProfileId: OFFICIAL_CLAUDE_PROFILE_ID,
    profiles: [],
    officialSecrets: {
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    },
    officialUpdatedAt: null,
    officialCustomEnv: {},
  };

  writeStoredState({
    ...baseState,
    activeProfileId: options?.activateOfficial
      ? OFFICIAL_CLAUDE_PROFILE_ID
      : baseState.activeProfileId,
    officialSecrets,
    officialUpdatedAt: updatedAt,
  });

  return getClaudeProviderConfig();
}

export function listClaudeThirdPartyProfiles(): {
  activeProfileId: string;
  profiles: ClaudeThirdPartyProfile[];
} {
  const state = readStoredState();
  if (!state) {
    const fallback = defaultsFromEnv();
    const profile = makeDefaultThirdPartyProfile(fallback);
    return {
      activeProfileId: profile.id,
      profiles: [profile],
    };
  }

  return {
    activeProfileId: state.activeProfileId,
    profiles: state.profiles.map((item) => fromStoredProfile(item)),
  };
}

export function toPublicClaudeThirdPartyProfile(
  profile: ClaudeThirdPartyProfile,
): ClaudeThirdPartyProfilePublic {
  return {
    id: profile.id,
    name: profile.name,
    anthropicBaseUrl: profile.anthropicBaseUrl,
    anthropicModel: profile.anthropicModel,
    updatedAt: profile.updatedAt,
    hasAnthropicAuthToken: !!profile.anthropicAuthToken,
    anthropicAuthTokenMasked: maskSecret(profile.anthropicAuthToken),
    customEnv: profile.customEnv || {},
  };
}

function randomProfileId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function createClaudeThirdPartyProfile(input: {
  name: string;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicModel?: string;
  customEnv?: Record<string, string>;
}): ClaudeThirdPartyProfile {
  const state = readStoredState() || {
    activeProfileId: DEFAULT_THIRD_PARTY_PROFILE_ID,
    profiles: [],
    officialSecrets: {
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    },
    officialUpdatedAt: null,
    officialCustomEnv: {},
  };

  if (state.profiles.length >= MAX_THIRD_PARTY_PROFILES) {
    throw new Error(`最多只能创建 ${MAX_THIRD_PARTY_PROFILES} 个第三方配置`);
  }

  const now = new Date().toISOString();
  const profile: ClaudeThirdPartyProfile = {
    id: randomProfileId(),
    name: normalizeProfileName(input.name),
    anthropicBaseUrl: normalizeBaseUrl(input.anthropicBaseUrl),
    anthropicAuthToken: normalizeSecret(
      input.anthropicAuthToken,
      'anthropicAuthToken',
    ),
    anthropicModel: normalizeModel(input.anthropicModel ?? ''),
    updatedAt: now,
    customEnv: sanitizeCustomEnvMap(input.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
  };

  const merged = buildConfig(
    {
      anthropicBaseUrl: profile.anthropicBaseUrl,
      anthropicAuthToken: profile.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: profile.anthropicModel,
    },
    now,
  );
  const errors = validateClaudeProviderConfig(merged);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  writeStoredState({
    ...state,
    activeProfileId:
      state.profiles.length === 0 ? profile.id : state.activeProfileId,
    profiles: [...state.profiles, toStoredProfile(profile)],
  });

  return profile;
}

export function updateClaudeThirdPartyProfile(
  profileId: string,
  patch: {
    name?: string;
    anthropicBaseUrl?: string;
    anthropicModel?: string;
    customEnv?: Record<string, string>;
  },
): ClaudeThirdPartyProfile {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  const current = state.profiles.find((item) => item.id === id);
  if (!current) throw new Error('未找到指定第三方配置');

  const decoded = fromStoredProfile(current);
  const next: ClaudeThirdPartyProfile = {
    ...decoded,
    name:
      patch.name !== undefined
        ? normalizeProfileName(patch.name)
        : decoded.name,
    anthropicBaseUrl:
      patch.anthropicBaseUrl !== undefined
        ? normalizeBaseUrl(patch.anthropicBaseUrl)
        : decoded.anthropicBaseUrl,
    anthropicModel:
      patch.anthropicModel !== undefined
        ? normalizeModel(patch.anthropicModel)
        : decoded.anthropicModel,
    customEnv:
      patch.customEnv !== undefined
        ? sanitizeCustomEnvMap(patch.customEnv, {
            skipReservedClaudeKeys: true,
          })
        : decoded.customEnv,
    updatedAt: new Date().toISOString(),
  };

  const merged = buildConfig(
    {
      anthropicBaseUrl: next.anthropicBaseUrl,
      anthropicAuthToken: next.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: next.anthropicModel,
    },
    next.updatedAt,
  );
  const errors = validateClaudeProviderConfig(merged);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  writeStoredState({
    ...state,
    profiles: state.profiles.map((item) =>
      item.id === id ? toStoredProfile(next) : item,
    ),
  });

  return next;
}

export function updateClaudeThirdPartyProfileSecret(
  profileId: string,
  patch: {
    anthropicAuthToken?: string;
    clearAnthropicAuthToken?: boolean;
  },
): ClaudeThirdPartyProfile {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  const current = state.profiles.find((item) => item.id === id);
  if (!current) throw new Error('未找到指定第三方配置');

  const decoded = fromStoredProfile(current);
  const nextToken =
    typeof patch.anthropicAuthToken === 'string'
      ? normalizeSecret(patch.anthropicAuthToken, 'anthropicAuthToken')
      : patch.clearAnthropicAuthToken
        ? ''
        : decoded.anthropicAuthToken;

  const next: ClaudeThirdPartyProfile = {
    ...decoded,
    anthropicAuthToken: nextToken,
    updatedAt: new Date().toISOString(),
  };

  const merged = buildConfig(
    {
      anthropicBaseUrl: next.anthropicBaseUrl,
      anthropicAuthToken: next.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: next.anthropicModel,
    },
    next.updatedAt,
  );
  const errors = validateClaudeProviderConfig(merged);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  writeStoredState({
    ...state,
    profiles: state.profiles.map((item) =>
      item.id === id ? toStoredProfile(next) : item,
    ),
  });

  return next;
}

export function activateClaudeThirdPartyProfile(
  profileId: string,
): ClaudeProviderConfig {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  const target = state.profiles.find((item) => item.id === id);
  if (!target) throw new Error('未找到指定第三方配置');

  writeStoredState({
    ...state,
    activeProfileId: id,
  });

  return getClaudeProviderConfig();
}

export function deleteClaudeThirdPartyProfile(profileId: string): {
  activeProfileId: string;
  deletedProfileId: string;
} {
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');

  const id = normalizeProfileId(profileId);
  if (!state.profiles.some((item) => item.id === id)) {
    throw new Error('未找到指定第三方配置');
  }
  if (state.profiles.length <= 1) {
    throw new Error('至少需要保留一个第三方配置');
  }

  const profiles = state.profiles.filter((item) => item.id !== id);
  const activeProfileId =
    state.activeProfileId === id ? profiles[0]!.id : state.activeProfileId;

  writeStoredState({
    ...state,
    activeProfileId,
    profiles,
  });

  return {
    activeProfileId,
    deletedProfileId: id,
  };
}

/** Strip control characters from a value before writing to env file (defense-in-depth) */
function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

/** Convert KEY=value lines to shell-safe format by single-quoting values.
 *  Used when writing env files that are `source`d by bash. */
export function shellQuoteEnvLines(lines: string[]): string[] {
  return lines.map((line) => {
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) return line;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    // Escape embedded single quotes: ' → '\''
    const quoted = "'" + value.replace(/'/g, "'\\''") + "'";
    return `${key}=${quoted}`;
  });
}

export function buildClaudeEnvLines(
  config: ClaudeProviderConfig,
  profileCustomEnv?: Record<string, string>,
): string[] {
  const lines: string[] = [];

  // When full OAuth credentials exist, authentication is handled by .credentials.json file.
  // Only fall back to CLAUDE_CODE_OAUTH_TOKEN env var for legacy single-token mode.
  if (!config.claudeOAuthCredentials && config.claudeCodeOauthToken) {
    lines.push(
      `CLAUDE_CODE_OAUTH_TOKEN=${sanitizeEnvValue(config.claudeCodeOauthToken)}`,
    );
  }
  if (config.anthropicApiKey) {
    lines.push(`ANTHROPIC_API_KEY=${sanitizeEnvValue(config.anthropicApiKey)}`);
  }
  if (config.anthropicBaseUrl) {
    lines.push(
      `ANTHROPIC_BASE_URL=${sanitizeEnvValue(config.anthropicBaseUrl)}`,
    );
  }
  if (config.anthropicAuthToken) {
    if (config.anthropicBaseUrl) {
      // Third-party provider: the SDK treats ANTHROPIC_AUTH_TOKEN as an OAuth
      // legacy token and skips the standard Bearer header, causing 404 on
      // non-Anthropic endpoints. Use ANTHROPIC_API_KEY instead so the SDK
      // sends the correct Authorization header.
      lines.push(
        `ANTHROPIC_API_KEY=${sanitizeEnvValue(config.anthropicAuthToken)}`,
      );
    } else {
      lines.push(
        `ANTHROPIC_AUTH_TOKEN=${sanitizeEnvValue(config.anthropicAuthToken)}`,
      );
    }
  }
  if (config.anthropicModel) {
    lines.push(`ANTHROPIC_MODEL=${sanitizeEnvValue(config.anthropicModel)}`);
  }

  // Use explicit profileCustomEnv if provided (pool mode), otherwise active profile
  const customEnv = profileCustomEnv ?? getActiveProfileCustomEnv();
  for (const [key, value] of Object.entries(customEnv)) {
    if (RESERVED_CLAUDE_ENV_KEYS.has(key)) continue;
    lines.push(`${key}=${sanitizeEnvValue(value)}`);
  }

  return lines;
}

export function getActiveProfileCustomEnv(): Record<string, string> {
  const state = readStoredStateV4();
  if (!state) return {};

  const enabled = state.providers.find((p) => p.enabled) || state.providers[0];
  if (!enabled) return {};

  return sanitizeCustomEnvMap(enabled.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
}

/**
 * Resolve any profileId to a full ClaudeProviderConfig.
 * Used by ProviderPool to build env for a non-active profile.
 */
export function resolveProfileToConfig(
  profileId: string,
): ClaudeProviderConfig {
  const state = readStoredState();
  if (!state) return defaultsFromEnv();

  if (isOfficialClaudeMode(profileId)) {
    return buildOfficialClaudeProviderConfig(
      state.officialSecrets,
      state.officialUpdatedAt,
    );
  }

  const stored = state.profiles.find((p) => p.id === profileId);
  if (!stored) {
    // Profile not found — fallback to current active config
    logger.warn(
      { profileId },
      'resolveProfileToConfig: profile not found, falling back to active',
    );
    return getClaudeProviderConfig();
  }

  const profile = fromStoredProfile(stored);
  return buildConfig(
    {
      anthropicBaseUrl: profile.anthropicBaseUrl,
      anthropicAuthToken: profile.anthropicAuthToken,
      anthropicApiKey: state.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: state.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials:
        state.officialSecrets.claudeOAuthCredentials ?? null,
      anthropicModel: profile.anthropicModel,
    },
    profile.updatedAt || state.officialUpdatedAt,
  );
}

/**
 * Get customEnv for a specific profileId (not necessarily the active one).
 */
export function getCustomEnvForProfile(
  profileId: string,
): Record<string, string> {
  const state = readStoredState();
  if (!state) return {};

  if (isOfficialClaudeMode(profileId)) {
    return sanitizeCustomEnvMap(state.officialCustomEnv || {}, {
      skipReservedClaudeKeys: true,
    });
  }

  const exact = state.profiles.find((p) => p.id === profileId);
  if (!exact) {
    logger.warn(
      { profileId },
      'getCustomEnvForProfile: profile not found, falling back to active',
    );
  }
  const profile = exact || state.profiles[0];
  if (!profile) return {};

  const resolved = fromStoredProfile(profile);
  return sanitizeCustomEnvMap(resolved.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
}

/**
 * Resolve config AND customEnv for a profileId in a single disk read.
 * Used by container-runner to avoid double readStoredState() calls.
 */
/** @deprecated Use resolveProviderById instead. Kept for backward compat. */
export function resolveProfileFull(profileId: string): {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
} {
  return resolveProviderById(profileId);
}

export function saveOfficialCustomEnv(
  customEnv: Record<string, string>,
): Record<string, string> {
  const sanitized = sanitizeCustomEnvMap(customEnv, {
    skipReservedClaudeKeys: true,
  });
  const state = readStoredState();
  if (!state) throw new Error('Claude 配置不存在');
  writeStoredState({
    ...state,
    officialCustomEnv: sanitized,
  });
  return sanitized;
}

export function appendClaudeConfigAudit(
  actor: string,
  action: string,
  changedFields: string[],
  metadata?: Record<string, unknown>,
): void {
  const entry: ClaudeConfigAuditEntry = {
    timestamp: new Date().toISOString(),
    actor,
    action,
    changedFields,
    metadata,
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  // 用 fd + O_APPEND 路径强制 0o600 创建：fs.appendFileSync 不接受 mode 参数，
  // 首次落盘 mode = 0o666 & ~umask（实测 0o644），同主机其他本地账号能读
  // 管理员审计轨迹（用户名 / OAuth 登录时点 / IM 凭据轮换时间窗 = 暴力破解
  // 窗口枚举素材）。和 writeSecretFile 同形态强 0o600。
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND;
  const fd = fs.openSync(CLAUDE_CONFIG_AUDIT_FILE, flags, 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  // 自愈历史 0o644 文件：appendFileSync 在升级前已经创建过，单纯切到 fd 路径
  // 只对新文件生效；显式 chmod 保证存量也收紧。
  try {
    fs.chmodSync(CLAUDE_CONFIG_AUDIT_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * 记录 IM 通道密钥/配置轮换。复用 claude-provider.audit.log 文件以集中
 * 审计；调用方需提供 channel ('feishu'|'telegram'|...) 和 changedFields
 * （如 ['appSecret','encryptKey']）。同 appendClaudeConfigAudit 一样不抛错。
 */
export function appendImConfigAudit(
  actor: string,
  channel: string,
  action: string,
  changedFields: string[],
  metadata?: Record<string, unknown>,
): void {
  appendClaudeConfigAudit(
    actor,
    `im_${channel}_${action}`,
    changedFields,
    metadata,
  );
}

// ─── Per-container environment config ───────────────────────────

const CONTAINER_ENV_DIR = path.join(DATA_DIR, 'config', 'container-env');

export interface ContainerEnvConfig {
  /** Claude provider overrides — empty string means "use global" */
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
  anthropicModel?: string;
  /** Arbitrary extra env vars injected into the container */
  customEnv?: Record<string, string>;
}

export interface ContainerEnvPublicConfig {
  anthropicBaseUrl: string;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  anthropicModel: string;
  customEnv: Record<string, string>;
}

function containerEnvPath(folder: string): string {
  if (folder.includes('..') || folder.includes('/')) {
    throw new Error('Invalid folder name');
  }
  return path.join(CONTAINER_ENV_DIR, `${folder}.json`);
}

export function getContainerEnvConfig(folder: string): ContainerEnvConfig {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) {
      const stored = JSON.parse(
        fs.readFileSync(filePath, 'utf-8'),
      ) as ContainerEnvConfig & { happyclawModel?: string };
      // Backward compat: migrate old field name
      if (
        stored.anthropicModel === undefined &&
        stored.happyclawModel !== undefined
      ) {
        stored.anthropicModel = stored.happyclawModel;
        delete stored.happyclawModel;
      }
      return stored;
    }
  } catch (err) {
    logger.warn(
      { err, folder },
      'Failed to read container env config, returning defaults',
    );
  }
  return {};
}

export function saveContainerEnvConfig(
  folder: string,
  config: ContainerEnvConfig,
): void {
  // Sanitize all string fields to prevent env injection
  const sanitized: ContainerEnvConfig = { ...config };
  if (sanitized.anthropicBaseUrl)
    sanitized.anthropicBaseUrl = sanitizeEnvValue(sanitized.anthropicBaseUrl);
  if (sanitized.anthropicAuthToken)
    sanitized.anthropicAuthToken = sanitizeEnvValue(
      sanitized.anthropicAuthToken,
    );
  if (sanitized.anthropicApiKey)
    sanitized.anthropicApiKey = sanitizeEnvValue(sanitized.anthropicApiKey);
  if (sanitized.claudeCodeOauthToken)
    sanitized.claudeCodeOauthToken = sanitizeEnvValue(
      sanitized.claudeCodeOauthToken,
    );
  if (sanitized.anthropicModel)
    sanitized.anthropicModel = sanitizeEnvValue(sanitized.anthropicModel);
  if (sanitized.customEnv) {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(sanitized.customEnv)) {
      if (DANGEROUS_ENV_VARS.has(k)) {
        logger.warn(
          { key: k },
          'Rejected dangerous env variable in saveContainerEnvConfig',
        );
        continue;
      }
      cleanEnv[k] = sanitizeEnvValue(v);
    }
    sanitized.customEnv = cleanEnv;
  }

  fs.mkdirSync(CONTAINER_ENV_DIR, { recursive: true });
  writeSecretFile(containerEnvPath(folder), JSON.stringify(sanitized, null, 2) + '\n');
}

export function deleteContainerEnvConfig(folder: string): void {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export function toPublicContainerEnvConfig(
  config: ContainerEnvConfig,
): ContainerEnvPublicConfig {
  return {
    anthropicBaseUrl: config.anthropicBaseUrl || '',
    hasAnthropicAuthToken: !!config.anthropicAuthToken,
    hasAnthropicApiKey: !!config.anthropicApiKey,
    hasClaudeCodeOauthToken: !!config.claudeCodeOauthToken,
    anthropicAuthTokenMasked: maskSecret(config.anthropicAuthToken || ''),
    anthropicApiKeyMasked: maskSecret(config.anthropicApiKey || ''),
    claudeCodeOauthTokenMasked: maskSecret(config.claudeCodeOauthToken || ''),
    anthropicModel: config.anthropicModel || '',
    customEnv: config.customEnv || {},
  };
}

/**
 * Merge global config with per-container overrides.
 * Non-empty per-container fields override the global value.
 */
export function mergeClaudeEnvConfig(
  global: ClaudeProviderConfig,
  override: ContainerEnvConfig,
): ClaudeProviderConfig {
  const merged: ClaudeProviderConfig = {
    anthropicBaseUrl: override.anthropicBaseUrl || global.anthropicBaseUrl,
    anthropicAuthToken:
      override.anthropicAuthToken || global.anthropicAuthToken,
    anthropicApiKey: override.anthropicApiKey || global.anthropicApiKey,
    claudeCodeOauthToken:
      override.claudeCodeOauthToken || global.claudeCodeOauthToken,
    claudeOAuthCredentials:
      override.claudeOAuthCredentials ?? global.claudeOAuthCredentials,
    anthropicModel: override.anthropicModel || global.anthropicModel,
    updatedAt: global.updatedAt,
  };

  // Third-party provider: strip OAuth credentials so the SDK does not try
  // the OAuth auth path (which skips the standard Bearer header and causes
  // 404 on non-Anthropic endpoints like Kimi).
  if (merged.anthropicBaseUrl) {
    merged.claudeOAuthCredentials = null;
    merged.claudeCodeOauthToken = '';
  }

  return merged;
}

// ─── Registration config (plain JSON, no encryption) ─────────────

const REGISTRATION_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'registration.json',
);

export interface RegistrationConfig {
  allowRegistration: boolean;
  requireInviteCode: boolean;
  updatedAt: string | null;
}

const DEFAULT_REGISTRATION_CONFIG: RegistrationConfig = {
  allowRegistration: true,
  requireInviteCode: true,
  updatedAt: null,
};

export function getRegistrationConfig(): RegistrationConfig {
  try {
    if (!fs.existsSync(REGISTRATION_CONFIG_FILE)) {
      return { ...DEFAULT_REGISTRATION_CONFIG };
    }
    const raw = JSON.parse(
      fs.readFileSync(REGISTRATION_CONFIG_FILE, 'utf-8'),
    ) as Record<string, unknown>;
    return {
      allowRegistration:
        typeof raw.allowRegistration === 'boolean'
          ? raw.allowRegistration
          : true,
      requireInviteCode:
        typeof raw.requireInviteCode === 'boolean'
          ? raw.requireInviteCode
          : true,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read registration config, returning defaults',
    );
    return { ...DEFAULT_REGISTRATION_CONFIG };
  }
}

export function saveRegistrationConfig(
  next: Pick<RegistrationConfig, 'allowRegistration' | 'requireInviteCode'>,
): RegistrationConfig {
  const config: RegistrationConfig = {
    allowRegistration: next.allowRegistration,
    requireInviteCode: next.requireInviteCode,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${REGISTRATION_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, REGISTRATION_CONFIG_FILE);
  return config;
}

/**
 * Build full env lines: custom env vars only（happycodex，见函数内 tombstone）.
 */
export function buildContainerEnvLines(
  global: ClaudeProviderConfig,
  override: ContainerEnvConfig,
  profileCustomEnv?: Record<string, string>,
): string[] {
  // tombstone（happycodex）：上游 runtime-config.ts:2778-2812 先 mergeClaudeEnvConfig(
  // global, override) 再经 buildClaudeEnvLines 注入 ANTHROPIC_* / CLAUDE_CODE_OAUTH_TOKEN
  // 行。codex 容器不消费 Anthropic 凭据（container-runner 也恒传空 global 配置），
  // provider 字段贡献恒为零——不再透传 override 中历史遗留的 anthropic* /
  // claudeCodeOauthToken 覆盖，仅保留 profileCustomEnv 与 override.customEnv 的
  // 净化注入。签名保持不变（global 参数仅为兼容 container-runner 既有调用点）。
  void global;
  const lines: string[] = [];

  for (const [key, value] of Object.entries(profileCustomEnv ?? {})) {
    if (RESERVED_CLAUDE_ENV_KEYS.has(key)) continue;
    lines.push(`${key}=${sanitizeEnvValue(value)}`);
  }

  // Append custom env vars (with safety sanitization as defense-in-depth)
  if (override.customEnv) {
    for (const [key, value] of Object.entries(override.customEnv)) {
      if (!key || value === undefined) continue;
      if (!ENV_KEY_RE.test(key)) {
        logger.warn(
          { key },
          'Skipping invalid env key in buildContainerEnvLines',
        );
        continue;
      }
      // Block dangerous environment variables
      if (DANGEROUS_ENV_VARS.has(key)) {
        logger.warn(
          { key },
          'Blocked dangerous env variable in buildContainerEnvLines',
        );
        continue;
      }
      // Strip control characters to prevent env injection
      const sanitized = value.replace(/[\r\n\0]/g, '');
      lines.push(`${key}=${sanitized}`);
    }
  }

  return lines;
}

// ─── OAuth credentials file management ────────────────────────────

/**
 * Write .credentials.json to a Claude session directory.
 * happycodex：停用为 no-op，见函数内 tombstone。
 */
export function writeCredentialsFile(
  sessionDir: string,
  config: ClaudeProviderConfig,
): void {
  // tombstone（happycodex）：上游 runtime-config.ts:2820-2870 向 Claude session 目录
  // 写 .credentials.json（Claude CLI/SDK 原生 OAuth 凭据文件，明文 token 落盘）。
  // codex 运行时凭据走 CODEX_HOME/auth.json（codex-home.ts 物化），该写入面停用为
  // no-op；container-runner 侧的旧接线已随 provider 面删除（见其 tombstone）。
  void sessionDir;
  void config;
}

/**
 * Update .credentials.json in all existing session directories.
 * happycodex：停用为 no-op，见函数内 tombstone。
 */
export function updateAllSessionCredentials(
  config: ClaudeProviderConfig,
): void {
  // tombstone（happycodex）：上游 runtime-config.ts:2875-2923 遍历 data/sessions/
  // 下所有 {folder}/.claude 与 {folder}/agents/{agentId}/.claude 目录批量回写
  // .credentials.json。codex 运行时无任何消费方（src/index.ts:155 仅残留死导入，
  // 保留导出以维持签名），停用为 no-op，不再扫描/写入任何 session 目录。
  void config;
}

// ─── Local Claude Code detection ──────────────────────────────────

export interface LocalClaudeCodeStatus {
  detected: boolean;
  hasCredentials: boolean;
  expiresAt: number | null;
  accessTokenMasked: string | null;
}

// tombstone（happycodex）：上游 runtime-config.ts:2934-2972 readLocalOAuthCredentials
// 直读宿主机 ~/.claude/.credentials.json（明文 OAuth access/refresh token）。
// codex-only 运行时不检测/导入 Claude Code 本地凭据，该读取面删除；下方两个导出
// 保留签名，恒返回「未检测 / 空」。

/**
 * Detect if the host machine has a valid ~/.claude/.credentials.json.
 * happycodex：停用，恒返回未检测态（见上方 tombstone）。
 */
export function detectLocalClaudeCode(): LocalClaudeCodeStatus {
  return {
    detected: false,
    hasCredentials: false,
    expiresAt: null,
    accessTokenMasked: null,
  };
}

/**
 * Read local ~/.claude/.credentials.json and return parsed OAuth credentials.
 * happycodex：停用，恒返回 null（见上方 tombstone）。
 */
export function importLocalClaudeCredentials(): ClaudeOAuthCredentials | null {
  return null;
}

// ─── Appearance config (plain JSON, no encryption) ────────────────

const APPEARANCE_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'appearance.json');

export interface AppearanceConfig {
  appName: string;
  aiName: string;
  aiAvatarEmoji: string;
  aiAvatarColor: string;
}

const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = {
  appName: ASSISTANT_NAME,
  aiName: ASSISTANT_NAME,
  aiAvatarEmoji: '\u{1F431}',
  aiAvatarColor: '#0d9488',
};

export function getAppearanceConfig(): AppearanceConfig {
  try {
    if (!fs.existsSync(APPEARANCE_CONFIG_FILE)) {
      return { ...DEFAULT_APPEARANCE_CONFIG };
    }
    const raw = JSON.parse(
      fs.readFileSync(APPEARANCE_CONFIG_FILE, 'utf-8'),
    ) as Record<string, unknown>;
    return {
      appName:
        typeof raw.appName === 'string' && raw.appName
          ? raw.appName
          : DEFAULT_APPEARANCE_CONFIG.appName,
      aiName:
        typeof raw.aiName === 'string' && raw.aiName
          ? raw.aiName
          : DEFAULT_APPEARANCE_CONFIG.aiName,
      aiAvatarEmoji:
        typeof raw.aiAvatarEmoji === 'string' && raw.aiAvatarEmoji
          ? raw.aiAvatarEmoji
          : DEFAULT_APPEARANCE_CONFIG.aiAvatarEmoji,
      aiAvatarColor:
        typeof raw.aiAvatarColor === 'string' && raw.aiAvatarColor
          ? raw.aiAvatarColor
          : DEFAULT_APPEARANCE_CONFIG.aiAvatarColor,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read appearance config, returning defaults',
    );
    return { ...DEFAULT_APPEARANCE_CONFIG };
  }
}

export function saveAppearanceConfig(
  next: Partial<Pick<AppearanceConfig, 'appName'>> &
    Omit<AppearanceConfig, 'appName'>,
): AppearanceConfig {
  const existing = getAppearanceConfig();
  const config = {
    appName: next.appName || existing.appName,
    aiName: next.aiName,
    aiAvatarEmoji: next.aiAvatarEmoji,
    aiAvatarColor: next.aiAvatarColor,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${APPEARANCE_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, APPEARANCE_CONFIG_FILE);
  return {
    appName: config.appName,
    aiName: config.aiName,
    aiAvatarEmoji: config.aiAvatarEmoji,
    aiAvatarColor: config.aiAvatarColor,
  };
}

// ─── Per-user IM config (AES-256-GCM encrypted) ─────────────────

const USER_IM_CONFIG_DIR = path.join(DATA_DIR, 'config', 'user-im');

export interface UserFeishuConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
  ownerOpenId?: string; // auto-detected from first DM; used as sender_allowlist seed for new groups
  autoIsolateContext?: boolean; // auto-create isolated conversation for each new IM chat
}

export interface UserTelegramConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserQQConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserDingTalkConfig {
  clientId: string;
  clientSecret: string;
  enabled?: boolean;
  streamingMode?: 'card' | 'text';
  updatedAt: string | null;
}

interface StoredDingTalkProviderConfigV1 {
  version: 1;
  clientId: string;
  enabled?: boolean;
  streamingMode?: 'card' | 'text';
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface DingTalkSecretPayload {
  clientSecret: string;
}

export interface UserDiscordConfig {
  botToken: string;
  enabled?: boolean;
  streamingMode?: 'edit' | 'off';
  updatedAt: string | null;
}

interface StoredDiscordProviderConfigV1 {
  version: 1;
  enabled?: boolean;
  streamingMode?: 'edit' | 'off';
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface DiscordSecretPayload {
  botToken: string;
}

interface StoredQQProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface QQSecretPayload {
  appSecret: string;
}

function userImDir(userId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error('Invalid userId');
  }
  return path.join(USER_IM_CONFIG_DIR, userId);
}

export function getUserFeishuConfig(userId: string): UserFeishuConfig | null {
  const filePath = path.join(userImDir(userId), 'feishu.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredFeishuProviderConfigV1;
    const secret = decryptChannelSecret<FeishuSecretPayload>(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
      ownerOpenId: stored.ownerOpenId || undefined,
      autoIsolateContext: stored.autoIsolateContext ?? false,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Feishu config');
    return null;
  }
}

export function saveUserFeishuConfig(
  userId: string,
  next: Omit<UserFeishuConfig, 'updatedAt'>,
): UserFeishuConfig {
  const normalized: UserFeishuConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
    ownerOpenId: next.ownerOpenId,
    autoIsolateContext: next.autoIsolateContext,
  };

  const payload: StoredFeishuProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    ownerOpenId: normalized.ownerOpenId,
    autoIsolateContext: normalized.autoIsolateContext,
    secret: encryptChannelSecret<FeishuSecretPayload>({
      appSecret: normalized.appSecret,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'feishu.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

/**
 * Update only the ownerOpenId in an existing Feishu config file, preserving the encrypted secret.
 */
export function saveFeishuOwnerOpenId(userId: string, openId: string): void {
  const filePath = path.join(userImDir(userId), 'feishu.json');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    parsed.ownerOpenId = openId;
    writeSecretFile(filePath, JSON.stringify(parsed, null, 2) + '\n');
    logger.info({ userId, openId }, 'Feishu owner open_id saved');
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to save Feishu owner open_id');
  }
}

export function getUserTelegramConfig(
  userId: string,
): UserTelegramConfig | null {
  const filePath = path.join(userImDir(userId), 'telegram.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredTelegramProviderConfigV1;
    const secret = decryptChannelSecret<TelegramSecretPayload>(stored.secret);
    return {
      botToken: secret.botToken,
      proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Telegram config');
    return null;
  }
}

export function saveUserTelegramConfig(
  userId: string,
  next: Omit<UserTelegramConfig, 'updatedAt'>,
): UserTelegramConfig {
  const normalizedProxyUrl = next.proxyUrl
    ? normalizeTelegramProxyUrl(next.proxyUrl)
    : '';
  const normalized: UserTelegramConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredTelegramProviderConfigV1 = {
    version: 1,
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<TelegramSecretPayload>({
      botToken: normalized.botToken,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'telegram.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== QQ User IM Config ==========

export function getUserQQConfig(userId: string): UserQQConfig | null {
  const filePath = path.join(userImDir(userId), 'qq.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredQQProviderConfigV1;
    const secret = decryptChannelSecret<QQSecretPayload>(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user QQ config');
    return null;
  }
}

export function saveUserQQConfig(
  userId: string,
  next: Omit<UserQQConfig, 'updatedAt'>,
): UserQQConfig {
  const normalized: UserQQConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredQQProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<QQSecretPayload>({
      appSecret: normalized.appSecret,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'qq.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== WeChat User IM Config ==========

export interface UserWeChatConfig {
  botToken: string; // iLink bot_token
  ilinkBotId: string; // bot ID (xxx@im.bot)
  baseUrl?: string; // 默认 https://ilinkai.weixin.qq.com
  cdnBaseUrl?: string; // 默认 https://novac2c.cdn.weixin.qq.com/c2c
  getUpdatesBuf?: string; // 长轮询游标
  bypassProxy?: boolean; // 直连模式：绕过 HTTP 代理（默认 true）
  enabled?: boolean;
  updatedAt: string | null;
}

interface StoredWeChatProviderConfigV1 {
  version: 1;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
  bypassProxy?: boolean;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface WeChatSecretPayload {
  botToken: string;
}

export function getUserWeChatConfig(userId: string): UserWeChatConfig | null {
  const filePath = path.join(userImDir(userId), 'wechat.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredWeChatProviderConfigV1;
    const secret = decryptChannelSecret<WeChatSecretPayload>(stored.secret);
    return {
      botToken: secret.botToken,
      ilinkBotId: ((stored.ilinkBotId as string) ?? '').trim(),
      baseUrl: stored.baseUrl,
      cdnBaseUrl: stored.cdnBaseUrl,
      getUpdatesBuf: stored.getUpdatesBuf,
      bypassProxy: stored.bypassProxy ?? true, // 默认直连
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user WeChat config');
    return null;
  }
}

export function saveUserWeChatConfig(
  userId: string,
  next: Omit<UserWeChatConfig, 'updatedAt'>,
): UserWeChatConfig {
  const normalized: UserWeChatConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    ilinkBotId: (next.ilinkBotId ?? '').trim(),
    baseUrl: next.baseUrl?.trim() || undefined,
    cdnBaseUrl: next.cdnBaseUrl?.trim() || undefined,
    getUpdatesBuf: next.getUpdatesBuf,
    bypassProxy: next.bypassProxy ?? true,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredWeChatProviderConfigV1 = {
    version: 1,
    ilinkBotId: normalized.ilinkBotId,
    baseUrl: normalized.baseUrl,
    cdnBaseUrl: normalized.cdnBaseUrl,
    getUpdatesBuf: normalized.getUpdatesBuf,
    bypassProxy: normalized.bypassProxy,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<WeChatSecretPayload>({
      botToken: normalized.botToken,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'wechat.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== WhatsApp User IM Config ==========

export interface UserWhatsAppConfig {
  accountId: string;
  phoneNumber: string;
  enabled?: boolean;
  /** Whether the user has completed Baileys QR pairing (set by future PR) */
  paired?: boolean;
  updatedAt: string | null;
}

interface StoredWhatsAppProviderConfigV1 {
  version: 1;
  accountId: string;
  phoneNumber: string;
  enabled?: boolean;
  paired?: boolean;
  updatedAt: string;
}

export function getUserWhatsAppConfig(
  userId: string,
): UserWhatsAppConfig | null {
  const filePath = path.join(userImDir(userId), 'whatsapp.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredWhatsAppProviderConfigV1;
    return {
      accountId: ((stored.accountId as string) ?? 'default').trim(),
      phoneNumber: ((stored.phoneNumber as string) ?? '').trim(),
      enabled: stored.enabled,
      paired: stored.paired,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user WhatsApp config');
    return null;
  }
}

export function saveUserWhatsAppConfig(
  userId: string,
  next: Omit<UserWhatsAppConfig, 'updatedAt'>,
): UserWhatsAppConfig {
  const normalized: UserWhatsAppConfig = {
    accountId: (next.accountId ?? 'default').trim() || 'default',
    phoneNumber: (next.phoneNumber ?? '').trim(),
    enabled: next.enabled,
    paired: next.paired,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredWhatsAppProviderConfigV1 = {
    version: 1,
    accountId: normalized.accountId,
    phoneNumber: normalized.phoneNumber,
    enabled: normalized.enabled,
    paired: normalized.paired,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'whatsapp.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== DingTalk User IM Config ==========

export function getUserDingTalkConfig(
  userId: string,
): UserDingTalkConfig | null {
  const filePath = path.join(userImDir(userId), 'dingtalk.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredDingTalkProviderConfigV1;
    const secret = decryptChannelSecret<DingTalkSecretPayload>(stored.secret);
    return {
      clientId: ((stored.clientId as string) ?? '').trim(),
      clientSecret: secret.clientSecret,
      enabled: stored.enabled,
      streamingMode: stored.streamingMode === 'text' ? 'text' : 'card',
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user DingTalk config');
    return null;
  }
}

export function saveUserDingTalkConfig(
  userId: string,
  next: Omit<UserDingTalkConfig, 'updatedAt'>,
): UserDingTalkConfig {
  const normalized: UserDingTalkConfig = {
    clientId: ((next.clientId as string) ?? '').trim(),
    clientSecret: normalizeSecret(next.clientSecret, 'clientSecret'),
    enabled: next.enabled,
    streamingMode: next.streamingMode === 'text' ? 'text' : 'card',
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredDingTalkProviderConfigV1 = {
    version: 1,
    clientId: normalized.clientId,
    enabled: normalized.enabled,
    streamingMode: normalized.streamingMode === 'text' ? 'text' : 'card',
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<DingTalkSecretPayload>({
      clientSecret: normalized.clientSecret,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'dingtalk.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== Discord User IM Config ==========

export function getUserDiscordConfig(
  userId: string,
): UserDiscordConfig | null {
  const filePath = path.join(userImDir(userId), 'discord.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredDiscordProviderConfigV1;
    const secret = decryptChannelSecret<DiscordSecretPayload>(stored.secret);
    return {
      botToken: secret.botToken,
      enabled: stored.enabled,
      streamingMode: stored.streamingMode === 'edit' ? 'edit' : 'off',
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Discord config');
    return null;
  }
}

export function saveUserDiscordConfig(
  userId: string,
  next: Omit<UserDiscordConfig, 'updatedAt'>,
): UserDiscordConfig {
  const normalized: UserDiscordConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    enabled: next.enabled,
    streamingMode: next.streamingMode === 'edit' ? 'edit' : 'off',
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredDiscordProviderConfigV1 = {
    version: 1,
    enabled: normalized.enabled,
    streamingMode: normalized.streamingMode,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<DiscordSecretPayload>({
      botToken: normalized.botToken,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'discord.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ─── System settings (plain JSON, no encryption) ─────────────────

const SYSTEM_SETTINGS_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'system-settings.json',
);

export interface SystemSettings {
  containerTimeout: number;
  idleTimeout: number;
  containerMaxOutputSize: number;
  maxConcurrentContainers: number;
  maxConcurrentHostProcesses: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  maxConcurrentScripts: number;
  scriptTimeout: number;
  // Billing
  billingEnabled: boolean;
  billingMode: 'wallet_first';
  billingMinStartBalanceUsd: number;
  billingCurrency: string;
  billingCurrencyRate: number;
  // External Claude directory (admin only)
  externalClaudeDir: string;
  // Claude Agent SDK 自动对话压缩触发点（tokens）。0 = 保留 SDK 默认（约 1M）
  autoCompactWindow: number;
  // 预定义 SubAgent（code-reviewer / web-researcher）使用的模型别名或完整 ID。
  // 经 SUBAGENT_MODEL 注入容器；默认 inherit（继承主会话模型，不擅自改变），可在设置页改。
  subagentModel: string;
  // 关闭 admin host 模式下 HappyClaw 自带的 memory 注入层（MCP 工具、模板 CLAUDE.md、WORKSPACE_GLOBAL/MEMORY env）
  // 启用后 admin 可以在 host 模式下完全按原生 Claude Code 的 Playbook 使用 ~/.claude/ 下的 memory/skills/rules
  disableMemoryLayerForAdminHost: boolean;
  // Plugin catalog 自动扫描：true（默认）= 启动 5s 后扫一次 + 每小时一次；
  // false = 关闭定时扫描，admin 仍可手点 POST /api/plugins/catalog/scan。
  // 适用于不希望本机私有 plugin 自动入共享 catalog 的环境。
  pluginAutoScan: boolean;
  // 定时任务逾期容忍窗口（毫秒）。任何 next_run 落在过去且距今超过该窗口的任务
  // 在 scheduler 轮询时直接跳过本次（next_run 推到下一次），避免停机/重启后多个
  // 跨天积压任务集体在重启那一秒并发 fire 刷屏。
  // 0 = 关闭（保留旧行为：无视逾期时长全部 backfill）。默认 300000 (5 分钟)。
  taskBackfillGraceMs: number;
}

const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  containerTimeout: 1800000,
  idleTimeout: 1800000,
  containerMaxOutputSize: 10485760,
  maxConcurrentContainers: 20,
  maxConcurrentHostProcesses: 5,
  maxLoginAttempts: 5,
  loginLockoutMinutes: 15,
  maxConcurrentScripts: 10,
  scriptTimeout: 60000,
  billingEnabled: false,
  billingMode: 'wallet_first',
  billingMinStartBalanceUsd: 0.01,
  billingCurrency: 'USD',
  billingCurrencyRate: 1,
  externalClaudeDir: '',
  autoCompactWindow: 0,
  subagentModel: 'inherit',
  disableMemoryLayerForAdminHost: false,
  pluginAutoScan: true,
  taskBackfillGraceMs: 300000,
};

function parseIntEnv(envVar: string | undefined, fallback: number): number {
  if (!envVar) return fallback;
  const parsed = parseInt(envVar, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * autoCompactWindow 区间收紧：0 = 禁用（用 SDK 默认 ~1M）；>0 收紧到 [100000, 1000000]。
 * SDK 侧 schema 为 assistant.mjs 的 `.min(1e5).max(1e6).catch(void 0)`——越界值会被静默剥离
 * 回退默认。在读（file/env）与写（save）两端统一调用，避免存量/手填的越界值在下游静默失效。
 */
function clampAutoCompactWindow(v: unknown): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1_000_000, Math.max(100_000, Math.floor(n)));
}

function parseFloatEnv(envVar: string | undefined, fallback: number): number {
  if (!envVar) return fallback;
  const parsed = parseFloat(envVar);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// In-memory cache: avoid synchronous file I/O on hot paths (stdout data handler, queue capacity check)
let _settingsCache: SystemSettings | null = null;
let _settingsMtimeMs = 0;

function readSystemSettingsFromFile(): SystemSettings | null {
  if (!fs.existsSync(SYSTEM_SETTINGS_FILE)) return null;
  const raw = JSON.parse(
    fs.readFileSync(SYSTEM_SETTINGS_FILE, 'utf-8'),
  ) as Record<string, unknown>;
  return {
    containerTimeout:
      typeof raw.containerTimeout === 'number' && raw.containerTimeout > 0
        ? raw.containerTimeout
        : DEFAULT_SYSTEM_SETTINGS.containerTimeout,
    idleTimeout:
      typeof raw.idleTimeout === 'number' && raw.idleTimeout > 0
        ? raw.idleTimeout
        : DEFAULT_SYSTEM_SETTINGS.idleTimeout,
    containerMaxOutputSize:
      typeof raw.containerMaxOutputSize === 'number' &&
      raw.containerMaxOutputSize > 0
        ? raw.containerMaxOutputSize
        : DEFAULT_SYSTEM_SETTINGS.containerMaxOutputSize,
    maxConcurrentContainers:
      typeof raw.maxConcurrentContainers === 'number' &&
      raw.maxConcurrentContainers > 0
        ? raw.maxConcurrentContainers
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentContainers,
    maxConcurrentHostProcesses:
      typeof raw.maxConcurrentHostProcesses === 'number' &&
      raw.maxConcurrentHostProcesses > 0
        ? raw.maxConcurrentHostProcesses
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentHostProcesses,
    maxLoginAttempts:
      typeof raw.maxLoginAttempts === 'number' && raw.maxLoginAttempts > 0
        ? raw.maxLoginAttempts
        : DEFAULT_SYSTEM_SETTINGS.maxLoginAttempts,
    loginLockoutMinutes:
      typeof raw.loginLockoutMinutes === 'number' && raw.loginLockoutMinutes > 0
        ? raw.loginLockoutMinutes
        : DEFAULT_SYSTEM_SETTINGS.loginLockoutMinutes,
    maxConcurrentScripts:
      typeof raw.maxConcurrentScripts === 'number' &&
      raw.maxConcurrentScripts > 0
        ? raw.maxConcurrentScripts
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentScripts,
    scriptTimeout:
      typeof raw.scriptTimeout === 'number' && raw.scriptTimeout > 0
        ? raw.scriptTimeout
        : DEFAULT_SYSTEM_SETTINGS.scriptTimeout,
    billingEnabled:
      typeof raw.billingEnabled === 'boolean'
        ? raw.billingEnabled
        : DEFAULT_SYSTEM_SETTINGS.billingEnabled,
    billingMode: 'wallet_first',
    billingMinStartBalanceUsd:
      typeof raw.billingMinStartBalanceUsd === 'number' &&
      raw.billingMinStartBalanceUsd >= 0
        ? raw.billingMinStartBalanceUsd
        : DEFAULT_SYSTEM_SETTINGS.billingMinStartBalanceUsd,
    billingCurrency:
      typeof raw.billingCurrency === 'string' && raw.billingCurrency
        ? raw.billingCurrency
        : DEFAULT_SYSTEM_SETTINGS.billingCurrency,
    billingCurrencyRate:
      typeof raw.billingCurrencyRate === 'number' && raw.billingCurrencyRate > 0
        ? raw.billingCurrencyRate
        : DEFAULT_SYSTEM_SETTINGS.billingCurrencyRate,
    externalClaudeDir:
      typeof raw.externalClaudeDir === 'string'
        ? raw.externalClaudeDir.trim()
        : DEFAULT_SYSTEM_SETTINGS.externalClaudeDir,
    autoCompactWindow: clampAutoCompactWindow(raw.autoCompactWindow),
    subagentModel:
      typeof raw.subagentModel === 'string' && raw.subagentModel.trim()
        ? raw.subagentModel.trim()
        : DEFAULT_SYSTEM_SETTINGS.subagentModel,
    disableMemoryLayerForAdminHost:
      typeof raw.disableMemoryLayerForAdminHost === 'boolean'
        ? raw.disableMemoryLayerForAdminHost
        : DEFAULT_SYSTEM_SETTINGS.disableMemoryLayerForAdminHost,
    pluginAutoScan:
      typeof raw.pluginAutoScan === 'boolean'
        ? raw.pluginAutoScan
        : DEFAULT_SYSTEM_SETTINGS.pluginAutoScan,
    taskBackfillGraceMs:
      typeof raw.taskBackfillGraceMs === 'number' &&
      raw.taskBackfillGraceMs >= 0
        ? raw.taskBackfillGraceMs
        : DEFAULT_SYSTEM_SETTINGS.taskBackfillGraceMs,
  };
}

function buildEnvFallbackSettings(): SystemSettings {
  return {
    containerTimeout: parseIntEnv(
      process.env.CONTAINER_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.containerTimeout,
    ),
    idleTimeout: parseIntEnv(
      process.env.IDLE_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.idleTimeout,
    ),
    containerMaxOutputSize: parseIntEnv(
      process.env.CONTAINER_MAX_OUTPUT_SIZE,
      DEFAULT_SYSTEM_SETTINGS.containerMaxOutputSize,
    ),
    maxConcurrentContainers: parseIntEnv(
      process.env.MAX_CONCURRENT_CONTAINERS,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentContainers,
    ),
    maxConcurrentHostProcesses: parseIntEnv(
      process.env.MAX_CONCURRENT_HOST_PROCESSES,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentHostProcesses,
    ),
    maxLoginAttempts: parseIntEnv(
      process.env.MAX_LOGIN_ATTEMPTS,
      DEFAULT_SYSTEM_SETTINGS.maxLoginAttempts,
    ),
    loginLockoutMinutes: parseIntEnv(
      process.env.LOGIN_LOCKOUT_MINUTES,
      DEFAULT_SYSTEM_SETTINGS.loginLockoutMinutes,
    ),
    maxConcurrentScripts: parseIntEnv(
      process.env.MAX_CONCURRENT_SCRIPTS,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentScripts,
    ),
    scriptTimeout: parseIntEnv(
      process.env.SCRIPT_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.scriptTimeout,
    ),
    billingEnabled:
      process.env.BILLING_ENABLED === 'true' ||
      DEFAULT_SYSTEM_SETTINGS.billingEnabled,
    billingMode: 'wallet_first',
    billingMinStartBalanceUsd: parseFloatEnv(
      process.env.BILLING_MIN_START_BALANCE_USD,
      DEFAULT_SYSTEM_SETTINGS.billingMinStartBalanceUsd,
    ),
    billingCurrency:
      process.env.BILLING_CURRENCY || DEFAULT_SYSTEM_SETTINGS.billingCurrency,
    billingCurrencyRate: parseFloatEnv(
      process.env.BILLING_CURRENCY_RATE,
      DEFAULT_SYSTEM_SETTINGS.billingCurrencyRate,
    ),
    externalClaudeDir:
      process.env.EXTERNAL_CLAUDE_DIR || DEFAULT_SYSTEM_SETTINGS.externalClaudeDir,
    autoCompactWindow: clampAutoCompactWindow(
      parseIntEnv(process.env.AUTO_COMPACT_WINDOW, DEFAULT_SYSTEM_SETTINGS.autoCompactWindow),
    ),
    subagentModel:
      process.env.SUBAGENT_MODEL || DEFAULT_SYSTEM_SETTINGS.subagentModel,
    disableMemoryLayerForAdminHost:
      process.env.DISABLE_MEMORY_LAYER_FOR_ADMIN_HOST === 'true' ||
      DEFAULT_SYSTEM_SETTINGS.disableMemoryLayerForAdminHost,
    pluginAutoScan:
      process.env.PLUGIN_AUTO_SCAN === 'false'
        ? false
        : DEFAULT_SYSTEM_SETTINGS.pluginAutoScan,
    taskBackfillGraceMs: parseIntEnv(
      process.env.TASK_BACKFILL_GRACE_MS,
      DEFAULT_SYSTEM_SETTINGS.taskBackfillGraceMs,
    ),
  };
}

export function getSystemSettings(): SystemSettings {
  // Fast path: return cached value if file hasn't changed (single stat)
  if (_settingsCache) {
    try {
      const mtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
      if (mtimeMs === _settingsMtimeMs) return _settingsCache;
    } catch {
      return _settingsCache; // file gone or stat failed — cached value is still valid
    }
  }

  // 1. Try reading from file
  try {
    const settings = readSystemSettingsFromFile();
    if (settings) {
      _settingsCache = settings;
      try {
        _settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
      } catch {
        /* ignore */
      }
      return settings;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        { err },
        'Failed to read system settings, falling back to env/defaults',
      );
    }
  }

  // 2. Fall back to env vars, then hardcoded defaults
  const settings = buildEnvFallbackSettings();
  _settingsCache = settings;
  _settingsMtimeMs = 0; // no file — will re-check on next call
  return settings;
}

/** 获取生效的外部 Claude 目录（externalClaudeDir 空时 fallback 到 ~/.claude） */
export function getEffectiveExternalDir(): string {
  const settings = getSystemSettings();
  return settings.externalClaudeDir || path.join(os.homedir(), '.claude');
}

export function saveSystemSettings(
  partial: Partial<SystemSettings>,
): SystemSettings {
  const existing = getSystemSettings();
  const merged: SystemSettings = { ...existing, ...partial };

  // Range validation
  if (merged.containerTimeout < 60000) merged.containerTimeout = 60000; // min 1 min
  if (merged.containerTimeout > 86400000) merged.containerTimeout = 86400000; // max 24 hours
  if (merged.idleTimeout < 60000) merged.idleTimeout = 60000;
  if (merged.idleTimeout > 86400000) merged.idleTimeout = 86400000;
  if (merged.containerMaxOutputSize < 1048576)
    merged.containerMaxOutputSize = 1048576; // min 1MB
  if (merged.containerMaxOutputSize > 104857600)
    merged.containerMaxOutputSize = 104857600; // max 100MB
  if (merged.maxConcurrentContainers < 1) merged.maxConcurrentContainers = 1;
  if (merged.maxConcurrentContainers > 100)
    merged.maxConcurrentContainers = 100;
  if (merged.maxConcurrentHostProcesses < 1)
    merged.maxConcurrentHostProcesses = 1;
  if (merged.maxConcurrentHostProcesses > 50)
    merged.maxConcurrentHostProcesses = 50;
  if (merged.maxLoginAttempts < 1) merged.maxLoginAttempts = 1;
  if (merged.maxLoginAttempts > 100) merged.maxLoginAttempts = 100;
  if (merged.loginLockoutMinutes < 1) merged.loginLockoutMinutes = 1;
  if (merged.loginLockoutMinutes > 1440) merged.loginLockoutMinutes = 1440; // max 24 hours
  if (merged.maxConcurrentScripts < 1) merged.maxConcurrentScripts = 1;
  if (merged.maxConcurrentScripts > 50) merged.maxConcurrentScripts = 50;
  if (merged.scriptTimeout < 5000) merged.scriptTimeout = 5000; // min 5s
  if (merged.scriptTimeout > 600000) merged.scriptTimeout = 600000; // max 10 min
  merged.billingMode = 'wallet_first';
  if (merged.billingMinStartBalanceUsd < 0)
    merged.billingMinStartBalanceUsd =
      DEFAULT_SYSTEM_SETTINGS.billingMinStartBalanceUsd;
  if (merged.billingMinStartBalanceUsd > 1000000)
    merged.billingMinStartBalanceUsd = 1000000;

  // autoCompactWindow 在读/写两端统一用 clampAutoCompactWindow 收紧（见函数注释）。
  merged.autoCompactWindow = clampAutoCompactWindow(merged.autoCompactWindow);

  // subagentModel: 非空字符串（别名或完整 model ID），去空白并限长；空则回退默认。
  if (typeof merged.subagentModel !== 'string' || !merged.subagentModel.trim()) {
    merged.subagentModel = DEFAULT_SYSTEM_SETTINGS.subagentModel;
  } else {
    merged.subagentModel = merged.subagentModel.trim().slice(0, 64);
  }

  // taskBackfillGraceMs: 0 = 关闭（旧行为：无视逾期全 backfill）；
  // >0 限制在 [1s, 24h]，避免误配置成几毫秒导致正常任务也被跳过。
  if (
    merged.taskBackfillGraceMs < 0 ||
    !Number.isFinite(merged.taskBackfillGraceMs)
  ) {
    merged.taskBackfillGraceMs = 0;
  } else if (merged.taskBackfillGraceMs > 0) {
    if (merged.taskBackfillGraceMs < 1000) merged.taskBackfillGraceMs = 1000;
    if (merged.taskBackfillGraceMs > 86400000)
      merged.taskBackfillGraceMs = 86400000;
  }

  // Validate externalClaudeDir: must be empty or an absolute directory path
  if (merged.externalClaudeDir) {
    const trimmed = merged.externalClaudeDir.trim();
    if (trimmed) {
      try {
        const resolved = fs.realpathSync(trimmed);
        merged.externalClaudeDir = fs.statSync(resolved).isDirectory() ? resolved : '';
      } catch {
        merged.externalClaudeDir = '';
      }
    } else {
      merged.externalClaudeDir = '';
    }
  }

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${SYSTEM_SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, SYSTEM_SETTINGS_FILE);

  // Update in-memory cache immediately
  _settingsCache = merged;
  try {
    _settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
  } catch {
    /* ignore */
  }

  return merged;
}

// ─── OAuth Usage Types ─────────────────────────────────────────────────────

export interface OAuthUsageBucket {
  utilization: number;
  resets_at: string;
}

/**
 * 解析 OAuth usage bucket 对象
 * 运行时类型守卫，验证 API 响应结构
 */
export function parseOAuthUsageBucket(v: unknown): OAuthUsageBucket | null {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.utilization !== 'number' || typeof obj.resets_at !== 'string')
    return null;
  return { utilization: obj.utilization, resets_at: obj.resets_at };
}
