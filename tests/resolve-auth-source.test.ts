/**
 * resolveAuthSource：auth.json 复制源的选源 scope（R1 加固——共享回退可观测）。
 *
 * 选源矩阵：
 *   - ownerId 缺失              → shared-no-owner（共享）
 *   - owner 有 per-user 凭据     → own（用自己的）
 *   - 无 per-user + fallback 开  → shared-fallback（回退共享，调用方 WARN 观测）
 *   - 无 per-user + fallback 关  → self-required（指向无 auth 的 per-user，provision 抛"请先登录"）
 *
 * config.js 重定向 tmp：DATA_DIR 落 tmp，userCodexHomeDir/auth.json 也落同一 tmp。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/config.js')>();
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const tmpRoot = fsm.realpathSync(
    fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'hcx-auth-source-')),
  );
  return {
    ...orig,
    DATA_DIR: pathm.join(tmpRoot, 'data'),
    GROUPS_DIR: pathm.join(tmpRoot, 'data', 'groups'),
    MOUNT_ALLOWLIST_PATH: pathm.join(tmpRoot, 'config', 'mount-allowlist.json'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { resolveAuthSource } = await import('../src/container-runner.js');
const { userCodexHomeDir, sharedCodexHomeDir, CODEX_AUTH_FILE } = await import(
  '../src/codex-paths.js'
);

const OWNER = 'owner-1';

describe('resolveAuthSource — 选源 scope 矩阵（R1）', () => {
  let sharedHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hcx-shared-codex-'));
    for (const key of [
      'HAPPYCODEX_SHARED_CODEX_HOME',
      'CODEX_HOME',
      'HAPPYCODEX_PERUSER_AUTH_FALLBACK',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HAPPYCODEX_SHARED_CODEX_HOME = sharedHome;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(sharedHome, { recursive: true, force: true });
    // 清理可能写入的 per-user auth.json
    try {
      fs.rmSync(userCodexHomeDir(OWNER), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function seedUserAuth(): void {
    const dir = userCodexHomeDir(OWNER);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, CODEX_AUTH_FILE),
      JSON.stringify({ OPENAI_API_KEY: 'sk-own' }),
    );
  }

  test('ownerId 缺失 → shared-no-owner（共享）', () => {
    const r = resolveAuthSource(undefined);
    expect(r.scope).toBe('shared-no-owner');
    expect(r.dir).toBe(sharedCodexHomeDir());
  });

  test('owner 有 per-user 凭据 → own（用自己的）', () => {
    seedUserAuth();
    const r = resolveAuthSource(OWNER);
    expect(r.scope).toBe('own');
    expect(r.dir).toBe(userCodexHomeDir(OWNER));
  });

  test('无 per-user + fallback 默认开 → shared-fallback（回退共享）', () => {
    const r = resolveAuthSource(OWNER);
    expect(r.scope).toBe('shared-fallback');
    expect(r.dir).toBe(sharedCodexHomeDir());
  });

  test('无 per-user + fallback 关 → self-required（指向无 auth 的 per-user 目录）', () => {
    process.env.HAPPYCODEX_PERUSER_AUTH_FALLBACK = 'false';
    const r = resolveAuthSource(OWNER);
    expect(r.scope).toBe('self-required');
    expect(r.dir).toBe(userCodexHomeDir(OWNER));
  });
});
