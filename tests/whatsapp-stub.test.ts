/**
 * Finding #18 regression: WhatsApp stub 的 connect() 必须在抛错前把
 * stubState（status='disconnected' + error=STUB_MESSAGE）推给
 * opts.onConnectionUpdate（镜像上游 setState→onConnectionUpdate 契约）。
 * 否则 im-manager 缓存不到 stub 原因（lastWhatsAppState），
 * 前端 WhatsAppChannelCard 的「断线原因」块成为不可达死代码 ——
 * 用户启用/重连只看到成功 toast，二维码永不出现且无任何解释。
 */
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const { createWhatsAppConnection } = await import('../src/whatsapp.js');

function makeConnection() {
  return createWhatsAppConnection({ authDir: '/tmp/happycodex-wa-stub-test' });
}

describe('WhatsApp stub connect()', () => {
  test('抛错前推送 disconnected + stub error 给 onConnectionUpdate', async () => {
    const conn = makeConnection();
    const onConnectionUpdate = vi.fn();

    await expect(
      conn.connect({ onNewChat: () => {}, onConnectionUpdate }),
    ).rejects.toThrow(/WhatsApp 渠道未搬迁/);

    expect(onConnectionUpdate).toHaveBeenCalledTimes(1);
    const state = onConnectionUpdate.mock.calls[0]![0];
    expect(state.status).toBe('disconnected');
    expect(state.error).toMatch(/WhatsApp 渠道未搬迁/);
  });

  test('onConnectionUpdate 抛错不掩盖 stub 主错误', async () => {
    const conn = makeConnection();
    await expect(
      conn.connect({
        onNewChat: () => {},
        onConnectionUpdate: () => {
          throw new Error('callback boom');
        },
      }),
    ).rejects.toThrow(/WhatsApp 渠道未搬迁/);
  });

  test('未提供 onConnectionUpdate 时仍正常抛 stub 错误', async () => {
    const conn = makeConnection();
    await expect(conn.connect({ onNewChat: () => {} })).rejects.toThrow(
      /WhatsApp 渠道未搬迁/,
    );
  });

  test('getState() 返回 stub 断线快照，isConnected() 恒为 false', () => {
    const conn = makeConnection();
    expect(conn.isConnected()).toBe(false);
    const state = conn.getState();
    expect(state.status).toBe('disconnected');
    expect(state.error).toMatch(/WhatsApp 渠道未搬迁/);
  });
});
