/**
 * agent-definitions 路由（codex 版）回归测试 —— 修复轮 finding #4。
 *
 * 上游本路由对宿主机 ~/.claude/agents/*.md 做活体 CRUD（对 codex 引擎完全无效，
 * 且越界写宿主 HOME）。codex 版契约：
 *   - GET 列表/详情如实展示 PREDEFINED_AGENTS（codex 实际 provision 进
 *     {CODEX_HOME}/agents/*.toml 的预定义子代理）；
 *   - PUT/POST/DELETE 一律 501（编辑不支持，绝不写 ~/.claude）；
 *   - 任何路径不再读 ~/.claude/agents（宿主 HOME 里的 *.md 不出现在列表）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// 伪 HOME：预埋一个 ~/.claude/agents/rogue.md，回归断言它绝不出现在 GET 列表。
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-agent-defs-'));
const ORIGINAL_HOME = process.env.HOME;

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'admin-1',
      username: 'admin',
      role: 'admin',
      permissions: ['manage_system_config'],
    });
    return next();
  },
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

beforeAll(() => {
  process.env.HOME = FAKE_HOME;
  const agentsDir = path.join(FAKE_HOME, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'rogue.md'),
    '---\nname: rogue\ndescription: should never be served\n---\nbody\n',
  );
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

const routesModule = await import('../src/routes/agent-definitions.js');
const { PREDEFINED_AGENTS } = await import(
  '../src/runtime/multitenant/agent-defs.js'
);
const agentDefinitionsRoutes = routesModule.default;

async function request(
  pathName: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await agentDefinitionsRoutes.request(pathName, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('agent-definitions routes (codex)', () => {
  test('GET / 如实返回 PREDEFINED_AGENTS（id=name、tools 空）', async () => {
    const { status, body } = await request('/');
    expect(status).toBe(200);
    expect(body.agents.map((a: any) => a.id).sort()).toEqual(
      PREDEFINED_AGENTS.map((d) => d.name).sort(),
    );
    for (const agent of body.agents) {
      expect(agent.tools).toEqual([]);
      expect(typeof agent.description).toBe('string');
    }
  });

  test('GET / 不读宿主 ~/.claude/agents（rogue.md 绝不出现）', async () => {
    const { body } = await request('/');
    expect(body.agents.map((a: any) => a.id)).not.toContain('rogue');
  });

  test('GET /:id 返回 developerInstructions 作为 content', async () => {
    const def = PREDEFINED_AGENTS[0]!;
    const { status, body } = await request(`/${def.name}`);
    expect(status).toBe(200);
    expect(body.agent.id).toBe(def.name);
    expect(body.agent.content).toBe(def.developerInstructions);
  });

  test('GET /:id 未知 agent → 404', async () => {
    const { status } = await request('/no-such-agent');
    expect(status).toBe(404);
  });

  test('PUT /:id → 501，且绝不写 ~/.claude/agents', async () => {
    const def = PREDEFINED_AGENTS[0]!;
    const { status, body } = await request(`/${def.name}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'overwrite attempt' }),
    });
    expect(status).toBe(501);
    expect(body.error).toMatch(/not supported on the codex engine/i);
    // ~/.claude/agents 下绝无新文件 / 被改写文件
    const agentsDir = path.join(FAKE_HOME, '.claude', 'agents');
    expect(fs.readdirSync(agentsDir)).toEqual(['rogue.md']);
    expect(fs.readFileSync(path.join(agentsDir, 'rogue.md'), 'utf-8')).toContain(
      'should never be served',
    );
  });

  test('POST / → 501', async () => {
    const { status, body } = await request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new-agent', content: 'x' }),
    });
    expect(status).toBe(501);
    expect(body.error).toMatch(/not supported/i);
    expect(
      fs.existsSync(path.join(FAKE_HOME, '.claude', 'agents', 'new-agent.md')),
    ).toBe(false);
  });

  test('DELETE /:id → 501（rogue.md 不被删除）', async () => {
    const { status } = await request('/rogue', { method: 'DELETE' });
    expect(status).toBe(501);
    expect(
      fs.existsSync(path.join(FAKE_HOME, '.claude', 'agents', 'rogue.md')),
    ).toBe(true);
  });
});
