/**
 * claude-context-resolver（codex 版）。
 *
 * 文件名保持上游镜像（upstream-happyclaw/src/claude-context-resolver.ts），便于日后
 * 人工同步时 diff 上游同名文件直接定位到本文件评估语义迁移——这是仓库级约定
 * （container-runner.ts / web.ts 等引擎面整体替换的文件均保留上游名）。
 *
 * 引擎面整体替换（Claude → codex），通道映射依 AGENTS.md PoC 实测结论
 * （src/poc/poc-agentsmd.ts）：
 *
 *   上游（Claude SDK）                          → happycodex（codex）
 *   ───────────────────────────────────────────────────────────────────────
 *   ① 用户/全局维度：admin 全局 ~/.claude/CLAUDE.md  → 生成内容物化进 per-folder
 *      symlink/挂载 + user-global CLAUDE.md extraDirs  CODEX_HOME/AGENTS.md（全局注入：
 *                                                      对该 home 所有 thread 生效、
 *                                                      不污染工作区；经
 *                                                      FsCodexHomeProvisioner 幂等物化）
 *   ② 项目维度：工作区 CLAUDE.md 由 Claude CLI     → per-folder CODEX_HOME/config.toml 写
 *      自动加载                                       project_doc_fallback_filenames=
 *                                                      ["CLAUDE.md"]，codex 零拷贝直读
 *                                                      群组工作区 CLAUDE.md 原文
 *                                                      （目录已有 AGENTS.md 自动让位）
 *   ③ 会话动态上下文（机器信息/用户态/每会话段）   → ContainerInput.developerInstructions
 *                                                      透传链（container-runner →
 *                                                      agent-runner → ThreadSessionConfig.
 *                                                      developerInstructions；叠加生效且
 *                                                      冲突时胜出，"动态覆盖静态"）
 *
 * 红线（用户决策）：
 *   - CLAUDE.md 是只读数据源——本模块**绝不改写/生成/删除任何 CLAUDE.md 本体**，
 *     写入面仅 per-folder CODEX_HOME 的 AGENTS.md + config.toml。
 *   - 永不生成 AGENTS.override.md（PoC 结论 ⑤）。
 *   - 注入边界（PoC 结论 ④）：codex 单文件读取上限 project_doc_max_bytes（默认 32KiB），
 *     生成的 AGENTS.md 超限时在此预裁剪并日志（codex 侧静默截断不可观测）。
 *
 * tombstone（happycodex）：上游 buildClaudeContextPlan / syncHostClaudeContext 的
 * rules/skills symlink 农场、/workspace/CLAUDE.md 挂载计划、ClaudeContextAudit
 * （contextAudit StreamEvent，冻结契约无此事件）均为 Claude 引擎面，整段删除；
 * 本模块以 buildCodexContextPlan（①②）+ buildSessionDeveloperInstructions（③）替代。
 * admin 全局 rules/ 目录不再注入（32KiB 预算内放不下且 codex 无 rules 语义），
 * AGENTS.md 中仅留目录路径提示（host 模式 agent 可按需自行读取）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getChannelFromJid } from './channel-prefixes.js';
import { logger } from './logger.js';
import {
  AGENTS_MD_GENERATED_MARKER,
} from './runtime/multitenant/codex-home.js';
import type { RegisteredGroup } from './types.js';

/** 与上游一致：admin 主容器 folder。 */
const ADMIN_HOME_FOLDER = 'main';

/**
 * 容器模式下 user-global 记忆的容器内路径（与 container-runner.ts buildVolumeMounts
 * 的 containerPath '/workspace/global' 挂载点对齐）。AGENTS.md 的记忆写回指引必须
 * 指向容器内可达路径——宿主机路径在容器内不存在。
 */
const CONTAINER_USER_GLOBAL_CLAUDE_MD = '/workspace/global/CLAUDE.md';

/**
 * codex 的 project_doc_max_bytes 默认值（PoC 结论 ④：单文件 32KiB 上限）。
 * 物化的 AGENTS.md（含 generated marker 行）超过该值会被 codex 静默截断，
 * 因此在生成侧预裁剪并日志。
 */
export const AGENTS_MD_MAX_BYTES = 32 * 1024;

/** 项目维度 fallback 文件名（PoC 结论 ②：codex 零拷贝直读工作区 CLAUDE.md）。 */
export const PROJECT_DOC_FALLBACK_FILENAMES: readonly string[] = ['CLAUDE.md'];

export interface CodexContextPlanArgs {
  executionMode: 'host' | 'container';
  group: RegisteredGroup;
  /** 群组 owner 的主容器 folder（admin 为 'main'）。 */
  ownerHomeFolder?: string | undefined;
  /** admin 全局 ~/.claude 等价目录（getEffectiveExternalDir()，只读数据源）。 */
  externalClaudeDir: string;
  /** data/groups 根（user-global/{userId}/CLAUDE.md 用户全局记忆源，只读数据源）。 */
  groupsDir: string;
  /**
   * 技能索引（skills-materializer 产物）：section 为完整 Markdown 节（名称/何时用/入口
   * 路径），skillsDir 为工作区 .skills 目录（审计 sourcePath）。缺省/null = 无技能不注入。
   */
  skillsIndex?: { section: string; skillsDir: string } | null | undefined;
}

/** AGENTS.md 单个内容源的审计条目（替代上游 ClaudeContextAudit 的轻量版）。 */
export interface CodexAgentsMdSource {
  name: 'admin-global-claude-md' | 'user-global-claude-md' | 'skills-index';
  sourcePath: string;
  /** 源文件原始字节数。 */
  bytes: number;
  /** 是否因 32KiB 预算被裁剪（含整段被挤掉的情况）。 */
  truncated: boolean;
}

export interface CodexContextPlan {
  executionMode: 'host' | 'container';
  isAdminOwned: boolean;
  /**
   * 物化进 {CODEX_HOME}/AGENTS.md 的内容（不含 generated marker 行，由
   * FsCodexHomeProvisioner 添加）。null = 本组无用户/全局上下文源 →
   * provisioner 清除此前生成的 marker 文件（用户手工接管的文件不动）。
   */
  agentsMd: string | null;
  agentsMdSources: CodexAgentsMdSource[];
  /** 项目维度：写进 per-folder config.toml 的 project_doc_fallback_filenames。 */
  projectDocFallbackFilenames: readonly string[];
  warnings: string[];
}

/** 安全读文本文件：不存在/读失败返回 null。 */
function readTextIfExists(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * UTF-8 字节级截断：保证结果 ≤ maxBytes 且不在多字节序列中间切断。
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // 回退跳过 UTF-8 continuation bytes（0b10xxxxxx），避免切出半个字符。
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

const TRUNCATION_NOTICE = '\n\n[happycodex] 内容超出 32KiB（project_doc_max_bytes）上限，已截断。';

/** 上游同款 admin-owned 判定（upstream claude-context-resolver.ts:101-104）；
 *  skills-materializer 的 external 源共用此单一真相。 */
export function isAdminOwnedGroup(
  group: RegisteredGroup,
  ownerHomeFolder?: string | undefined,
): boolean {
  return (
    ownerHomeFolder === ADMIN_HOME_FOLDER ||
    (!!group.is_home && group.folder === ADMIN_HOME_FOLDER)
  );
}

/**
 * 构建 codex 上下文计划：①用户/全局维度 → AGENTS.md 内容；②项目维度 → fallback 键。
 *
 * 内容源（与上游 user-level 注入面一一对应）：
 *   - admin-owned 群组（owner 主容器为 main，对齐上游 isAdminOwned 判定）：
 *     externalClaudeDir/CLAUDE.md（上游 host symlink / container 挂 /workspace/CLAUDE.md）。
 *   - is_home 群组：user-global/{ownerId}/CLAUDE.md（上游经 SDK extraDirs 注入；
 *     非 home 群组上游也不注入 system prompt，仅留文件系统访问——此处对齐不注入）。
 *   - 技能索引（skillsIndex 通道，所有群组）：上游经 SDK skills:'all' 把 frontmatter 注入
 *     system prompt；codex 等价为 AGENTS.md 索引 + 工作区 .skills/ 按需读取。
 */
export function buildCodexContextPlan(args: CodexContextPlanArgs): CodexContextPlan {
  const ownerId = args.group.created_by;
  const isAdminOwned = isAdminOwnedGroup(args.group, args.ownerHomeFolder);

  const warnings: string[] = [];
  const sources: CodexAgentsMdSource[] = [];
  const sections: Array<{ source: CodexAgentsMdSource; text: string }> = [];

  // ① admin 全局指令（只读源：externalClaudeDir/CLAUDE.md）
  if (isAdminOwned) {
    const adminClaudeMdPath = path.join(args.externalClaudeDir, 'CLAUDE.md');
    const adminClaudeMd = readTextIfExists(adminClaudeMdPath);
    if (adminClaudeMd !== null) {
      const source: CodexAgentsMdSource = {
        name: 'admin-global-claude-md',
        sourcePath: adminClaudeMdPath,
        bytes: Buffer.byteLength(adminClaudeMd, 'utf8'),
        truncated: false,
      };
      const rulesDir = path.join(args.externalClaudeDir, 'rules');
      // rules 提示仅 host 模式输出：容器未挂载 rules 目录（上游 ro-mount 随
      // Claude 引擎面 tombstone 删除），容器内给出宿主机死路径有害无益。
      const rulesHint =
        args.executionMode === 'host' && fs.existsSync(rulesDir)
          ? `\n\n（补充规则目录：${rulesDir}/ —— 涉及对应主题时按需读取其中的 *.md）`
          : '';
      sections.push({
        source,
        text: `## 管理员全局指令（源：${adminClaudeMdPath}，happycodex 物化，勿在此回写）\n\n${adminClaudeMd.trimEnd()}${rulesHint}`,
      });
      sources.push(source);
    } else {
      warnings.push('CLAUDE.md missing'); // 对齐上游 warning 文案
    }
  }

  // ② 用户全局记忆（只读源：user-global/{ownerId}/CLAUDE.md，仅 home 群组注入）
  if (args.group.is_home && ownerId) {
    const userGlobalPath = path.join(args.groupsDir, 'user-global', ownerId, 'CLAUDE.md');
    const userGlobal = readTextIfExists(userGlobalPath);
    if (userGlobal !== null) {
      const source: CodexAgentsMdSource = {
        name: 'user-global-claude-md',
        sourcePath: userGlobalPath,
        bytes: Buffer.byteLength(userGlobal, 'utf8'),
        truncated: false,
      };
      // 展示路径按执行模式切换：容器内宿主机路径不可达，写回指引指向 /workspace/global
      // 挂载点（②段仅 is_home 群组物化，而 /workspace/global 恰在 is_home 时可写，口径自洽）；
      // 审计条目 source.sourcePath 保留真实宿主机路径（host 侧读取/追溯用）。
      const displayPath =
        args.executionMode === 'container'
          ? CONTAINER_USER_GLOBAL_CLAUDE_MD
          : userGlobalPath;
      sections.push({
        source,
        text: `## 用户全局记忆（源：${displayPath}，happycodex 物化；更新记忆请写回该源文件，勿改本文件）\n\n${userGlobal.trimEnd()}`,
      });
      sources.push(source);
    }
  }

  // ③ 技能索引（skills-materializer 产物；置于用户/全局上下文之后，预算挤占时先裁此节）
  if (args.skillsIndex?.section) {
    const source: CodexAgentsMdSource = {
      name: 'skills-index',
      sourcePath: args.skillsIndex.skillsDir,
      bytes: Buffer.byteLength(args.skillsIndex.section, 'utf8'),
      truncated: false,
    };
    sections.push({ source, text: args.skillsIndex.section.trimEnd() });
    sources.push(source);
  }

  // 组装 + 32KiB 预算裁剪（预算扣除 provisioner 添加的 marker 行 + 收尾换行）。
  let agentsMd: string | null = null;
  if (sections.length > 0) {
    const overhead = Buffer.byteLength(AGENTS_MD_GENERATED_MARKER, 'utf8') + 3; // marker + '\n\n' + 末尾 '\n'
    let remaining = AGENTS_MD_MAX_BYTES - overhead;
    const assembled: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      const { source, text } = sections[i]!;
      const joiner = assembled.length > 0 ? 2 : 0; // '\n\n'
      const budget = remaining - joiner;
      const textBytes = Buffer.byteLength(text, 'utf8');
      if (textBytes <= budget) {
        assembled.push(text);
        remaining = budget - textBytes;
        continue;
      }
      // 超限：裁剪本段（预留截断提示空间），其后段落整体放弃。
      source.truncated = true;
      const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
      const cut = truncateUtf8(text, Math.max(0, budget - noticeBytes));
      if (cut.length > 0) assembled.push(`${cut}${TRUNCATION_NOTICE}`);
      warnings.push(`AGENTS.md 超出 ${AGENTS_MD_MAX_BYTES} 字节上限，已裁剪（${source.name}）`);
      logger.warn(
        {
          folder: args.group.folder,
          source: source.name,
          sourcePath: source.sourcePath,
          sourceBytes: source.bytes,
          maxBytes: AGENTS_MD_MAX_BYTES,
        },
        'AGENTS.md content exceeds project_doc_max_bytes budget, truncated',
      );
      // 标记其余未放入的段。
      for (const rest of sections.slice(i + 1)) {
        rest.source.truncated = true;
        warnings.push(`AGENTS.md 预算耗尽，整段未注入（${rest.source.name}）`);
      }
      break;
    }
    agentsMd = assembled.join('\n\n');
  }

  // ② 项目维度观测：codex 经 project_doc_fallback_filenames 直读工作区 CLAUDE.md，
  // 超 project_doc_max_bytes（默认 32KiB）时 codex 静默截断尾部——此处只 stat 预警，
  // 不读不写不裁剪（CLAUDE.md 只读红线）。预警锚点跟随 codex 实际 cwd：host 模式
  // customCwd 群组直读 {customCwd}/CLAUDE.md，其余为受管工作区 {groupsDir}/{folder}
  // （customCwd 仅宿主机模式语义，container 模式恒挂载受管工作区）。
  try {
    const workspaceDir =
      args.executionMode === 'host' && args.group.customCwd
        ? args.group.customCwd
        : path.join(args.groupsDir, args.group.folder);
    const workspaceClaudeMd = path.join(workspaceDir, 'CLAUDE.md');
    const st = fs.statSync(workspaceClaudeMd);
    if (st.size > AGENTS_MD_MAX_BYTES) {
      warnings.push(
        `工作区 CLAUDE.md 超出 ${AGENTS_MD_MAX_BYTES} 字节（project_doc_max_bytes），codex 将静默截断尾部（${workspaceClaudeMd}）`,
      );
      logger.warn(
        {
          folder: args.group.folder,
          sourcePath: workspaceClaudeMd,
          sourceBytes: st.size,
          maxBytes: AGENTS_MD_MAX_BYTES,
        },
        'workspace CLAUDE.md exceeds project_doc_max_bytes, codex will silently truncate the tail',
      );
    }
  } catch {
    // 文件不存在/不可读：正常情况，无需告警。
  }

  return {
    executionMode: args.executionMode,
    isAdminOwned,
    agentsMd,
    agentsMdSources: sources,
    projectDocFallbackFilenames: PROJECT_DOC_FALLBACK_FILENAMES,
    warnings,
  };
}

// ───────────────────────── ③ 会话动态上下文（developerInstructions） ─────────────────────────

/** 会话动态上下文输入（ContainerInput 的结构子集——避免与 container-runner 循环 import）。 */
export interface SessionContextInput {
  chatJid: string;
  isScheduledTask?: boolean | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
}

export interface SessionDeveloperInstructionsArgs {
  executionMode: 'host' | 'container';
  group: RegisteredGroup;
  input: SessionContextInput;
  /** 调度时区（config.TIMEZONE）。 */
  timezone: string;
  /** 测试注入用当前时刻；缺省 new Date()。 */
  now?: Date;
}

/**
 * 构建每会话注入的 developerInstructions 段（机器信息 + 用户态 + 会话场景）。
 * 经 ContainerInput.developerInstructions 透传到 thread/start.developerInstructions
 * （PoC 结论 ③：与静态 AGENTS.md 叠加生效，冲突时动态侧胜出）。
 */
export function buildSessionDeveloperInstructions(
  args: SessionDeveloperInstructionsArgs,
): string {
  const now = args.now ?? new Date();
  const channel = getChannelFromJid(args.input.chatJid);
  const lines: string[] = [
    `- 当前时间: ${now.toISOString()}（时区 ${args.timezone}）`,
    `- 主机: ${os.hostname()}（${os.platform()}/${os.arch()}，${
      args.executionMode === 'host' ? '宿主机进程模式' : 'Docker 容器模式'
    }）`,
    `- 工作区: ${args.group.name}（folder: ${args.group.folder}）`,
    `- 会话渠道: ${channel}`,
  ];
  if (args.group.created_by) {
    lines.push(`- 工作区所有者用户ID: ${args.group.created_by}`);
  }
  if (args.input.isScheduledTask) {
    lines.push('- 运行场景: 定时任务（无人值守，结果经 send_message/通知渠道送达）');
  }
  if (args.input.agentId) {
    lines.push(
      `- 子代理会话: ${args.input.agentName || args.input.agentId}（id: ${args.input.agentId}）`,
    );
  }
  return [
    '<happycodex-session-context>',
    '以下为本次会话的动态上下文（与全局/项目文档冲突时以本节为准）：',
    ...lines,
    '</happycodex-session-context>',
  ].join('\n');
}
