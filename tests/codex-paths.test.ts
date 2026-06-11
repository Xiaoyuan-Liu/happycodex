/**
 * src/codex-paths.ts 单元测试 —— 修复轮 2 清理项 CR#14。
 *
 * sharedCodexHomeDir 此前在 routes/config.ts / container-runner.ts /
 * sdk-query.ts / routes/mcp-servers.ts 各有一份副本，readCodexAuthStatus
 * 住在 routes/config.ts 被 auth/bug-report 横向 import。本测试钉死下沉后的
 * 单一真相源行为：
 *   - 解析优先级 HAPPYCODEX_SHARED_CODEX_HOME > CODEX_HOME > ~/.codex；
 *   - auth.json 存在性 + 认证方式判定（api_key / chatgpt / unknown）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  readCodexAuthStatus,
  sharedCodexHomeDir,
} from '../src/codex-paths.js';

const ENV_KEYS = ['HAPPYCODEX_SHARED_CODEX_HOME', 'CODEX_HOME', 'HOME'] as const;

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-paths-'));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('sharedCodexHomeDir — 解析优先级', () => {
  test('HAPPYCODEX_SHARED_CODEX_HOME 最高优先', () => {
    process.env.HAPPYCODEX_SHARED_CODEX_HOME = '/custom/shared';
    process.env.CODEX_HOME = '/custom/codex';
    expect(sharedCodexHomeDir()).toBe('/custom/shared');
  });

  test('无 HAPPYCODEX_SHARED_CODEX_HOME 时取 CODEX_HOME', () => {
    process.env.CODEX_HOME = '/custom/codex';
    expect(sharedCodexHomeDir()).toBe('/custom/codex');
  });

  test('两者都缺省时回落 ~/.codex', () => {
    process.env.HOME = tmpDir; // posix 下 os.homedir() 读 HOME
    expect(sharedCodexHomeDir()).toBe(path.join(os.homedir(), '.codex'));
    expect(sharedCodexHomeDir()).toBe(path.join(tmpDir, '.codex'));
  });
});

describe('readCodexAuthStatus — auth.json 判定', () => {
  beforeEach(() => {
    process.env.HAPPYCODEX_SHARED_CODEX_HOME = tmpDir;
  });

  test('无 auth.json → loggedIn=false，loginHint 含路径指引', () => {
    const status = readCodexAuthStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.method).toBeNull();
    expect(status.lastRefresh).toBeNull();
    expect(status.codexHome).toBe(tmpDir);
    expect(status.loginHint).toContain(path.join(tmpDir, 'auth.json'));
  });

  test('api_key 形态 → method=api_key', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-test' }),
    );
    const status = readCodexAuthStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.method).toBe('api_key');
    expect(status.lastRefresh).toBeNull();
  });

  test('chatgpt OAuth 形态 → method=chatgpt + lastRefresh', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({ tokens: { last_refresh: '2026-06-11T00:00:00Z' } }),
    );
    const status = readCodexAuthStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.method).toBe('chatgpt');
    expect(status.lastRefresh).toBe('2026-06-11T00:00:00Z');
  });

  test('非 JSON 内容 → 存在即 loggedIn=true，method=unknown', () => {
    fs.writeFileSync(path.join(tmpDir, 'auth.json'), 'not-json{{');
    const status = readCodexAuthStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.method).toBe('unknown');
  });
});
