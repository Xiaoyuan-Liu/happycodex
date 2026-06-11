/**
 * Container Runner for happycodex
 * Spawns agent execution in Docker container and handles IPC
 *
 * 忠实搬迁自 upstream-happyclaw/src/container-runner.ts（1925 行），骨架保持上游结构：
 * runContainerAgent（Docker 模式）/ runHostAgent（host 模式）两入口 + 共享编排
 * （stdin 写 ContainerInput、attachStdoutHandler 解析、超时 kill、close 状态机、
 * per-group IPC 目录、快照写入、killProcessTree）。
 *
 * 引擎面整体替换（Claude → codex）：
 *   - provider pool（trySelectPoolProvider / setProviderOverride / willClearSessionOnProviderSwitch /
 *     providerFailure 上报 / releaseSession）随 provider failover 作废，整段删除（各处留 tombstone）。
 *   - ~/.claude.json / .credentials.json / settings.json / CLAUDE_CONFIG_DIR / claude 二进制
 *     PATH 前置 / plugins 预构建（prepareHostPlugins）→ 删除或换 codex 等价：
 *     host/docker 两路 spawn 前用 FsCodexHomeProvisioner provision per-folder CODEX_HOME
 *     （auth 复制 + agents/hooks 物化），env 注入 CODEX_HOME + codex 二进制 PATH 可达。
 *   - dist 预检（@anthropic-ai/claude-agent-sdk + container/agent-runner dist）→ 校验我们的
 *     引擎产物 dist/agent-runner.js（npm run build 产出），可经 env HAPPYCODEX_RUNNER_CMD
 *     覆盖（dev：`tsx src/agent-runner.ts`；测试：fake runner）。
 *   - CLAUDE.md / rules / skills / plugins 挂载（claude-context-resolver）→ 删除；
 *     AGENTS.md 路线由后续 context-resolver 阶段接（本阶段只保证 cwd 正确）。
 *   - HAPPYCLAW_WORKSPACE_* env 名与语义原样保留（per-folder 路径）。
 */
import {
  ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  hasUserCodexAuth,
  perUserAuthFallbackEnabled,
  sharedCodexHomeDir,
  userCodexHomeDir,
} from './codex-paths.js';
import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { resolveHostNodeBinary, resolveBinaryOnPath } from './node-resolver.js';
import {
  loadMountAllowlist,
  validateAdditionalMounts,
} from './mount-security.js';
import {
  buildContainerEnvLines,
  getContainerEnvConfig,
  getEffectiveExternalDir,
  getSystemSettings,
  getUserCodexProvider,
  shellQuoteEnvLines,
  type ClaudeProviderConfig,
  type ContainerEnvConfig,
} from './runtime-config.js';
// tombstone（happycodex）：上游 providerPool / db 的 deleteSession+getSessionProviderId+
// setSessionProviderId / isApiError（pool 健康上报用途）/ resolveProviderById 等 provider
// failover 触点随 provider pool 作废删除（provider-pool.ts 本体不搬）。
// tombstone（happycodex）：上游 plugin-utils / plugin-materializer / plugin-command-index /
// agent-capabilities（checkHostCapabilities）为 Claude 引擎面，未搬迁、对应逻辑删除。
// claude-context-resolver 已接 codex 版（buildClaudeContextPlan/syncHostClaudeContext →
// buildCodexContextPlan/buildSessionDeveloperInstructions：AGENTS.md + config.toml fallback +
// developerInstructions 三通道）；mcp-utils（loadUserMcpServers）经 provisionCodexHome 的
// mcpServers 接线点渲染进 per-folder config.toml（替代上游写 Claude settings.json）。
import { loadUserMcpServers } from './mcp-utils.js';
import {
  buildCodexContextPlan,
  buildSessionDeveloperInstructions,
} from './claude-context-resolver.js';
import { buildSystemPromptAppend } from './prompt-assembly.js';
import {
  buildSkillsIndexSection,
  materializeGroupSkills,
  WORKSPACE_SKILLS_DIRNAME,
} from './skills-materializer.js';
import { getChannelFromJid } from './channel-prefixes.js';
import {
  FsCodexHomeProvisioner,
  type CodexModelProviderConfig,
} from './runtime/multitenant/codex-home.js';
import type { RegisteredGroup } from './types.js';
import type { ContainerOutput } from './container-output.js';
import {
  attachStderrHandler,
  attachStdoutHandler,
  createStderrState,
  createStdoutParserState,
  handleNonZeroExit,
  handleSuccessClose,
  handleTimeoutClose,
  writeRunLog,
  type CloseHandlerContext,
} from './agent-output-parser.js';

// 上游在本文件定义并导出 ContainerOutput；happycodex 单一真相源在 src/container-output.ts，
// 此处 re-export 保持上游 import 面（`import { ContainerOutput } from './container-runner.js'`）不变。
export type { ContainerOutput } from './container-output.js';

// tombstone（happycodex）：上游 getHostClaudeJsonPath / ensureHostClaudeJson /
// getContainerClaudeJsonPath / ensureSymlinkTo / REQUIRED_SETTINGS_ENV / ensureSettingsJson
// （~/.claude.json deviceId 一致性 + settings.json 必需 env 合并，upstream container-runner.ts:80-199）
// 均为 Claude 配置面，随 codex 引擎替换整段删除。codex 的 per-folder 配置由
// FsCodexHomeProvisioner（auth.json/config.toml 复制 + agents/hooks 物化）承担。

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  /** Source JID of the latest message that triggered this run (e.g. `discord:123…`).
   * Used by per-channel MCP tools (discord_*, etc.) to identify the current
   * incoming chat. Undefined when chatJid already encodes the IM source. */
  currentSourceJid?: string;
  /** @deprecated Use isHome + isAdminHome instead */
  isMain: boolean;
  turnId?: string;
  isHome?: boolean;
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** Isolated task run ID — determines IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  /** If the last unprocessed message was emitted by a scheduled task prompt,
   * this is that task's ID; propagated into agent-runner so MCP send_message
   * outputs can be attributed back to the task record. */
  messageTaskId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  /**
   * codex 通道：会话动态上下文，agent-runner 透传到 ThreadSessionConfig.developerInstructions
   * （thread/start.developerInstructions，与静态 AGENTS.md 叠加且冲突时胜出）。
   * 两处 spawn 前由 context-resolver 就地派生注入（buildSessionDeveloperInstructions），
   * 调用方也可预置（追加在前）。
   */
  developerInstructions?: string;
  // tombstone（happycodex）：上游 plugins?: SdkPluginConfig[]（Claude Code plugins，
  // 两处 spawn 前 loadUserPlugins 就地派生注入）与 contextAudit?: ClaudeContextAudit
  // （claude-context-resolver 审计）随 Claude 引擎面删除。
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Create directory with 0o777 permissions for container volume mounts.
 * Fixes uid mismatch between host user and container node user (uid 1000),
 * especially in rootless podman where uid remapping causes permission denied.
 */
function mkdirForContainer(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  try {
    fs.chmodSync(dirPath, 0o777);
  } catch {
    // Ignore — may fail on read-only filesystem or special mounts
  }
}

// tombstone（happycodex）：上游 ResolvedProvider / providerOverrides / setProviderOverride /
// willClearSessionOnProviderSwitch / trySelectPoolProvider（provider pool 选择 + session-sticky
// 绑定 + 一次性 override，upstream container-runner.ts:269-489）随 provider failover 作废整段删除。
// codex 单账号凭据由 per-folder CODEX_HOME（auth.json 复制）承载，无池化选择。

// ─── codex 引擎面：CODEX_HOME provision + 引擎 env ───────────────────
// sharedCodexHomeDir 已下沉 src/codex-paths.ts（单一真相源），此处副本删除。

/** context-resolver / MCP 接线产物（provision 时一并物化进 per-folder CODEX_HOME）。 */
export interface CodexHomeContextOptions {
  /** AGENTS.md 内容（null=清除旧投影；undefined=不触碰），见 FsCodexHomeProvisioner。 */
  agentsMd?: string | null;
  /** config.toml 顶层 project_doc_fallback_filenames（幂等写入）。 */
  projectDocFallbackFilenames?: readonly string[];
  /** config.toml 顶层 project_doc_max_bytes（幂等写入；提高 codex 默认 32KiB 上限）。 */
  projectDocMaxBytes?: number;
  /** loadUserMcpServers(ownerId) 的结果（渲染为 [mcp_servers.*] TOML 段幂等合并）。 */
  mcpServers?: Record<string, Record<string, unknown>>;
  /**
   * per-user auth 源目录：auth.json 复制源（缺省回退 sharedCodexHome）。
   * buildCodexHomeContext 按 owner 的 per-user 凭据存在性 + fallback 开关计算，
   * 透传进 provisioner（照 projectDocMaxBytes 透传范式）。
   */
  authSourceDir?: string;
  /**
   * per-user 自定义模型 provider（不含 apiKey）：buildCodexHomeContext 按 owner
   * 的 getUserCodexProvider 填充，透传进 provisioner 写 config.toml；apiKey 走
   * buildAgentEnvLines 注入 env（CODEX_CUSTOM_API_KEY）。
   */
  modelProvider?: CodexModelProviderConfig;
}

/**
 * Provision per-folder CODEX_HOME（`{DATA_DIR}/sessions/{folder}/.codex`，sub-agent 走
 * `{folder}/agents/{agentId}/.codex`——路径形状对齐上游 per-group `.claude` 会话目录）。
 * auth.json 从共享 codex home 复制（幂等），预定义子代理 TOML 一并物化；
 * context 提供时再物化 AGENTS.md（用户/全局维度）+ config.toml 的
 * project_doc_fallback_filenames（项目维度）+ [mcp_servers.*]（MCP 接线点）。
 */
export async function provisionCodexHome(
  groupFolder: string,
  agentId?: string,
  context?: CodexHomeContextOptions,
): Promise<string> {
  const provisioner = new FsCodexHomeProvisioner({
    dataDir: DATA_DIR,
    sharedCodexHome: sharedCodexHomeDir(),
    ...(context && context.agentsMd !== undefined
      ? { agentsMd: context.agentsMd }
      : {}),
    ...(context?.projectDocFallbackFilenames
      ? { projectDocFallbackFilenames: context.projectDocFallbackFilenames }
      : {}),
    ...(context?.projectDocMaxBytes !== undefined
      ? { projectDocMaxBytes: context.projectDocMaxBytes }
      : {}),
    ...(context?.mcpServers ? { mcpServers: context.mcpServers } : {}),
    ...(context?.authSourceDir !== undefined
      ? { authSourceDir: context.authSourceDir }
      : {}),
    ...(context?.modelProvider
      ? { modelProvider: context.modelProvider }
      : {}),
  });
  const folder = agentId
    ? path.join(groupFolder, 'agents', agentId)
    : groupFolder;
  return provisioner.provision(folder);
}

/**
 * 两处 spawn 共用：构建 context-resolver 接线产物。
 * - 技能承载 → 四源技能物化到受管群组工作区 {GROUPS_DIR}/{folder}/.skills/（幂等；
 *   绝不写 customCwd），索引节经 skillsIndex 通道并入 AGENTS.md（上游对应 SDK skills:'all'
 *   的 frontmatter 注入 + install_skill 落盘目录 data/skills/{ownerId} 即 user 源）；
 * - 用户/全局维度 → AGENTS.md 内容（admin 全局 CLAUDE.md + user-global 记忆，只读源）；
 * - 项目维度 → project_doc_fallback_filenames=["CLAUDE.md"]；
 * - MCP servers → loadUserMcpServers(ownerId)（对应上游注入 Claude settings.json 的位置）。
 */
function buildCodexHomeContext(
  executionMode: 'host' | 'container',
  group: RegisteredGroup,
  ownerHomeFolder?: string,
): CodexHomeContextOptions {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  const skillsResult = materializeGroupSkills({
    executionMode,
    group,
    ownerHomeFolder,
    externalClaudeDir: getEffectiveExternalDir(),
    dataDir: DATA_DIR,
    projectRoot: process.cwd(),
    groupDir,
  });
  for (const warning of skillsResult.warnings) {
    logger.warn({ group: group.name, warning }, 'Skill materialization warning');
  }
  const skillsIndexSection = buildSkillsIndexSection(skillsResult.skills);
  const plan = buildCodexContextPlan({
    executionMode,
    group,
    ownerHomeFolder,
    externalClaudeDir: getEffectiveExternalDir(),
    groupsDir: GROUPS_DIR,
    ...(skillsIndexSection
      ? {
          skillsIndex: {
            section: skillsIndexSection,
            skillsDir: path.join(groupDir, WORKSPACE_SKILLS_DIRNAME),
          },
        }
      : {}),
  });
  const ownerId = group.created_by;
  const mcpServers = ownerId ? loadUserMcpServers(ownerId) : {};
  // per-user 自定义模型 provider（不含 apiKey，apiKey 走 buildAgentEnvLines 注入 env）。
  const modelProvider = resolveModelProvider(ownerId);
  return {
    agentsMd: plan.agentsMd,
    projectDocFallbackFilenames: plan.projectDocFallbackFilenames,
    projectDocMaxBytes: plan.projectDocMaxBytes,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    authSourceDir: resolveAuthSourceDir(ownerId),
    ...(modelProvider ? { modelProvider } : {}),
  };
}

/**
 * 解析 owner 的自定义模型 provider 写库描述（不含 apiKey）。
 * - ownerId 缺失 / 未配置 → undefined（不触碰 config.toml 的 model/model_provider）。
 * - apiKey 缺失（hasApiKey=false）→ 仍 undefined：写了 provider 段但无 key，codex 起不来；
 *   宁可不切换 provider，回退默认账号（不引入"半配置"破窗）。
 */
function resolveModelProvider(
  ownerId: string | undefined | null,
): CodexModelProviderConfig | undefined {
  if (!ownerId) return undefined;
  const provider = getUserCodexProvider(ownerId);
  if (!provider || !provider.apiKey) return undefined;
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    wireApi: provider.wireApi,
  };
}

/**
 * 计算 auth.json 复制源目录（per-user OAuth 选源）：
 * - owner 有 per-user 凭据 → 用其 userCodexHomeDir（用自己的账号）。
 * - 无 per-user 凭据 + fallback 开启 → sharedCodexHomeDir（回退共享账号）。
 * - 无 per-user 凭据 + fallback 关闭 → 故意指向不含 auth 的 per-user 目录：
 *   provision 时 copyIfAbsent(auth.json, required) 抛"未登录"错，由编排层经现有
 *   agent_error 通路呈现为友好"请先登录"（强制每人自登，不新增分支）。
 * - ownerId 缺失（无 created_by）→ 回退 sharedCodexHomeDir。
 */
function resolveAuthSourceDir(ownerId: string | undefined | null): string {
  if (!ownerId) return sharedCodexHomeDir();
  if (hasUserCodexAuth(ownerId)) return userCodexHomeDir(ownerId);
  return perUserAuthFallbackEnabled()
    ? sharedCodexHomeDir()
    : userCodexHomeDir(ownerId);
}

/**
 * 两处 spawn 共用：就地派生注入系统提示词分片 + 会话动态上下文的 ContainerInput
 * （不 mutate 调用方 input——队列/日志/重试路径共享同一引用，对齐上游 dockerInput/
 * hostInput 派生范式）。三段顺序：
 *   1. 调用方预置 developerInstructions（保持在前，既有契约）
 *   2. 场景化分片拼装产物（上游 systemPrompt preset append 的 codex 等价，见 prompt-assembly）
 *   3. 会话动态上下文（殿后，便于"后者胜出"语义）
 *
 * opts.disableMemoryLayer：host 路径与 HAPPYCLAW_DISABLE_MEMORY_LAYER env 同源同值
 * （上游 agent-runner 在容器内读该 env 选片；codex 版拼装在宿主侧，直接传值）。
 * opts.workspaceGlobalDir：host 模式真实 user-global 目录（替换 memory 分片中的
 * 容器路径 /workspace/global 字面量）；容器模式不传。
 */
function deriveInputWithSessionContext(
  executionMode: 'host' | 'container',
  group: RegisteredGroup,
  input: ContainerInput,
  opts?: { disableMemoryLayer?: boolean; workspaceGlobalDir?: string },
): ContainerInput {
  // 上游 normalizeHomeFlags 同式（isMain 为 legacy 兜底）。
  const isHome = input.isHome !== undefined ? !!input.isHome : !!input.isMain;
  const promptAppend = buildSystemPromptAppend({
    channel: getChannelFromJid(input.chatJid),
    isHome,
    disableMemoryLayer: opts?.disableMemoryLayer ?? false,
    agentId: input.agentId,
    workspaceGlobalDir: opts?.workspaceGlobalDir,
  });
  const sessionContext = buildSessionDeveloperInstructions({
    executionMode,
    group,
    input,
    timezone: TIMEZONE,
  });
  const parts = [
    ...(input.developerInstructions ? [input.developerInstructions] : []),
    promptAppend,
    sessionContext,
  ];
  return {
    ...input,
    developerInstructions: parts.join('\n\n'),
  };
}

/** 空 provider 配置：复用 runtime-config 的 env 行构建/净化管线但不产生任何 ANTHROPIC_* 行。 */
const EMPTY_PROVIDER_CONFIG: ClaudeProviderConfig = {
  anthropicBaseUrl: '',
  anthropicAuthToken: '',
  anthropicApiKey: '',
  claudeCodeOauthToken: '',
  claudeOAuthCredentials: null,
  anthropicModel: '',
  updatedAt: '',
};

/**
 * 构建注入 agent 进程/容器的 env 行。
 *
 * codex 替换：上游在此合并 Claude provider env（ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY/MODEL）
 * —— 随 provider failover 作废删除；仅保留群组级 customEnv（沿用 buildContainerEnvLines 的
 * ENV_KEY_RE 校验 + DANGEROUS_ENV_VARS 拦截 + 控制字符剥离），以及与引擎无关的
 * AUTO_COMPACT_WINDOW / SUBAGENT_MODEL 系统设置注入（语义对齐上游）。
 *
 * ownerId 提供且该 owner 配了自定义模型 provider（含 apiKey）时，注入一行
 * CODEX_CUSTOM_API_KEY=<解密 apiKey>——config.toml 的 [model_providers.<id>] env_key 据此
 * 取 key（apiKey 不落 config.toml）。apiKey 已由 normalizeSecret 剥空白/非 ASCII，无换行；
 * 容器侧再经 shellQuoteEnvLines 单引号转义，特殊字符不破坏 env 文件。
 */
function buildAgentEnvLines(
  folder: string,
  ownerId?: string | null,
): string[] {
  const override = getContainerEnvConfig(folder);
  // 只透传 customEnv：override 中可能残留的 anthropic* 字段（旧配置文件）一律不进入 env。
  const customOnly: ContainerEnvConfig = override.customEnv
    ? { customEnv: override.customEnv }
    : {};
  const lines = buildContainerEnvLines(EMPTY_PROVIDER_CONFIG, customOnly, {});

  // SystemSettings.autoCompactWindow > 0 时注入；消费端 agent-runner applySessionEnvFallbacks
  // 映射为 codex config.model_auto_compact_token_limit（对齐上游 flagSettings.autoCompactWindow）。
  const sysSettings = getSystemSettings();
  if (sysSettings.autoCompactWindow > 0) {
    lines.push(`AUTO_COMPACT_WINDOW=${sysSettings.autoCompactWindow}`);
  }
  // SubAgent 模型：仅在显式配置了非默认值时注入（默认 'inherit' 不注入，对齐上游）。
  // 注意：codex 侧当前无消费端——agent TOML 无 model 字段（见 agent-defs.ts 头注释），
  // 子代理模型由 codex 继承主线程决定；注入保留上游 parity，待 codex 支持 per-agent model 时接线。
  if (sysSettings.subagentModel && sysSettings.subagentModel !== 'inherit') {
    lines.push(`SUBAGENT_MODEL=${sysSettings.subagentModel}`);
  }

  // per-user 自定义模型 provider 的 API key：仅当 owner 配了 provider 且有 key 时注入。
  // 与 resolveModelProvider 同门控（provision 写了 [model_providers.<id>] env_key 引用此 env）。
  if (ownerId) {
    const provider = getUserCodexProvider(ownerId);
    if (provider && provider.apiKey) {
      lines.push(`CODEX_CUSTOM_API_KEY=${provider.apiKey}`);
    }
  }
  return lines;
}

// tombstone（happycodex）：上游 prepareHostPlugins（host 模式 plugins 预构建 + command index
// 失效，upstream container-runner.ts:500-516）随 Claude Code plugins 面删除。

export function buildVolumeMounts(
  group: RegisteredGroup,
  isAdminHome: boolean,
  codexHome: string,
  agentId?: string,
  ownerHomeFolder?: string,
  taskRunId?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  // Per-user global memory directory:
  // Each user gets their own user-global/{userId}/ mounted as /workspace/global
  const ownerId = group.created_by;
  if (ownerId) {
    const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
    mkdirForContainer(userGlobalDir);
    mounts.push({
      hostPath: userGlobalDir,
      containerPath: '/workspace/global',
      readonly: !group.is_home,
    });
  } else {
    // Legacy fallback for rows without created_by.
    const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
    mkdirForContainer(legacyGlobalDir);
    mounts.push({
      hostPath: legacyGlobalDir,
      containerPath: '/workspace/global',
      readonly: !isAdminHome,
    });
  }

  if (isAdminHome) {
    // Admin home gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Admin home also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Member home and non-home groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Memory directory: home containers write their own; non-home containers read owner's home memory
  const memoryFolder = group.is_home
    ? group.folder
    : ownerHomeFolder || group.folder;
  const memoryDir = path.join(DATA_DIR, 'memory', memoryFolder);
  mkdirForContainer(memoryDir);
  mounts.push({
    hostPath: memoryDir,
    containerPath: '/workspace/memory',
    readonly: !group.is_home,
  });

  // Per-group codex home（isolated from other groups）— 调用方已 provision（auth 复制 +
  // agents/hooks 物化）。codex 替换：上游此处挂 per-group `.claude` 会话目录到
  // /home/node/.claude；这里换成 per-folder CODEX_HOME → /home/node/.codex
  // （entrypoint.sh export CODEX_HOME=/home/node/.codex）。
  mkdirForContainer(codexHome);
  mounts.push({
    hostPath: codexHome,
    containerPath: '/home/node/.codex',
    readonly: false,
  });

  // tombstone（happycodex）：上游此处的 settings.json 合并写入（ensureSettingsJson）、
  // SDK 遗留 .claude.json 清理、精简版 ~/.claude.json 只读挂载
  // （upstream container-runner.ts:600-637）均为 Claude 配置面，删除；
  // loadUserMcpServers 的注入改在 provisionCodexHome（mcpServers → config.toml）完成。
  // tombstone（happycodex）：上游 Skills 双目录只读挂载（/workspace/project-skills +
  // /workspace/user-skills，claude-context-resolver 提供路径）删除；codex 侧 context 注入
  // 已走 AGENTS.md 路线（per-folder CODEX_HOME/AGENTS.md + config.toml，随 provision 物化）。

  // Per-user feishu-cli OAuth state (token.json + config.yaml).
  // Without this mount, every container restart loses the user's feishu OAuth
  // authorization, forcing re-auth every IDLE_TIMEOUT (#477).
  if (ownerId) {
    const userFeishuCliDir = path.join(
      DATA_DIR,
      'config',
      'user-cli',
      ownerId,
      'feishu-cli',
    );
    mkdirForContainer(userFeishuCliDir);
    mounts.push({
      hostPath: userFeishuCliDir,
      containerPath: '/home/node/.feishu-cli',
      readonly: false,
    });
  }

  // tombstone（happycodex）：上游 Claude Code plugins per-user runtime 只读挂载
  // （materializeUserRuntime + /workspace/plugins，upstream container-runner.ts:701-720）
  // 随 plugins 面删除。

  // Per-group IPC namespace: each group gets its own IPC directory
  // Sub-agents get their own IPC subdirectory under agents/{agentId}/
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  // Use 0o777 so container (node/1000) and host (agent/1002) can both read/write.
  const groupIpcDir = agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', agentId)
    : taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  mkdirForContainer(groupIpcDir);
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  // Use chmod 777 so both host (agent/1002) and container (node/1000) can write
  for (const sub of ['messages', 'tasks', 'input', 'agents'] as const) {
    const subDir = path.join(groupIpcDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    try {
      fs.chmodSync(subDir, 0o777);
    } catch {
      /* ignore if already correct */
    }
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-container environment file (keeps credentials out of process listings)
  // codex 替换：仅 customEnv + 系统设置 + per-user 自定义 provider 的 CODEX_CUSTOM_API_KEY
  // （无 ANTHROPIC_* provider env），见 buildAgentEnvLines。
  const envDir = path.join(DATA_DIR, 'env', group.folder);
  fs.mkdirSync(envDir, { recursive: true });
  const envLines = buildAgentEnvLines(group.folder, ownerId);
  if (envLines.length > 0) {
    const envFilePath = path.join(envDir, 'env');
    const quotedLines = shellQuoteEnvLines(envLines);
    fs.writeFileSync(envFilePath, quotedLines.join('\n') + '\n', {
      mode: 0o600,
    });
    try {
      fs.chmodSync(envFilePath, 0o600);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to enforce env file permissions',
      );
    }
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true,
    });
  }

  // tombstone（happycodex）：上游此处的 .credentials.json 写入（writeCredentialsFile）与
  // 第三方 provider 残留凭据清理（upstream container-runner.ts:791-811）随 provider 面删除。
  // tombstone（happycodex）：上游 agent-runner src 热挂载（/app/src，容器启动时重编译，
  // upstream container-runner.ts:813-825）删除——happycodex 镜像 COPY 编译后的 dist/，
  // 代码变更需重建镜像（见 container/Dockerfile）。
  // tombstone（happycodex）：上游 admin 工作区的 CLAUDE.md / rules / external-skills 只读挂载
  // （claudeContextPlan.isAdminOwned 分支，upstream container-runner.ts:827-852）删除；
  // CLAUDE.md 是只读数据源，codex 侧注入已走 AGENTS.md 路线（buildCodexContextPlan 把
  // admin 全局 CLAUDE.md 内容物化进 per-folder CODEX_HOME/AGENTS.md，经 .codex 挂载进容器）。

  // Per-group persistent extra directory: provides a durable /workspace/extra/ even when
  // no additionalMounts are configured. User-configured additionalMounts from the allowlist
  // are mounted as subdirectories (/workspace/extra/{name}) and overlay on top.
  const extraDir = path.join(DATA_DIR, 'extra', group.folder);
  mkdirForContainer(extraDir);
  mounts.push({
    hostPath: extraDir,
    containerPath: '/workspace/extra',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isAdminHome,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  tz: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Set timezone so container Node.js processes use local time (Asia/Shanghai)
  args.push('-e', `TZ=${tz}`);

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  // 第三参对齐上游 onProcess(proc, containerName, selectedProviderId)；provider pool 已删，
  // happycodex 恒传 null（保留参数位让上游编排层调用形状不变）。
  onProcess: (proc: ChildProcess, containerName: string, selectedProviderId: string | null) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);

  // tombstone（happycodex）：上游此处的 Provider Pool selection（trySelectPoolProvider +
  // resetSession 清会话重绑，upstream container-runner.ts:914-938）随 provider failover 删除。

  // ─── codex 引擎面：per-folder CODEX_HOME provision（auth 复制 + agents/hooks 物化
  //     + context-resolver：AGENTS.md / config.toml fallback / mcp_servers 接线） ───
  let codexHome: string;
  try {
    codexHome = await provisionCodexHome(
      group.folder,
      input.agentId,
      buildCodexHomeContext('container', group, ownerHomeFolder),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { group: group.name, err },
      'Container agent preflight failed: CODEX_HOME provision error',
    );
    return {
      status: 'error',
      result: `容器模式启动失败：CODEX_HOME 准备失败（${message}）`,
      error: message,
    };
  }

  // Determine if this is an admin home container (full privileges)
  const isAdminHome = !!group.is_home && group.folder === 'main';
  const mounts = buildVolumeMounts(
    group,
    isAdminHome,
    codexHome,
    input.agentId,
    ownerHomeFolder,
    input.taskRunId,
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const agentSuffix = input.agentId
    ? `-${input.agentId.replace(/[^a-zA-Z0-9-]/g, '-')}`
    : '';
  const containerName = `happycodex-${safeName}${agentSuffix}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, TIMEZONE);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const result = await new Promise<ContainerOutput>((resolve) => {
    const container = spawn('docker', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName, null);

    const stdoutState = createStdoutParserState();
    const stderrState = createStderrState();

    // Write input and close stdin (容器需要 EOF 来刷新 stdin 管道)
    container.stdin.on('error', (err) => {
      logger.error(
        { group: group.name, err },
        'Container stdin write failed',
      );
      container.kill();
    });
    // 对齐上游就地派生 dockerInput 范式（upstream container-runner.ts:1005-1024）：
    // plugins/contextAudit 注入随 Claude 面删除（tombstone），codex 版派生注入
    // 会话动态上下文 developerInstructions（不 mutate 调用方 input）。
    const dockerInput = deriveInputWithSessionContext('container', group, input);
    container.stdin.write(JSON.stringify(dockerInput));
    container.stdin.end();

    let timedOut = false;
    const timeoutMs =
      group.containerConfig?.timeout || getSystemSettings().containerTimeout;

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      execFile(
        'docker',
        ['stop', containerName],
        { timeout: 15000 },
        (err) => {
          if (err) {
            logger.warn(
              { group: group.name, containerName, err },
              'Graceful stop failed, force killing',
            );
            container.kill('SIGKILL');
          }
        },
      );
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };
    // tombstone（happycodex）：上游 handleOutput 对 output.providerFailure 的限额嗅探 +
    // providerPool.reportFailure + docker stop（upstream container-runner.ts:1060-1088）
    // 随 provider failover 删除；onOutput 直接透传。

    // Attach stdout/stderr handlers using shared parser
    attachStdoutHandler(container.stdout, stdoutState, {
      groupName: group.name,
      label: 'Container',
      ...(onOutput ? { onOutput } : {}),
      resetTimeout,
    });
    attachStderrHandler(container.stderr, stderrState, group.name, {
      container: group.folder,
    });

    container.on('close', (code, signal) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      const closeCtx: CloseHandlerContext = {
        groupName: group.name,
        label: 'Container',
        filePrefix: 'container',
        identifier: containerName,
        logsDir,
        input,
        stdoutState,
        stderrState,
        ...(onOutput ? { onOutput } : {}),
        resolvePromise: resolve,
        startTime,
        timeoutMs,
        extraSummaryLines: [
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
        ],
        extraVerboseLines: [
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts (detailed) ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
        ],
      };

      if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
      const logFile = writeRunLog(closeCtx, code, duration);
      if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
        return;
      handleSuccessClose(closeCtx, duration);
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });

  // tombstone（happycodex）：上游此处的 Provider Pool health reporting（reportSuccess /
  // reportFailure / isApiError 分类）与 finally releaseSession（upstream
  // container-runner.ts:1160-1179）随 provider failover 删除。

  return result;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all tasks, others only see their own
  const filteredTasks = isAdminHome
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  // 删除后重建：容器创建的文件归属 node(1000) 用户，宿主机进程无法覆写
  try {
    fs.unlinkSync(tasksFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only admin home can see all available groups (for activation).
 * Other groups see nothing (they can't activate groups).
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isAdminHome ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  try {
    fs.unlinkSync(groupsFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * 杀死进程及其所有子进程。
 * 如果进程以 detached 模式启动（独立进程组），使用负 PID 杀整个进程组。
 */
export function killProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
      return true;
    }
  } catch {
    try {
      proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Run agent directly on the host machine (no Docker container).
 * Used for host execution mode — the agent gets full access to the host filesystem.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, identifier: string, selectedProviderId: string | null) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  // codex 替换：上游提示 `npm --prefix container/agent-runner install/build`；
  // happycodex 引擎与主项目同仓，产物为 dist/agent-runner.js。
  const setupInstallHint = 'npm install';
  const setupBuildHint = 'npm run build';
  const hostModeSetupError = (message: string): ContainerOutput => ({
    status: 'error',
    result: `宿主机模式启动失败：${message}`,
    error: message,
  });

  // 1. 确定工作目录
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  if (!group.customCwd) {
    fs.mkdirSync(defaultGroupDir, { recursive: true });
    // 确保 group 目录是独立 git root，防止 codex 向上找到父项目的 .git
    const gitDir = path.join(defaultGroupDir, '.git');
    if (!fs.existsSync(gitDir)) {
      try {
        execFileSync('git', ['init'], {
          cwd: defaultGroupDir,
          stdio: 'ignore',
        });
        logger.info(
          { folder: group.folder },
          'Initialized git repository for group',
        );
      } catch (err) {
        // Non-fatal: agent still works, just reports wrong working directory
        logger.warn(
          { folder: group.folder, err },
          'Failed to initialize git repository',
        );
      }
    }
  }
  let groupDir = group.customCwd || defaultGroupDir;
  if (!path.isAbsolute(groupDir)) {
    return hostModeSetupError(`工作目录必须是绝对路径：${groupDir}`);
  }
  // Resolve symlinks to prevent TOCTOU attacks
  try {
    groupDir = fs.realpathSync(groupDir);
  } catch {
    return hostModeSetupError(`工作目录不存在或无法解析：${groupDir}`);
  }
  if (!fs.statSync(groupDir).isDirectory()) {
    return hostModeSetupError(`工作目录不是目录：${groupDir}`);
  }

  // Runtime allowlist validation for custom CWD (defense-in-depth: web.ts validates at creation,
  // but re-check here in case allowlist was tightened or path was injected via DB)
  if (group.customCwd) {
    const allowlist = loadMountAllowlist();
    if (
      allowlist &&
      allowlist.allowedRoots &&
      allowlist.allowedRoots.length > 0
    ) {
      let allowed = false;
      for (const root of allowlist.allowedRoots) {
        const expandedRoot = root.path.startsWith('~')
          ? path.join(
              process.env.HOME || '/Users/user',
              root.path.slice(root.path.startsWith('~/') ? 2 : 1),
            )
          : path.resolve(root.path);

        let realRoot: string;
        try {
          realRoot = fs.realpathSync(expandedRoot);
        } catch {
          continue;
        }

        const relative = path.relative(realRoot, groupDir);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        return hostModeSetupError(
          `工作目录 ${groupDir} 不在允许的根目录下，请检查 mount-allowlist.json`,
        );
      }
    }
  }

  // Always store logs in data/groups/{folder}/logs/, not in customCwd
  const logsBaseDir = path.join(defaultGroupDir, 'logs');
  fs.mkdirSync(logsBaseDir, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'memory', group.folder), {
    recursive: true,
  });

  // 2. 确保目录结构（宿主机模式下限制目录权限）
  // Sub-agents get their own IPC and session directories
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  const groupIpcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', input.agentId)
    : input.taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', input.taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), {
    recursive: true,
    mode: 0o700,
  });
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  fs.mkdirSync(path.join(groupIpcDir, 'agents'), {
    recursive: true,
    mode: 0o700,
  });

  // codex 替换：上游此处建 per-group `.claude` 会话目录 + symlink ~/.claude.json +
  // ensureSettingsJson + claude-context 三件套同步（buildClaudeContextPlan/syncHostClaudeContext，
  // upstream container-runner.ts:1413-1450）。codex 侧由 FsCodexHomeProvisioner 完成
  // per-folder CODEX_HOME 隔离（auth 复制 + agents/hooks 物化），context-resolver 三通道
  // （AGENTS.md / config.toml fallback / mcp_servers）随 provision 一并物化。
  let codexHome: string;
  try {
    codexHome = await provisionCodexHome(
      group.folder,
      input.agentId,
      buildCodexHomeContext('host', group, ownerHomeFolder),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { group: group.name, err },
      'Host agent preflight failed: CODEX_HOME provision error',
    );
    return hostModeSetupError(`CODEX_HOME 准备失败（${message}）`);
  }

  // 5. 构建环境变量
  const hostEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  // Strip macOS launch-context vars that must not be inherited by child
  // processes. When the service is started by a background process manager
  // (pm2 / launchd / ssh / cron) outside a normal login session, XPC_FLAGS=0x2
  // leaks into the environment and can break XPC-dependent network stacks in
  // child processes（上游为 claude CLI 的 CFNetwork 解析故障；对 codex 同样无意义，
  // 直接剥离，no-op on non-macOS）。
  delete hostEnv['XPC_FLAGS'];

  // tombstone（happycodex）：上游此处的 Provider Pool selection（host 模式 trySelectPoolProvider +
  // resetSession 清会话，upstream container-runner.ts:1469-1493）随 provider failover 删除。

  // 配置层环境变量（codex 替换：仅 customEnv + 系统设置 + per-user 自定义 provider 的
  // CODEX_CUSTOM_API_KEY，无 ANTHROPIC_* provider 行）。host 模式直接进 hostEnv 对象
  // （无 shell 解析），apiKey 含特殊字符不破坏。
  const envLines = buildAgentEnvLines(group.folder, group.created_by);
  for (const line of envLines) {
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      hostEnv[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
    }
  }

  // tombstone（happycodex）：上游此处的第三方 provider 处理（ANTHROPIC_BASE_URL → 删
  // ANTHROPIC_AUTH_TOKEN、剥 oauthAccount、删 .credentials.json）与 OAuth 凭据写入
  // （writeCredentialsFile，upstream container-runner.ts:1509-1561）随 provider 面删除。
  // 注：AUTO_COMPACT_WINDOW / SUBAGENT_MODEL 已并入 buildAgentEnvLines（对齐上游语义）。

  // admin 主容器 + 系统设置 disableMemoryLayerForAdminHost 时禁用自带记忆层：
  // 不注入 WORKSPACE_GLOBAL/MEMORY env（工具层的 memory 路径仍由 agent-runner 默认解析）。
  // 仅作用于 admin 主容器（is_home=1, folder=main），不影响 admin 创建的其他子群组。
  const isCreatorAdmin = ownerHomeFolder === 'main';
  const disableMemoryLayer =
    isCreatorAdmin &&
    !!group.is_home &&
    getSystemSettings().disableMemoryLayerForAdminHost;

  // 路径映射（env 名与语义严格对齐上游：HAPPYCLAW_WORKSPACE_* 均为 per-folder 路径）
  hostEnv['HAPPYCLAW_WORKSPACE_GROUP'] = groupDir;
  hostEnv['HAPPYCLAW_WORKSPACE_IPC'] = groupIpcDir;

  if (!disableMemoryLayer) {
    // Per-user global memory（自带 memory 层）
    const ownerId = group.created_by;
    if (ownerId) {
      const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
      fs.mkdirSync(userGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = userGlobalDir;
    } else {
      const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
      fs.mkdirSync(legacyGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = legacyGlobalDir;
    }
    const memoryFolder = group.is_home
      ? group.folder
      : ownerHomeFolder || group.folder;
    hostEnv['HAPPYCLAW_WORKSPACE_MEMORY'] = path.join(
      DATA_DIR,
      'memory',
      memoryFolder,
    );
  }

  // Resolve symlinks so CODEX_HOME ends up as the real on-disk path.
  // （上游对 CLAUDE_CONFIG_DIR 做同样处理，upstream container-runner.ts:1609-1618。）
  let resolvedCodexHome = codexHome;
  try {
    resolvedCodexHome = fs.realpathSync(codexHome);
  } catch {
    // Path may not exist yet on first spawn; fall back to the literal path.
  }
  hostEnv['CODEX_HOME'] = resolvedCodexHome;

  if (disableMemoryLayer) {
    hostEnv['HAPPYCLAW_DISABLE_MEMORY_LAYER'] = 'true';
    // tombstone（happycodex）：上游此分支的 REQUIRED_SETTINGS_ENV 直注 + per-user MCP servers
    // env 透传（HAPPYCLAW_USER_MCP_SERVERS_JSON，upstream container-runner.ts:1622-1631）
    // 为 Claude settings/MCP 面，删除。
  }
  // tombstone（happycodex）：上游 DEBUG_CLAUDE_AGENT_SDK=1 / IS_SANDBOX=1
  // （Claude SDK/CLI 专属开关，upstream container-runner.ts:1632-1638）删除。

  // 5b. codex 引擎预检：codex 二进制可达（PATH 前置其所在目录，对齐上游 claude 二进制
  // PATH 前置语义，upstream container-runner.ts:1640-1659；agent-capabilities 不搬）。
  const runnerCmdOverride = process.env.HAPPYCODEX_RUNNER_CMD;
  const resolvedCodexBin = resolveBinaryOnPath(
    'codex',
    hostEnv['PATH'] || process.env.PATH,
  );
  if (resolvedCodexBin) {
    const resolvedCodexDir = path.dirname(resolvedCodexBin);
    const currentPath = hostEnv['PATH'] || process.env.PATH || '';
    hostEnv['PATH'] = `${resolvedCodexDir}:${currentPath}`;
    logger.info(
      { group: group.name, resolvedCodexDir, resolvedPath: resolvedCodexBin },
      'Host preflight: codex binary resolved',
    );
  } else if (!runnerCmdOverride) {
    logger.error(
      { group: group.name },
      'Host agent preflight failed: codex binary not found on PATH',
    );
    return hostModeSetupError(
      'codex CLI 不在 PATH 中。请先安装（npm i -g @openai/codex）并执行 codex login',
    );
  } else {
    // dev/test override：fake runner 不依赖 codex，仅记 warn。
    logger.warn(
      { group: group.name },
      'codex binary not found on PATH (HAPPYCODEX_RUNNER_CMD override set, continuing)',
    );
  }

  // 6. 编译检查（codex 替换：上游校验 container/agent-runner 的 SDK 依赖 + dist；
  //    happycodex 校验本仓 dist/agent-runner.js，HAPPYCODEX_RUNNER_CMD 覆盖时跳过）
  const projectRoot = process.cwd();
  const agentRunnerDist = path.join(projectRoot, 'dist', 'agent-runner.js');
  if (!runnerCmdOverride) {
    if (!fs.existsSync(agentRunnerDist)) {
      logger.error(
        { group: group.name, agentRunnerDist },
        'Host agent preflight failed: dist not found',
      );
      return hostModeSetupError(
        `引擎未编译（缺 ${agentRunnerDist}）。请先执行：${setupBuildHint}`,
      );
    }

    // Auto-rebuild if dist is stale (src newer than dist)
    try {
      const distMtime = fs.statSync(agentRunnerDist).mtimeMs;
      const srcDir = path.join(projectRoot, 'src');
      const srcFiles = (
        fs.readdirSync(srcDir, { recursive: true }) as string[]
      ).filter((f) => f.endsWith('.ts'));
      const newestSrc = Math.max(
        ...srcFiles.map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs),
      );
      if (newestSrc > distMtime) {
        logger.info(
          { group: group.name },
          'agent-runner dist 已过期，自动重新编译...',
        );
        try {
          const { execSync } = await import('child_process');
          execSync('npm run build', {
            cwd: projectRoot,
            stdio: 'pipe',
            timeout: 60_000,
          });
          logger.info({ group: group.name }, 'agent-runner 自动编译完成');
        } catch (buildErr) {
          logger.warn(
            { group: group.name, err: buildErr },
            `agent-runner 自动编译失败，使用旧版 dist。手动执行：${setupBuildHint}`,
          );
        }
      }
    } catch {
      // Best effort, don't block execution
    }
  }

  logger.info(
    {
      group: group.name,
      workingDir: groupDir,
      isMain: input.isMain,
    },
    'Spawning host agent',
  );

  const logsDir = logsBaseDir;

  const hostResult = await new Promise<ContainerOutput>((resolve) => {
    let settled = false;
    const resolveOnce = (output: ContainerOutput): void => {
      if (settled) return;
      settled = true;
      resolve(output);
    };

    // 7. 启动进程
    // Resolve absolute node path: bare 'node' fails with ENOENT under
    // PM2 / launchd / GUI launchers where PATH lacks nvm/fnm dirs.
    // HAPPYCODEX_RUNNER_CMD 覆盖（dev：`tsx src/agent-runner.ts`；测试：fake runner 脚本）。
    let spawnCmd: string;
    let spawnArgs: string[];
    if (runnerCmdOverride) {
      const parts = runnerCmdOverride.split(/\s+/).filter(Boolean);
      spawnCmd = parts[0] ?? 'node';
      spawnArgs = parts.slice(1);
    } else {
      spawnCmd = resolveHostNodeBinary(hostEnv);
      spawnArgs = [agentRunnerDist];
    }
    const proc = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: hostEnv,
      cwd: groupDir,
      detached: true,
    });

    const processId = `host-${group.folder}-${Date.now()}`;
    onProcess(proc, processId, null);

    const stdoutState = createStdoutParserState();
    const stderrState = createStderrState();

    // 8. stdin 输入
    proc.stdin.on('error', (err) => {
      logger.error(
        { group: group.name, err },
        'Host agent stdin write failed',
      );
      killProcessTree(proc);
    });
    // 对齐上游就地派生 hostInput 范式（upstream container-runner.ts:1776-1780）：
    // prepareHostPlugins/contextAudit 注入随 Claude 面删除（tombstone），codex 版派生注入
    // 系统提示词分片 + 会话动态上下文 developerInstructions（不 mutate 调用方 input）。
    // disableMemoryLayer 与上文 HAPPYCLAW_DISABLE_MEMORY_LAYER env 同源同值；
    // workspaceGlobalDir 取 env 段算出的真实 user-global 路径（禁用记忆层时本就无 memory 分片）。
    const hostInput = deriveInputWithSessionContext('host', group, input, {
      disableMemoryLayer,
      ...(hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL']
        ? { workspaceGlobalDir: hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] }
        : {}),
    });
    proc.stdin.write(JSON.stringify(hostInput));
    proc.stdin.end();

    // 9. 超时管理
    let timedOut = false;
    const timeoutMs =
      group.containerConfig?.timeout || getSystemSettings().containerTimeout;

    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processId },
        'Host agent timeout, killing',
      );
      killProcessTree(proc, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          killProcessTree(proc, 'SIGKILL');
        }
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };
    // tombstone（happycodex）：上游 handleOutput 的 providerFailure 嗅探 + reportFailure +
    // killProcessTree（upstream container-runner.ts:1811-1831）随 provider failover 删除。

    // 10. stdout/stderr 解析
    attachStdoutHandler(proc.stdout, stdoutState, {
      groupName: group.name,
      label: 'Host agent',
      ...(onOutput ? { onOutput } : {}),
      resetTimeout,
    });
    attachStderrHandler(proc.stderr, stderrState, group.name, {
      host: group.folder,
    });

    // 11. close 事件处理
    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const duration = Date.now() - startTime;

      const closeCtx: CloseHandlerContext = {
        groupName: group.name,
        label: 'Host Agent',
        filePrefix: 'host',
        identifier: processId,
        logsDir,
        input,
        stdoutState,
        stderrState,
        ...(onOutput ? { onOutput } : {}),
        resolvePromise: resolveOnce,
        startTime,
        timeoutMs,
        extraSummaryLines: [`Working Directory: ${groupDir}`],
        enrichError: (stderrContent, exitLabel) => {
          const missingPackageMatch = stderrContent.match(
            /Cannot find package '([^']+)' imported from/u,
          );
          const userFacingError = missingPackageMatch
            ? `宿主机模式启动失败：缺少依赖 ${missingPackageMatch[1]}。请先执行：${setupInstallHint}`
            : null;
          return {
            result: userFacingError,
            error: `Host agent exited with ${exitLabel}: ${stderrContent.slice(-200)}`,
          };
        },
      };

      if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
      const logFile = writeRunLog(closeCtx, code, duration);
      if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
        return;
      handleSuccessClose(closeCtx, duration);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processId, error: err },
        'Host agent spawn error',
      );
      resolveOnce({
        status: 'error',
        result: null,
        error: `Host agent spawn error: ${err.message}`,
      });
    });
  });

  // tombstone（happycodex）：上游此处的 Provider Pool health reporting（host 模式）与
  // finally releaseSession（upstream container-runner.ts:1899-1924）随 provider failover 删除。

  return hostResult;
}
