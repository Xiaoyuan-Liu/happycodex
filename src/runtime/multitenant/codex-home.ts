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

import { mkdir, copyFile, access, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';

import type { ICodexHomeProvisioner } from './types.js';
import { PREDEFINED_AGENTS, renderAgentToml } from './agent-defs.js';
import {
  CONFIG_TOML_FILE,
  ensureHooksFeature,
  writeHooksJson,
  type BuildHooksOptions,
} from './hooks-config.js';

/** 必需的共享凭据文件名。 */
const AUTH_FILE = 'auth.json';
/** 可选的共享配置文件名（= hooks-config 的 CONFIG_TOML_FILE，保持单一真相）。 */
const CONFIG_FILE = CONFIG_TOML_FILE;
/** B2：预定义子代理 TOML 子目录（codex 读 {CODEX_HOME}/agents/<name>.toml）。 */
const AGENTS_DIR = 'agents';

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
}

export class FsCodexHomeProvisioner implements ICodexHomeProvisioner {
  private readonly dataDir: string;
  private readonly sharedCodexHome: string;
  /** sessions 基目录，folder 解析后必须仍在其内（防逃逸）。 */
  private readonly sessionsBase: string;
  private readonly enableHooks: boolean;
  private readonly hookCommands: FsCodexHomeProvisionerOptions['hookCommands'];

  constructor(opts: FsCodexHomeProvisionerOptions) {
    this.dataDir = opts.dataDir;
    this.sharedCodexHome = opts.sharedCodexHome;
    this.sessionsBase = path.resolve(this.dataDir, 'sessions');
    this.enableHooks = opts.enableHooks ?? false;
    this.hookCommands = opts.hookCommands;
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

    return codexHome;
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
   * - required 且源不存在 → 抛错（auth.json 必需）。
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
