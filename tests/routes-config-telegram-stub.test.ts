/**
 * Finding #19 regression: Telegram 渠道为 stub 时不得制造假成功信号。
 *
 * 覆盖矩阵：
 *   - POST /telegram/test（system）   → 501 + stub 说明（此前用真 grammy 校验
 *     token 并返回 success:true —— 「测试成功」但渠道永不可连）
 *   - POST /user-im/telegram/test     → 501 + stub 说明
 *   - PUT  /user-im/telegram 启用     → 响应附 lastError（前端灰点解释）
 *   - GET  /user-im/telegram          → 已启用 + 有 token + 未连接 → lastError
 *   - GET  /user-im/telegram（无配置）→ 不附 lastError
 *   - PUT  /user-im/telegram 停用     → 不附 lastError（仅在假象场景下解释）
 *   - PUT  /telegram（system）启用    → 响应附 lastError
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-tg-stub-'));
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

// 避免经 im-channel.js → feishu.js 拉起完整 web.js（Hono app + WebSocket，
// 模块顶层 mount 路由会撞上循环引用）。
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'alice',
        username: 'alice',
        role: 'admin',
        permissions: [],
      });
      return next();
    },
    systemConfigMiddleware: async (_c: any, next: any) => next(),
  };
});

const configRoutesModule = await import('../src/routes/config.js');
const { STUB_MESSAGE } = await import('../src/telegram.js');

const configRoutes = configRoutesModule.default;

async function request(
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await configRoutes.request(pathname, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function putJson(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  return request(pathname, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Telegram stub 诚实降级', () => {
  test('POST /telegram/test → 501 + stub 说明（不做真 token 校验）', async () => {
    const { status, body } = await request('/telegram/test', { method: 'POST' });
    expect(status).toBe(501);
    expect(body.error).toBe(STUB_MESSAGE);
    expect(body.success).toBeUndefined();
  });

  test('POST /user-im/telegram/test → 501 + stub 说明', async () => {
    const { status, body } = await request('/user-im/telegram/test', {
      method: 'POST',
    });
    expect(status).toBe(501);
    expect(body.error).toBe(STUB_MESSAGE);
  });

  test('GET /user-im/telegram（无配置）→ 不附 lastError', async () => {
    const { status, body } = await request('/user-im/telegram');
    expect(status).toBe(200);
    expect(body.hasBotToken).toBe(false);
    expect(body.lastError).toBeUndefined();
  });

  test('PUT /user-im/telegram 启用 → 响应附 lastError，GET 同样可见', async () => {
    const put = await putJson('/user-im/telegram', {
      botToken: '123456:test-token',
      enabled: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.hasBotToken).toBe(true);
    expect(put.body.connected).toBe(false);
    expect(put.body.lastError).toBe(STUB_MESSAGE);

    const get = await request('/user-im/telegram');
    expect(get.status).toBe(200);
    expect(get.body.enabled).toBe(true);
    expect(get.body.lastError).toBe(STUB_MESSAGE);
  });

  test('PUT /user-im/telegram 停用 → 不附 lastError', async () => {
    const put = await putJson('/user-im/telegram', { enabled: false });
    expect(put.status).toBe(200);
    expect(put.body.enabled).toBe(false);
    expect(put.body.lastError).toBeUndefined();
  });

  test('PUT /telegram（system）启用 → 响应附 lastError', async () => {
    const put = await putJson('/telegram', {
      botToken: '654321:system-token',
      enabled: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.hasBotToken).toBe(true);
    expect(put.body.connected).toBe(false);
    expect(put.body.lastError).toBe(STUB_MESSAGE);
  });
});
