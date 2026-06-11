/**
 * Regression: PUT /api/groups/:jid/env 不再接收/持久化 per-group Claude
 * provider 覆盖字段（anthropicBaseUrl / anthropicAuthToken / anthropicApiKey /
 * claudeCodeOauthToken / anthropicModel）。
 *
 * 这些字段随 provider failover 作废（codex 引擎无任何生效路径，保存只会沉淀
 * 死配置）：ContainerEnvSchema 收窄为仅 customEnv（zod 默认 strip 未知键），
 * handler 不再拷贝。写时淘汰（保存即清）：旧 on-disk 文件里的残留 provider
 * 字段（含明文密钥）在任意一次 PUT 时被显式剥离——这是存量密钥唯一的清除
 * 路径。读侧保持容忍：从未重写过的旧文件 GET 仍按 masked 形状返回。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-routes-groups-env-'));
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
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

// groups.ts statically imports these from web.js; mock them so importing the
// route module doesn't pull in the full Hono app + every route's middleware.
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const groupRoutes = groupRoutesModule.default;

const ADMIN_ID = 'zadmin';
const JID = 'feishu:env-group';
const FOLDER = 'env-group';

function asAdmin(): void {
  process.env.HAPPYCLAW_TEST_USER_ID = ADMIN_ID;
  process.env.HAPPYCLAW_TEST_USER_ROLE = 'admin';
}

function envConfigPath(): string {
  return path.join(tmpDataDir, 'config', 'container-env', `${FOLDER}.json`);
}

function readEnvConfigFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(envConfigPath(), 'utf-8'));
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  // PUT /:jid/env 在保存成功后会 restartGroup；其余路由只 touch getRegisteredGroups。
  webContext.setWebDeps({
    getRegisteredGroups: () => ({}),
    queue: { restartGroup: async () => {} },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  asAdmin();
  db.setRegisteredGroup(JID, {
    name: 'Env Group',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: ADMIN_ID,
    is_home: false,
  } as any);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
  try {
    db.deleteRegisteredGroup(JID);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(envConfigPath());
  } catch {
    /* ignore */
  }
});

describe('PUT /:jid/env rejects per-group Claude provider overrides (#8)', () => {
  test('legacy anthropic*/claudeCodeOauthToken fields are stripped, customEnv persists', async () => {
    const res = await groupRoutes.request(`/${encodeURIComponent(JID)}/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anthropicBaseUrl: 'https://evil.example.com',
        anthropicAuthToken: 'sk-ant-token',
        anthropicApiKey: 'sk-ant-key',
        claudeCodeOauthToken: 'oauth-token',
        anthropicModel: 'claude-3-opus',
        customEnv: { GITHUB_TOKEN: 'ghp_abc' },
      }),
    });
    expect(res.status).toBe(200);

    // wire 响应（toPublicContainerEnvConfig 形状）：provider 字段均为空。
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.anthropicBaseUrl).toBe('');
    expect(body.hasAnthropicAuthToken).toBe(false);
    expect(body.hasAnthropicApiKey).toBe(false);
    expect(body.hasClaudeCodeOauthToken).toBe(false);
    expect(body.anthropicModel).toBe('');
    expect(body.customEnv).toEqual({ GITHUB_TOKEN: 'ghp_abc' });

    // on-disk：legacy 键一个都没落盘。
    const stored = readEnvConfigFile();
    expect(Object.keys(stored).sort()).toEqual(['customEnv']);
    expect(stored.customEnv).toEqual({ GITHUB_TOKEN: 'ghp_abc' });
  });

  test('customEnv-only update purges residual legacy fields from old on-disk files (write-time eviction)', async () => {
    // 模拟旧版本落盘的配置文件（含已作废的 provider 覆盖字段与明文密钥）。
    fs.mkdirSync(path.dirname(envConfigPath()), { recursive: true });
    fs.writeFileSync(
      envConfigPath(),
      JSON.stringify(
        {
          anthropicBaseUrl: 'https://legacy.example.com',
          anthropicAuthToken: 'legacy-auth-token',
          anthropicApiKey: 'legacy-key',
          claudeCodeOauthToken: 'legacy-oauth',
          claudeOAuthCredentials: { accessToken: 'legacy-access' },
          anthropicModel: 'legacy-model',
          customEnv: { OLD: 'old' },
        },
        null,
        2,
      ),
    );

    // 读侧容忍：从未重写过的旧文件，GET 仍按 masked 形状展示残留。
    const preRes = await groupRoutes.request(`/${encodeURIComponent(JID)}/env`, {
      method: 'GET',
    });
    expect(preRes.status).toBe(200);
    const preBody = (await preRes.json()) as Record<string, unknown>;
    expect(preBody.hasAnthropicApiKey).toBe(true);
    expect(preBody.anthropicModel).toBe('legacy-model');

    const res = await groupRoutes.request(`/${encodeURIComponent(JID)}/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customEnv: { NEW: 'new' } }),
    });
    expect(res.status).toBe(200);

    // 写时淘汰（保存即清）：legacy 残留（含明文密钥）一个不剩，customEnv 已更新。
    const stored = readEnvConfigFile();
    expect(Object.keys(stored).sort()).toEqual(['customEnv']);
    expect(stored.customEnv).toEqual({ NEW: 'new' });

    // GET 随之自然清零。
    const getRes = await groupRoutes.request(`/${encodeURIComponent(JID)}/env`, {
      method: 'GET',
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(getBody.hasAnthropicAuthToken).toBe(false);
    expect(getBody.hasAnthropicApiKey).toBe(false);
    expect(getBody.hasClaudeCodeOauthToken).toBe(false);
    expect(getBody.anthropicBaseUrl).toBe('');
    expect(getBody.anthropicModel).toBe('');
  });

  test('legacy fields in payload cannot resurrect residual on-disk values (both purged)', async () => {
    fs.mkdirSync(path.dirname(envConfigPath()), { recursive: true });
    fs.writeFileSync(
      envConfigPath(),
      JSON.stringify({ anthropicApiKey: 'legacy-key' }, null, 2),
    );

    const res = await groupRoutes.request(`/${encodeURIComponent(JID)}/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anthropicApiKey: 'attacker-new-key',
        customEnv: {},
      }),
    });
    expect(res.status).toBe(200);

    const stored = readEnvConfigFile();
    // 写侧剥离 + 写时淘汰：载荷值不被写入，残留旧值也被清除。
    expect(stored.anthropicApiKey).toBeUndefined();
    expect(Object.keys(stored).sort()).toEqual(['customEnv']);
  });
});
