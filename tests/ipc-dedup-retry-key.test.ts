/**
 * tests/ipc-dedup-retry-key.test.ts —— #F5 回归测试：IPC send_message 跨重试去重必须用
 * folder→真实 chatJid 反查（getJidsByFolder），而非 `web:${folder}`/`folder` 猜 retry key。
 *
 * 背景：GroupQueue 的 retryCount 以**真实 chatJid** 记账（普通群 web:<uuid>、IM 群 feishu:oc_xxx）；
 * 旧实现用 `web:${folder}` / `folder` 当 key 查 retry，仅 admin home（folder=jid=web:main）碰巧命中，
 * 对绝大多数群恒 inRetry=false → 去重 no-op。本测试以注入的 fake deps 直接 exercise createIpcSendDedup，
 * 钉死「真实 jid 的 retryCount 才决定 inRetry」这一契约；若回退成猜 key，最后两个断言会失败。
 */
import { describe, expect, test } from 'vitest';

import { createIpcSendDedup, IPC_SEND_DEDUP_TTL_MS } from '../src/ipc-dedup.js';

const FOLDER = 'bob';
const REAL_JID = 'web:uuid-abc-123'; // 普通群真实 chatJid，与 folder('bob') 不相等

/** retryByJid 决定哪些真实 jid 处于重试轮；clock 可推进以测 TTL。 */
function makeDedup(retryByJid: Record<string, number>) {
  let clock = 1_000;
  const dedup = createIpcSendDedup({
    getJidsByFolder: (f) => (f === FOLDER ? [REAL_JID] : []),
    getRetryCount: (jid) => retryByJid[jid] ?? 0,
    now: () => clock,
  });
  return { dedup, tick: (ms: number) => { clock += ms; } };
}

describe('createIpcSendDedup —— #F5 folder→真实 chatJid 反查', () => {
  test('首轮（无 jid 处于重试）相同文案不被抑制（fail-open）', () => {
    const { dedup } = makeDedup({}); // 没有任何 jid 在重试
    expect(dedup(FOLDER, REAL_JID, 'hello')).toBe(false); // 首次：仅落指纹
    expect(dedup(FOLDER, REAL_JID, 'hello')).toBe(false); // 重复但非重试轮 → 不抑制
  });

  test('重试重放窗口内，重复文案被抑制', () => {
    const { dedup } = makeDedup({ [REAL_JID]: 1 }); // 真实 jid 处于重试
    expect(dedup(FOLDER, REAL_JID, 'hello')).toBe(false); // 首次落指纹
    expect(dedup(FOLDER, REAL_JID, 'hello')).toBe(true); // 重放命中指纹 + inRetry → 抑制
  });

  test('回归守卫：retry 记在真实 jid 上而非 web:${folder}/folder，仍能检出', () => {
    // 旧 bug 实现会查 getRetryCount('web:bob')/getRetryCount('bob')（均为 0）→ 漏检；
    // 新实现经 getJidsByFolder 反查到 REAL_JID（retryCount=1）→ 检出。
    const { dedup } = makeDedup({ [REAL_JID]: 1, 'web:bob': 0, bob: 0 });
    expect(dedup(FOLDER, REAL_JID, 'dup')).toBe(false);
    expect(dedup(FOLDER, REAL_JID, 'dup')).toBe(true); // 回退成猜 key 会得 false → 本断言失败
  });

  test('不同文案各自独立（指纹含 text，per-message）', () => {
    const { dedup } = makeDedup({ [REAL_JID]: 1 });
    expect(dedup(FOLDER, REAL_JID, 'a')).toBe(false);
    expect(dedup(FOLDER, REAL_JID, 'b')).toBe(false); // 不同文案 → 各自首见，不抑制
  });

  test('TTL 过期后指纹失效，不再抑制', () => {
    const { dedup, tick } = makeDedup({ [REAL_JID]: 1 });
    expect(dedup(FOLDER, REAL_JID, 'x')).toBe(false); // 落指纹
    tick(IPC_SEND_DEDUP_TTL_MS + 1); // 超过 TTL
    expect(dedup(FOLDER, REAL_JID, 'x')).toBe(false); // 指纹已过期 → 视作首见，不抑制
  });

  test('folder 无任何注册 jid（getJidsByFolder 返回空）→ 永不抑制（fail-open）', () => {
    const { dedup } = makeDedup({ [REAL_JID]: 1 });
    // 用未知 folder：getJidsByFolder 返回 []，.some() 恒 false
    expect(dedup('unknown-folder', REAL_JID, 'x')).toBe(false);
    expect(dedup('unknown-folder', REAL_JID, 'x')).toBe(false);
  });
});
