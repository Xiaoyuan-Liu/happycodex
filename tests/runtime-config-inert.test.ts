/**
 * Finding #13 regression: runtime-config 的 Claude provider 体系必须「只读惰性」。
 *
 * 上游行为（已 tombstone 停用）：
 *   - 读取旧版 claude-provider.json（V3 及更老）触发 V3→V4 自动迁移回写；
 *   - 读取期 decryptSecrets → getOrCreateEncryptionKey 首次生成并落盘加密 key；
 *   - getClaudeProviderConfig 从 ANTHROPIC_* 环境变量兜底拼装活配置；
 *   - buildContainerEnvLines 向容器 env 透传 ANTHROPIC_* 与 CLAUDE_CODE_OAUTH_TOKEN；
 *   - updateAllSessionCredentials / writeCredentialsFile 批量回写 .credentials.json；
 *   - detectLocalClaudeCode / importLocalClaudeCredentials 直读宿主机 ~/.claude。
 *
 * 覆盖矩阵：
 *   - 读取期零副作用：存量 V3 文件读取后字节不变、不生成 key 文件
 *   - 读取函数空态：getProviders/getEnabledProviders → []，getBalancingConfig →
 *     默认值，getClaudeProviderConfig → 全空（env 兜底停用）
 *   - 写路径禁用：全部 CRUD 抛错且零落盘
 *   - credentials 机器 no-op；本地 Claude Code 检测恒「未检测/空」
 *   - buildContainerEnvLines 仅注入净化后的 customEnv，不透传 provider 字段
 *   - 通道密文机器保持活体：Feishu 配置加密往返成功（key 仅在该写路径合法生成）
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const nodeFs = await import('fs');
  const nodeOs = await import('os');
  const nodePath = await import('path');
  const dataDir = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'happycodex-rcfg-inert-'),
  );
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: nodePath.join(dataDir, 'groups'),
    STORE_DIR: nodePath.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { DATA_DIR } = await import('../src/config.js');
const rc = await import('../src/runtime-config.js');

const CONFIG_DIR = path.join(DATA_DIR, 'config');
const PROVIDER_FILE = path.join(CONFIG_DIR, 'claude-provider.json');
const KEY_FILE = path.join(CONFIG_DIR, 'claude-provider.key');

const EMPTY_CONFIG = {
  anthropicBaseUrl: '',
  anthropicAuthToken: '',
  anthropicApiKey: '',
  claudeCodeOauthToken: '',
  claudeOAuthCredentials: null,
  anthropicModel: '',
};

function seedV3ProviderFile(): string {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const v3 = {
    version: 3,
    activeProfileId: '__official__',
    profiles: [],
    official: {
      updatedAt: '2024-01-01T00:00:00.000Z',
      secrets: { iv: 'aXY=', tag: 'dGFn', data: 'ZGF0YQ==' },
    },
  };
  const content = JSON.stringify(v3, null, 2) + '\n';
  fs.writeFileSync(PROVIDER_FILE, content, 'utf-8');
  return content;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('读取期零副作用（V3→V4 自动回写 + key 首次落盘 已停用）', () => {
  test('读取存量 V3 claude-provider.json：文件字节不变、不生成加密 key', () => {
    const before = seedV3ProviderFile();

    expect(rc.getProviders()).toEqual([]);
    expect(rc.getEnabledProviders()).toEqual([]);
    expect(rc.getBalancingConfig()).toEqual({
      strategy: 'round-robin',
      unhealthyThreshold: 3,
      recoveryIntervalMs: 300_000,
    });
    expect(rc.getActiveProfileCustomEnv()).toEqual({});
    expect(rc.getCustomEnvForProfile('__official__')).toEqual({});
    expect(rc.resolveProviderById('anything')).toEqual({
      config: { ...EMPTY_CONFIG, updatedAt: null },
      customEnv: {},
    });

    // 上游会在首次读取时把 V3 重写为 V4 —— 现在必须原样保留
    const after = fs.readFileSync(PROVIDER_FILE, 'utf-8');
    expect(after).toBe(before);
    expect((JSON.parse(after) as { version: number }).version).toBe(3);
    // 上游 decryptSecrets → getOrCreateEncryptionKey 会首次生成 key 文件
    expect(fs.existsSync(KEY_FILE)).toBe(false);
  });

  test('getClaudeProviderConfig 空态：ANTHROPIC_* env 兜底已停用', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://leak.example.com');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-auth-token');
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-api-key');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'env-oauth-token');
    vi.stubEnv('ANTHROPIC_MODEL', 'env-model');

    expect(rc.getClaudeProviderConfig()).toEqual({
      ...EMPTY_CONFIG,
      updatedAt: null,
    });
    expect(rc.resolveProfileToConfig('default')).toEqual({
      ...EMPTY_CONFIG,
      updatedAt: null,
    });
  });
});

describe('写路径禁用（CRUD 抛错且零落盘）', () => {
  test('全部 provider 写入口抛错', () => {
    const before = fs.readFileSync(PROVIDER_FILE, 'utf-8');

    expect(() =>
      rc.saveClaudeProviderConfig({ ...EMPTY_CONFIG, anthropicApiKey: 'sk-x' }),
    ).toThrow(/已停用/);
    expect(() =>
      rc.saveClaudeProviderConfig({
        ...EMPTY_CONFIG,
        anthropicBaseUrl: 'https://api.example.com',
        anthropicAuthToken: 'tok',
      }),
    ).toThrow(/已停用/);
    expect(() =>
      rc.saveClaudeOfficialProviderSecrets({
        anthropicApiKey: 'sk-x',
        claudeCodeOauthToken: '',
        claudeOAuthCredentials: null,
      }),
    ).toThrow(/已停用/);
    expect(() =>
      rc.createProvider({ name: 'p1', type: 'official' }),
    ).toThrow(/已停用/);
    expect(() => rc.saveBalancingConfig({ strategy: 'failover' })).toThrow(
      /已停用/,
    );
    expect(() =>
      rc.createClaudeThirdPartyProfile({
        name: 'n',
        anthropicBaseUrl: 'https://api.example.com',
        anthropicAuthToken: 't',
      }),
    ).toThrow(/已停用/);

    // readStored* 恒 null → 这些走「配置不存在」分支，同样是禁用态
    expect(() => rc.updateProvider('x', { name: 'y' })).toThrow();
    expect(() => rc.updateProviderSecrets('x', {})).toThrow();
    expect(() => rc.toggleProvider('x')).toThrow();
    expect(() => rc.deleteProvider('x')).toThrow();
    expect(() => rc.updateClaudeThirdPartyProfile('x', {})).toThrow();
    expect(() => rc.updateClaudeThirdPartyProfileSecret('x', {})).toThrow();
    expect(() => rc.activateClaudeThirdPartyProfile('x')).toThrow();
    expect(() => rc.deleteClaudeThirdPartyProfile('x')).toThrow();
    expect(() => rc.saveOfficialCustomEnv({ FOO: 'bar' })).toThrow();

    // 抛错前后零落盘：配置文件原样、key 文件依旧不存在
    expect(fs.readFileSync(PROVIDER_FILE, 'utf-8')).toBe(before);
    expect(fs.existsSync(KEY_FILE)).toBe(false);
  });
});

describe('credentials 机器停用', () => {
  test('updateAllSessionCredentials / writeCredentialsFile 为 no-op', () => {
    const claudeDir = path.join(DATA_DIR, 'sessions', 'main', '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const config = {
      ...EMPTY_CONFIG,
      claudeOAuthCredentials: {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 1234567890,
        scopes: ['user:inference'],
      },
      updatedAt: null,
    };

    rc.updateAllSessionCredentials(config);
    rc.writeCredentialsFile(claudeDir, config);

    expect(fs.existsSync(path.join(claudeDir, '.credentials.json'))).toBe(
      false,
    );
  });

  test('detectLocalClaudeCode / importLocalClaudeCredentials 不读宿主机 ~/.claude', () => {
    const fakeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happycodex-rcfg-home-'),
    );
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'local-at',
          refreshToken: 'local-rt',
          expiresAt: 99,
          scopes: [],
        },
      }),
      'utf-8',
    );
    vi.stubEnv('HOME', fakeHome);

    expect(rc.detectLocalClaudeCode()).toEqual({
      detected: false,
      hasCredentials: false,
      expiresAt: null,
      accessTokenMasked: null,
    });
    expect(rc.importLocalClaudeCredentials()).toBeNull();
  });
});

describe('buildContainerEnvLines 不再透传 provider 字段', () => {
  test('仅注入净化后的 profileCustomEnv 与 override.customEnv', () => {
    const lines = rc.buildContainerEnvLines(
      {
        ...EMPTY_CONFIG,
        anthropicBaseUrl: 'https://global.example.com',
        anthropicApiKey: 'global-key',
        anthropicModel: 'global-model',
        updatedAt: null,
      },
      {
        anthropicBaseUrl: 'https://override.example.com',
        anthropicAuthToken: 'override-token',
        claudeCodeOauthToken: 'override-oauth',
        customEnv: {
          FOO: 'bar',
          LD_PRELOAD: 'evil.so', // DANGEROUS_ENV_VARS → 拦截
          'BAD-KEY': 'x', // 非法 env key → 拦截
        },
      },
      {
        HELLO: 'world',
        ANTHROPIC_BASE_URL: 'https://leak.example.com', // RESERVED → 拦截
      },
    );

    expect(lines).toEqual(['HELLO=world', 'FOO=bar']);
    expect(lines.join('\n')).not.toMatch(/ANTHROPIC|CLAUDE_CODE_OAUTH/);
  });
});

describe('通道密文机器保持活体（不可过度惰性化）', () => {
  test('Feishu 配置加密往返成功，key 仅在该写路径合法生成', () => {
    expect(fs.existsSync(KEY_FILE)).toBe(false);

    rc.saveFeishuProviderConfig({
      appId: 'cli_test123',
      appSecret: 'feishu-secret-value',
      enabled: true,
    });

    // encryptChannelSecret → getOrCreateEncryptionKey：写路径合法生成 key
    expect(fs.existsSync(KEY_FILE)).toBe(true);

    const { config, source } = rc.getFeishuProviderConfigWithSource();
    expect(source).toBe('runtime');
    expect(config.appId).toBe('cli_test123');
    expect(config.appSecret).toBe('feishu-secret-value');
  });
});
