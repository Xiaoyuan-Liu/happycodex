/**
 * 按 key 串行执行（单写者）：同一 key 的任务排队，不同 key 并发。
 *
 * 动机（Stage 4 多租户）：每 folder 一个 CODEX_HOME，rollout 文件无锁写入。若同一 folder 的
 * 两个 turn 重叠跑，会损坏 rollout（互操作调研 P0）。本队列保证「同 folder 严格串行、不同
 * folder 并发」，作为 per-folder 单写者闸门。
 *
 * 实现：内部 Map<key, Promise<unknown>> 维护每 key 的「尾巴」（最后一次入队任务的链尾）。run
 * 时把新 task 链到尾巴之后（`tail.then(run task)`）。对尾巴的 rejection 做隔离——前一个 task
 * 失败不应阻断后一个执行，故链接时吞掉尾巴异常（`tail.catch(()=>{})`），task 自身的成功/失败
 * 仍如实透传给该次 run 的调用方。
 *
 * 内存回收：每 key 用计数器记录「在跑+排队」的任务数；链尾任务结算后计数归零且当前尾巴仍是自己
 * 时，从 Map 删除该 key，避免空闲 key 永久占用内存。
 */

import type { ISerialQueue } from './types.js';

interface KeyState {
  /** 该 key 当前的链尾 Promise（最后一次入队任务结算后 resolve；rejection 已被隔离）。 */
  tail: Promise<unknown>;
  /** 在跑 + 排队的任务数（用于判断闲置以清理 Map）。 */
  pending: number;
}

export class SerialQueue implements ISerialQueue {
  private readonly states = new Map<string, KeyState>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    let state = this.states.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0 };
      this.states.set(key, state);
    }
    const s = state;
    s.pending += 1;

    // 链到当前尾巴之后；隔离前一个任务的 rejection，保证后续任务仍执行。
    const prevTail = s.tail;
    const result = prevTail.then(() => task());

    // 新尾巴：等本次 task 结算（无论成败）后 resolve，供下一个任务挂接。
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    s.tail = settled;

    // 本次任务结算后递减计数；若 key 已无任何在跑/排队任务且尾巴未被更新者覆盖，清理 Map 项。
    void settled.then(() => {
      s.pending -= 1;
      if (s.pending === 0 && this.states.get(key) === s) {
        this.states.delete(key);
      }
    });

    return result;
  }

  isBusy(key: string): boolean {
    const s = this.states.get(key);
    return s !== undefined && s.pending > 0;
  }
}
