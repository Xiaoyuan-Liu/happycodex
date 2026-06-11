/**
 * Finding #3 regression: setupStatus 必须按 codex 共享 auth.json 判定，
 * 而非已作废的 Claude provider 池 —— 否则 codex-only 部署的 admin 永远
 * needsSetup=true，被锁死在占位 Setup 页。
 *
 * 覆盖矩阵：
 *   - 共享 CODEX_HOME 无 auth.json → needsSetup=true / codexConfigured=false
 *   - 写入 auth.json（api_key 形态）  → needsSetup=false / codexConfigured=true
 *   - 写入 auth.json（chatgpt 形态）  → needsSetup=false（存在性判定）
 *   - 响应不再携带上游字段 claudeConfigured（前端 SetupStatus 已更名 codexConfigured）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-setup-status-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

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

// 避免经 routes/config.js → im-channel.js → feishu.js 拉起完整 web.js
// （Hono app + WebSocket，模块顶层 mount 路由会撞上循环引用）。
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
}));

const { buildSetupStatus } = await import('../src/routes/auth.js');

describe('buildSetupStatus (codex-only 判定)', () => {
  let codexHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(SHARED_TMP, 'codex-home-'));
    for (const key of [
      'HAPPYCODEX_SHARED_CODEX_HOME',
      'CODEX_HOME',
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HAPPYCODEX_SHARED_CODEX_HOME = codexHome;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  test('无 auth.json → needsSetup=true / codexConfigured=false', () => {
    const status = buildSetupStatus();
    expect(status.needsSetup).toBe(true);
    expect(status.codexConfigured).toBe(false);
    expect(status.feishuConfigured).toBe(false);
  });

  test('auth.json（api_key 形态）→ needsSetup=false / codexConfigured=true', () => {
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-test-123' }),
    );
    const status = buildSetupStatus();
    expect(status.needsSetup).toBe(false);
    expect(status.codexConfigured).toBe(true);
  });

  test('auth.json（chatgpt OAuth 形态）→ needsSetup=false', () => {
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: { last_refresh: '2026-06-11T00:00:00Z' },
      }),
    );
    const status = buildSetupStatus();
    expect(status.needsSetup).toBe(false);
    expect(status.codexConfigured).toBe(true);
  });

  test('不再携带上游字段 claudeConfigured', () => {
    const status = buildSetupStatus() as Record<string, unknown>;
    expect('claudeConfigured' in status).toBe(false);
    expect('codexConfigured' in status).toBe(true);
  });
});
