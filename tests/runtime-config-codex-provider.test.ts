/**
 * runtime-config per-user codex 自定义模型 provider 读写/加密/脱敏/删除/校验单测。
 *
 * 对标既有 Feishu/Telegram per-user 加密范式（encryptChannelSecret + writeSecretFile 0o600），
 * 钉死契约：
 *   - saveUserCodexProvider：name → slug id、baseUrl https 校验、wireApi 默认 responses、
 *     apiKey 加密落盘（0o600）、apiKey 可选（未传保留旧 key / 空串清空）。
 *   - getUserCodexProvider：apiKey 解密（内部用），无配置 / 损坏 → null。
 *   - toPublicCodexProvider：脱敏（hasApiKey + 末 4 位 mask，绝不回明文）。
 *   - deleteUserCodexProvider：幂等删除。
 *   - hasUserCodexProvider：provider.json 存在性。
 *   - userId 逃逸校验（userImDir 同款白名单）。
 *
 * config.js 重定向到临时 DATA_DIR：落盘 data/config/user-im/{userId}/codex/provider.json
 * 与加密 key（claude-provider.key）都落 tmp，不写仓库 data/。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const nodeFs = await import('fs');
  const nodeOs = await import('os');
  const nodePath = await import('path');
  const dataDir = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'happycodex-codex-prov-'),
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

const USER = 'u-codex-1';

function providerFile(userId: string): string {
  return path.join(DATA_DIR, 'config', 'user-im', userId, 'codex', 'provider.json');
}

// 每个 case 之间清掉该用户目录，避免「保留旧 key」逻辑跨用例串味。
afterEach(() => {
  const dir = path.join(DATA_DIR, 'config', 'user-im');
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('saveUserCodexProvider — 落盘 + 加密 + slug + 校验', () => {
  test('保存返回脱敏视图：slug id、wireApi 默认 responses、apiKey mask（不回明文）', () => {
    const pub = rc.saveUserCodexProvider(USER, {
      name: 'GLM Provider',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.6',
      apiKey: 'sk-secret-abcd1234',
    });

    expect(pub.id).toBe('glm-provider'); // [a-z0-9-] 小写 slug
    expect(pub.name).toBe('GLM Provider');
    expect(pub.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(pub.model).toBe('glm-4.6');
    expect(pub.wireApi).toBe('responses'); // 默认
    expect(pub.hasApiKey).toBe(true);
    expect(pub.apiKeyMask).toBe('••••1234');
    expect(typeof pub.updatedAt).toBe('string');
    // 脱敏视图绝不含明文 apiKey 字段。
    expect((pub as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain('sk-secret-abcd1234');
  });

  test('落盘文件：apiKey 加密（密文不含明文）、权限 0o600、version 1', () => {
    rc.saveUserCodexProvider(USER, {
      name: 'custom',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      apiKey: 'sk-plaintext-xyz',
    });

    const file = providerFile(USER);
    expect(fs.existsSync(file)).toBe(true);

    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.id).toBe('custom');
    // apiKey 明文绝不出现在落盘字节里（只在 encrypted secret 内）。
    expect(raw).not.toContain('sk-plaintext-xyz');
    expect(parsed.secret).toMatchObject({
      iv: expect.any(String),
      tag: expect.any(String),
      data: expect.any(String),
    });

    // 文件权限 0o600（与 writeSecretFile 钉死语义一致）。
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('wireApi 可显式 chat；空 name slug 回退 custom', () => {
    const pub = rc.saveUserCodexProvider(USER, {
      name: '!!!', // slug 化后为空 → 回退 custom
      baseUrl: 'https://api.example.com',
      model: 'm',
      wireApi: 'chat',
      apiKey: 'k',
    });
    expect(pub.id).toBe('custom');
    expect(pub.wireApi).toBe('chat');
  });

  test('baseUrl 非 https → 抛错且不落盘', () => {
    expect(() =>
      rc.saveUserCodexProvider(USER, {
        name: 'p',
        baseUrl: 'http://insecure.example.com',
        model: 'm',
        apiKey: 'k',
      }),
    ).toThrow(/baseUrl/);
    expect(fs.existsSync(providerFile(USER))).toBe(false);
  });

  test('baseUrl 非法 URL → 抛错', () => {
    expect(() =>
      rc.saveUserCodexProvider(USER, {
        name: 'p',
        baseUrl: 'not-a-url',
        model: 'm',
        apiKey: 'k',
      }),
    ).toThrow(/baseUrl/);
  });

  test('name 空 / 非字符串 → 抛错', () => {
    expect(() =>
      rc.saveUserCodexProvider(USER, {
        name: '   ',
        baseUrl: 'https://api.example.com',
        model: 'm',
        apiKey: 'k',
      }),
    ).toThrow(/name/);
  });

  test('model 空 → 抛错', () => {
    expect(() =>
      rc.saveUserCodexProvider(USER, {
        name: 'p',
        baseUrl: 'https://api.example.com',
        model: '   ',
        apiKey: 'k',
      }),
    ).toThrow(/model/);
  });

  test('name/model 含控制字符 → 抛错且不落盘（否则破坏 config.toml）', () => {
    // ESC (U+001B) 在 name。
    expect(() =>
      rc.saveUserCodexProvider(USER, {
        name: 'Ev\x1bil',
        baseUrl: 'https://api.example.com',
        model: 'm',
        apiKey: 'k',
      }),
    ).toThrow(/name/);
    // U+2028 行分隔符在 model。
    expect(() =>
      rc.saveUserCodexProvider(USER, {
        name: 'p',
        baseUrl: 'https://api.example.com',
        model: 'glm\u20284',
        apiKey: 'k',
      }),
    ).toThrow(/model/);
    expect(fs.existsSync(providerFile(USER))).toBe(false);
  });

  test('apiKey 未传（仅改 model/baseUrl）→ 保留旧 key', () => {
    rc.saveUserCodexProvider(USER, {
      name: 'p',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      apiKey: 'sk-original-9999',
    });

    // 二次保存不带 apiKey：旧 key 应被保留。
    const pub = rc.saveUserCodexProvider(USER, {
      name: 'p',
      baseUrl: 'https://api.example.com/v2',
      model: 'm2',
    });
    expect(pub.model).toBe('m2');
    expect(pub.hasApiKey).toBe(true);
    expect(pub.apiKeyMask).toBe('••••9999');

    const internal = rc.getUserCodexProvider(USER);
    expect(internal?.apiKey).toBe('sk-original-9999'); // 解密后还是旧 key
    expect(internal?.model).toBe('m2');
  });

  test('apiKey 传空串 → 清空 key（hasApiKey 变 false）', () => {
    rc.saveUserCodexProvider(USER, {
      name: 'p',
      baseUrl: 'https://api.example.com',
      model: 'm',
      apiKey: 'sk-will-be-cleared',
    });

    const pub = rc.saveUserCodexProvider(USER, {
      name: 'p',
      baseUrl: 'https://api.example.com',
      model: 'm',
      apiKey: '',
    });
    expect(pub.hasApiKey).toBe(false);
    expect(pub.apiKeyMask).toBeNull();
    expect(rc.getUserCodexProvider(USER)?.apiKey).toBe('');
  });
});

describe('getUserCodexProvider — 解密往返 + 空态', () => {
  test('保存后读回：apiKey 解密为明文（内部使用）', () => {
    rc.saveUserCodexProvider(USER, {
      name: 'GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.6',
      apiKey: 'sk-roundtrip-key',
    });

    const got = rc.getUserCodexProvider(USER);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      id: 'glm',
      name: 'GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.6',
      wireApi: 'responses',
      apiKey: 'sk-roundtrip-key',
    });
  });

  test('无配置 → null', () => {
    expect(rc.getUserCodexProvider('nobody')).toBeNull();
  });

  test('损坏文件（非 JSON）→ null（不抛）', () => {
    const file = providerFile(USER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all', 'utf-8');
    expect(rc.getUserCodexProvider(USER)).toBeNull();
  });

  test('version 非 1 → null', () => {
    const file = providerFile(USER);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99 }), 'utf-8');
    expect(rc.getUserCodexProvider(USER)).toBeNull();
  });
});

describe('toPublicCodexProvider — 脱敏', () => {
  test('返回 hasApiKey + mask，绝不含明文', () => {
    rc.saveUserCodexProvider(USER, {
      name: 'GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.6',
      apiKey: 'sk-very-secret-7788',
    });

    const pub = rc.toPublicCodexProvider(USER);
    expect(pub).not.toBeNull();
    expect(pub).toMatchObject({
      id: 'glm',
      name: 'GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.6',
      wireApi: 'responses',
      hasApiKey: true,
      apiKeyMask: '••••7788',
    });
    // 明文绝不出现。
    expect((pub as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain('sk-very-secret-7788');
  });

  test('无配置 → null', () => {
    expect(rc.toPublicCodexProvider('nobody')).toBeNull();
  });

  test('空 apiKey → hasApiKey=false、mask=null', () => {
    rc.saveUserCodexProvider(USER, {
      name: 'p',
      baseUrl: 'https://api.example.com',
      model: 'm',
      apiKey: '',
    });
    const pub = rc.toPublicCodexProvider(USER);
    expect(pub?.hasApiKey).toBe(false);
    expect(pub?.apiKeyMask).toBeNull();
  });
});

describe('deleteUserCodexProvider / hasUserCodexProvider', () => {
  test('删除后 has=false、读回 null；二次删除幂等不抛', () => {
    rc.saveUserCodexProvider(USER, {
      name: 'p',
      baseUrl: 'https://api.example.com',
      model: 'm',
      apiKey: 'k',
    });
    expect(rc.hasUserCodexProvider(USER)).toBe(true);

    rc.deleteUserCodexProvider(USER);
    expect(rc.hasUserCodexProvider(USER)).toBe(false);
    expect(rc.getUserCodexProvider(USER)).toBeNull();

    // 幂等：再删一次不报错。
    expect(() => rc.deleteUserCodexProvider(USER)).not.toThrow();
  });

  test('未配置时 hasUserCodexProvider=false', () => {
    expect(rc.hasUserCodexProvider('nobody')).toBe(false);
  });
});

describe('userId 逃逸校验（userImDir 同款白名单）', () => {
  test.each(['../escape', 'a/b', 'a\\b', '..', 'with space', ''])(
    '非法 userId %j → save/has 抛 Invalid userId',
    (bad) => {
      expect(() =>
        rc.saveUserCodexProvider(bad, {
          name: 'p',
          baseUrl: 'https://api.example.com',
          model: 'm',
          apiKey: 'k',
        }),
      ).toThrow(/Invalid userId/);
      expect(() => rc.hasUserCodexProvider(bad)).toThrow(/Invalid userId/);
    },
  );

  test('合法 userId（字母/数字/下划线/连字符）通过', () => {
    expect(() =>
      rc.saveUserCodexProvider('User_1-x', {
        name: 'p',
        baseUrl: 'https://api.example.com',
        model: 'm',
        apiKey: 'k',
      }),
    ).not.toThrow();
    expect(rc.hasUserCodexProvider('User_1-x')).toBe(true);
  });
});
