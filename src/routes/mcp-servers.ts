// MCP Servers management routes

import { Hono } from 'hono';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { sharedCodexHomeDir } from '../codex-paths.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { checkMcpServerLimit } from '../billing.js';

// --- Types ---

interface McpServerEntry {
  // stdio type
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse type
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  // metadata
  enabled: boolean;
  syncedFromHost?: boolean;
  description?: string;
  addedAt: string;
}

interface McpServersFile {
  servers: Record<string, McpServerEntry>;
}

interface HostSyncManifest {
  syncedServers: string[];
  lastSyncAt: string;
}

// --- Utility Functions ---

function getUserMcpServersDir(userId: string): string {
  return path.join(DATA_DIR, 'mcp-servers', userId);
}

function getServersFilePath(userId: string): string {
  return path.join(getUserMcpServersDir(userId), 'servers.json');
}

function getHostSyncManifestPath(userId: string): string {
  return path.join(getUserMcpServersDir(userId), '.host-sync.json');
}

function validateServerId(id: string): boolean {
  // Length cap mirrors MAX_MCP_KEY_LEN (256) — id is the JSON object key
  // inside servers.json, an unbounded length there can balloon the file
  // into multi-MB and slow every container spawn that JSON.parses it.
  return id.length > 0 && id.length <= 256 && /^[\w\-]+$/.test(id) && id !== 'happyclaw';
}

async function readMcpServersFile(userId: string): Promise<McpServersFile> {
  try {
    const data = await fs.readFile(getServersFilePath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { servers: {} };
  }
}

async function writeMcpServersFile(
  userId: string,
  data: McpServersFile,
): Promise<void> {
  const dir = getUserMcpServersDir(userId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getServersFilePath(userId), JSON.stringify(data, null, 2));
}

async function readHostSyncManifest(userId: string): Promise<HostSyncManifest> {
  try {
    const data = await fs.readFile(getHostSyncManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { syncedServers: [], lastSyncAt: '' };
  }
}

async function writeHostSyncManifest(
  userId: string,
  manifest: HostSyncManifest,
): Promise<void> {
  const dir = getUserMcpServersDir(userId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    getHostSyncManifestPath(userId),
    JSON.stringify(manifest, null, 2),
  );
}

// ─── codex config.toml 导入（/sync-host Source 3） ──────────────────────
// 共享 codex home 解析已下沉 src/codex-paths.ts（单一真相源），此处副本删除。

/** TOML 基本字符串反转义（覆盖 mcp-toml.tomlString 产出的转义集）。 */
function unescapeTomlString(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_m, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch,
  );
}

/** 解析单个 TOML 键（bare key 或带引号 key），返回规范化名字。 */
function parseTomlKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeTomlString(trimmed.slice(1, -1));
  }
  return trimmed;
}

/**
 * 解析 TOML 标量值（基本/字面字符串 / 布尔 / 数字 / 字符串数组 / inline table）。
 * 数组值可能已由调用方累积为多行文本（TOML 允许数组跨行）。
 * 解析失败返回 undefined（调用方记 warning，消费键失败则跳过整个 server）。
 */
function parseTomlValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    return m ? unescapeTomlString(m[1] ?? '') : undefined;
  }
  if (v.startsWith("'")) {
    // TOML 字面串（literal string）：单引号包裹，无转义语义。
    const m = v.match(/^'([^']*)'\s*(?:#.*)?$/);
    return m ? (m[1] ?? '') : undefined;
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?\s*(?:#.*)?$/.test(v)) return Number(v.replace(/#.*$/, '').trim());
  if (v.startsWith('[')) {
    // 字符串数组（args 等，基本/字面串成员均支持）；
    // 非字符串成员的数组对 hostEntry 形状无意义，跳过。
    const close = v.lastIndexOf(']');
    if (close < 0) return undefined;
    const inner = v.slice(1, close);
    const out: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(inner)) !== null) {
      out.push(m[1] !== undefined ? unescapeTomlString(m[1]) : (m[2] ?? ''));
    }
    return out;
  }
  if (v.startsWith('{')) {
    // inline table（codex 原生形状常见 env = { KEY = "v" }），只取字符串成员。
    const out: Record<string, string> = {};
    const re = /([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\s*=\s*"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v)) !== null) {
      out[parseTomlKey(m[1] ?? '')] = unescapeTomlString(m[2] ?? '');
    }
    return out;
  }
  return undefined;
}

/** `[mcp_servers.<name>]` 或 `[mcp_servers.<name>.<sub>]` 段头。 */
const MCP_SECTION_RE =
  /^\[mcp_servers\.("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)(?:\.("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+))?\]\s*(?:#.*)?$/;

/**
 * codexServerToHostEntry 消费的键集合：这些键（或同名子表）的值解析失败
 * 意味着导入会产出残缺 server（如有 command 无 args）——整个 server 必须跳过，
 * 不能静默报成功。其余键（codex 自有配置，如 startup_timeout_sec）解析失败
 * 仅告警不致命（hostEntry 映射本就忽略它们）。
 */
const CONSUMED_SERVER_KEYS = new Set([
  'command',
  'args',
  'env',
  'url',
  'http_headers',
  'headers',
]);

/** `[mcp_servers.*]` 段内单键解析失败的告警载荷。 */
export interface McpTomlParseWarning {
  server: string;
  key: string;
  /** true = 消费键失败，server 整体被跳过；false = 无关键失败，仅丢该键。 */
  fatal: boolean;
}

/** 多行数组累积的闭合判定：剔除字符串字面量与注释后是否出现 `]`。 */
function tomlArrayClosed(s: string): boolean {
  return /\]/.test(
    s
      .replace(/"(?:[^"\\]|\\.)*"/g, '')
      .replace(/'[^']*'/g, '')
      .replace(/#[^\n]*/g, ''),
  );
}

/**
 * 解析 codex config.toml 的 `[mcp_servers.*]` 段。
 *
 * tombstone（happycodex）：上游 /sync-host 只认 Claude 配置面（~/.claude/settings.json
 * + ~/.claude.json）；codex-only 主机的 MCP 真相源是 {codex home}/config.toml。
 * 行式解析（与 mcp-toml.mergeMcpServersIntoToml 的「段头 marker 检测」同款策略，
 * 不引入 TOML 依赖），只需覆盖 mcp-toml 渲染器自身产出 + codex 原生形状：
 * 标量 command/url、数组 args（含跨行数组——TOML 允许，`codex mcp add` 与手编
 * 配置常见）、子表 [mcp_servers.<name>.env]/[.http_headers]、inline table
 * env = { ... }。未知键原样收集（hostEntry 映射阶段忽略）。
 *
 * 值解析失败不再静默丢键：经 onWarning 上报；消费键（CONSUMED_SERVER_KEYS
 * 或 env/http_headers 子表成员）失败时整个 server 从返回值剔除（fail-closed，
 * 由调用方计入 skipped），杜绝「缺 args 的残缺 server 报导入成功」。
 */
export function parseMcpServersFromToml(
  content: string,
  onWarning?: (warning: McpTomlParseWarning) => void,
): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  let current: Record<string, unknown> | null = null;
  let currentServer = '';
  let currentSub = ''; // '' = server 顶层；否则为子表名（env / http_headers / …）
  const failed = new Set<string>();

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      const m = line.match(MCP_SECTION_RE);
      if (!m) {
        current = null; // 其他段（[model] / [projects."…"] 等）→ 退出 mcp 上下文
        continue;
      }
      const name = parseTomlKey(m[1] ?? '');
      currentServer = name;
      const srv = (servers[name] ??= {});
      if (m[2]) {
        // 子表 [mcp_servers.<name>.env] / [.http_headers]
        const subName = parseTomlKey(m[2]);
        const sub: Record<string, unknown> = {};
        srv[subName] = sub;
        current = sub;
        currentSub = subName;
      } else {
        current = srv;
        currentSub = '';
      }
      continue;
    }

    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = parseTomlKey(line.slice(0, eq));
    if (!key) continue;
    let valueRaw = line.slice(eq + 1);
    // TOML 允许数组跨行：累积续行直到出现闭合 ]（剔除字符串字面量与注释后判定），
    // 再整体交给 parseTomlValue（其数组分支 lastIndexOf(']') + 跨行正则天然兼容）。
    // inline table 在 TOML 1.0 中禁止跨行，无需同等处理。
    if (valueRaw.trimStart().startsWith('[')) {
      while (!tomlArrayClosed(valueRaw) && i + 1 < lines.length) {
        i++;
        valueRaw += '\n' + (lines[i] ?? '');
      }
    }
    const value = parseTomlValue(valueRaw);
    if (value !== undefined) {
      current[key] = value;
    } else {
      const fatal =
        currentSub === ''
          ? CONSUMED_SERVER_KEYS.has(key)
          : CONSUMED_SERVER_KEYS.has(currentSub);
      if (fatal) failed.add(currentServer);
      onWarning?.({ server: currentServer, key, fatal });
    }
  }

  for (const name of failed) delete servers[name];
  return servers;
}

/**
 * codex `[mcp_servers.*]` 段 → sync-host 的 hostEntry 消费形状
 * （与 ~/.claude 来源对齐：含 url → { type:'http', url, headers }；
 * 否则 { command, args, env }。codex 的 http_headers 键还原为 headers）。
 */
function codexServerToHostEntry(
  server: Record<string, unknown>,
): Record<string, unknown> {
  const url = typeof server.url === 'string' ? server.url : '';
  if (url) {
    const headers = (server.http_headers ?? server.headers) as
      | Record<string, string>
      | undefined;
    return {
      type: 'http',
      url,
      ...(headers &&
      typeof headers === 'object' &&
      Object.keys(headers).length > 0
        ? { headers }
        : {}),
    };
  }
  const entry: Record<string, unknown> = {
    command: typeof server.command === 'string' ? server.command : '',
  };
  if (Array.isArray(server.args)) entry.args = server.args;
  if (
    server.env &&
    typeof server.env === 'object' &&
    Object.keys(server.env as object).length > 0
  ) {
    entry.env = server.env;
  }
  return entry;
}

// --- Routes ---

// 单个 MCP server 字段上限：避免认证用户用一个深度对象 / 巨型 args 把
// data/mcp-servers/{userId}/servers.json 撑成多 MB（每次容器启动会 JSON.parse
// 整个文件，OOM-class 退化）。配额同 ContainerEnvSchema 的口径。
const MAX_MCP_STRING_LEN = 4096;
const MAX_MCP_ARG_LEN = 2048;
const MAX_MCP_ARGS = 50;
const MAX_MCP_ENV_ENTRIES = 50;
const MAX_MCP_HEADERS = 50;
const MAX_MCP_KEY_LEN = 256;

function validateMcpStringArrayLikeArgs(
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: 'args must be an array of strings' };
  if (value.length > MAX_MCP_ARGS) return { ok: false, reason: `args has too many entries (max ${MAX_MCP_ARGS})` };
  for (const v of value) {
    if (typeof v !== 'string') return { ok: false, reason: 'args entries must be strings' };
    if (v.length > MAX_MCP_ARG_LEN) return { ok: false, reason: `args entry exceeds ${MAX_MCP_ARG_LEN} chars` };
  }
  return { ok: true };
}

function validateMcpKeyValueRecord(
  value: unknown,
  fieldName: string,
  maxEntries: number,
): { ok: true } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: `${fieldName} must be a plain object` };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxEntries) {
    return { ok: false, reason: `${fieldName} has too many entries (max ${maxEntries})` };
  }
  for (const [k, v] of entries) {
    if (k.length > MAX_MCP_KEY_LEN) {
      return { ok: false, reason: `${fieldName} key exceeds ${MAX_MCP_KEY_LEN} chars` };
    }
    if (typeof v !== 'string') {
      return { ok: false, reason: `${fieldName} value for "${k}" must be a string` };
    }
    if (v.length > MAX_MCP_STRING_LEN) {
      return { ok: false, reason: `${fieldName} value for "${k}" exceeds ${MAX_MCP_STRING_LEN} chars` };
    }
  }
  return { ok: true };
}

const mcpServersRoutes = new Hono<{ Variables: Variables }>();

// GET / — list all MCP servers for the current user
mcpServersRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const file = await readMcpServersFile(authUser.id);
  const servers = Object.entries(file.servers).map(([id, entry]) => ({
    id,
    ...entry,
  }));
  return c.json({ servers });
});

// POST / — add a new MCP server
mcpServersRoutes.post('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  const { id, command, args, env, description, type, url, headers } = body as {
    id?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    description?: string;
    type?: string;
    url?: string;
    headers?: Record<string, string>;
  };

  if (!id || typeof id !== 'string') {
    return c.json({ error: 'id is required and must be a string' }, 400);
  }
  if (!validateServerId(id)) {
    return c.json(
      {
        error:
          'Invalid server ID: must match /^[\\w\\-]+$/ and cannot be "happyclaw"',
      },
      400,
    );
  }

  // Billing: check MCP server limit
  const existingServers = await readMcpServersFile(authUser.id);
  const currentCount = Object.keys(existingServers.servers).length;
  if (!existingServers.servers[id]) {
    // Only check limit for new servers, not updates
    const limit = checkMcpServerLimit(authUser.id, authUser.role, currentCount);
    if (!limit.allowed) {
      return c.json({ error: limit.reason }, 403);
    }
  }

  const isHttpType = type === 'http' || type === 'sse';

  if (isHttpType) {
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required for http/sse type' }, 400);
    }
    if (url.length > MAX_MCP_STRING_LEN) {
      return c.json({ error: `url exceeds ${MAX_MCP_STRING_LEN} chars` }, 400);
    }
    if (headers !== undefined) {
      const r = validateMcpKeyValueRecord(headers, 'headers', MAX_MCP_HEADERS);
      if (!r.ok) return c.json({ error: r.reason }, 400);
    }
  } else {
    if (!command || typeof command !== 'string') {
      return c.json({ error: 'command is required and must be a string' }, 400);
    }
    if (command.length > MAX_MCP_STRING_LEN) {
      return c.json({ error: `command exceeds ${MAX_MCP_STRING_LEN} chars` }, 400);
    }
    if (args !== undefined) {
      const r = validateMcpStringArrayLikeArgs(args);
      if (!r.ok) return c.json({ error: r.reason }, 400);
    }
    if (env !== undefined) {
      const r = validateMcpKeyValueRecord(env, 'env', MAX_MCP_ENV_ENTRIES);
      if (!r.ok) return c.json({ error: r.reason }, 400);
    }
  }
  if (description !== undefined) {
    if (typeof description !== 'string') {
      return c.json({ error: 'description must be a string' }, 400);
    }
    if (description.length > MAX_MCP_STRING_LEN) {
      return c.json({ error: `description exceeds ${MAX_MCP_STRING_LEN} chars` }, 400);
    }
  }

  const file = await readMcpServersFile(authUser.id);
  if (file.servers[id]) {
    return c.json({ error: `Server "${id}" already exists` }, 409);
  }

  const entry: McpServerEntry = {
    enabled: true,
    ...(description ? { description } : {}),
    addedAt: new Date().toISOString(),
  };

  if (isHttpType) {
    entry.type = type as 'http' | 'sse';
    entry.url = url;
    if (headers && Object.keys(headers).length > 0) entry.headers = headers;
  } else {
    entry.command = command;
    if (args && args.length > 0) entry.args = args;
    if (env && Object.keys(env).length > 0) entry.env = env;
  }

  file.servers[id] = entry;

  await writeMcpServersFile(authUser.id, file);
  return c.json({ success: true, server: { id, ...file.servers[id] } });
});

// PATCH /:id — update config / enable / disable
mcpServersRoutes.patch('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  if (!validateServerId(id)) {
    return c.json({ error: 'Invalid server ID' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const { command, args, env, enabled, description, url, headers } = body as {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
    description?: string;
    url?: string;
    headers?: Record<string, string>;
  };

  const file = await readMcpServersFile(authUser.id);
  const entry = file.servers[id];
  if (!entry) {
    return c.json({ error: 'Server not found' }, 404);
  }

  // stdio fields
  if (command !== undefined) {
    if (typeof command !== 'string' || !command) {
      return c.json({ error: 'command must be a non-empty string' }, 400);
    }
    if (command.length > MAX_MCP_STRING_LEN) {
      return c.json({ error: `command exceeds ${MAX_MCP_STRING_LEN} chars` }, 400);
    }
    entry.command = command;
  }
  if (args !== undefined) {
    const r = validateMcpStringArrayLikeArgs(args);
    if (!r.ok) return c.json({ error: r.reason }, 400);
    entry.args = args;
  }
  if (env !== undefined) {
    const r = validateMcpKeyValueRecord(env, 'env', MAX_MCP_ENV_ENTRIES);
    if (!r.ok) return c.json({ error: r.reason }, 400);
    entry.env = env;
  }
  // http/sse fields
  if (url !== undefined) {
    if (typeof url !== 'string' || !url) {
      return c.json({ error: 'url must be a non-empty string' }, 400);
    }
    if (url.length > MAX_MCP_STRING_LEN) {
      return c.json({ error: `url exceeds ${MAX_MCP_STRING_LEN} chars` }, 400);
    }
    entry.url = url;
  }
  if (headers !== undefined) {
    const r = validateMcpKeyValueRecord(headers, 'headers', MAX_MCP_HEADERS);
    if (!r.ok) return c.json({ error: r.reason }, 400);
    entry.headers = headers;
  }
  // common fields
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    entry.enabled = enabled;
  }
  if (description !== undefined) {
    if (typeof description !== 'string' && description !== null) {
      return c.json({ error: 'description must be a string' }, 400);
    }
    if (typeof description === 'string' && description.length > MAX_MCP_STRING_LEN) {
      return c.json({ error: `description exceeds ${MAX_MCP_STRING_LEN} chars` }, 400);
    }
    entry.description =
      typeof description === 'string' ? description : undefined;
  }

  await writeMcpServersFile(authUser.id, file);
  return c.json({ success: true, server: { id, ...entry } });
});

// DELETE /:id — delete a server
mcpServersRoutes.delete('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  if (!validateServerId(id)) {
    return c.json({ error: 'Invalid server ID' }, 400);
  }

  const file = await readMcpServersFile(authUser.id);
  if (!file.servers[id]) {
    return c.json({ error: 'Server not found' }, 404);
  }

  delete file.servers[id];
  await writeMcpServersFile(authUser.id, file);
  return c.json({ success: true });
});

// POST /sync-host — sync from host MCP configs (admin only)
// Reads from ~/.claude/settings.json, ~/.claude.json, and the codex
// config.toml at {shared codex home}（codex-only 主机上前两者通常不存在）.
mcpServersRoutes.post('/sync-host', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can sync host MCP servers' }, 403);
  }

  // 5 处读盘并行（3 个 host 配置源 + 用户 servers.json + sync manifest）；
  // 合并顺序仍按 Source 1 → 2 → 3 串行应用，语义不变。
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const globalConfigPath = path.join(os.homedir(), '.claude.json');
  const codexConfigPath = path.join(sharedCodexHomeDir(), 'config.toml');
  const [settingsRaw, globalRaw, codexRaw, file, manifest] = await Promise.all([
    fs.readFile(settingsPath, 'utf-8').catch(() => null), // File may not exist, that's OK
    fs.readFile(globalConfigPath, 'utf-8').catch(() => null),
    fs.readFile(codexConfigPath, 'utf-8').catch(() => null),
    readMcpServersFile(authUser.id),
    readHostSyncManifest(authUser.id),
  ]);

  let hostServers: Record<string, any> = {};

  // Source 1: ~/.claude/settings.json
  if (settingsRaw !== null) {
    try {
      const settings = JSON.parse(settingsRaw);
      if (settings.mcpServers) {
        hostServers = { ...hostServers, ...settings.mcpServers };
      }
    } catch {
      // Invalid JSON, skip this source
    }
  }

  // Source 2: ~/.claude.json (global Claude Code config, stores per-user MCP settings)
  // When both files define the same server ID, ~/.claude.json wins because it's
  // the primary user-facing config file where Claude Code persists MCP settings.
  if (globalRaw !== null) {
    try {
      const config = JSON.parse(globalRaw);
      if (config.mcpServers) {
        hostServers = { ...hostServers, ...config.mcpServers };
      }
    } catch {
      // Invalid JSON, skip this source
    }
  }

  // Source 3: {shared codex home}/config.toml 的 [mcp_servers.*]（codex 原生
  // 配置；codex-only 主机上这是唯一非空来源）。codex 来源最后合并——ID 冲突时
  // 胜出（codex-first 语义）。段内值解析失败不再静默：记 warn 日志、计入
  // skipped、warnings 随响应返回（消灭「缺 args 还报成功」）。
  const warnings: string[] = [];
  const tomlSkippedServers = new Set<string>();
  if (codexRaw !== null) {
    const codexServers = parseMcpServersFromToml(codexRaw, (w) => {
      logger.warn(
        { server: w.server, key: w.key, fatal: w.fatal, file: codexConfigPath },
        'sync-host: unparseable TOML value in [mcp_servers.*] section',
      );
      if (w.fatal) {
        tomlSkippedServers.add(w.server);
        warnings.push(
          `config.toml [mcp_servers.${w.server}]：键 "${w.key}" 的值无法解析，已跳过该 server`,
        );
      } else {
        warnings.push(
          `config.toml [mcp_servers.${w.server}]：键 "${w.key}" 的值无法解析，已忽略该键`,
        );
      }
    });
    for (const [id, server] of Object.entries(codexServers)) {
      hostServers[id] = codexServerToHostEntry(server);
    }
  }

  if (Object.keys(hostServers).length === 0) {
    return c.json({
      added: 0,
      updated: 0,
      deleted: 0,
      skipped: tomlSkippedServers.size,
      ...(warnings.length > 0 ? { warnings } : {}),
      message:
        'No MCP servers found in host config files (~/.claude/settings.json, ~/.claude.json, codex config.toml)',
    });
  }

  const previouslySynced = new Set(manifest.syncedServers);
  const hostServerIds = new Set(Object.keys(hostServers));

  const stats = {
    added: 0,
    updated: 0,
    deleted: 0,
    skipped: tomlSkippedServers.size,
  };
  const newSyncedList: string[] = [];

  // Add/update from host
  for (const [id, hostEntry] of Object.entries(hostServers) as [
    string,
    any,
  ][]) {
    if (!validateServerId(id)) {
      stats.skipped++;
      continue;
    }

    const existsInUser = !!file.servers[id];
    const wasSynced = previouslySynced.has(id);

    // Skip manually added entries
    if (existsInUser && !wasSynced) {
      stats.skipped++;
      continue;
    }

    const isHttpType = hostEntry.type === 'http' || hostEntry.type === 'sse';

    const entry: McpServerEntry = {
      enabled: true,
      syncedFromHost: true,
      addedAt: existsInUser
        ? file.servers[id]?.addedAt || new Date().toISOString()
        : new Date().toISOString(),
    };

    if (isHttpType) {
      entry.type = hostEntry.type;
      entry.url = hostEntry.url || '';
      if (hostEntry.headers) entry.headers = hostEntry.headers;
    } else {
      entry.command = hostEntry.command || '';
      if (hostEntry.args) entry.args = hostEntry.args;
      if (hostEntry.env) entry.env = hostEntry.env;
    }

    if (existsInUser) {
      stats.updated++;
    } else {
      stats.added++;
    }

    file.servers[id] = entry;
    newSyncedList.push(id);
  }

  // Delete servers that were synced before but no longer on host
  for (const id of previouslySynced) {
    if (!hostServerIds.has(id) && file.servers[id]?.syncedFromHost) {
      delete file.servers[id];
      stats.deleted++;
    }
  }

  await writeMcpServersFile(authUser.id, file);
  await writeHostSyncManifest(authUser.id, {
    syncedServers: newSyncedList,
    lastSyncAt: new Date().toISOString(),
  });

  return c.json({ ...stats, ...(warnings.length > 0 ? { warnings } : {}) });
});

export { getUserMcpServersDir, readMcpServersFile };
// parseMcpServersFromToml 经函数声明处 export（回归测试直接消费）。
export default mcpServersRoutes;
