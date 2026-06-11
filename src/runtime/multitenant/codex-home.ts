/**
 * FsCodexHomeProvisioner —— ICodexHomeProvisioner 的文件系统实现。
 *
 * 为每个 folder 准备隔离的 CODEX_HOME（`{dataDir}/sessions/{folder}/.codex`），并从共享
 * codex home（已登录的单账号）复制 `auth.json`（必需）与 `config.toml`（可选）进去。
 * 复制是幂等的：per-folder 已存在的文件不覆盖 —— 保留各 folder 自己的 token 刷新结果。
 *
 * 已知限制（standalone PoC）：
 *   共享单账号下，每个 per-folder 的 auth.json 由各自进程独立 refresh，多个 folder 同时
 *   刷新 token 时可能竞争（codex 的 refresh 是 auth.json + .bak 原子改写，但跨 home 之间
 *   无协调）。PoC 阶段可容忍；生产应集中一个 refresh owner（留待"接主仓"阶段）。
 */

import { mkdir, copyFile, access, readFile, writeFile, rm } from 'node:fs/promises';
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
import { mergeMcpServersIntoToml, tomlString } from './mcp-toml.js';

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
}

export class FsCodexHomeProvisioner implements ICodexHomeProvisioner {
  private readonly dataDir: string;
  private readonly sharedCodexHome: string;
  /** sessions 基目录，folder 解析后必须仍在其内（防逃逸）。 */
  private readonly sessionsBase: string;
  private readonly enableHooks: boolean;
  private readonly hookCommands: FsCodexHomeProvisionerOptions['hookCommands'];
  private readonly mcpServers: FsCodexHomeProvisionerOptions['mcpServers'];
  private readonly agentsMd: FsCodexHomeProvisionerOptions['agentsMd'];
  private readonly projectDocFallbackFilenames: FsCodexHomeProvisionerOptions['projectDocFallbackFilenames'];

  constructor(opts: FsCodexHomeProvisionerOptions) {
    this.dataDir = opts.dataDir;
    this.sharedCodexHome = opts.sharedCodexHome;
    this.sessionsBase = path.resolve(this.dataDir, 'sessions');
    this.enableHooks = opts.enableHooks ?? false;
    this.hookCommands = opts.hookCommands;
    this.mcpServers = opts.mcpServers;
    this.agentsMd = opts.agentsMd;
    this.projectDocFallbackFilenames = opts.projectDocFallbackFilenames;
  }

  async provision(folder: string): Promise<string> {
    const codexHome = this.resolveCodexHome(folder);

    // 1. 确保 per-folder CODEX_HOME 存在。
    await mkdir(codexHome, { recursive: true });

    // 2. 复制共享凭据（幂等：per-folder 已有则不覆盖）。
    //    auth.json 必需：源缺失则抛错。
    await this.copyIfAbsent(
      path.join(this.sharedCodexHome, AUTH_FILE),
      path.join(codexHome, AUTH_FILE),
      { required: true },
    );
    //    config.toml 可选：源存在才复制。
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

    // 7. context-resolver：项目维度 → config.toml 顶层 project_doc_fallback_filenames。
    if (this.projectDocFallbackFilenames && this.projectDocFallbackFilenames.length > 0) {
      await this.ensureProjectDocFallback(
        path.join(codexHome, CONFIG_FILE),
        this.projectDocFallbackFilenames,
      );
    }

    return codexHome;
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
   * 确保 config.toml 顶层含 project_doc_fallback_filenames 键（幂等）。
   * 键已存在（无论值是什么——per-folder 本地修改优先）则不动；
   * 否则把键行插到文件最前（TOML 顶层键必须出现在第一个表头之前）。
   */
  private async ensureProjectDocFallback(
    configPath: string,
    filenames: readonly string[],
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
    if (/^\s*project_doc_fallback_filenames\s*=/m.test(topLevel)) {
      return; // 幂等：顶层键已存在（保留 per-folder 本地修改）。
    }
    const line = `project_doc_fallback_filenames = [${filenames
      .map((f) => tomlString(f))
      .join(', ')}]\n`;
    await writeFile(configPath, line + content, 'utf8');
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
        throw new Error(`shared codex home 未登录: 缺 ${path.basename(src)} (${src})`);
      }
      return; // 可选文件源缺失 → 跳过。
    }
    await copyFile(src, dest);
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
