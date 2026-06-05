/**
 * SerialQueue 单测 —— 按 key 串行（单写者），不同 key 并发。
 *
 * 覆盖契约（src/runtime/multitenant/types.ts ISerialQueue）：
 * - 同 key 严格串行：第二个 task 在第一个 settle 后才开始（用手动 release 的 deferred 断言重叠）。
 * - 不同 key 并发：两个 task 可同时在跑。
 * - 透传：task resolve/reject 原样透传给该次 run 的调用方。
 * - 容错隔离：同 key 前一个 task reject，不影响后一个执行。
 * - isBusy：排队/在跑时 true，全部结算后 false。
 * - FIFO：大量同 key 任务保持入队顺序。
 * - 无内存泄漏：空闲后内部 Map 清理（经 isBusy 间接验证 + 反射读 size）。
 */

import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../src/runtime/multitenant/serial-queue.js';

/** 手动控制结算时机的 deferred。 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让出微任务队列，确保已排队的 .then 链推进。 */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** 读内部 Map 大小（仅测试用，验证无泄漏）。 */
function internalSize(q: SerialQueue): number {
  return (q as unknown as { states: Map<string, unknown> }).states.size;
}

describe('SerialQueue', () => {
  it('同 key 严格串行：第二个 task 在第一个结算后才开始', async () => {
    const q = new SerialQueue();
    const events: string[] = [];
    const gate1 = deferred();

    const p1 = q.run('k', async () => {
      events.push('start1');
      await gate1.promise;
      events.push('end1');
    });

    const p2 = q.run('k', async () => {
      events.push('start2');
      events.push('end2');
    });

    // 此刻只有 task1 应已开始，task2 必须等待。
    await flush();
    expect(events).toEqual(['start1']);

    // 释放 task1 后 task2 才能跑。
    gate1.resolve();
    await Promise.all([p1, p2]);
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('不同 key 并发：两个 task 可同时在跑', async () => {
    const q = new SerialQueue();
    const started: string[] = [];
    const gateA = deferred();
    const gateB = deferred();

    const pa = q.run('a', async () => {
      started.push('a');
      await gateA.promise;
    });
    const pb = q.run('b', async () => {
      started.push('b');
      await gateB.promise;
    });

    // 两个不同 key 的 task 都应已开始（互不阻塞），尚未结算。
    await flush();
    expect(started.sort()).toEqual(['a', 'b']);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([pa, pb]);
  });

  it('透传 resolve 结果', async () => {
    const q = new SerialQueue();
    await expect(q.run('k', async () => 42)).resolves.toBe(42);
  });

  it('透传 reject，并且同 key 下一个 task 仍执行', async () => {
    const q = new SerialQueue();
    const events: string[] = [];
    const err = new Error('boom');

    const p1 = q.run('k', async () => {
      events.push('run1');
      throw err;
    });
    const p2 = q.run('k', async () => {
      events.push('run2');
      return 'ok';
    });

    await expect(p1).rejects.toBe(err);
    await expect(p2).resolves.toBe('ok');
    expect(events).toEqual(['run1', 'run2']);
  });

  it('isBusy：排队时 true，全部结算后 false', async () => {
    const q = new SerialQueue();
    const gate = deferred();

    expect(q.isBusy('k')).toBe(false);

    const p1 = q.run('k', async () => {
      await gate.promise;
    });
    const p2 = q.run('k', async () => {});

    // task1 在跑、task2 排队 → busy。
    await flush();
    expect(q.isBusy('k')).toBe(true);

    gate.resolve();
    await Promise.all([p1, p2]);
    await flush();
    expect(q.isBusy('k')).toBe(false);
  });

  it('isBusy 不受其他 key 影响', async () => {
    const q = new SerialQueue();
    const gate = deferred();
    const p = q.run('a', async () => {
      await gate.promise;
    });
    await flush();
    expect(q.isBusy('a')).toBe(true);
    expect(q.isBusy('b')).toBe(false);
    gate.resolve();
    await p;
  });

  it('大量同 key 任务保持 FIFO 顺序', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const N = 50;
    const ps: Array<Promise<void>> = [];

    for (let i = 0; i < N; i++) {
      ps.push(
        q.run('k', async () => {
          // 用一个微任务让出，模拟异步边界，验证仍然 FIFO 不重叠。
          await Promise.resolve();
          order.push(i);
        }),
      );
    }

    await Promise.all(ps);
    expect(order).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it('FIFO 在中途 reject 时保持（失败任务不打乱后续顺序）', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const ps: Array<Promise<unknown>> = [];

    for (let i = 0; i < 6; i++) {
      ps.push(
        q
          .run('k', async () => {
            await Promise.resolve();
            order.push(i);
            if (i % 2 === 0) throw new Error(`fail ${i}`);
            return i;
          })
          .catch(() => {
            /* 隔离失败，仅验证顺序 */
          }),
      );
    }

    await Promise.all(ps);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('空闲后内部 Map 不泄漏', async () => {
    const q = new SerialQueue();

    await q.run('a', async () => {});
    await q.run('b', async () => {});
    await flush();

    expect(q.isBusy('a')).toBe(false);
    expect(q.isBusy('b')).toBe(false);
    expect(internalSize(q)).toBe(0);
  });

  it('连续复用同一 key 后仍清理（计数归零判定正确）', async () => {
    const q = new SerialQueue();

    // 第一波。
    await Promise.all([q.run('k', async () => {}), q.run('k', async () => {})]);
    await flush();
    expect(internalSize(q)).toBe(0);

    // 第二波复用同 key。
    await q.run('k', async () => {});
    await flush();
    expect(internalSize(q)).toBe(0);
    expect(q.isBusy('k')).toBe(false);
  });

  it('新入队任务在前批仍在跑时不会被误清理', async () => {
    const q = new SerialQueue();
    const gate1 = deferred();

    const p1 = q.run('k', async () => {
      await gate1.promise;
    });
    await flush();
    expect(q.isBusy('k')).toBe(true);
    expect(internalSize(q)).toBe(1);

    // 在 task1 仍在跑时入队 task2。
    const p2 = q.run('k', async () => {});
    await flush();
    // 仍 busy，Map 项保留。
    expect(q.isBusy('k')).toBe(true);
    expect(internalSize(q)).toBe(1);

    gate1.resolve();
    await Promise.all([p1, p2]);
    await flush();
    expect(q.isBusy('k')).toBe(false);
    expect(internalSize(q)).toBe(0);
  });
});
