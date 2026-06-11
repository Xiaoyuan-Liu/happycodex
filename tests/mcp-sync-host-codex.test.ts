/**
 * MCP /sync-host 的 codex config.toml 来源回归测试 —— 修复轮 finding #11。
 *
 * 上游 /sync-host 只读 ~/.claude/settings.json 与 ~/.claude.json（codex-only
 * 主机上恒为空结果）。codex 版新增 Source 3：{shared codex home}/config.toml 的
 * [mcp_servers.*] 段（HAPPYCODEX_SHARED_CODEX_HOME > CODEX_HOME > ~/.codex），
 * ID 冲突时 codex 来源胜出。
 *
 * 覆盖：
 *   - parseMcpServersFromToml 单元（渲染器产出形状 + codex 原生 inline env）；
 *   - 路由集成：无任何 .claude 文件时 admin POST /sync-host 从 config.toml
 *     导入 stdio + http 两个 server，servers.json 带 syncedFromHost=true。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const TMP =
  process.env.HAPPYCODEX_MCP_SYNC_TMP ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-mcp-sync-'));
    process.env.HAPPYCODEX_MCP_SYNC_TMP = d;
    return d;
  })();
const DATA_DIR = path.join(TMP, 'data');
const FAKE_HOME = path.join(TMP, 'home'); // 无 .claude 文件
const CODEX_HOME = path.join(TMP, 'codex-home');

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_SHARED = process.env.HAPPYCODEX_SHARED_CODEX_HOME;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const tmp = process.env.HAPPYCODEX_MCP_SYNC_TMP!;
  return { ...real, DATA_DIR: path.join(tmp, 'data') };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'admin-1',
      username: 'admin',
      role: 'admin',
      permissions: [],
    });
    return next();
  },
}));

beforeAll(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FAKE_HOME, { recursive: true });
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  process.env.HOME = FAKE_HOME;
  process.env.HAPPYCODEX_SHARED_CODEX_HOME = CODEX_HOME;
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_SHARED === undefined) {
    delete process.env.HAPPYCODEX_SHARED_CODEX_HOME;
  } else {
    process.env.HAPPYCODEX_SHARED_CODEX_HOME = ORIGINAL_SHARED;
  }
  delete process.env.HAPPYCODEX_MCP_SYNC_TMP;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('parseMcpServersFromToml', () => {
  test('解析渲染器产出形状：标量 + args 数组 + env/http_headers 子表', async () => {
    const { parseMcpServersFromToml } = await import(
      '../src/routes/mcp-servers.js'
    );
    const toml = [
      '# happycodex config',
      'model = "gpt-5"',
      '',
      '[mcp_servers.filesystem]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-filesystem"]',
      '',
      '[mcp_servers.filesystem.env]',
      'API_KEY = "secret\\"quoted"',
      '',
      '[mcp_servers.remote]',
      'url = "https://mcp.example.com/sse"',
      '',
      '[mcp_servers.remote.http_headers]',
      'Authorization = "Bearer tok"',
      '',
      '[projects."/some/path"]',
      'trust_level = "trusted"',
    ].join('\n');

    const servers = parseMcpServersFromToml(toml);
    expect(Object.keys(servers).sort()).toEqual(['filesystem', 'remote']);
    expect(servers.filesystem).toMatchObject({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { API_KEY: 'secret"quoted' },
    });
    expect(servers.remote).toMatchObject({
      url: 'https://mcp.example.com/sse',
      http_headers: { Authorization: 'Bearer tok' },
    });
    // 非 mcp_servers 段（projects）不渗入
    expect(servers['/some/path']).toBeUndefined();
  });

  test('解析 codex 原生 inline table env', async () => {
    const { parseMcpServersFromToml } = await import(
      '../src/routes/mcp-servers.js'
    );
    const servers = parseMcpServersFromToml(
      '[mcp_servers.native]\ncommand = "uvx"\nenv = { TOKEN = "t1", REGION = "us" }\n',
    );
    expect(servers.native).toMatchObject({
      command: 'uvx',
      env: { TOKEN: 't1', REGION: 'us' },
    });
  });
});

describe('POST /sync-host — codex config.toml 来源', () => {
  test('无 .claude 文件时从 config.toml 导入 stdio + http，added=2', async () => {
    fs.writeFileSync(
      path.join(CODEX_HOME, 'config.toml'),
      [
        '[mcp_servers.codex-fs]',
        'command = "npx"',
        'args = ["-y", "server-fs"]',
        '',
        '[mcp_servers.codex-fs.env]',
        'KEY = "v"',
        '',
        '[mcp_servers.codex-http]',
        'url = "https://mcp.example.com/mcp"',
        '',
        '[mcp_servers.codex-http.http_headers]',
        'Authorization = "Bearer abc"',
        '',
      ].join('\n'),
    );

    const routesModule = await import('../src/routes/mcp-servers.js');
    const mcpServersRoutes = routesModule.default;

    const res = await mcpServersRoutes.request('/sync-host', { method: 'POST' });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.added).toBe(2);
    expect(body.deleted).toBe(0);

    // servers.json 条目形状（http 来源映射 type/url/headers；stdio 保 command/args/env）
    const listRes = await mcpServersRoutes.request('/', { method: 'GET' });
    const listBody = (await listRes.json()) as any;
    const byId: Record<string, any> = {};
    for (const s of listBody.servers) byId[s.id] = s;

    expect(byId['codex-fs']).toMatchObject({
      command: 'npx',
      args: ['-y', 'server-fs'],
      env: { KEY: 'v' },
      syncedFromHost: true,
      enabled: true,
    });
    expect(byId['codex-http']).toMatchObject({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
      syncedFromHost: true,
      enabled: true,
    });
  });
});
