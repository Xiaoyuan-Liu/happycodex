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
  CODEX_AUTH_FILE,
  hasUserCodexAuth,
  perUserAuthFallbackEnabled,
  readCodexAuthStatus,
  sharedCodexHomeDir,
  userCodexHomeDir,
} from '../src/codex-paths.js';

const ENV_KEYS = [
  'HAPPYCODEX_SHARED_CODEX_HOME',
  'CODEX_HOME',
  'HOME',
  'HAPPYCODEX_PERUSER_AUTH_FALLBACK',
] as const;

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

describe('userCodexHomeDir — 路径解析 + 逃逸校验（与 sessions folder 同款）', () => {
  test('合法 userId → DATA_DIR/config/user-im/{userId}/codex', () => {
    const dir = userCodexHomeDir('alice');
    // 末尾必须是 .../config/user-im/alice/codex
    expect(dir.endsWith(path.join('config', 'user-im', 'alice', 'codex'))).toBe(true);
    expect(path.isAbsolute(dir)).toBe(true);
  });

  test('允许字母 / 数字 / 下划线 / 连字符的合法 userId', () => {
    for (const id of ['u_123', 'User-9', 'ABC', '0', 'a-b_c-1']) {
      expect(() => userCodexHomeDir(id)).not.toThrow();
    }
  });

  test('拒绝 ".." 段（目录穿越）', () => {
    expect(() => userCodexHomeDir('..')).toThrow(/Invalid userId/);
    expect(() => userCodexHomeDir('a..b')).toThrow(/Invalid userId/);
  });

  test('拒绝路径分隔符（POSIX / Windows）', () => {
    expect(() => userCodexHomeDir('a/b')).toThrow(/Invalid userId/);
    expect(() => userCodexHomeDir('a\\b')).toThrow(/Invalid userId/);
  });

  test('拒绝绝对路径 / 前导斜杠', () => {
    expect(() => userCodexHomeDir('/etc')).toThrow(/Invalid userId/);
    expect(() => userCodexHomeDir('/abs')).toThrow(/Invalid userId/);
  });

  test('拒绝空串 / 空段', () => {
    expect(() => userCodexHomeDir('')).toThrow(/Invalid userId/);
  });

  test('拒绝含其他特殊字符（空格 / 点 / 冒号）', () => {
    for (const bad of ['a b', 'a.b', 'a:b', 'a;b', 'a$b']) {
      expect(() => userCodexHomeDir(bad)).toThrow(/Invalid userId/);
    }
  });
});

describe('hasUserCodexAuth — per-user auth.json 存在性', () => {
  // 用唯一 userId，真实落在 DATA_DIR/config/user-im/{userId}/codex；afterEach 清理。
  let userId: string;
  let userHome: string;

  beforeEach(() => {
    userId = `test-user-${process.pid}-${Math.random().toString(36).slice(2)}`;
    userHome = userCodexHomeDir(userId);
  });

  afterEach(() => {
    // 清理整个 per-user 目录（DATA_DIR/config/user-im/{userId}）。
    fs.rmSync(path.dirname(userHome), { recursive: true, force: true });
  });

  test('auth.json 不存在 → false', () => {
    expect(hasUserCodexAuth(userId)).toBe(false);
  });

  test('写入 auth.json 后 → true', () => {
    fs.mkdirSync(userHome, { recursive: true });
    fs.writeFileSync(path.join(userHome, CODEX_AUTH_FILE), '{"OPENAI_API_KEY":"sk"}');
    expect(hasUserCodexAuth(userId)).toBe(true);
  });

  test('非法 userId 透传 userCodexHomeDir 的抛错', () => {
    expect(() => hasUserCodexAuth('../evil')).toThrow(/Invalid userId/);
  });
});

describe('readCodexAuthStatus(userId) — per-user 优先 vs 无参读共享', () => {
  let userId: string;
  let userHome: string;

  beforeEach(() => {
    // 共享态指向 tmpDir（与上方 describe 一致），per-user 落真实 DATA_DIR。
    process.env.HAPPYCODEX_SHARED_CODEX_HOME = tmpDir;
    userId = `test-user-${process.pid}-${Math.random().toString(36).slice(2)}`;
    userHome = userCodexHomeDir(userId);
  });

  afterEach(() => {
    fs.rmSync(path.dirname(userHome), { recursive: true, force: true });
  });

  test('用户已自登 → 读 per-user 凭据，hasUserAuth=true / usingShared=false', () => {
    fs.mkdirSync(userHome, { recursive: true });
    fs.writeFileSync(
      path.join(userHome, CODEX_AUTH_FILE),
      JSON.stringify({ OPENAI_API_KEY: 'sk-user' }),
    );
    const status = readCodexAuthStatus(userId);
    expect(status.loggedIn).toBe(true);
    expect(status.method).toBe('api_key');
    expect(status.codexHome).toBe(userHome);
    expect(status.hasUserAuth).toBe(true);
    expect(status.usingShared).toBe(false);
  });

  test('用户未登录 + fallback 开启 + 共享已登录 → 回退共享态，usingShared=true / hasUserAuth=false', () => {
    delete process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK; // 缺省=开启
    // 共享有凭据。
    fs.writeFileSync(
      path.join(tmpDir, CODEX_AUTH_FILE),
      JSON.stringify({ tokens: { last_refresh: '2026-06-11T00:00:00Z' } }),
    );
    const status = readCodexAuthStatus(userId);
    expect(status.usingShared).toBe(true);
    expect(status.hasUserAuth).toBe(false);
    // 回退态读的是共享凭据。
    expect(status.codexHome).toBe(tmpDir);
    expect(status.loggedIn).toBe(true);
    expect(status.method).toBe('chatgpt');
    expect(status.lastRefresh).toBe('2026-06-11T00:00:00Z');
  });

  test('用户未登录 + fallback 关闭 → 不回退共享：loggedIn=false / codexHome 指向 per-user', () => {
    process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK = 'false';
    // 即使共享有凭据，也不回退。
    fs.writeFileSync(
      path.join(tmpDir, CODEX_AUTH_FILE),
      JSON.stringify({ OPENAI_API_KEY: 'sk-shared' }),
    );
    const status = readCodexAuthStatus(userId);
    expect(status.loggedIn).toBe(false);
    expect(status.method).toBeNull();
    expect(status.codexHome).toBe(userHome);
    expect(status.hasUserAuth).toBe(false);
    expect(status.usingShared).toBe(false);
    expect(status.loginHint).toContain('fallback');
  });

  test('无参（向后兼容）→ 读共享，且不带 hasUserAuth/usingShared 字段', () => {
    fs.writeFileSync(
      path.join(tmpDir, CODEX_AUTH_FILE),
      JSON.stringify({ OPENAI_API_KEY: 'sk-shared' }),
    );
    const status = readCodexAuthStatus();
    expect(status.codexHome).toBe(tmpDir);
    expect(status.loggedIn).toBe(true);
    // 共享态不应填充 per-user 专属字段（前端据此区分）。
    expect(status.hasUserAuth).toBeUndefined();
    expect(status.usingShared).toBeUndefined();
  });

  test('用户已自登优先于 fallback 开关：fallback 关闭也读自己的凭据', () => {
    process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK = 'false';
    fs.mkdirSync(userHome, { recursive: true });
    fs.writeFileSync(
      path.join(userHome, CODEX_AUTH_FILE),
      JSON.stringify({ OPENAI_API_KEY: 'sk-user' }),
    );
    const status = readCodexAuthStatus(userId);
    expect(status.loggedIn).toBe(true);
    expect(status.hasUserAuth).toBe(true);
    expect(status.codexHome).toBe(userHome);
  });
});

describe('perUserAuthFallbackEnabled — 读 env 开关', () => {
  test('缺省（未设置）→ true（回退共享）', () => {
    delete process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK;
    expect(perUserAuthFallbackEnabled()).toBe(true);
  });

  test('"true" → true', () => {
    process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK = 'true';
    expect(perUserAuthFallbackEnabled()).toBe(true);
  });

  test('"false" → false（强制每人自登）', () => {
    process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK = 'false';
    expect(perUserAuthFallbackEnabled()).toBe(false);
  });

  test('"FALSE"/"False"（大小写不敏感）→ false', () => {
    for (const v of ['FALSE', 'False', 'fAlSe']) {
      process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK = v;
      expect(perUserAuthFallbackEnabled()).toBe(false);
    }
  });

  test('带前后空白的 " false " → false（trim 后判定）', () => {
    process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK = '  false  ';
    expect(perUserAuthFallbackEnabled()).toBe(false);
  });

  test('其他任意值（如 "1" / "yes" / 空串）→ true（只有显式 false 才关闭）', () => {
    for (const v of ['1', 'yes', '', 'no', '0']) {
      process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK = v;
      expect(perUserAuthFallbackEnabled()).toBe(true);
    }
  });
});
