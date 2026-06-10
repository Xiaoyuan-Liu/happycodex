/**
 * claude-context-resolver（codex 版）测试。
 *
 * 上游 tests/claude-context-resolver.test.ts（symlink 农场 / mounted/linked/shadowed
 * 审计）绑定已删除的 Claude 引擎面，不搬（tombstone）。本文件为 codex 版三通道的行为网：
 *   ① 用户/全局维度 → buildCodexContextPlan 产出 AGENTS.md 内容（admin 全局 CLAUDE.md +
 *      user-global 记忆，只读源；32KiB 预算裁剪）；
 *   ② 项目维度 → project_doc_fallback_filenames=["CLAUDE.md"]，经 FsCodexHomeProvisioner
 *      幂等写入 per-folder config.toml 顶部；
 *   ③ 会话动态上下文 → buildSessionDeveloperInstructions 段。
 * 以及 FsCodexHomeProvisioner 的 AGENTS.md 物化幂等语义（marker 接管 / 用户接管 / 清除）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  AGENTS_MD_MAX_BYTES,
  buildCodexContextPlan,
  buildSessionDeveloperInstructions,
  truncateUtf8,
} from '../src/claude-context-resolver.js';
import {
  AGENTS_MD_GENERATED_MARKER,
  FsCodexHomeProvisioner,
} from '../src/runtime/multitenant/codex-home.js';
import type { RegisteredGroup } from '../src/types.js';

function writeFile(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fakeGroup(
  folder: string,
  ownerId: string | undefined,
  isHome = false,
): RegisteredGroup {
  return {
    name: folder,
    folder,
    added_at: '2026-06-10T00:00:00.000Z',
    ...(ownerId ? { created_by: ownerId } : {}),
    is_home: isHome,
  };
}

let tmp: string;
let external: string;
let groupsDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-context-'));
  external = path.join(tmp, 'external-claude');
  groupsDir = path.join(tmp, 'data', 'groups');
  fs.mkdirSync(external, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function planFor(
  group: RegisteredGroup,
  ownerHomeFolder?: string,
  executionMode: 'host' | 'container' = 'host',
) {
  return buildCodexContextPlan({
    executionMode,
    group,
    ownerHomeFolder,
    externalClaudeDir: external,
    groupsDir,
  });
}

// ─── ① 用户/全局维度 → AGENTS.md 内容 ────────────────────────────────

describe('buildCodexContextPlan（AGENTS.md 内容生成）', () => {
  test('admin home：注入 admin 全局 CLAUDE.md + 用户全局记忆，带源路径标注', () => {
    writeFile(path.join(external, 'CLAUDE.md'), '# admin playbook\n规则A');
    writeFile(path.join(external, 'rules', 'browser.md'), '# rule');
    writeFile(path.join(groupsDir, 'user-global', 'admin', 'CLAUDE.md'), '# 用户记忆\n偏好B');

    const plan = planFor(fakeGroup('main', 'admin', true), 'main');

    expect(plan.isAdminOwned).toBe(true);
    expect(plan.agentsMd).not.toBeNull();
    expect(plan.agentsMd).toContain('# admin playbook');
    expect(plan.agentsMd).toContain('# 用户记忆');
    // 源路径标注（人/agent 可追溯到只读源）
    expect(plan.agentsMd).toContain(path.join(external, 'CLAUDE.md'));
    expect(plan.agentsMd).toContain(
      path.join(groupsDir, 'user-global', 'admin', 'CLAUDE.md'),
    );
    // rules 目录提示（不内联，只留路径）
    expect(plan.agentsMd).toContain(path.join(external, 'rules'));
    expect(plan.agentsMdSources.map((s) => s.name)).toEqual([
      'admin-global-claude-md',
      'user-global-claude-md',
    ]);
    expect(plan.agentsMdSources.every((s) => !s.truncated)).toBe(true);
    expect(plan.projectDocFallbackFilenames).toEqual(['CLAUDE.md']);
  });

  test('member home：只注入自己的 user-global 记忆，无 admin 段', () => {
    writeFile(path.join(external, 'CLAUDE.md'), '# admin secrets');
    writeFile(path.join(groupsDir, 'user-global', 'u1', 'CLAUDE.md'), '# u1 记忆');

    const plan = planFor(fakeGroup('home-u1', 'u1', true), 'home-u1');

    expect(plan.isAdminOwned).toBe(false);
    expect(plan.agentsMd).toContain('# u1 记忆');
    expect(plan.agentsMd).not.toContain('# admin secrets');
    expect(plan.agentsMdSources.map((s) => s.name)).toEqual(['user-global-claude-md']);
  });

  test('非 home 群组：user-global 不注入（对齐上游非 home 不进 system prompt）', () => {
    writeFile(path.join(groupsDir, 'user-global', 'u1', 'CLAUDE.md'), '# u1 记忆');

    const plan = planFor(fakeGroup('ws-x', 'u1', false), 'home-u1');

    expect(plan.agentsMd).toBeNull();
    expect(plan.agentsMdSources).toEqual([]);
  });

  test('admin-owned 非 home 群组：仍注入 admin 全局指令（ownerHomeFolder=main 判定）', () => {
    writeFile(path.join(external, 'CLAUDE.md'), '# admin playbook');

    const plan = planFor(fakeGroup('ws-admin', 'admin', false), 'main');

    expect(plan.isAdminOwned).toBe(true);
    expect(plan.agentsMd).toContain('# admin playbook');
  });

  test('admin 全局 CLAUDE.md 缺失：warning 对齐上游文案，agentsMd 为 null', () => {
    const plan = planFor(fakeGroup('main', 'admin', true), 'main');

    expect(plan.warnings).toContain('CLAUDE.md missing');
    expect(plan.agentsMd).toBeNull();
  });

  test('32KiB 预算：超限段被裁剪并标记 truncated + warning，总量不破上限', () => {
    // user-global 记忆远超 32KiB（中文多字节，验证 UTF-8 安全截断）
    const big = '# 用户记忆\n' + '记忆条目甲乙丙丁。'.repeat(8 * 1024);
    writeFile(path.join(groupsDir, 'user-global', 'u1', 'CLAUDE.md'), big);

    const plan = planFor(fakeGroup('home-u1', 'u1', true), 'home-u1');

    expect(plan.agentsMd).not.toBeNull();
    const finalFile = `${AGENTS_MD_GENERATED_MARKER}\n\n${plan.agentsMd!}\n`;
    expect(Buffer.byteLength(finalFile, 'utf8')).toBeLessThanOrEqual(AGENTS_MD_MAX_BYTES);
    expect(plan.agentsMd).toContain('已截断');
    const src = plan.agentsMdSources[0]!;
    expect(src.truncated).toBe(true);
    expect(src.bytes).toBe(Buffer.byteLength(big, 'utf8'));
    expect(plan.warnings.some((w) => w.includes('已裁剪'))).toBe(true);
    // 无 U+FFFD（未切断多字节序列）
    expect(plan.agentsMd).not.toContain('�');
  });

  test('预算被前段耗尽时后段整体放弃并标记 truncated', () => {
    writeFile(path.join(external, 'CLAUDE.md'), 'A'.repeat(AGENTS_MD_MAX_BYTES));
    writeFile(path.join(groupsDir, 'user-global', 'admin', 'CLAUDE.md'), '# 用户记忆');

    const plan = planFor(fakeGroup('main', 'admin', true), 'main');

    expect(plan.agentsMd).not.toContain('# 用户记忆');
    expect(plan.agentsMdSources.find((s) => s.name === 'user-global-claude-md')!.truncated).toBe(
      true,
    );
    expect(plan.warnings.some((w) => w.includes('整段未注入'))).toBe(true);
  });

  test('plan 构建是只读的：绝不改写/生成/删除 CLAUDE.md 本体', () => {
    const adminMd = path.join(external, 'CLAUDE.md');
    const userMd = path.join(groupsDir, 'user-global', 'admin', 'CLAUDE.md');
    writeFile(adminMd, '# admin');
    writeFile(userMd, '# user');
    const before = [fs.readFileSync(adminMd, 'utf8'), fs.readFileSync(userMd, 'utf8')];

    planFor(fakeGroup('main', 'admin', true), 'main');

    expect(fs.readFileSync(adminMd, 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(userMd, 'utf8')).toBe(before[1]);
  });
});

describe('truncateUtf8', () => {
  test('不在多字节序列中间切断', () => {
    const s = '汉字串'; // 每字 3 字节
    expect(truncateUtf8(s, 4)).toBe('汉'); // 4 字节预算 → 回退到 3 字节边界
    expect(truncateUtf8(s, 6)).toBe('汉字');
    expect(truncateUtf8(s, 100)).toBe(s);
    expect(truncateUtf8(s, 0)).toBe('');
  });
});

// ─── AGENTS.md / config.toml 物化（FsCodexHomeProvisioner 幂等语义） ───

describe('FsCodexHomeProvisioner（AGENTS.md + project_doc_fallback 物化）', () => {
  let dataDir: string;
  let sharedHome: string;

  beforeEach(() => {
    dataDir = path.join(tmp, 'data');
    sharedHome = path.join(tmp, 'shared-codex-home');
    fs.mkdirSync(sharedHome, { recursive: true });
    fs.writeFileSync(path.join(sharedHome, 'auth.json'), '{"fake":"auth"}\n');
  });

  function makeProvisioner(opts: {
    agentsMd?: string | null;
    projectDocFallbackFilenames?: readonly string[];
  }) {
    return new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome: sharedHome,
      ...opts,
    });
  }

  test('物化 AGENTS.md：marker 首行 + 内容；内容变化时重生成', async () => {
    const home = await makeProvisioner({ agentsMd: '# v1 上下文' }).provision('g1');
    const agentsMdPath = path.join(home, 'AGENTS.md');
    const v1 = fs.readFileSync(agentsMdPath, 'utf8');
    expect(v1.startsWith(AGENTS_MD_GENERATED_MARKER)).toBe(true);
    expect(v1).toContain('# v1 上下文');

    // 同内容 re-provision → 文件内容不变（幂等）
    await makeProvisioner({ agentsMd: '# v1 上下文' }).provision('g1');
    expect(fs.readFileSync(agentsMdPath, 'utf8')).toBe(v1);

    // 投影源演进 → 重生成
    await makeProvisioner({ agentsMd: '# v2 上下文' }).provision('g1');
    const v2 = fs.readFileSync(agentsMdPath, 'utf8');
    expect(v2).toContain('# v2 上下文');
    expect(v2).not.toContain('# v1 上下文');
  });

  test('用户手工接管（无 marker）：不覆盖、不删除', async () => {
    const home = await makeProvisioner({ agentsMd: '# 投影' }).provision('g2');
    const agentsMdPath = path.join(home, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, '# 我自己的 AGENTS.md\n');

    await makeProvisioner({ agentsMd: '# 投影新版' }).provision('g2');
    expect(fs.readFileSync(agentsMdPath, 'utf8')).toBe('# 我自己的 AGENTS.md\n');

    await makeProvisioner({ agentsMd: null }).provision('g2');
    expect(fs.existsSync(agentsMdPath)).toBe(true); // 用户文件不删
  });

  test('agentsMd=null：清除旧投影（marker 文件）；undefined：不触碰', async () => {
    const home = await makeProvisioner({ agentsMd: '# 投影' }).provision('g3');
    const agentsMdPath = path.join(home, 'AGENTS.md');
    expect(fs.existsSync(agentsMdPath)).toBe(true);

    // undefined（不传）→ 不触碰
    await makeProvisioner({}).provision('g3');
    expect(fs.existsSync(agentsMdPath)).toBe(true);

    // null → 源消失，清除陈旧投影
    await makeProvisioner({ agentsMd: null }).provision('g3');
    expect(fs.existsSync(agentsMdPath)).toBe(false);
  });

  test('project_doc_fallback_filenames：写在 config.toml 最前（TOML 顶层键约束）且幂等', async () => {
    // 共享 home 带既有 config.toml（含表头段），验证键插在表头之前
    fs.writeFileSync(
      path.join(sharedHome, 'config.toml'),
      '[features]\nhooks = false\n',
    );
    const provision = () =>
      makeProvisioner({ projectDocFallbackFilenames: ['CLAUDE.md'] }).provision('g4');

    const home = await provision();
    const configPath = path.join(home, 'config.toml');
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content.startsWith('project_doc_fallback_filenames = ["CLAUDE.md"]\n')).toBe(true);
    expect(content).toContain('[features]');

    // 幂等：再 provision 不重复写
    await provision();
    const again = fs.readFileSync(configPath, 'utf8');
    expect(again.match(/project_doc_fallback_filenames/g)).toHaveLength(1);
  });

  test('per-folder 已有 project_doc_fallback_filenames（本地修改）→ 不动', async () => {
    const home = await makeProvisioner({}).provision('g5');
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, 'project_doc_fallback_filenames = ["NOTES.md"]\n');

    await makeProvisioner({ projectDocFallbackFilenames: ['CLAUDE.md'] }).provision('g5');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(
      'project_doc_fallback_filenames = ["NOTES.md"]\n',
    );
  });

  test('物化绝不生成 AGENTS.override.md / CLAUDE.md（PoC 红线）', async () => {
    const home = await makeProvisioner({
      agentsMd: '# 投影',
      projectDocFallbackFilenames: ['CLAUDE.md'],
    }).provision('g6');
    expect(fs.existsSync(path.join(home, 'AGENTS.override.md'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'CLAUDE.md'))).toBe(false);
  });
});

// ─── ③ 会话动态上下文（developerInstructions） ───────────────────────

describe('buildSessionDeveloperInstructions', () => {
  const now = new Date('2026-06-10T08:30:00.000Z');

  test('基础段：时间/时区/主机/模式/工作区/渠道/owner', () => {
    const text = buildSessionDeveloperInstructions({
      executionMode: 'host',
      group: fakeGroup('home-u1', 'u1', true),
      input: { chatJid: 'feishu:oc_abc' },
      timezone: 'Asia/Shanghai',
      now,
    });
    expect(text).toContain('<happycodex-session-context>');
    expect(text).toContain('</happycodex-session-context>');
    expect(text).toContain('2026-06-10T08:30:00.000Z');
    expect(text).toContain('Asia/Shanghai');
    expect(text).toContain('宿主机进程模式');
    expect(text).toContain('folder: home-u1');
    expect(text).toContain('会话渠道: feishu');
    expect(text).toContain('工作区所有者用户ID: u1');
    expect(text).not.toContain('定时任务');
    expect(text).not.toContain('子代理');
  });

  test('container 模式 + web 渠道 + 定时任务 + 子代理段', () => {
    const text = buildSessionDeveloperInstructions({
      executionMode: 'container',
      group: fakeGroup('task-abc', 'u1', false),
      input: {
        chatJid: 'web:task-abc',
        isScheduledTask: true,
        agentId: 'a1',
        agentName: 'researcher',
      },
      timezone: 'UTC',
      now,
    });
    expect(text).toContain('Docker 容器模式');
    expect(text).toContain('会话渠道: web');
    expect(text).toContain('运行场景: 定时任务');
    expect(text).toContain('子代理会话: researcher（id: a1）');
  });
});

// ─── skillsIndex 通道（skills-materializer 索引并入 AGENTS.md） ──────────

describe('buildCodexContextPlan（skillsIndex 通道）', () => {
  const SKILLS_SECTION =
    '## 可用技能（happycodex 物化到工作区 .skills/，勿在此回写）\n\n- **agent-browser**（入口：`/g/.skills/agent-browser/SKILL.md`）：浏览器自动化';

  function planWithSkills(group: RegisteredGroup, ownerHomeFolder?: string, section = SKILLS_SECTION) {
    return buildCodexContextPlan({
      executionMode: 'host',
      group,
      ownerHomeFolder,
      externalClaudeDir: external,
      groupsDir,
      skillsIndex: { section, skillsDir: '/g/.skills' },
    });
  }

  test('索引节追加在用户/全局段之后，源记为 skills-index', () => {
    writeFile(path.join(groupsDir, 'user-global', 'u1', 'CLAUDE.md'), '# u1 记忆');

    const plan = planWithSkills(fakeGroup('home-u1', 'u1', true), 'home-u1');

    expect(plan.agentsMd).toContain('## 可用技能');
    expect(plan.agentsMd!.indexOf('# u1 记忆')).toBeLessThan(
      plan.agentsMd!.indexOf('## 可用技能'),
    );
    expect(plan.agentsMdSources.map((s) => s.name)).toEqual([
      'user-global-claude-md',
      'skills-index',
    ]);
    const skillsSource = plan.agentsMdSources.find((s) => s.name === 'skills-index')!;
    expect(skillsSource.sourcePath).toBe('/g/.skills');
    expect(skillsSource.truncated).toBe(false);
  });

  test('仅有技能索引（非 home 非 admin 群组）：agentsMd 不为 null，只含索引节', () => {
    const plan = planWithSkills(fakeGroup('ws-x', 'u1', false), 'home-u1');

    expect(plan.agentsMd).not.toBeNull();
    expect(plan.agentsMd).toContain('agent-browser');
    expect(plan.agentsMdSources.map((s) => s.name)).toEqual(['skills-index']);
  });

  test('skillsIndex 缺省/null：行为与未接技能时完全一致（agentsMd null）', () => {
    const plan = buildCodexContextPlan({
      executionMode: 'host',
      group: fakeGroup('ws-x', 'u1', false),
      ownerHomeFolder: 'home-u1',
      externalClaudeDir: external,
      groupsDir,
      skillsIndex: null,
    });
    expect(plan.agentsMd).toBeNull();
    expect(plan.agentsMdSources).toEqual([]);
  });

  test('32KiB 预算：索引节超限被裁剪并标记 truncated + warning，总量不破上限', () => {
    const hugeSection =
      '## 可用技能\n\n' + '- **技能甲**（入口：`/g/.skills/甲/SKILL.md`）：描述。\n'.repeat(2048);
    const plan = planWithSkills(fakeGroup('ws-x', 'u1', false), 'home-u1', hugeSection);

    const finalFile = `${AGENTS_MD_GENERATED_MARKER}\n\n${plan.agentsMd!}\n`;
    expect(Buffer.byteLength(finalFile, 'utf8')).toBeLessThanOrEqual(AGENTS_MD_MAX_BYTES);
    expect(plan.agentsMd).toContain('已截断');
    expect(plan.agentsMdSources.find((s) => s.name === 'skills-index')!.truncated).toBe(true);
    expect(plan.warnings.some((w) => w.includes('skills-index'))).toBe(true);
    expect(plan.agentsMd).not.toContain('�');
  });

  test('预算被用户/全局段耗尽时索引节整段放弃并标记 truncated', () => {
    writeFile(path.join(groupsDir, 'user-global', 'u1', 'CLAUDE.md'), 'A'.repeat(AGENTS_MD_MAX_BYTES));

    const plan = planWithSkills(fakeGroup('home-u1', 'u1', true), 'home-u1');

    expect(plan.agentsMd).not.toContain('## 可用技能');
    expect(plan.agentsMdSources.find((s) => s.name === 'skills-index')!.truncated).toBe(true);
    expect(plan.warnings.some((w) => w.includes('整段未注入（skills-index）'))).toBe(true);
  });
});
