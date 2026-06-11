/**
 * workspace-config 写路径根目录回归测试 —— 修复轮 finding #6。
 *
 * 上游 host 模式 customCwd 群组的 workspace-config 直接往真实用户仓库写
 * `.claude/`（settings.json / skills/）。codex 版契约：
 *   - 落盘根永远是受管群组目录 {GROUPS_DIR}/{folder}/.claude/，绝不写 customCwd；
 *   - workspace 级 skills/MCP 尚未接入 codex 消费——成功响应显式带
 *     effective:false + notice，不静默谎报生效。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happycodex-ws-config-root-'),
    );
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
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

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const workspaceConfigRoutes = (
  await import('../src/routes/workspace-config.js')
).default;
const db = await import('../src/db.js');
const config = await import('../src/config.js');

const OWNER_ID = 'alice';
const GROUP_JID = 'web:host-group';
const GROUP_FOLDER = 'host-group';

let customCwd: string;

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  customCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-custom-cwd-'));
  try {
    db.removeGroupMember(GROUP_FOLDER, OWNER_ID);
  } catch {
    /* ignore */
  }
  try {
    db.deleteRegisteredGroup(GROUP_JID);
  } catch {
    /* ignore */
  }
  const groupsDir = path.join(tmpDataDir, 'groups');
  fs.rmSync(groupsDir, { recursive: true, force: true });
  fs.mkdirSync(groupsDir, { recursive: true });

  // host 模式 + customCwd 指向"真实用户仓库"（上游会向这里写 .claude/）
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Host Group',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    customCwd,
    created_by: OWNER_ID,
    is_home: false,
  } as any);
  db.addGroupMember(GROUP_FOLDER, OWNER_ID, 'owner');
});

afterEach(() => {
  fs.rmSync(customCwd, { recursive: true, force: true });
});

async function req(
  sub: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config${sub}`,
    init,
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('workspace-config — 写路径绝不落 customCwd', () => {
  test('POST mcp-servers 写入受管群组目录而非 customCwd，响应带 effective:false', async () => {
    const { status, body } = await req('/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'srv1', command: 'echo', args: ['hi'] }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.effective).toBe(false);
    expect(body.notice).toMatch(/not yet consumed by the codex engine/i);

    // customCwd（真实用户仓库）必须原封不动——没有任何 .claude/ 产物
    expect(fs.existsSync(path.join(customCwd, '.claude'))).toBe(false);
    expect(fs.readdirSync(customCwd)).toEqual([]);

    // 受管群组目录里有落盘（settings.json + workspace meta）
    const managedClaudeDir = path.join(config.GROUPS_DIR, GROUP_FOLDER, '.claude');
    expect(
      fs.existsSync(path.join(managedClaudeDir, 'settings.json')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(managedClaudeDir, 'happyclaw-workspace.json')),
    ).toBe(true);
  });

  test('GET skills 只读受管群组目录：customCwd 下的 .claude/skills 不参与', async () => {
    // 故意在 customCwd 里放一个技能（上游会把这里当工作区根）
    const rogueDir = path.join(customCwd, '.claude', 'skills', 'rogue-skill');
    fs.mkdirSync(rogueDir, { recursive: true });
    fs.writeFileSync(
      path.join(rogueDir, 'SKILL.md'),
      '---\nname: rogue-skill\ndescription: in customCwd\n---\n',
    );
    // 受管群组目录里放一个技能
    const managedDir = path.join(
      config.GROUPS_DIR,
      GROUP_FOLDER,
      '.claude',
      'skills',
      'managed-skill',
    );
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(
      path.join(managedDir, 'SKILL.md'),
      '---\nname: managed-skill\ndescription: managed\n---\n',
    );

    const { status, body } = await req('/skills', { method: 'GET' });
    expect(status).toBe(200);
    const ids = body.skills.map((s: any) => s.id);
    expect(ids).toContain('managed-skill');
    expect(ids).not.toContain('rogue-skill');
    expect(body.notice).toMatch(/not yet consumed/i);
  });

  test('PATCH skill（toggle）写受管目录，响应带 effective:false', async () => {
    const managedDir = path.join(
      config.GROUPS_DIR,
      GROUP_FOLDER,
      '.claude',
      'skills',
      't-skill',
    );
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(
      path.join(managedDir, 'SKILL.md'),
      '---\nname: t-skill\ndescription: t\n---\n',
    );

    const { status, body } = await req('/skills/t-skill', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.effective).toBe(false);
    expect(fs.existsSync(path.join(managedDir, 'SKILL.md.disabled'))).toBe(true);
    expect(fs.existsSync(path.join(customCwd, '.claude'))).toBe(false);
  });
});
