/**
 * FsCodexHomeProvisioner —— ICodexHomeProvisioner 的文件系统实现。
 *
 * 为每个 folder 准备隔离的 CODEX_HOME（`{dataDir}/sessions/{folder}/.codex`），并从共享
 * codex home（已登录的单账号）复制 `auth.json`（必需）与 `config.toml`（可选）进去。
 * auth.json 会在源凭据更新后同步到旧 per-folder home；若 per-folder 自己刷新出更新的
 * auth.json，则不覆盖。config.toml 等其他文件仍是 copy-if-absent。
 *
 * 已知限制（standalone PoC）：
 *   共享单账号下，每个 per-folder 的 auth.json 由各自进程独立 refresh，多个 folder 同时
 *   刷新 token 时可能竞争（codex 的 refresh 是 auth.json + .bak 原子改写，但跨 home 之间
 *   无协调）。PoC 阶段可容忍；生产应集中一个 refresh owner（留待"接主仓"阶段）。
 */

import { mkdir, copyFile, access, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomic } from '../../utils.js';
import type { ICodexHomeProvisioner } from './types.js';
import { PREDEFINED_AGENTS, renderAgentToml } from './agent-defs.js';
import {
  CONFIG_TOML_FILE,
  ensureHooksFeature,
  writeHooksJson,
  type BuildHooksOptions,
} from './hooks-config.js';
import { mergeMcpServersIntoToml, tomlKey, tomlString } from './mcp-toml.js';

/** 必需的共享凭据文件名。 */
const AUTH_FILE = 'auth.json';
/** 可选的共享配置文件名（= hooks-config 的 CONFIG_TOML_FILE，保持单一真相）。 */
const CONFIG_FILE = CONFIG_TOML_FILE;
/** B2：预定义子代理 TOML 子目录（codex 读 {CODEX_HOME}/agents/<name>.toml）。 */
const AGENTS_DIR = 'agents';

/** context-resolver 物化目标：{CODEX_HOME}/AGENTS.md（codex 对该 home 所有 thread 全局注入）。 */
export const AGENTS_MD_FILE = 'AGENTS.md';

/**
 * generated marker（必须是 AGENTS.md 首行）：标记该文件由 happycodex 物化生成。
 * 投影源（CLAUDE.md 等只读数据源）会演进，因此带 marker 的文件在每次 provision
 * 时按最新内容重生成；用户手工接管 = 删除此行，此后 happycodex 不再覆盖/删除。
 */
export const AGENTS_MD_GENERATED_MARKER =
  '<!-- happycodex:generated AGENTS.md —— 由 context-resolver 在每次 provision 时重生成；手工接管请删除本行 -->';

/**
 * B3：默认 hook 命令 —— 把一行 marker append 到 per-folder CODEX_HOME 下的 marker 文件。
 * 无副作用、可观测（端到端测试据此断言触发），$CODEX_HOME 由 codex 在 hook 执行时注入。
 */
const DEFAULT_SESSION_START_MARKER = 'fired-session-start.txt';
const DEFAULT_STOP_MARKER = 'fired-stop.txt';

export interface FsCodexHomeProvisionerOptions {
  /** 运行时数据根目录（per-folder CODEX_HOME 落在 `{dataDir}/sessions/{folder}/.codex`）。 */
  dataDir: string;
  /** 共享 codex home 源目录（应已登录，含 auth.json）。 */
  sharedCodexHome: string;
  /**
   * per-user auth 源目录（per-user 已登录时由调用方传该用户 codex home）。
   * 缺省回退 sharedCodexHome。auth.json 复制源 = authSourceDir ?? sharedCodexHome；
   * required 行为不变（源缺 auth.json 仍抛错——由调用方保证 authSourceDir 已含 auth.json
   * 或回退到含 auth 的 shared）。config.toml 等其余源仍取 sharedCodexHome。
   */
  authSourceDir?: string;
  /**
   * B3：是否注入 SessionStart + Stop hook 配置（hooks.json + [features] hooks=true）。
   * 默认 false（保持向后兼容；信任注入需 live client，由 SessionManager 在 client 起后完成）。
   */
  enableHooks?: boolean;
  /**
   * B3：自定义 hook 命令（默认 append marker 到 CODEX_HOME 下文件）。
   * 测试可注入可观测命令；生产可换成真实通知/副作用命令。
   */
  hookCommands?: Partial<Pick<BuildHooksOptions, 'sessionStartCommand' | 'stopCommand' | 'timeoutSec'>>;
  /**
   * MCP servers 接线点（可选，对应上游把 loadUserMcpServers() 注入 Claude settings.json）：
   * 提供时 provision 把每个 server 渲染为 config.toml 的 `[mcp_servers.<name>]` TOML 段，
   * 幂等合并（段头已存在则跳过，不覆盖 per-folder 本地修改）。调用方（container-runner）
   * 可传 loadUserMcpServers(ownerId) 的结果；不传则完全不触碰 mcp_servers 配置。
   */
  mcpServers?: Record<string, Record<string, unknown>>;
  /**
   * context-resolver 产物（用户/全局维度上下文）：物化 {CODEX_HOME}/AGENTS.md。
   * - string：以 generated-marker 首行写入；带 marker 的既有文件在内容变化时重写
   *   （投影源会演进），无 marker（用户手工接管）则不触碰。
   * - null：清除此前由 happycodex 生成的 AGENTS.md（带 marker 的文件）；用户文件不动。
   * - undefined：完全不触碰 AGENTS.md。
   */
  agentsMd?: string | null;
  /**
   * 项目维度上下文：确保 config.toml 顶层含 project_doc_fallback_filenames
   * （如 ["CLAUDE.md"]，codex 零拷贝直读群组工作区 CLAUDE.md 原文）。
   * 幂等：键已存在（per-folder 本地修改）则不动；写入位置在文件最前
   * （TOML 顶层键必须出现在第一个表头之前）。
   */
  projectDocFallbackFilenames?: readonly string[];
  /**
   * 项目维度上下文：写 config.toml 顶层 project_doc_max_bytes（codex 默认 32KiB）。
   * 调用方（container-runner）传 AGENTS_MD_MAX_BYTES，使 codex 实际读取上限与生成侧
   * 预裁剪预算一致，避免大 AGENTS.md（如多技能索引）被 codex 静默截断。幂等写入。
   */
  projectDocMaxBytes?: number;
  /**
   * per-user 自定义模型 provider（如 GLM 等兼容 OpenAI Responses API 的第三方）。
   * **不含 apiKey** —— provision 只写 config.toml 引用 env_key（固定 CODEX_CUSTOM_API_KEY）；
   * apiKey 由 container-runner 经 buildAgentEnvLines 注入 env，与凭据落盘解耦。
   * 提供时 provision 幂等写：顶层 model + model_provider，并合并 [model_providers.<id>] 段。
   */
  modelProvider?: CodexModelProviderConfig;
}

/** config.toml 写入用的自定义 provider 描述（不含 apiKey）。 */
export interface CodexModelProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** codex wire_api：默认 "responses"（codex 0.137.0 仅此可用）。 */
  wireApi?: 'responses' | 'chat';
}

/** 固定 env_key：每用户一个 provider + per-folder CODEX_HOME 隔离，固定名安全。 */
export const CODEX_CUSTOM_API_KEY_ENV = 'CODEX_CUSTOM_API_KEY';

// ── 自定义 provider 的 config.toml 调和（行式编辑，与 mcp-toml 同约定，不引入 TOML 依赖）──
const TOML_HEADER_RE = /^\s*\[/;
const MODEL_PROVIDERS_HEADER_RE = /^\s*\[model_providers\.("(?:[^"\\]|\\.)*"|[^\].]+)\]\s*(?:#.*)?$/;
const MANAGED_ENV_KEY_RE = new RegExp(
  `^\\s*env_key\\s*=\\s*["']${CODEX_CUSTOM_API_KEY_ENV}["']`,
);

/**
 * 剥离 happycodex 写入的自定义 provider 配置（其余内容原样保留）：
 * - 移除 `[model_providers.<id>]` 段中 body 含 `env_key="CODEX_CUSTOM_API_KEY"` 者（含其前导一空行）；
 * - 若顶层（首个表头前）`model_provider` 指向被移除的 id，则连同顶层 `model` 一并移除。
 * 用户手工 provider（无该 env_key）与无关键不动。无 happycodex 段则原样返回。
 */
export function stripManagedModelProvider(content: string): string {
  if (!content) return content;
  const lines = content.split('\n');
  const remove = new Array<boolean>(lines.length).fill(false);
  const managedIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(MODEL_PROVIDERS_HEADER_RE);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (TOML_HEADER_RE.test(lines[j]!)) { end = j; break; }
    }
    const managed = lines.slice(i + 1, end).some((l) => MANAGED_ENV_KEY_RE.test(l));
    if (managed) {
      managedIds.add(m[1]!.replace(/^["']|["']$/g, ''));
      for (let k = i; k < end; k++) remove[k] = true;
      // 连带移除段头前的一空行（insert 时加的分隔），避免越积越多空行。
      if (i > 0 && lines[i - 1]!.trim() === '') remove[i - 1] = true;
    }
    i = end - 1;
  }
  if (managedIds.size === 0) return content;

  let firstHeader = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (TOML_HEADER_RE.test(lines[i]!)) { firstHeader = i; break; }
  }
  let mpManaged = false;
  for (let i = 0; i < firstHeader; i++) {
    const mm = lines[i]!.match(/^\s*model_provider\s*=\s*["']?([^"'#\s]+)["']?/);
    if (mm) {
      if (managedIds.has(mm[1]!)) { remove[i] = true; mpManaged = true; }
      break;
    }
  }
  if (mpManaged) {
    for (let i = 0; i < firstHeader; i++) {
      if (/^\s*model\s*=/.test(lines[i]!)) { remove[i] = true; break; }
    }
  }

  const kept = lines.filter((_, i) => !remove[i]);
  // 折叠连续空行（≥2 → 1），并去掉首尾多余空行，保证 strip∘insert 稳定。
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '\n');
}

/**
 * 从 content 移除：顶层（首个表头前）所有 `model` / `model_provider` 行，以及
 * `[model_providers.<id>]` 段（裸名或带引号匹配 id）。供 insert 前清场——happycodex 配
 * provider 时拥有顶层 model/model_provider 与该 id 段，覆盖任何既有（用户 pin 的 model
 * 或同 id 的 user-authored 段），避免重复键 / 重复段头导致非法 TOML。
 */
function removeTopModelAndSection(content: string, id: string): string {
  if (!content) return content;
  const lines = content.split('\n');
  const remove = new Array<boolean>(lines.length).fill(false);

  let firstHeader = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (TOML_HEADER_RE.test(lines[i]!)) { firstHeader = i; break; }
  }
  for (let i = 0; i < firstHeader; i++) {
    if (/^\s*model\s*=/.test(lines[i]!) || /^\s*model_provider\s*=/.test(lines[i]!)) {
      remove[i] = true;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(MODEL_PROVIDERS_HEADER_RE);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (TOML_HEADER_RE.test(lines[j]!)) { end = j; break; }
    }
    if (m[1]!.replace(/^["']|["']$/g, '') === id) {
      for (let k = i; k < end; k++) remove[k] = true;
      if (i > 0 && lines[i - 1]!.trim() === '') remove[i - 1] = true;
    }
    i = end - 1;
  }
  const kept = lines.filter((_, i) => !remove[i]);
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '\n');
}

/**
 * 写入自定义 provider：先清场（移除既有顶层 model/model_provider + 同 id 段），再把顶层
 * model/model_provider 置最前（首个表头前，与其他顶层键共存）、`[model_providers.<id>]` 段
 * （env_key 固定 CODEX_CUSTOM_API_KEY）追加末尾。须先经 stripManagedModelProvider 清掉旧的
 * happycodex 管理段（含改名前的旧 id）。
 */
export function insertManagedModelProvider(
  content: string,
  provider: CodexModelProviderConfig,
): string {
  const cleaned = removeTopModelAndSection(content, provider.id);
  const wireApi = provider.wireApi ?? 'responses';
  const top =
    `model = ${tomlString(provider.model)}\n` +
    `model_provider = ${tomlString(provider.id)}\n`;
  const section =
    `[model_providers.${tomlKey(provider.id)}]\n` +
    `name = ${tomlString(provider.name)}\n` +
    `base_url = ${tomlString(provider.baseUrl)}\n` +
    `env_key = ${tomlString(CODEX_CUSTOM_API_KEY_ENV)}\n` +
    `wire_api = ${tomlString(wireApi)}\n`;
  const base = cleaned.replace(/^\n+/, '').replace(/\n+$/, '');
  const mid = base ? `${base}\n` : '';
  return `${top}${mid}\n${section}`;
}

export class FsCodexHomeProvisioner implements ICodexHomeProvisioner {
  private readonly dataDir: string;
  private readonly sharedCodexHome: string;
  /** auth.json 复制源（per-user 已登录则为其 codex home，否则回退 sharedCodexHome）。 */
  private readonly authSourceDir: string;
  /** sessions 基目录，folder 解析后必须仍在其内（防逃逸）。 */
  private readonly sessionsBase: string;
  private readonly enableHooks: boolean;
  private readonly hookCommands: FsCodexHomeProvisionerOptions['hookCommands'];
  private readonly mcpServers: FsCodexHomeProvisionerOptions['mcpServers'];
  private readonly agentsMd: FsCodexHomeProvisionerOptions['agentsMd'];
  private readonly projectDocFallbackFilenames: FsCodexHomeProvisionerOptions['projectDocFallbackFilenames'];
  private readonly projectDocMaxBytes: FsCodexHomeProvisionerOptions['projectDocMaxBytes'];
  private readonly modelProvider: FsCodexHomeProvisionerOptions['modelProvider'];

  constructor(opts: FsCodexHomeProvisionerOptions) {
    this.dataDir = opts.dataDir;
    this.sharedCodexHome = opts.sharedCodexHome;
    this.authSourceDir = opts.authSourceDir ?? opts.sharedCodexHome;
    this.sessionsBase = path.resolve(this.dataDir, 'sessions');
    this.enableHooks = opts.enableHooks ?? false;
    this.hookCommands = opts.hookCommands;
    this.mcpServers = opts.mcpServers;
    this.agentsMd = opts.agentsMd;
    this.projectDocFallbackFilenames = opts.projectDocFallbackFilenames;
    this.projectDocMaxBytes = opts.projectDocMaxBytes;
    this.modelProvider = opts.modelProvider;
  }

  async provision(folder: string): Promise<string> {
    const codexHome = this.resolveCodexHome(folder);

    // 1. 确保 per-folder CODEX_HOME 存在。
    await mkdir(codexHome, { recursive: true });

    // 2. 同步凭据。源 auth 更新（如设备码重新登录）后要刷新旧 per-folder 副本；
    //    但 per-folder 自己刷新出的更新 auth 不能被旧源覆盖。
    //    auth.json 必需：源 = authSourceDir（per-user 已登录的 codex home 或回退 shared）；
    //    源缺失则抛错（由调用方保证 authSourceDir 已含 auth.json 或回退含 auth 的 shared）。
    await this.syncAuthFile(
      path.join(this.authSourceDir, AUTH_FILE),
      path.join(codexHome, AUTH_FILE),
    );
    //    config.toml 可选：源取 sharedCodexHome（共享配置基线），源存在才复制。
    await this.copyIfAbsent(
      path.join(this.sharedCodexHome, CONFIG_FILE),
      path.join(codexHome, CONFIG_FILE),
      { required: false },
    );

    // 3. B2：写预定义子代理 TOML（幂等：已有不覆盖，保留 per-folder 可能的本地修改）。
    await this.provisionAgents(codexHome);

    // 4. B3：注入 SessionStart + Stop hook 配置（hooks.json + [features] hooks=true）。
    //    信任注入（trusted_hash，需 live client）由 SessionManager 在 app-server 起后完成。
    if (this.enableHooks) {
      await this.provisionHooks(codexHome);
    }

    // 5. MCP servers 接线点（可选）：渲染 [mcp_servers.*] 段幂等合并进 config.toml。
    if (this.mcpServers && Object.keys(this.mcpServers).length > 0) {
      await this.provisionMcpServers(codexHome, this.mcpServers);
    }

    // 6. context-resolver：用户/全局维度上下文 → {CODEX_HOME}/AGENTS.md（marker 幂等接管）。
    if (this.agentsMd !== undefined) {
      await this.provisionAgentsMd(codexHome, this.agentsMd);
    }

    // 7. context-resolver：项目维度 → config.toml 顶层 project_doc_fallback_filenames
    //    + project_doc_max_bytes（提高 codex 默认 32KiB 上限，与生成侧预算一致）。
    if (this.projectDocFallbackFilenames && this.projectDocFallbackFilenames.length > 0) {
      await this.ensureProjectDocSettings(
        path.join(codexHome, CONFIG_FILE),
        this.projectDocFallbackFilenames,
        this.projectDocMaxBytes,
      );
    }

    // 8. per-user 自定义模型 provider：调和式写——总是调用（即便无 provider），以便在
    //    删除/清 key 时剥离 config.toml 里残留的 happycodex 管理 provider 配置（否则
    //    codex 仍引用 model_provider 但 env 不再注入 key → 会话起不来、删除不自愈）。
    await this.provisionModelProvider(
      path.join(codexHome, CONFIG_FILE),
      this.modelProvider,
    );

    return codexHome;
  }

  /**
   * 调和式写自定义模型 provider 到 config.toml（非只追加——支持删除/改名/改 model 的收敛）：
   * - 先剥离上一次 happycodex 写入的 provider 配置：靠 `env_key = "CODEX_CUSTOM_API_KEY"`
   *   这个 happycodex 独有标记识别 `[model_providers.*]` 段并整段移除；若顶层
   *   `model_provider` 指向被剥离的 id，连同同组的顶层 `model` 一并移除。用户手工写的
   *   provider 段（无该 env_key）与无关顶层键不动。
   * - provider 提供时再按当前值重写：顶层 `model`/`model_provider`（插到首个表头前，与
   *   ensureProjectDocSettings 共存）+ `[model_providers.<id>]` 段（env_key 固定
   *   CODEX_CUSTOM_API_KEY）。provider 缺失（删除/无 key）则只剥不写 → codex 回退默认账号。
   * apiKey 绝不落盘（codex 运行时从 env_key 指向的 env 读取，由 buildAgentEnvLines 注入）。
   * 幂等：strip 是 insert 的左逆，二次 provision 结果稳定（next===content 免写盘）。
   */
  private async provisionModelProvider(
    configPath: string,
    provider: CodexModelProviderConfig | undefined,
  ): Promise<void> {
    let content = '';
    if (await this.exists(configPath)) {
      content = await readFile(configPath, 'utf8');
    }
    if (!content && !provider) return; // 无文件且无 provider：无事可做。

    // 调和：先剥离上一次 happycodex 写入的 provider 配置（靠 env_key=CODEX_CUSTOM_API_KEY
    // 这个独有标记识别 [model_providers.*] 段；顶层 model_provider 指向被剥离的 id 时连同
    // model 一并移除）。再按当前 provider 重写——删除→只剥不写、改名/改 model→旧的剥掉换新的。
    const stripped = stripManagedModelProvider(content);
    const next = provider
      ? insertManagedModelProvider(stripped, provider)
      : stripped;

    if (next === content) return; // 无变化免写盘（幂等）。
    await writeFile(configPath, next, 'utf8');
  }

  /**
   * 物化 AGENTS.md（用户/全局维度上下文投影）：
   * - 文件不存在 → 写入（marker 首行 + 内容）。
   * - 文件存在且以 marker 开头（我们生成的）→ 内容变化时重写（投影源演进），否则免写盘。
   * - 文件存在但无 marker（用户手工接管）→ 不触碰。
   * - content=null → 删除带 marker 的旧投影（源消失时不留陈旧上下文），用户文件不动。
   */
  private async provisionAgentsMd(
    codexHome: string,
    content: string | null,
  ): Promise<void> {
    const dest = path.join(codexHome, AGENTS_MD_FILE);
    let existing: string | null = null;
    if (await this.exists(dest)) {
      existing = await readFile(dest, 'utf8');
    }
    // 空文件视为可重写残留：手工接管的文档化方式是"删除 marker 行"（文件仍有内容），
    // 空文件只可能是崩溃残留（如非原子写中断），不当作接管，否则投影永久静默丢失。
    const generatedByUs =
      existing !== null &&
      (existing.startsWith(AGENTS_MD_GENERATED_MARKER) || existing.trim() === '');
    if (existing !== null && !generatedByUs) {
      return; // 用户手工接管：不覆盖、不删除。
    }
    if (content === null) {
      if (generatedByUs) {
        await rm(dest, { force: true });
      }
      return;
    }
    const next = `${AGENTS_MD_GENERATED_MARKER}\n\n${content}\n`;
    if (existing === next) return; // 幂等：内容未变，免写盘。
    // 原子写（tmp+rename，含 stale-tmp 防御）：避免崩溃留下空/半截文件。
    writeFileAtomic(dest, next);
  }

  /**
   * 确保 config.toml 顶层含 project_doc_fallback_filenames 与 project_doc_max_bytes
   * 两个键（各自幂等）。键已存在（无论值是什么——per-folder 本地修改优先）则不动；
   * 缺失的键行插到文件最前（TOML 顶层键必须出现在第一个表头之前）。两键都已存在则免写盘。
   */
  private async ensureProjectDocSettings(
    configPath: string,
    filenames: readonly string[],
    maxBytes: number | undefined,
  ): Promise<void> {
    let content = '';
    if (await this.exists(configPath)) {
      content = await readFile(configPath, 'utf8');
    }
    // 幂等检测只看顶层区域（第一个表头之前）：表内同名键（如 [profiles.x] 内）不算
    // 顶层键，不能据此跳过补写。用 /^\s*\[/m（TOML 允许表头前导空白）切出顶层区域，
    // 与仓库"不解析整份 TOML，只做行式段头检测"的既有约定一致（见 mcp-toml.ts）。
    const headerIdx = content.search(/^\s*\[/m);
    const topLevel = headerIdx === -1 ? content : content.slice(0, headerIdx);
    const prepend: string[] = [];
    if (!/^\s*project_doc_fallback_filenames\s*=/m.test(topLevel)) {
      prepend.push(
        `project_doc_fallback_filenames = [${filenames.map((f) => tomlString(f)).join(', ')}]`,
      );
    }
    if (maxBytes !== undefined && !/^\s*project_doc_max_bytes\s*=/m.test(topLevel)) {
      prepend.push(`project_doc_max_bytes = ${maxBytes}`);
    }
    if (prepend.length === 0) {
      return; // 幂等：顶层键都已存在（保留 per-folder 本地修改）。
    }
    await writeFile(configPath, `${prepend.join('\n')}\n${content}`, 'utf8');
  }

  /**
   * 把 MCP server 配置幂等合并进 per-folder config.toml：
   * 段头已存在的 server 跳过（保留 per-folder 本地修改），全部已存在则免写盘。
   */
  private async provisionMcpServers(
    codexHome: string,
    servers: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    const configPath = path.join(codexHome, CONFIG_FILE);
    let content = '';
    if (await this.exists(configPath)) {
      content = await readFile(configPath, 'utf8');
    }
    const merged = mergeMcpServersIntoToml(content, servers);
    if (merged.appended === 0) return; // 幂等：无新增段，不写盘。
    await writeFile(configPath, merged.content, 'utf8');
  }

  /**
   * 写 hooks.json + 确保 config.toml 的 [features] hooks=true（幂等）。
   * 键空间与 agents/ 不交叉：本步只动 hooks.json 与 config.toml 的 [features] 段。
   * 默认命令把 marker append 到 $CODEX_HOME 下文件（无副作用、可观测）。
   */
  private async provisionHooks(codexHome: string): Promise<void> {
    const ssMarker = path.join(codexHome, DEFAULT_SESSION_START_MARKER);
    const stopMarker = path.join(codexHome, DEFAULT_STOP_MARKER);
    const cmds = this.hookCommands ?? {};
    await writeHooksJson(codexHome, {
      sessionStartCommand:
        cmds.sessionStartCommand ?? `printf 'SS\\n' >> ${JSON.stringify(ssMarker)}`,
      stopCommand: cmds.stopCommand ?? `printf 'STOP\\n' >> ${JSON.stringify(stopMarker)}`,
      ...(cmds.timeoutSec !== undefined ? { timeoutSec: cmds.timeoutSec } : {}),
    });
    await ensureHooksFeature(path.join(codexHome, CONFIG_FILE));
  }

  /**
   * 写预定义子代理 TOML 到 {CODEX_HOME}/agents/<name>.toml（幂等）。
   * 与 copyIfAbsent 风格一致：目标已存在则跳过，不覆盖。
   */
  private async provisionAgents(codexHome: string): Promise<void> {
    const agentsDir = path.join(codexHome, AGENTS_DIR);
    await mkdir(agentsDir, { recursive: true });
    for (const def of PREDEFINED_AGENTS) {
      const dest = path.join(agentsDir, `${def.name}.toml`);
      if (await this.exists(dest)) continue; // 幂等：不覆盖已有。
      await writeFile(dest, renderAgentToml(def), 'utf8');
    }
  }

  /**
   * 解析 folder 对应的 CODEX_HOME 绝对路径，并校验未逃出 `{dataDir}/sessions`。
   * 拒绝含 '..' 段或绝对路径分隔导致逃逸的 folder。
   */
  private resolveCodexHome(folder: string): string {
    const sessionDir = path.resolve(this.sessionsBase, folder);
    const rel = path.relative(this.sessionsBase, sessionDir);
    // rel 以 '..' 开头或为绝对路径 → folder 逃出了 sessions 基目录。
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`非法 folder（逃出 sessions 目录）: ${folder}`);
    }
    return path.join(sessionDir, '.codex');
  }

  /**
   * 当目标不存在时复制 src → dest。
   * - 目标已存在 → 跳过（幂等，保留 per-folder 自己的内容）。
   * - required 且源不存在 → 抛错（auth.json 必需）。Web 端 setup 门与此同源：
   *   buildSetupStatus（routes/auth.ts）的 needsSetup 同样钉共享 auth.json
   *   存在性——两处必须保持一致，否则会出现「过了 setup 却起不了会话」或反之。
   * - 非 required 且源不存在 → 静默跳过（config.toml 可选）。
   */
  private async copyIfAbsent(
    src: string,
    dest: string,
    opts: { required: boolean },
  ): Promise<void> {
    if (await this.exists(dest)) {
      return; // 幂等：不覆盖 per-folder 已有文件。
    }
    if (!(await this.exists(src))) {
      if (opts.required) {
        // 消息对 shared / per-user 两种源都成立，且不泄漏绝对路径（会经 agent_error 透到用户）。
        throw new Error(
          `codex 未登录：缺 ${path.basename(src)}（请在设置中登录你的 codex 账号，或启用共享账号回退）`,
        );
      }
      return; // 可选文件源缺失 → 跳过。
    }
    await copyFile(src, dest);
  }

  /**
   * 同步 auth.json。
   *
   * 设备码 / access-token 重新登录会更新 authSourceDir/auth.json。旧 per-folder CODEX_HOME
   * 里已经存在的 auth.json 若仍是旧 token，继续 copy-if-absent 会让会话永远用 revoked
   * refresh token。这里按 mtime 做单向收敛：
   * - dest 不存在：复制源；
   * - src 比 dest 新：复制源，传播重新登录后的凭据；
   * - dest 等新或更新：保留 dest，避免覆盖 Codex 在该 per-folder 内刚刷新出的 token。
   */
  private async syncAuthFile(src: string, dest: string): Promise<void> {
    const missingAuthError = (): Error =>
      new Error(
        `codex 未登录：缺 ${path.basename(src)}（请在设置中登录你的 codex 账号，或启用共享账号回退）`,
      );

    if (path.resolve(src) === path.resolve(dest)) {
      if (!(await this.exists(src))) throw missingAuthError();
      return;
    }

    let srcStat;
    try {
      srcStat = await stat(src);
    } catch {
      throw missingAuthError();
    }

    let destStat;
    try {
      destStat = await stat(dest);
    } catch {
      await copyFile(src, dest);
      return;
    }

    if (srcStat.mtimeMs > destStat.mtimeMs) {
      await copyFile(src, dest);
    }
  }

  /** 文件/目录是否存在。 */
  private async exists(p: string): Promise<boolean> {
    try {
      await access(p, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
