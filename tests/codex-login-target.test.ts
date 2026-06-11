/**
 * resolveCodexLoginTarget：登录写入目标的 bootstrap 判定（门控闭环的承重逻辑）。
 *
 * 死循环根因回归：buildSetupStatus 读**共享** auth.json，而登录端点此前一律写
 * **per-user** → admin 在配置页登录成功 needsSetup 也永不翻 → AuthGuard 把 admin
 * 钉死在 /setup/providers。resolveCodexLoginTarget 让 bootstrap 期（admin + 共享未
 * 配置）的登录改写共享基线账号，令「判定源 == 写入目标」，打破死循环。
 *
 * 覆盖矩阵：
 *   - admin + 共享无 auth.json（bootstrap）→ scope=shared，写共享目录
 *   - admin + 共享已有 auth.json          → scope=per-user，写各自目录
 *   - 非 admin + 共享无 auth.json          → scope=per-user（普通用户永不 seed 共享）
 *   - 非 admin + 共享已有 auth.json        → scope=per-user
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-login-target-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

const { resolveCodexLoginTarget, sharedCodexHomeDir, userCodexHomeDir } =
  await import('../src/codex-paths.js');

const UID = 'admin-user-1';

describe('resolveCodexLoginTarget (bootstrap 判定)', () => {
  let codexHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(SHARED_TMP, 'shared-codex-'));
    for (const key of [
      'HAPPYCODEX_SHARED_CODEX_HOME',
      'CODEX_HOME',
      'HAPPYCODEX_PERUSER_AUTH_FALLBACK',
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

  function seedShared(): void {
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-shared' }),
    );
  }

  test('admin + 共享未配置（bootstrap）→ 写共享基线账号', () => {
    const target = resolveCodexLoginTarget(UID, true);
    expect(target.scope).toBe('shared');
    expect(target.codexHome).toBe(sharedCodexHomeDir());
  });

  test('admin + 共享已配置 → 回归 per-user 隔离', () => {
    seedShared();
    const target = resolveCodexLoginTarget(UID, true);
    expect(target.scope).toBe('per-user');
    expect(target.codexHome).toBe(userCodexHomeDir(UID));
  });

  test('非 admin + 共享未配置 → 仍写 per-user（普通用户不可 seed 共享）', () => {
    const target = resolveCodexLoginTarget(UID, false);
    expect(target.scope).toBe('per-user');
    expect(target.codexHome).toBe(userCodexHomeDir(UID));
  });

  test('非 admin + 共享已配置 → per-user', () => {
    seedShared();
    const target = resolveCodexLoginTarget(UID, false);
    expect(target.scope).toBe('per-user');
    expect(target.codexHome).toBe(userCodexHomeDir(UID));
  });

  test('共享目录路径优先级：HAPPYCODEX_SHARED_CODEX_HOME 命中', () => {
    const target = resolveCodexLoginTarget(UID, true);
    expect(target.codexHome).toBe(codexHome);
  });
});
