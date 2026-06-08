/**
 * B3 MVP：per-folder CODEX_HOME 的 hooks 配置生成 + 信任注入。
 *
 * 目标：让 SessionStart + Stop 两个 hook 在 standalone 隔离 home 里端到端打通：
 *   配置注入 → codex 识别并信任 → hook 触发 → hook/started|completed 通知 → mapper → StreamEvent。
 *
 * ───── 三套命名（PoC 实测，互不相同，本模块统一处理） ─────
 *   1) hooks.json 事件键：PascalCase —— "SessionStart" / "Stop"。
 *   2) config.toml 信任态键里的事件段：snake_case —— "session_start" / "stop"。
 *   3) 协议 HookEventName（通知/mapper）：camelCase —— "sessionStart" / "stop"。
 * 本模块以 (1)(2) 落盘，mapper 侧消费 (3)。
 *
 * ───── 真实落盘格式（探明自 ~/.codex，PoC 复核） ─────
 *   hooks.json（CODEX_HOME 根）:
 *     { "hooks": { "SessionStart": [ { "hooks": [ { "type":"command","command":"…","timeout":10 } ] } ],
 *                  "Stop":         [ { "hooks": [ { … } ] } ] } }
 *   config.toml:
 *     [features]
 *     hooks = true
 *     [hooks.state."<hooks.json绝对路径>:<event_snake>:<group_idx>:<handler_idx>"]
 *     trusted_hash = "sha256:<hex>"
 *
 * ───── 信任机制（PoC 验明，recommendation='config'，无需自实现 hash） ─────
 *   新写入的 hook 默认 trustStatus='untrusted' 且不执行。
 *   流程：写 hooks.json + [features] hooks=true（不带 trusted_hash）→ 调 JSON-RPC `hooks/list`
 *   读各 hook 的 key 与 currentHash（'sha256:<hex>'，由 codex 自算、写前后稳定）→ 把 currentHash
 *   原样写入 config.toml 的 [hooks.state."<key>"].trusted_hash → 重启 app-server 后 trustStatus
 *   翻成 'trusted'，hook 即执行。
 *
 * 落盘函数均为幂等（marker 检测：已存在则跳过），与 codex-home.ts 的 copyIfAbsent 风格一致，
 * 键空间与 B2 的 agents/ 不交叉（本模块只动 hooks.json 与 config.toml 的 [features]/[hooks.state]）。
 */

import { readFile, writeFile, access, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';

/** hooks.json 文件名（落 CODEX_HOME 根）。 */
export const HOOKS_JSON_FILE = 'hooks.json';
/** config.toml 文件名。 */
export const CONFIG_TOML_FILE = 'config.toml';

/** B3 MVP 注入的 hook 事件（协议 camelCase）。SessionStart + Stop 两个端到端。 */
export type ManagedHookEvent = 'sessionStart' | 'stop';

/** 一个 hook 事件的三套命名对照。 */
interface HookEventNaming {
  /** 协议 HookEventName（通知/mapper）。 */
  readonly protocol: ManagedHookEvent;
  /** hooks.json 事件键（PascalCase）。 */
  readonly jsonKey: string;
  /** config.toml 信任态键里的事件段（snake_case）。 */
  readonly snake: string;
}

/** B3 MVP 托管的 hook 事件命名表（顺序即注入顺序，决定 group_idx 不影响这里——每事件单 group）。 */
export const MANAGED_HOOK_EVENTS: readonly HookEventNaming[] = [
  { protocol: 'sessionStart', jsonKey: 'SessionStart', snake: 'session_start' },
  { protocol: 'stop', jsonKey: 'Stop', snake: 'stop' },
] as const;

/** 单个 command handler（hooks.json 内 hooks[] 的成员）。 */
export interface HookCommandHandler {
  readonly type: 'command';
  readonly command: string;
  readonly timeout: number;
}

/** 一个 matcher group（hooks.json 内某事件数组的成员）。 */
export interface HookMatcherGroup {
  readonly hooks: HookCommandHandler[];
}

/** hooks.json 顶层结构（仅托管 SessionStart + Stop）。 */
export interface HooksJson {
  readonly hooks: {
    readonly SessionStart: HookMatcherGroup[];
    readonly Stop: HookMatcherGroup[];
  };
}

/** 生成 hooks.json 内容时的可注入项（便于测试与 marker 落点定制）。 */
export interface BuildHooksOptions {
  /** SessionStart 触发执行的命令。 */
  readonly sessionStartCommand: string;
  /** Stop 触发执行的命令。 */
  readonly stopCommand: string;
  /** 单个 hook 的超时（秒）。默认 10。 */
  readonly timeoutSec?: number;
}

const DEFAULT_TIMEOUT_SEC = 10;

/**
 * 构造 hooks.json 对象（SessionStart + Stop，各一个 command handler）。
 * group_idx 与 handler_idx 均为 0（单 group 单 handler）—— 与 hookStateKey 的默认一致。
 */
export function buildHooksJson(opts: BuildHooksOptions): HooksJson {
  const timeout = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: opts.sessionStartCommand, timeout }] }],
      Stop: [{ hooks: [{ type: 'command', command: opts.stopCommand, timeout }] }],
    },
  };
}

/** hooks.json 内容序列化（稳定 2 空格缩进，便于 marker 检测与 diff）。 */
export function renderHooksJson(hooks: HooksJson): string {
  return JSON.stringify(hooks, null, 2) + '\n';
}

/**
 * config.toml 的信任态键：`<hooks.json绝对路径>:<event_snake>:<group_idx>:<handler_idx>`。
 * 例：`/data/.codex/hooks.json:session_start:0:0`。
 * 注意：路径用绝对路径，codex 据此定位来源文件并校验 hash。
 */
export function hookStateKey(
  hooksJsonAbsPath: string,
  eventSnake: string,
  groupIdx = 0,
  handlerIdx = 0,
): string {
  return `${hooksJsonAbsPath}:${eventSnake}:${groupIdx}:${handlerIdx}`;
}

/** 一条待写入的信任条目（key=hookStateKey，hash=codex 自算的 currentHash，形如 'sha256:<hex>'）。 */
export interface TrustEntry {
  readonly key: string;
  /** 形如 'sha256:<hex>'，原样取自 hooks/list 的 HookMetadata.currentHash。 */
  readonly hash: string;
}

// ───────────────────────── 落盘（幂等） ─────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写 hooks.json 进 CODEX_HOME（幂等：已存在则不覆盖，保留 per-folder 本地修改）。
 * 返回 hooks.json 绝对路径（信任态键需要它）。
 */
export async function writeHooksJson(
  codexHome: string,
  opts: BuildHooksOptions,
): Promise<string> {
  const hooksPath = path.join(codexHome, HOOKS_JSON_FILE);
  if (!(await exists(hooksPath))) {
    await writeFile(hooksPath, renderHooksJson(buildHooksJson(opts)), 'utf8');
  }
  return hooksPath;
}

/**
 * 确保 config.toml 启用 hooks 特性（`[features]` 下 `hooks = true`），幂等合并：
 * - 文件不存在 → 新建，写 [features]\nhooks = true。
 * - 已有 `hooks = true`（任意空白变体）→ 不动。
 * - 有 [features] 段但缺 hooks → 在 [features] 段头后插入 `hooks = true`。
 * - 无 [features] 段 → 追加一个 [features] 段。
 * 不解析整份 TOML（无依赖），只对必要 marker 做最小化文本编辑。
 */
export async function ensureHooksFeature(configTomlPath: string): Promise<void> {
  let content = '';
  if (await exists(configTomlPath)) {
    content = await readFile(configTomlPath, 'utf8');
  }

  // 已启用？匹配 [features] 段内的 `hooks = true`（容空白）。粗匹配整文件足够（hooks 键名独特）。
  if (/^\s*hooks\s*=\s*true\s*$/m.test(content)) {
    return; // 幂等：已启用。
  }

  const featuresHeader = /^\[features\]\s*$/m;
  if (featuresHeader.test(content)) {
    // 在 [features] 段头之后插入 hooks = true。
    content = content.replace(featuresHeader, (h) => `${h}\nhooks = true`);
  } else {
    // 无 [features] 段：追加一个（保证前面有换行分隔）。
    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    content = `${content}${sep}\n[features]\nhooks = true\n`;
  }
  await writeFile(configTomlPath, content, 'utf8');
}

/**
 * 把 trusted_hash 幂等合并进 config.toml：每条 `[hooks.state."<key>"]` 段缺失才追加。
 * 已存在同名段（已信任过）→ 跳过该条，不重复追加、不覆盖。
 * 返回实际新写入的条目数（便于判断是否需重启 app-server 生效）。
 */
export async function writeTrustedHashes(
  configTomlPath: string,
  entries: readonly TrustEntry[],
): Promise<number> {
  let content = '';
  if (await exists(configTomlPath)) {
    content = await readFile(configTomlPath, 'utf8');
  }

  let appended = 0;
  let extra = '';
  for (const e of entries) {
    // TOML 段头里的 key 用基本字符串引号包裹（key 含冒号/斜杠/绝对路径）。
    const sectionHeader = `[hooks.state.${tomlBasicString(e.key)}]`;
    if (content.includes(sectionHeader)) continue; // 幂等：已信任过该 hook。
    extra += `\n${sectionHeader}\ntrusted_hash = ${tomlBasicString(e.hash)}\n`;
    appended += 1;
  }
  if (appended === 0) return 0;

  const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await writeFile(configTomlPath, `${content}${sep}${extra}`, 'utf8');
  return appended;
}

/** TOML 基本字符串（双引号）转义：反斜杠与双引号。 */
function tomlBasicString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ───────────────────────── 信任注入（需 live client） ─────────────────────────

/** hooks/list 返回的单个 hook 元数据（子集，对齐 protocol/ts/v2/HookMetadata.ts）。 */
export interface HookListMetadata {
  key: string;
  eventName: string;
  currentHash: string;
  trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified';
  sourcePath?: string;
  isManaged?: boolean;
}

/** 能发起 hooks/list 的最小 client 接口（便于测试注入替身）。 */
export interface HooksListClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** hooks/list 方法名（不在 Method 常量主路径，B3 内部使用）。 */
export const HOOKS_LIST_METHOD = 'hooks/list';

/**
 * 调 `hooks/list` 读取指定 cwd 下被识别的 hook 元数据。
 * 容错：响应缺字段时返回空数组（绝不抛，避免阻塞会话创建）。
 */
export async function listHooks(
  client: HooksListClient,
  cwd: string,
): Promise<HookListMetadata[]> {
  const resp = await client.request<{ data?: Array<{ hooks?: HookListMetadata[] }> }>(
    HOOKS_LIST_METHOD,
    { cwds: [cwd] },
  );
  return resp?.data?.[0]?.hooks ?? [];
}

/**
 * 从 hooks/list 的元数据里，挑出归属本 hooks.json 的 SessionStart/Stop，组装 TrustEntry。
 * - 仅取 sourcePath ∈ acceptablePaths 且 currentHash 非空者（防误信任其它来源的 hook）。
 * - eventName 用协议 camelCase 匹配 MANAGED_HOOK_EVENTS。
 * - acceptablePaths 传多个变体（如符号链接路径 + realpath）以兼容 macOS /var→/private/var：
 *   codex 的 sourcePath 是 realpath，而我们写盘用的可能是 symlink 路径，二者需都接受。
 */
export function selectManagedTrustEntries(
  metas: readonly HookListMetadata[],
  acceptablePaths: string | readonly string[],
): TrustEntry[] {
  const managed = new Set<string>(MANAGED_HOOK_EVENTS.map((e) => e.protocol));
  const accept = new Set<string>(
    typeof acceptablePaths === 'string' ? [acceptablePaths] : acceptablePaths,
  );
  const out: TrustEntry[] = [];
  for (const m of metas) {
    if (!m.key || !m.currentHash) continue;
    if (!managed.has(m.eventName)) continue;
    // sourcePath 缺省时放宽（部分实现可能不回填），但若提供则必须匹配本 hooks.json（任一变体）。
    if (m.sourcePath && !accept.has(m.sourcePath)) continue;
    out.push({ key: m.key, hash: m.currentHash });
  }
  return out;
}

/**
 * 端到端信任注入（一次性，幂等）：list → 选本 home 的 SessionStart/Stop → 写 trusted_hash。
 * 返回新写入的信任条目数；>0 表示首次信任、需重启 app-server 才生效（trustStatus 翻 'trusted'）。
 * cwd 默认取 codexHome（hooks/list 按 cwd 解析项目级 hook，这里用 home 即可命中根 hooks.json）。
 */
export async function trustManagedHooks(
  client: HooksListClient,
  codexHome: string,
  hooksJsonAbsPath: string,
  cwd: string = codexHome,
): Promise<number> {
  const metas = await listHooks(client, cwd);
  // 接受 hooks.json 的原路径与其 realpath（macOS /var→/private/var 等符号链接差异）。
  const accept = [hooksJsonAbsPath, ...(await resolveRealpathVariants(hooksJsonAbsPath))];
  const entries = selectManagedTrustEntries(metas, accept);
  if (entries.length === 0) return 0;
  return writeTrustedHashes(path.join(codexHome, CONFIG_TOML_FILE), entries);
}

/** 返回 p 的 realpath（若与原路径不同）。realpath 失败（文件不在等）→ 空数组（仅用原路径）。 */
async function resolveRealpathVariants(p: string): Promise<string[]> {
  try {
    const rp = await realpath(p);
    return rp !== p ? [rp] : [];
  } catch {
    return [];
  }
}
