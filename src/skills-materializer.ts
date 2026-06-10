/**
 * skills-materializer —— 四源技能发现 + 群组工作区物化 + AGENTS.md 技能索引（codex 版）。
 *
 * 上游对应：upstream-happyclaw/src/claude-context-resolver.ts 的四源 skills 目录
 * （builtinSkillsDir / externalSkillsDir / projectSkillsDir / userSkillsDir，
 * buildClaudeContextPlan:108-116）+ syncHostClaudeContext 的 symlink 农场
 * （linkEntries 顺序 builtin → external → project → user，同名后者覆盖前者，:219-230）。
 *
 * 引擎面整体替换（codex 无 Claude 的 SKILL.md 发现 / Skill 工具 / --plugin-dir 机制）：
 *   - 上游把技能 symlink 进 Claude 发现目录（容器 entrypoint 链到 ~/.claude/skills、
 *     host 链到 {sessions}/skills），SDK 启动期解析 frontmatter 注入 system prompt；
 *   - codex 版把技能**文件复制**物化到群组工作区 `{groupDir}/.skills/{id}/`（cwd 链内、
 *     容器经 /workspace/group 挂载可见——symlink 跨挂载会悬空，故用复制），并在生成的
 *     per-folder CODEX_HOME/AGENTS.md 写技能索引（名称/何时用/入口路径，经
 *     claude-context-resolver.buildCodexContextPlan 的 skillsIndex 通道），让模型按需
 *     `cat` 入口文件——对齐 codex 的文件感知习惯。
 *
 * 四源（与上游一一对应；同名后者胜出，顺序同上游 linkEntries）：
 *   builtin  : {dataDir}/builtin-skills            （上游 host 同路径；容器侧上游用镜像内
 *                                                    /opt/builtin-skills——codex 版物化发生在
 *                                                    宿主侧 spawn 前，两种模式统一读宿主目录）
 *   external : {externalClaudeDir}/skills           （仅 admin-owned 群组，上游同判定）
 *   project  : {projectRoot}/container/skills       （随仓库 port 的 3 个技能）
 *   user     : {dataDir}/skills/{ownerId}           （install_skill / uninstall_skill 工具与
 *                                                    routes/skills.ts 的落盘端即此目录；安装后
 *                                                    下次 spawn 物化生效，对齐工具描述
 *                                                    「安装后将在后续会话中可用」）
 *
 * 边界：
 *   - 物化目标恒为受管群组工作区 {GROUPS_DIR}/{folder}/.skills（绝不写 customCwd——那是
 *     用户自有目录）；customCwd 场景索引中的绝对入口路径仍可达。
 *   - 仅物化启用技能（含 SKILL.md；SKILL.md.disabled 跳过并从工作区清除）。
 *   - manifest（.happycodex-skills.json）记录受管技能 id：源消失/禁用时只清除受管目录，
 *     用户手工放进 .skills/ 的目录不动（与 AGENTS.md generated-marker 同精神）。
 *   - 幂等：文件内容未变不重写；无技能时不创建 .skills/。
 */
import fs from 'fs';
import path from 'path';

import { isAdminOwnedGroup } from './claude-context-resolver.js';
import { logger } from './logger.js';
import { parseFrontmatter, validateSkillId } from './skill-utils.js';
import type { RegisteredGroup } from './types.js';

/** 群组工作区内的技能物化目录名（cwd 链内，容器侧路径 /workspace/group/.skills）。 */
export const WORKSPACE_SKILLS_DIRNAME = '.skills';

/** 受管技能清单文件（位于 .skills/ 内）：区分 happycodex 物化目录与用户手工目录。 */
export const SKILLS_MANIFEST_FILE = '.happycodex-skills.json';

/** 容器模式下群组工作区的挂载点（container-runner buildVolumeMounts 固定值）。 */
const CONTAINER_GROUP_DIR = '/workspace/group';

export type SkillSourceName = 'builtin' | 'external' | 'project' | 'user';

export interface MaterializeSkillsArgs {
  executionMode: 'host' | 'container';
  group: RegisteredGroup;
  /** 群组 owner 的主容器 folder（admin 为 'main'）——external 源的 admin-owned 判定。 */
  ownerHomeFolder?: string | undefined;
  /** admin 全局 ~/.claude 等价目录（只读数据源）。 */
  externalClaudeDir: string;
  /** 运行时数据根（builtin-skills/ 与 skills/{ownerId}/ 在其下）。 */
  dataDir: string;
  /** 项目根（container/skills 在其下）。 */
  projectRoot: string;
  /** 受管群组工作区绝对路径（{GROUPS_DIR}/{folder}；物化目标，绝不传 customCwd）。 */
  groupDir: string;
}

export interface MaterializedSkill {
  /** 技能目录名（= 上游 skill id）。 */
  id: string;
  /** frontmatter name（缺省回退 id）。 */
  name: string;
  /** frontmatter description（「何时用」语义来源）。 */
  description: string;
  source: SkillSourceName;
  /** 索引中展示的入口路径：container → /workspace/group/.skills/…，host → 宿主绝对路径。 */
  entryPath: string;
}

export interface MaterializeSkillsResult {
  /** 本次物化（或确认已就位）的技能，按 id 排序。 */
  skills: MaterializedSkill[];
  /** 被清除的受管技能 id（源消失/禁用）。 */
  removed: string[];
  warnings: string[];
}

interface SkillsManifest {
  version: 1;
  managed: string[];
}

interface SkillCandidate {
  id: string;
  source: SkillSourceName;
  dir: string;
}

/** 安全 stat（穿透 symlink）；失败返回 null（悬空链接等）。 */
function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** 扫描单个源目录下的启用技能（含 SKILL.md 的子目录；同名由调用方后者覆盖）。 */
function scanSource(rootDir: string, source: SkillSourceName): SkillCandidate[] {
  const out: SkillCandidate[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out; // 源目录不存在/不可读：跳过（上游 linkEntries 同语义）。
  }
  for (const entry of entries) {
    if (!validateSkillId(entry.name)) continue; // 路径安全：仅 [\w-]+ 目录名
    const dir = path.join(rootDir, entry.name);
    const st = statOrNull(dir);
    if (!st || !st.isDirectory()) continue;
    if (!statOrNull(path.join(dir, 'SKILL.md'))?.isFile()) continue; // 禁用/无入口 → 跳过
    out.push({ id: entry.name, source, dir });
  }
  return out;
}

/**
 * 递归同步 src → dest（内容比对幂等：未变不重写；dest 多余条目清除；跳过 .git）。
 * 穿透 symlink（跨挂载 symlink 在容器内会悬空，故物化为实体文件）。
 */
function syncDir(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const keep = new Set<string>();

  for (const entry of srcEntries) {
    if (entry.name === '.git') continue;
    const srcPath = path.join(srcDir, entry.name);
    const st = statOrNull(srcPath);
    if (!st) continue; // 悬空 symlink 等
    const destPath = path.join(destDir, entry.name);
    if (st.isDirectory()) {
      const destSt = statOrNull(destPath);
      if (destSt && !destSt.isDirectory()) fs.rmSync(destPath, { force: true });
      syncDir(srcPath, destPath);
      keep.add(entry.name);
    } else if (st.isFile()) {
      const content = fs.readFileSync(srcPath);
      const destSt = statOrNull(destPath);
      if (destSt?.isDirectory()) fs.rmSync(destPath, { recursive: true, force: true });
      const same =
        destSt?.isFile() &&
        destSt.size === content.byteLength &&
        fs.readFileSync(destPath).equals(content);
      if (!same) fs.writeFileSync(destPath, content);
      keep.add(entry.name);
    }
    // 其他类型（socket/fifo）不物化。
  }

  // 清除 dest 中源里已不存在的条目（保持镜像同步）。
  for (const entry of fs.readdirSync(destDir)) {
    if (!keep.has(entry)) {
      fs.rmSync(path.join(destDir, entry), { recursive: true, force: true });
    }
  }
}

function readManifest(skillsDir: string): SkillsManifest {
  try {
    const raw = fs.readFileSync(path.join(skillsDir, SKILLS_MANIFEST_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { managed?: unknown }).managed)
    ) {
      const managed = ((parsed as { managed: unknown[] }).managed).filter(
        (id): id is string => typeof id === 'string' && validateSkillId(id),
      );
      return { version: 1, managed };
    }
  } catch {
    // 不存在/损坏 → 视为空 manifest
  }
  return { version: 1, managed: [] };
}

function writeManifestIfChanged(skillsDir: string, prev: SkillsManifest, managed: string[]): void {
  const next = [...managed].sort();
  const prevSorted = [...prev.managed].sort();
  if (next.length === prevSorted.length && next.every((id, i) => id === prevSorted[i])) return;
  const manifest: SkillsManifest = { version: 1, managed: next };
  fs.writeFileSync(
    path.join(skillsDir, SKILLS_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

/**
 * 四源发现 + 物化到 {groupDir}/.skills/（幂等；best-effort，单个技能失败不影响其余）。
 */
export function materializeGroupSkills(args: MaterializeSkillsArgs): MaterializeSkillsResult {
  const warnings: string[] = [];
  const isAdminOwned = isAdminOwnedGroup(args.group, args.ownerHomeFolder);
  const ownerId = args.group.created_by;

  // 四源（顺序对齐上游 linkEntries：builtin → external → project → user，同名后者胜出）。
  const sources: Array<{ root: string; name: SkillSourceName }> = [
    { root: path.join(args.dataDir, 'builtin-skills'), name: 'builtin' },
    ...(isAdminOwned
      ? [{ root: path.join(args.externalClaudeDir, 'skills'), name: 'external' as const }]
      : []),
    { root: path.join(args.projectRoot, 'container', 'skills'), name: 'project' },
    ...(ownerId ? [{ root: path.join(args.dataDir, 'skills', ownerId), name: 'user' as const }] : []),
  ];

  const candidates = new Map<string, SkillCandidate>();
  for (const { root, name } of sources) {
    for (const candidate of scanSource(root, name)) {
      candidates.set(candidate.id, candidate); // 后者覆盖前者
    }
  }

  const skillsDir = path.join(args.groupDir, WORKSPACE_SKILLS_DIRNAME);
  const prevManifest = readManifest(skillsDir);
  const skills: MaterializedSkill[] = [];
  const materializedIds: string[] = [];

  if (candidates.size > 0) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  for (const candidate of [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      syncDir(candidate.dir, path.join(skillsDir, candidate.id));
      const frontmatter = parseFrontmatter(
        fs.readFileSync(path.join(candidate.dir, 'SKILL.md'), 'utf-8'),
      );
      const entryBase =
        args.executionMode === 'container' ? CONTAINER_GROUP_DIR : args.groupDir;
      skills.push({
        id: candidate.id,
        name: frontmatter.name || candidate.id,
        description: frontmatter.description || '',
        source: candidate.source,
        entryPath: path.join(entryBase, WORKSPACE_SKILLS_DIRNAME, candidate.id, 'SKILL.md'),
      });
      materializedIds.push(candidate.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`技能物化失败（${candidate.id}）: ${message}`);
      logger.warn(
        { skillId: candidate.id, sourceDir: candidate.dir, err },
        'Skill materialization failed',
      );
    }
  }

  // 清除受管但已消失/禁用的技能目录（用户手工目录不在 manifest，不动）。
  const removed: string[] = [];
  const current = new Set(materializedIds);
  for (const id of prevManifest.managed) {
    if (current.has(id)) continue;
    const dir = path.join(skillsDir, id);
    if (statOrNull(dir)?.isDirectory()) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    removed.push(id);
  }

  // manifest 收尾：有受管技能则更新；全部清空且目录已空则连 manifest/.skills 一并移除。
  if (materializedIds.length > 0) {
    writeManifestIfChanged(skillsDir, prevManifest, materializedIds);
  } else if (statOrNull(skillsDir)?.isDirectory()) {
    fs.rmSync(path.join(skillsDir, SKILLS_MANIFEST_FILE), { force: true });
    if (fs.readdirSync(skillsDir).length === 0) {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
  }

  return { skills, removed, warnings };
}

/**
 * 生成 AGENTS.md 的「可用技能」索引节（名称/何时用/入口路径）。
 * 无技能返回 null（调用方据此跳过 skillsIndex 通道）。
 */
export function buildSkillsIndexSection(skills: MaterializedSkill[]): string | null {
  if (skills.length === 0) return null;
  const lines = skills.map(
    (skill) =>
      `- **${skill.name}**（入口：\`${skill.entryPath}\`）${
        skill.description ? `：${skill.description}` : ''
      }`,
  );
  return [
    '## 可用技能（happycodex 物化到工作区 .skills/，勿在此回写）',
    '',
    '需要某项技能时，先读取其入口 SKILL.md（如 `cat <入口路径>`），再按其中流程执行。不要假设未列出的技能存在。',
    '',
    ...lines,
  ].join('\n');
}
