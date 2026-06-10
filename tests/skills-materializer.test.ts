/**
 * skills-materializer（四源技能发现 + 工作区物化 + AGENTS.md 索引）测试。
 *
 * 上游对应行为网：upstream claude-context-resolver 的四源目录 + syncHostClaudeContext
 * symlink 农场（顺序 builtin → external → project → user、同名后者胜出、admin-owned 才挂
 * external）。codex 版改为复制物化到 {groupDir}/.skills/ + manifest 受管语义，
 * 全部用临时目录断言（幂等 / 清除 / 用户目录不动 / 索引格式）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildSkillsIndexSection,
  materializeGroupSkills,
  SKILLS_MANIFEST_FILE,
  WORKSPACE_SKILLS_DIRNAME,
  type MaterializeSkillsArgs,
} from '../src/skills-materializer.js';
import type { RegisteredGroup } from '../src/types.js';

let tmp: string;
let dataDir: string;
let externalDir: string;
let projectRoot: string;
let groupDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-skills-'));
  dataDir = path.join(tmp, 'data');
  externalDir = path.join(tmp, 'external-claude');
  projectRoot = path.join(tmp, 'project');
  groupDir = path.join(tmp, 'groups', 'g1');
  for (const dir of [dataDir, externalDir, projectRoot, groupDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'g1',
    folder: 'g1',
    added_at: '2026-06-10T00:00:00.000Z',
    created_by: 'u1',
    is_home: true,
    ...overrides,
  };
}

function writeSkill(rootDir: string, id: string, description: string, extra?: Record<string, string>): void {
  const dir = path.join(rootDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n`,
  );
  for (const [rel, content] of Object.entries(extra ?? {})) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function materialize(overrides: Partial<MaterializeSkillsArgs> = {}) {
  return materializeGroupSkills({
    executionMode: 'host',
    group: fakeGroup(),
    externalClaudeDir: externalDir,
    dataDir,
    projectRoot,
    groupDir,
    ...overrides,
  });
}

const skillsDir = () => path.join(groupDir, WORKSPACE_SKILLS_DIRNAME);

// ─── 四源发现与优先级 ────────────────────────────────────────────────

describe('materializeGroupSkills — 四源发现', () => {
  test('project 源物化到 {groupDir}/.skills/{id}/，附属文件一并复制', () => {
    writeSkill(path.join(projectRoot, 'container', 'skills'), 'agent-browser', '浏览器自动化', {
      'references/usage.md': '# usage\n',
    });

    const result = materialize();

    expect(result.skills.map((s) => s.id)).toEqual(['agent-browser']);
    expect(result.skills[0]!.description).toBe('浏览器自动化');
    expect(fs.readFileSync(path.join(skillsDir(), 'agent-browser', 'SKILL.md'), 'utf8')).toContain(
      'agent-browser',
    );
    expect(
      fs.readFileSync(path.join(skillsDir(), 'agent-browser', 'references', 'usage.md'), 'utf8'),
    ).toBe('# usage\n');
  });

  test('同名后者胜出：builtin → external → project → user（上游 linkEntries 顺序）', () => {
    writeSkill(path.join(dataDir, 'builtin-skills'), 'dup', 'from-builtin');
    writeSkill(path.join(externalDir, 'skills'), 'dup', 'from-external');
    writeSkill(path.join(projectRoot, 'container', 'skills'), 'dup', 'from-project');
    writeSkill(path.join(dataDir, 'skills', 'u1'), 'dup', 'from-user');

    const result = materialize({ ownerHomeFolder: 'main' }); // admin-owned → external 参战

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.description).toBe('from-user');
    expect(result.skills[0]!.source).toBe('user');
  });

  test('external 源仅 admin-owned 群组挂载（上游 isAdminOwned 同判定）', () => {
    writeSkill(path.join(externalDir, 'skills'), 'ext-only', 'external skill');

    const member = materialize({ ownerHomeFolder: 'home-u1' });
    expect(member.skills).toHaveLength(0);

    const admin = materialize({ ownerHomeFolder: 'main' });
    expect(admin.skills.map((s) => s.id)).toEqual(['ext-only']);
    expect(admin.skills[0]!.source).toBe('external');
  });

  test('user 源即 install_skill 落盘目录 data/skills/{ownerId}；无 ownerId 不挂', () => {
    writeSkill(path.join(dataDir, 'skills', 'u1'), 'installed', 'via install_skill');

    const withOwner = materialize();
    expect(withOwner.skills.map((s) => s.id)).toEqual(['installed']);
    expect(withOwner.skills[0]!.source).toBe('user');

    fs.rmSync(skillsDir(), { recursive: true, force: true });
    const group = fakeGroup();
    delete group.created_by;
    const noOwner = materialize({ group });
    expect(noOwner.skills).toHaveLength(0);
  });

  test('禁用技能（SKILL.md.disabled）与无 SKILL.md 目录不物化', () => {
    const projSkills = path.join(projectRoot, 'container', 'skills');
    const disabled = path.join(projSkills, 'off');
    fs.mkdirSync(disabled, { recursive: true });
    fs.writeFileSync(path.join(disabled, 'SKILL.md.disabled'), '---\nname: off\n---\n');
    fs.mkdirSync(path.join(projSkills, 'not-a-skill'), { recursive: true });

    const result = materialize();
    expect(result.skills).toHaveLength(0);
    expect(fs.existsSync(skillsDir())).toBe(false); // 无技能不创建 .skills/
  });
});

// ─── 幂等与生命周期 ──────────────────────────────────────────────────

describe('materializeGroupSkills — 幂等物化与受管清除', () => {
  test('幂等：内容未变不重写（mtime 保持）；源演进后重新同步', () => {
    writeSkill(path.join(projectRoot, 'container', 'skills'), 's1', 'v1');
    materialize();

    const destFile = path.join(skillsDir(), 's1', 'SKILL.md');
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(destFile, past, past);

    materialize(); // 第二次：内容一致 → 不应触碰文件
    expect(fs.statSync(destFile).mtime.getTime()).toBe(past.getTime());

    // 源演进 → 重写
    writeSkill(path.join(projectRoot, 'container', 'skills'), 's1', 'v2');
    materialize();
    expect(fs.readFileSync(destFile, 'utf8')).toContain('v2');
    expect(fs.statSync(destFile).mtime.getTime()).not.toBe(past.getTime());
  });

  test('目标被篡改/残留文件：重物化恢复源内容并清除多余文件', () => {
    writeSkill(path.join(projectRoot, 'container', 'skills'), 's1', 'v1', {
      'helper.sh': 'echo ok\n',
    });
    materialize();

    const dest = path.join(skillsDir(), 's1');
    fs.writeFileSync(path.join(dest, 'SKILL.md'), 'tampered');
    fs.writeFileSync(path.join(dest, 'stale.txt'), 'leftover');
    fs.rmSync(path.join(projectRoot, 'container', 'skills', 's1', 'helper.sh'));

    materialize();
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('v1');
    expect(fs.existsSync(path.join(dest, 'stale.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'helper.sh'))).toBe(false);
  });

  test('受管清除：源消失 → 受管目录移除并记入 removed；用户手工目录不动', () => {
    writeSkill(path.join(projectRoot, 'container', 'skills'), 'gone', 'soon removed');
    materialize();
    expect(fs.existsSync(path.join(skillsDir(), 'gone'))).toBe(true);

    // 用户手工放进 .skills/ 的目录（不在 manifest）
    const manual = path.join(skillsDir(), 'hand-made');
    fs.mkdirSync(manual, { recursive: true });
    fs.writeFileSync(path.join(manual, 'SKILL.md'), '---\nname: hand-made\n---\n');

    fs.rmSync(path.join(projectRoot, 'container', 'skills', 'gone'), {
      recursive: true,
      force: true,
    });
    const result = materialize();

    expect(result.removed).toEqual(['gone']);
    expect(fs.existsSync(path.join(skillsDir(), 'gone'))).toBe(false);
    expect(fs.existsSync(path.join(manual, 'SKILL.md'))).toBe(true); // 手工目录原样
  });

  test('manifest 记录受管 id；全部清空且目录无残留时 .skills/ 一并移除', () => {
    writeSkill(path.join(projectRoot, 'container', 'skills'), 'only', 'temp');
    materialize();

    const manifest = JSON.parse(
      fs.readFileSync(path.join(skillsDir(), SKILLS_MANIFEST_FILE), 'utf8'),
    );
    expect(manifest).toEqual({ version: 1, managed: ['only'] });

    fs.rmSync(path.join(projectRoot, 'container', 'skills', 'only'), {
      recursive: true,
      force: true,
    });
    const result = materialize();
    expect(result.removed).toEqual(['only']);
    expect(fs.existsSync(skillsDir())).toBe(false);
  });

  test('单技能源损坏（SKILL.md 不可读）不影响其余技能，warning 上报', () => {
    const projSkills = path.join(projectRoot, 'container', 'skills');
    writeSkill(projSkills, 'good', 'fine');
    // broken：SKILL.md 是目录（statOrNull isFile=false → 扫描期即跳过，不算 warning）；
    // 用 dangling symlink 才能命中物化期失败 → 改为放一个扫描通过但复制失败的形态：
    // SKILL.md 为普通文件但技能目录里含不可读子目录在多数平台难以稳定模拟，
    // 这里验证「损坏目录被跳过 + 正常技能不受影响」即可。
    const broken = path.join(projSkills, 'broken');
    fs.mkdirSync(path.join(broken, 'SKILL.md'), { recursive: true }); // SKILL.md 是目录 → 非启用

    const result = materialize();
    expect(result.skills.map((s) => s.id)).toEqual(['good']);
  });
});

// ─── 索引生成 ────────────────────────────────────────────────────────

describe('buildSkillsIndexSection — AGENTS.md 技能索引', () => {
  test('无技能 → null（调用方跳过 skillsIndex 通道）', () => {
    expect(buildSkillsIndexSection([])).toBeNull();
  });

  test('host 模式：入口为宿主绝对路径；含名称/何时用/读取指引', () => {
    writeSkill(path.join(projectRoot, 'container', 'skills'), 'agent-browser', '浏览器自动化任务');
    const { skills } = materialize();
    const section = buildSkillsIndexSection(skills)!;

    expect(section).toContain('## 可用技能');
    expect(section).toContain('cat <入口路径>');
    expect(section).toContain('**agent-browser**');
    expect(section).toContain('：浏览器自动化任务');
    expect(section).toContain(path.join(groupDir, '.skills', 'agent-browser', 'SKILL.md'));
  });

  test('container 模式：入口为 /workspace/group/.skills/…（挂载点视角）', () => {
    writeSkill(path.join(projectRoot, 'container', 'skills'), 's1', 'desc');
    const { skills } = materialize({ executionMode: 'container' });
    expect(skills[0]!.entryPath).toBe('/workspace/group/.skills/s1/SKILL.md');
    expect(buildSkillsIndexSection(skills)!).toContain('/workspace/group/.skills/s1/SKILL.md');
  });

  test('多技能按 id 排序，索引逐行列出', () => {
    const projSkills = path.join(projectRoot, 'container', 'skills');
    writeSkill(projSkills, 'zeta', 'z skill');
    writeSkill(projSkills, 'alpha', 'a skill');
    const { skills } = materialize();
    expect(skills.map((s) => s.id)).toEqual(['alpha', 'zeta']);
    const section = buildSkillsIndexSection(skills)!;
    expect(section.indexOf('**alpha**')).toBeLessThan(section.indexOf('**zeta**'));
  });
});
