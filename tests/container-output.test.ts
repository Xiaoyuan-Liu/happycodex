/**
 * ContainerOutput 信封映射单测 —— 纯函数 (state, StreamEvent) → { state', outputs }。
 *
 * 契约对齐上游 HappyClaw（upstream-happyclaw/src/container-runner.ts ContainerOutput +
 * container/agent-runner/src/index.ts writeOutput/emit 的发法 +
 * src/agent-output-parser.ts 的消费语义）：
 *   stream 包裹 / success 累积文本+newSessionId / error / closed /
 *   interrupted（stream 信封 + statusText:'interrupted' + newSessionId）/
 *   threadId 未知不带 newSessionId / 多轮累积清零。
 */

import { describe, expect, it } from 'vitest';

import {
  closedOutput,
  createContainerOutputState,
  errorOutput,
  mapStreamEventToOutputs,
  type ContainerOutput,
  type ContainerOutputMapperState,
} from '../src/container-output.js';
import type { StreamEvent } from '../src/shared/stream-event.js';

/** 依次喂事件，滚动 state，返回全量信封（模拟 agent-runner sink 的逐条处理）。 */
function run(events: StreamEvent[], initial?: ContainerOutputMapperState): {
  state: ContainerOutputMapperState;
  outputs: ContainerOutput[];
} {
  let state = initial ?? createContainerOutputState();
  const outputs: ContainerOutput[] = [];
  for (const ev of events) {
    const r = mapStreamEventToOutputs(state, ev);
    state = r.state;
    outputs.push(...r.outputs);
  }
  return { state, outputs };
}

const init = (threadId: string): StreamEvent => ({ eventType: 'init', threadId });
const delta = (text: string): StreamEvent => ({ eventType: 'text_delta', text });

describe('ContainerOutput — stream 包裹', () => {
  it('普通事件 → {status:"stream", result:null, streamEvent:原事件}', () => {
    const ev: StreamEvent = {
      eventType: 'tool_use_start',
      toolName: 'ls',
      toolUseId: 'it_1',
      threadId: 'th_1',
    };
    const { outputs } = run([ev]);
    expect(outputs).toEqual([
      { status: 'stream', result: null, streamEvent: ev, newSessionId: 'th_1' },
    ]);
  });

  it('threadId 未知时 stream 信封不带 newSessionId', () => {
    const ev = delta('hello');
    const { outputs } = run([ev]);
    expect(outputs).toEqual([{ status: 'stream', result: null, streamEvent: ev }]);
    expect(outputs[0]).not.toHaveProperty('newSessionId');
  });

  it('init 确立 threadId 后，后续 stream 信封都带 newSessionId（主进程可尽早持久化）', () => {
    const { outputs } = run([init('th_main'), delta('hi')]);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.newSessionId).toBe('th_main');
    expect(outputs[1]?.newSessionId).toBe('th_main');
    expect(outputs[1]?.status).toBe('stream');
    expect(outputs[1]?.streamEvent?.eventType).toBe('text_delta');
  });
});

describe('ContainerOutput — success 终态（result completed）', () => {
  it('累积本轮 text_delta，result completed → success（累积文本 + newSessionId）', () => {
    const { outputs } = run([
      init('th_1'),
      delta('Hello '),
      { eventType: 'thinking_delta', text: 'IGNORED', threadId: 'th_1' }, // 思考不入正文
      delta('world'),
      { eventType: 'result', subtype: 'completed', turnId: 'tn_1', threadId: 'th_1' },
    ]);
    const final = outputs[outputs.length - 1];
    expect(final).toEqual({
      status: 'success',
      result: 'Hello world',
      newSessionId: 'th_1',
      sourceKind: 'sdk_final',
      finalizationReason: 'completed',
      turnId: 'tn_1',
    });
  });

  it('result 事件不再以 stream 信封透传（终态语义由信封 status 承载，对齐上游）', () => {
    const { outputs } = run([init('th_1'), { eventType: 'result', subtype: 'completed' }]);
    const resultWrapped = outputs.filter((o) => o.streamEvent?.eventType === 'result');
    expect(resultWrapped).toEqual([]);
    expect(outputs[outputs.length - 1]?.status).toBe('success');
  });

  it('无累积文本的 completed → result:null（对齐上游静默成功的 session-update 形态）', () => {
    const { outputs } = run([init('th_1'), { eventType: 'result', subtype: 'completed' }]);
    const final = outputs[outputs.length - 1];
    expect(final?.status).toBe('success');
    expect(final?.result).toBeNull();
    expect(final?.newSessionId).toBe('th_1');
  });

  it('subtype 缺省按 completed 处理（mapper 对未知 turn status 的兜底同向）', () => {
    const { outputs } = run([init('th_1'), delta('ok'), { eventType: 'result' }]);
    expect(outputs[outputs.length - 1]).toMatchObject({ status: 'success', result: 'ok' });
  });

  it('threadId 未知时 success 不带 newSessionId', () => {
    const { outputs } = run([delta('x'), { eventType: 'result', subtype: 'completed' }]);
    const final = outputs[outputs.length - 1];
    expect(final?.status).toBe('success');
    expect(final).not.toHaveProperty('newSessionId');
  });
});

describe('ContainerOutput — error 终态（result failed）', () => {
  it('failed 带 statusText → {status:"error", error:statusText, result:null}', () => {
    const { outputs } = run([
      init('th_1'),
      { eventType: 'result', subtype: 'failed', statusText: 'app-server closed (code=1 signal=null)' },
    ]);
    const final = outputs[outputs.length - 1];
    expect(final).toEqual({
      status: 'error',
      result: null,
      error: 'app-server closed (code=1 signal=null)',
      finalizationReason: 'error',
      newSessionId: 'th_1',
    });
  });

  it('failed 无 statusText → error 兜底 "agent failed"', () => {
    const { outputs } = run([{ eventType: 'result', subtype: 'failed' }]);
    expect(outputs).toEqual([
      { status: 'error', result: null, error: 'agent failed', finalizationReason: 'error' },
    ]);
  });

  it('failed 清空累积正文（失败轮的部分文本不混入下一轮 success）', () => {
    const { outputs } = run([
      init('th_1'),
      delta('partial'),
      { eventType: 'result', subtype: 'failed' },
      delta('next turn'),
      { eventType: 'result', subtype: 'completed' },
    ]);
    const final = outputs[outputs.length - 1];
    expect(final).toMatchObject({ status: 'success', result: 'next turn' });
  });
});

describe('ContainerOutput — interrupted（对齐上游发法）', () => {
  it('result interrupted → stream 信封 + status/interrupted 事件 + newSessionId', () => {
    const { outputs } = run([
      init('th_1'),
      delta('partial text'),
      { eventType: 'result', subtype: 'interrupted', turnId: 'tn_1' },
    ]);
    const final = outputs[outputs.length - 1];
    // 上游 agent-output-parser 检测条件：status==='stream' && streamEvent.statusText==='interrupted'。
    expect(final?.status).toBe('stream');
    expect(final?.result).toBeNull();
    expect(final?.streamEvent?.statusText).toBe('interrupted');
    expect(final?.streamEvent?.eventType).toBe('status');
    // 上游中断标记带 newSessionId：确保主进程持久化 session ID。
    expect(final?.newSessionId).toBe('th_1');
    // 不产生 success/error 终态。
    expect(outputs.some((o) => o.status === 'success' || o.status === 'error')).toBe(false);
  });

  it('interrupted 清空累积正文（被中断轮的文本不泄漏到下一轮 success）', () => {
    const { outputs } = run([
      init('th_1'),
      delta('interrupted half'),
      { eventType: 'result', subtype: 'interrupted' },
      delta('fresh'),
      { eventType: 'result', subtype: 'completed' },
    ]);
    expect(outputs[outputs.length - 1]).toMatchObject({ status: 'success', result: 'fresh' });
  });
});

describe('ContainerOutput — 多轮累积清零', () => {
  it('两轮各自 success，第二轮不携带第一轮文本', () => {
    const { outputs } = run([
      init('th_1'),
      delta('AAA'),
      { eventType: 'result', subtype: 'completed', turnId: 'tn_1' },
      delta('BBB'),
      { eventType: 'result', subtype: 'completed', turnId: 'tn_2' },
    ]);
    const finals = outputs.filter((o) => o.status === 'success');
    expect(finals.map((o) => o.result)).toEqual(['AAA', 'BBB']);
    expect(finals.map((o) => o.turnId)).toEqual(['tn_1', 'tn_2']);
  });
});

describe('ContainerOutput — 子代理 scope 隔离', () => {
  it('subagent 的 text_delta 不计入主轮累积正文，但仍以 stream 信封透传', () => {
    const subDelta: StreamEvent = {
      eventType: 'text_delta',
      text: 'CHILD',
      threadId: 'th_child',
      agentScope: 'subagent',
    };
    const { outputs } = run([
      init('th_main'),
      delta('MAIN'),
      subDelta,
      { eventType: 'result', subtype: 'completed' },
    ]);
    expect(outputs.filter((o) => o.status === 'stream' && o.streamEvent === subDelta)).toHaveLength(1);
    expect(outputs[outputs.length - 1]).toMatchObject({ status: 'success', result: 'MAIN' });
  });

  it('subagent 的 result 不触发终态（主轮还在飞），仅 stream 透传', () => {
    const subResult: StreamEvent = {
      eventType: 'result',
      subtype: 'completed',
      agentScope: 'subagent',
      threadId: 'th_child',
    };
    const { outputs } = run([init('th_main'), delta('MAIN'), subResult]);
    expect(outputs.some((o) => o.status === 'success')).toBe(false);
    expect(outputs[outputs.length - 1]?.streamEvent).toBe(subResult);
  });

  it('subagent 事件的 threadId 不劫持主线程 newSessionId', () => {
    const { outputs } = run([
      init('th_main'),
      { eventType: 'text_delta', text: 'c', threadId: 'th_child', agentScope: 'subagent' },
      { eventType: 'result', subtype: 'completed' },
    ]);
    expect(outputs[outputs.length - 1]?.newSessionId).toBe('th_main');
  });

  it('threadId 未确立时，subagent 事件也不兜底采纳 threadId', () => {
    const { state } = run([
      { eventType: 'text_delta', text: 'c', threadId: 'th_child', agentScope: 'subagent' },
    ]);
    expect(state.threadId).toBeUndefined();
  });
});

describe('ContainerOutput — threadId 采纳规则', () => {
  it('init 之前的主线程事件可兜底采纳 threadId（resume 路径可能无 init 通知）', () => {
    const { outputs } = run([
      { eventType: 'text_delta', text: 'x', threadId: 'th_resume' },
      { eventType: 'result', subtype: 'completed' },
    ]);
    expect(outputs[outputs.length - 1]?.newSessionId).toBe('th_resume');
  });

  it('init 无条件采纳（覆盖兜底值），后续非 init 事件不再覆盖', () => {
    const { state } = run([
      { eventType: 'status', statusText: 'boot', threadId: 'th_early' },
      init('th_real'),
      { eventType: 'text_delta', text: 'x', threadId: 'th_other' },
    ]);
    expect(state.threadId).toBe('th_real');
  });
});

describe('ContainerOutput — 纯函数性', () => {
  it('mapStreamEventToOutputs 不修改入参 state', () => {
    const s0 = createContainerOutputState();
    Object.freeze(s0);
    const r1 = mapStreamEventToOutputs(s0, init('th_1'));
    Object.freeze(r1.state);
    const r2 = mapStreamEventToOutputs(r1.state, delta('abc'));
    expect(s0).toEqual({ accumulatedText: '', threadId: undefined });
    expect(r1.state.accumulatedText).toBe('');
    expect(r2.state).toEqual({ accumulatedText: 'abc', threadId: 'th_1' });
  });
});

describe('ContainerOutput — 进程级收尾/错误信封', () => {
  it('closedOutput：_close/_drain 收尾 → {status:"closed", result:null}', () => {
    expect(closedOutput()).toEqual({ status: 'closed', result: null });
  });

  it('errorOutput：fatal/stdin 解析失败 → {status:"error", error, result:null}（可带 newSessionId）', () => {
    expect(errorOutput('Failed to parse input: bad json')).toEqual({
      status: 'error',
      result: null,
      error: 'Failed to parse input: bad json',
    });
    expect(errorOutput('agent-runner error: boom', 'th_1')).toEqual({
      status: 'error',
      result: null,
      error: 'agent-runner error: boom',
      newSessionId: 'th_1',
    });
  });
});
