/**
 * 修复轮 2 CR#11 回归：container-env 配置文件中残留的 legacy Claude provider 键
 * （anthropic* / claudeCodeOauthToken / claudeOAuthCredentials）在 codex 运行时
 * 无任何消费路径（buildContainerEnvLines 只透传 customEnv）。读取（getContainerEnvConfig）
 * 命中残留键时必须 logger.warn 提示存量配置已失效——且按 folder 去重只告警一次
 * （该读取位于 buildAgentEnvLines 热路径，每次 spawn 都会触发）。
 */
import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const nodeFs = await import('fs');
  const nodeOs = await import('os');
  const nodePath = await import('path');
  const dataDir = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'happycodex-legacy-env-warn-'),
  );
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: nodePath.join(dataDir, 'groups'),
    STORE_DIR: nodePath.join(dataDir, 'db'),
  };
});

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: warnSpy, error: () => {} },
}));

const { DATA_DIR } = await import('../src/config.js');
const rc = await import('../src/runtime-config.js');

const CONTAINER_ENV_DIR = path.join(DATA_DIR, 'config', 'container-env');

function seedEnvFile(folder: string, content: Record<string, unknown>): void {
  fs.mkdirSync(CONTAINER_ENV_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CONTAINER_ENV_DIR, `${folder}.json`),
    JSON.stringify(content, null, 2),
    'utf-8',
  );
}

function legacyWarnCalls(): Array<[unknown, unknown]> {
  return warnSpy.mock.calls.filter(([, msg]) =>
    typeof msg === 'string' && msg.includes('residual legacy Claude provider keys'),
  ) as Array<[unknown, unknown]>;
}

beforeEach(() => {
  warnSpy.mockClear();
});

describe('getContainerEnvConfig — 残留 legacy provider 键告警（per-folder 去重）', () => {
  test('读到残留 legacy 键：告警一次，重复读取不再告警', () => {
    seedEnvFile('legacy-folder-a', {
      anthropicApiKey: 'sk-stale',
      anthropicBaseUrl: 'https://stale.example.com',
      customEnv: { FOO: 'bar' },
    });

    const first = rc.getContainerEnvConfig('legacy-folder-a');
    expect(first.customEnv).toEqual({ FOO: 'bar' });

    const calls = legacyWarnCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      folder: 'legacy-folder-a',
      legacyKeys: expect.arrayContaining(['anthropicBaseUrl', 'anthropicApiKey']),
    });

    // 热路径重复读取（buildAgentEnvLines 每次 spawn）：不刷屏
    rc.getContainerEnvConfig('legacy-folder-a');
    rc.getContainerEnvConfig('legacy-folder-a');
    expect(legacyWarnCalls()).toHaveLength(1);
  });

  test('纯 customEnv 配置（无残留）：零告警', () => {
    seedEnvFile('clean-folder', { customEnv: { BAR: 'baz' } });
    const cfg = rc.getContainerEnvConfig('clean-folder');
    expect(cfg.customEnv).toEqual({ BAR: 'baz' });
    expect(legacyWarnCalls()).toHaveLength(0);
  });

  test('去重按 folder 维度：另一个残留 folder 仍各自告警一次', () => {
    seedEnvFile('legacy-folder-b', { claudeCodeOauthToken: 'tok-stale' });
    rc.getContainerEnvConfig('legacy-folder-b');
    rc.getContainerEnvConfig('legacy-folder-b');

    const calls = legacyWarnCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({
      folder: 'legacy-folder-b',
      legacyKeys: ['claudeCodeOauthToken'],
    });
  });

  test('配置文件不存在：返回空对象、零告警', () => {
    expect(rc.getContainerEnvConfig('missing-folder')).toEqual({});
    expect(legacyWarnCalls()).toHaveLength(0);
  });
});
