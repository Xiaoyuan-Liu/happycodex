/**
 * Regression: bug-report 的 AI 能力门控改用 codex 判定（#7/#22）。
 *
 * 上游用 Claude provider 配置（anthropicApiKey / claudeCodeOauthToken /
 * claudeOAuthCredentials）门控 AI 生成——happycodex 的执行体是 codex
 * （sdkQuery → `codex exec`），provider 体系已随 failover 作废，旧门控会让
 * claudeAvailable 恒 false、AI 生成恒走 fallback。现门控 = readCodexAuthStatus()
 * .loggedIn（共享 CODEX_HOME/auth.json 存在，与 sdkQuery 认证来源同口径）。
 *
 * 门控函数本体（readCodexAuthStatus）由 routes/config.ts 自己的测试覆盖；
 * 这里 mock 它，只验证 bug-report 的接线与分支行为。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-routes-bug-report-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

// 可变 mock 状态（vi.mock 工厂被提升，引用名须以 mock 开头）。
let mockLoggedIn = false;
const mockSdkQuery = vi.fn(async () => null);

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

vi.mock('../src/db.js', () => ({
  getUserHomeGroup: () => null,
}));

// codex 门控真相源：bug-report 只消费 loggedIn。
vi.mock('../src/routes/config.js', () => ({
  readCodexAuthStatus: () => ({
    loggedIn: mockLoggedIn,
    method: mockLoggedIn ? 'chatgpt' : null,
    lastRefresh: null,
    codexHome: '/tmp/fake-codex-home',
    loginHint: 'run codex login',
  }),
}));

vi.mock('../src/sdk-query.js', () => ({
  sdkQuery: mockSdkQuery,
}));

// gh CLI 探测走 promisify(execFile)：mock 成恒失败（gh 不可用），
// 避免测试机上真实拉起 gh / 网络调用。
vi.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb?: (err: Error | null) => void,
  ) => {
    const callback = typeof _opts === 'function' ? (_opts as typeof cb) : cb;
    callback?.(new Error('not available'));
  },
}));

/** capCache 是模块级 5min 缓存——每个用例 resetModules 拿全新模块实例。 */
async function freshBugReportRoutes() {
  vi.resetModules();
  const mod = await import('../src/routes/bug-report.js');
  return mod.default;
}

beforeEach(() => {
  mockLoggedIn = false;
  mockSdkQuery.mockClear();
});

afterEach(() => {
  vi.resetModules();
});

describe('GET /capabilities — AI 门控走 codex auth（#7/#22）', () => {
  test('共享 CODEX_HOME 未登录 → claudeAvailable=false', async () => {
    mockLoggedIn = false;
    const routes = await freshBugReportRoutes();
    const res = await routes.request('/capabilities', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.claudeAvailable).toBe(false);
  });

  test('共享 CODEX_HOME 已登录 → claudeAvailable=true（不再依赖 Claude provider 配置）', async () => {
    mockLoggedIn = true;
    const routes = await freshBugReportRoutes();
    const res = await routes.request('/capabilities', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.claudeAvailable).toBe(true);
  });
});

describe('POST /generate — 未登录走 fallback，不调 sdkQuery', () => {
  test('codex 未认证时返回 fallback 模板且不拉起 codex', async () => {
    mockLoggedIn = false;
    const routes = await freshBugReportRoutes();
    const res = await routes.request('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: '点击按钮后页面白屏' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.title).toBe('string');
    expect(String(body.body)).toContain('点击按钮后页面白屏');
    expect(mockSdkQuery).not.toHaveBeenCalled();
  });

  test('codex 已认证时进入 AI 路径（调用 sdkQuery；null 结果再兜底 fallback）', async () => {
    mockLoggedIn = true;
    const routes = await freshBugReportRoutes();
    const res = await routes.request('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: '上传附件 500' }),
    });
    expect(res.status).toBe(200);
    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    // sdkQuery 返回 null（AI 不可用）时仍有 fallback 安全网。
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.body).toBe('string');
  });
});
