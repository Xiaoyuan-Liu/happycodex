/**
 * routes/skills.ts 落盘端 ↔ skills-materializer 用户源 布局契约测试
 * —— 修复轮 finding #9（重判为 RESOLVED-BY-MERGE 后的回归钉子）。
 *
 * 契约：routes/skills.ts（getUserSkillsDir = {DATA_DIR}/skills/{userId}）安装的
 * 用户级技能，必须被 skills-materializer 的 user 源（{dataDir}/skills/{ownerId}）
 * 在下一次 spawn 时发现并物化到 {groupDir}/.skills/——这是「安装后将在后续会话
 * 中可用」工具描述成立的承重路径。禁用（SKILL.md.disabled）必须不被物化。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCODEX_SKILLS_CONTRACT_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happycodex-skills-contract-'),
    );
    process.env.HAPPYCODEX_SKILLS_CONTRACT_DIR = d;
    return d;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCODEX_SKILLS_CONTRACT_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// getUserSkillsDir 是 routes/skills.ts 的落盘端真相源（HTTP /install 与 IPC
// install_skill 工具共用）；materializeGroupSkills 是消费端。两者必须指向同一布局。
const { getUserSkillsDir } = await import('../src/routes/skills.js');
const { materializeGroupSkills, WORKSPACE_SKILLS_DIRNAME } = await import(
  '../src/skills-materializer.js'
);
const config = await import('../src/config.js');

const OWNER_ID = 'owner-1';

let groupDir: string;

beforeEach(() => {
  groupDir = path.join(config.GROUPS_DIR, 'g-contract');
  fs.rmSync(path.join(config.DATA_DIR, 'skills'), { recursive: true, force: true });
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.mkdirSync(groupDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(groupDir, { recursive: true, force: true });
});

function writeUserSkill(id: string, enabled: boolean): void {
  // 模拟 installSkillForUser 的落盘产物（copySkillToUser 复制到 getUserSkillsDir）
  const dir = path.join(getUserSkillsDir(OWNER_ID), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, enabled ? 'SKILL.md' : 'SKILL.md.disabled'),
    `---\nname: ${id}\ndescription: contract test skill\n---\n\n# ${id}\n`,
  );
}

describe('skills 落盘端 ↔ materializer user 源契约', () => {
  test('getUserSkillsDir 安装的启用技能被 user 源发现并物化', () => {
    writeUserSkill('contract-skill', true);

    const result = materializeGroupSkills({
      executionMode: 'host',
      group: {
        name: 'g-contract',
        folder: 'g-contract',
        added_at: '2026-06-11T00:00:00.000Z',
        created_by: OWNER_ID,
        is_home: false,
      } as any,
      externalClaudeDir: path.join(config.DATA_DIR, 'external-claude'),
      dataDir: config.DATA_DIR,
      projectRoot: path.join(config.DATA_DIR, 'no-such-project'),
      groupDir,
    });

    expect(result.skills.map((s) => s.id)).toContain('contract-skill');
    const hit = result.skills.find((s) => s.id === 'contract-skill')!;
    expect(hit.source).toBe('user');
    expect(
      fs.existsSync(
        path.join(groupDir, WORKSPACE_SKILLS_DIRNAME, 'contract-skill', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  test('SKILL.md.disabled（routes PATCH 禁用产物）不被物化', () => {
    writeUserSkill('disabled-skill', false);

    const result = materializeGroupSkills({
      executionMode: 'host',
      group: {
        name: 'g-contract',
        folder: 'g-contract',
        added_at: '2026-06-11T00:00:00.000Z',
        created_by: OWNER_ID,
        is_home: false,
      } as any,
      externalClaudeDir: path.join(config.DATA_DIR, 'external-claude'),
      dataDir: config.DATA_DIR,
      projectRoot: path.join(config.DATA_DIR, 'no-such-project'),
      groupDir,
    });

    expect(result.skills.map((s) => s.id)).not.toContain('disabled-skill');
    expect(
      fs.existsSync(
        path.join(groupDir, WORKSPACE_SKILLS_DIRNAME, 'disabled-skill'),
      ),
    ).toBe(false);
  });
});
