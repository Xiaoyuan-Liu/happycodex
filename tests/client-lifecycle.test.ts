/**
 * tests/client-lifecycle.test.ts —— AppServerClient 关停/超时根因回归（#1 / #2）。
 *
 * 用 tests/helpers/fake-codex.mjs 作为假 `codex app-server`：对 initialize 立即回应（让 start()
 * 解握手），对其它请求一律不回复（模拟"收下请求但永不回该 id 的响应"）。据此验证：
 *   #1 close() 设 closed 后**立即** reject 在途 pending，关停延迟与 OS 进程回收解耦
 *      （即便子进程忽略 SIGTERM 卡到 SIGKILL grace，调用方的 await request(...) 也不被阻塞 3s）。
 *   #2 默认 per-request 看门狗：响应丢失时 pending 在超时后 reject，而非永久挂起。
 */

import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

import { AppServerClient } from '../src/appserver/client.js';

const FAKE_CODEX = fileURLToPath(new URL('./helpers/fake-codex.mjs', import.meta.url));

describe('AppServerClient — #1 close() 立即结算在途 pending（与进程回收解耦）', () => {
  it('子进程忽略 SIGTERM 时，在途 request 仍在 close() 触发后立即 reject（远早于 3s SIGKILL grace）', async () => {
    const client = new AppServerClient({
      codexBin: FAKE_CODEX,
      env: { FAKE_CODEX_IGNORE_SIGTERM: '1' },
      // 关闭看门狗，隔离出"唯一结算路径只能来自 close()"的场景（否则超时也会 reject，混淆因果）。
      requestTimeoutMs: 0,
    });
    await client.start();

    // 发一个永不被回复的请求。
    const pending = client.request('turn/start', { threadId: 'th', input: [] });
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // 给请求一点时间写出。
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    // 关键：close() 自身仍会 await SIGTERM→grace→SIGKILL（子进程忽略 SIGTERM，故 close 约耗 3s）。
    // 但在途 pending 应在 close 设 closed 后**立即** reject，不被该 grace 阻塞。
    // 故在调用 close() 后**不 await 它**，直接测 pending 的 reject 延迟。
    const t0 = Date.now();
    const closing = client.close();
    await expect(pending).rejects.toThrow(/closing/i);
    const elapsed = Date.now() - t0;

    // pending 的 reject 远早于 3s SIGKILL grace（给足 CI 抖动余量）。
    expect(elapsed).toBeLessThan(2500);

    await closing; // 收尾，等 close 走完 grace（避免悬挂进程/未处理 promise）。
  }, 15000);
});

describe('AppServerClient — #2 默认 per-request 看门狗（响应丢失也能 reject）', () => {
  it('不传 requestTimeoutMs → 默认 60000ms 看门狗：进程存活但响应丢失时 pending 仍超时 reject（根因：默认非 0）', async () => {
    // 关键回归：缺省取值由 0（永不超时）改为 60000ms。不传 timeout 即获兜底。
    const client = new AppServerClient({ codexBin: FAKE_CODEX });
    await client.start(); // 真实 I/O 完成握手

    // 用 fake timers 把 60s 看门狗瞬间推满（start() 已用真实 timer 完成，之后切 fake 安全）。
    vi.useFakeTimers();
    try {
      const pending = client.request('turn/start', { threadId: 'th', input: [] });
      let msg = '';
      pending.catch((e: unknown) => {
        msg = e instanceof Error ? e.message : String(e);
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(msg).toMatch(/timed out after 60000ms/); // 默认值生效
    } finally {
      vi.useRealTimers();
    }

    await client.close();
  }, 15000);

  it('显式短超时使 pending 在超时后 reject（计时机制不变）', async () => {
    const client = new AppServerClient({
      codexBin: FAKE_CODEX,
      requestTimeoutMs: 300,
    });
    await client.start();

    const t0 = Date.now();
    await expect(client.request('turn/start', { threadId: 'th', input: [] })).rejects.toThrow(
      /timed out after 300ms/,
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);

    await client.close();
  }, 15000);

  it('requestTimeoutMs 显式传 0 → 永不超时（语义保留）：在超时窗口内不被自动 reject', async () => {
    const client = new AppServerClient({ codexBin: FAKE_CODEX, requestTimeoutMs: 0 });
    await client.start();

    const pending = client.request('turn/start', { threadId: 'th', input: [] });
    let settled = false;
    pending.catch(() => {
      settled = true;
    });

    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false); // 传 0 → 无看门狗，不自动结算

    await client.close(); // close 结算它（避免 unhandled rejection）
    await expect(pending).rejects.toThrow();
  }, 15000);
});
