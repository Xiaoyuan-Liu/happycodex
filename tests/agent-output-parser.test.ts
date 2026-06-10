/**
 * agent-output-parser 测试 —— 忠实搬迁自 upstream-happyclaw/tests/agent-output-parser.test.ts
 * 并按 happycodex 适配扩展。
 *
 * 上游测试两部分：
 *   - isProviderFailureResult（Claude 账号限额嗅探）：该函数随 provider failover 作废已删除，
 *     对应测试不搬（tombstone）。
 *   - isApiError（stderr 分类）：搬迁保留；ANTHROPIC_* env 断言换成 codex/OpenAI 等价。
 *
 * happycodex 新增（引擎 ↔ 应用层第一次对拍）：
 *   - 用我们的 OUTPUT_MARKER（<<<HAPPYCODEX_OUTPUT_*>>>）+ ContainerOutput 信封喂
 *     attachStdoutHandler，断言 stream/success/closed/interrupted 标志位与 newSessionId 提取；
 *   - 信封由引擎侧 mapStreamEventToOutputs 真实产出（而非手写 JSON），确保 wrap 端
 *     （agent-runner）与 parse 端（agent-output-parser）协议闭环一致。
 */
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import { describe, expect, test } from 'vitest';

import {
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  attachStdoutHandler,
  attachStderrHandler,
  createStdoutParserState,
  createStderrState,
  handleNonZeroExit,
  handleSuccessClose,
  isApiError,
  type CloseHandlerContext,
  type StdoutParserState,
} from '../src/agent-output-parser.js';
import {
  closedOutput,
  createContainerOutputState,
  errorOutput,
  mapStreamEventToOutputs,
  type ContainerOutput,
  type ContainerOutputMapperState,
} from '../src/container-output.js';
import type { StreamEvent } from '../src/shared/stream-event.js';

// ─── helpers ─────────────────────────────────────────────────────────

/** 与 agent-runner.ts 的 stdout 写入格式逐字一致：marker + JSON + marker + 换行。 */
function wrap(out: ContainerOutput): string {
  return `${OUTPUT_START_MARKER}${JSON.stringify(out)}${OUTPUT_END_MARKER}\n`;
}

/** 把一串 StreamEvent 走引擎侧映射器，得到引擎实际会发出的信封序列。 */
function mapEvents(events: StreamEvent[]): ContainerOutput[] {
  let state: ContainerOutputMapperState = createContainerOutputState();
  const outputs: ContainerOutput[] = [];
  for (const ev of events) {
    const res = mapStreamEventToOutputs(state, ev);
    state = res.state;
    outputs.push(...res.outputs);
  }
  return outputs;
}

interface ParserHarness {
  stream: PassThrough;
  state: StdoutParserState;
  received: ContainerOutput[];
  resetCount: () => number;
  /** 写入后等事件循环排空 + outputChain 结算。 */
  settle: () => Promise<void>;
}

function createParserHarness(): ParserHarness {
  const stream = new PassThrough();
  const state = createStdoutParserState();
  const received: ContainerOutput[] = [];
  let resets = 0;
  attachStdoutHandler(stream, state, {
    groupName: 'test-group',
    label: 'Host agent',
    onOutput: async (out) => {
      received.push(out);
    },
    resetTimeout: () => {
      resets += 1;
    },
  });
  return {
    stream,
    state,
    received,
    resetCount: () => resets,
    settle: async () => {
      await new Promise((r) => setImmediate(r));
      await state.outputChain;
    },
  };
}

function createCloseCtx(
  stdoutState: StdoutParserState,
  overrides: Partial<CloseHandlerContext> = {},
): { ctx: CloseHandlerContext; resolved: Promise<ContainerOutput> } {
  let resolveFn!: (out: ContainerOutput) => void;
  const resolved = new Promise<ContainerOutput>((r) => {
    resolveFn = r;
  });
  const ctx: CloseHandlerContext = {
    groupName: 'test-group',
    label: 'Host Agent',
    filePrefix: 'host',
    identifier: 'pid-123',
    logsDir: path.join(os.tmpdir(), 'happycodex-aop-test-logs'),
    input: { prompt: 'hi', isMain: true },
    stdoutState,
    stderrState: createStderrState(),
    onOutput: async () => {},
    resolvePromise: resolveFn,
    startTime: Date.now(),
    timeoutMs: 30_000,
    ...overrides,
  };
  return { ctx, resolved };
}

// ─── 引擎 ↔ 应用层对拍：attachStdoutHandler 消费 mapStreamEventToOutputs 产物 ───

describe('attachStdoutHandler × mapStreamEventToOutputs — 协议对拍', () => {
  test('正常一轮：init + text_delta + result completed → stream/success 信封与 newSessionId', async () => {
    const h = createParserHarness();
    const envelopes = mapEvents([
      { eventType: 'init', threadId: 'thread-abc' },
      { eventType: 'text_delta', text: 'Hello ', threadId: 'thread-abc' },
      { eventType: 'text_delta', text: 'world', threadId: 'thread-abc' },
      { eventType: 'result', subtype: 'completed', threadId: 'thread-abc' },
    ]);
    for (const out of envelopes) h.stream.write(wrap(out));
    await h.settle();

    // 标志位
    expect(h.state.hasSuccessOutput).toBe(true);
    expect(h.state.hasClosedOutput).toBe(false);
    expect(h.state.hasInterruptedOutput).toBe(false);
    // newSessionId 提取（init 信封即携带，主进程可尽早持久化）
    expect(h.state.newSessionId).toBe('thread-abc');
    // onOutput 串行收到全部信封，顺序保持
    expect(h.received.map((o) => o.status)).toEqual([
      'stream',
      'stream',
      'stream',
      'success',
    ]);
    // success 终态携带累积正文
    const final = h.received[3];
    expect(final?.result).toBe('Hello world');
    expect(final?.newSessionId).toBe('thread-abc');
    // 每个信封都触发硬超时重置
    expect(h.resetCount()).toBe(envelopes.length);
  });

  test('中断：result interrupted → stream 信封 + status/interrupted 标志 + newSessionId', async () => {
    const h = createParserHarness();
    const envelopes = mapEvents([
      { eventType: 'init', threadId: 'thread-int' },
      { eventType: 'result', subtype: 'interrupted', threadId: 'thread-int' },
    ]);
    for (const out of envelopes) h.stream.write(wrap(out));
    await h.settle();

    expect(h.state.hasInterruptedOutput).toBe(true);
    expect(h.state.hasSuccessOutput).toBe(false);
    expect(h.state.newSessionId).toBe('thread-int');
    const last = h.received[h.received.length - 1];
    expect(last?.status).toBe('stream');
    expect(last?.streamEvent?.eventType).toBe('status');
    expect(last?.streamEvent?.statusText).toBe('interrupted');
  });

  test('result failed → error 信封：不置 success 标志，仍提取 newSessionId', async () => {
    const h = createParserHarness();
    const envelopes = mapEvents([
      { eventType: 'init', threadId: 'thread-err' },
      {
        eventType: 'result',
        subtype: 'failed',
        statusText: 'boom',
        threadId: 'thread-err',
      },
    ]);
    for (const out of envelopes) h.stream.write(wrap(out));
    await h.settle();

    expect(h.state.hasSuccessOutput).toBe(false);
    expect(h.state.newSessionId).toBe('thread-err');
    const last = h.received[h.received.length - 1];
    expect(last?.status).toBe('error');
    expect(last?.error).toBe('boom');
  });

  test('closed 信封（_close/_drain 收尾）→ hasClosedOutput', async () => {
    const h = createParserHarness();
    h.stream.write(wrap(closedOutput()));
    await h.settle();

    expect(h.state.hasClosedOutput).toBe(true);
    expect(h.state.hasSuccessOutput).toBe(false);
    expect(h.received).toEqual([{ status: 'closed', result: null }]);
  });

  test('error 信封（fatal/stdin 解析失败）→ 提取 newSessionId、不置任何标志', async () => {
    const h = createParserHarness();
    h.stream.write(wrap(errorOutput('Failed to parse input: bad json', 'thread-x')));
    await h.settle();

    expect(h.state.newSessionId).toBe('thread-x');
    expect(h.state.hasSuccessOutput).toBe(false);
    expect(h.state.hasClosedOutput).toBe(false);
    expect(h.state.hasInterruptedOutput).toBe(false);
    expect(h.received[0]?.status).toBe('error');
  });

  test('marker 跨 chunk 切割：信封被任意拆分仍完整配对解析', async () => {
    const h = createParserHarness();
    const envelopes = mapEvents([
      { eventType: 'init', threadId: 'thread-split' },
      { eventType: 'text_delta', text: 'chunked', threadId: 'thread-split' },
      { eventType: 'result', subtype: 'completed', threadId: 'thread-split' },
    ]);
    const raw = envelopes.map(wrap).join('');
    // 故意按 7 字节切，marker 与 JSON 都会被切断
    for (let i = 0; i < raw.length; i += 7) {
      h.stream.write(raw.slice(i, i + 7));
    }
    await h.settle();

    expect(h.received).toHaveLength(3);
    expect(h.state.hasSuccessOutput).toBe(true);
    expect(h.state.newSessionId).toBe('thread-split');
    expect(h.received[2]?.result).toBe('chunked');
  });

  test('marker 间夹杂非 JSON 垃圾：跳过该信封不中断后续解析', async () => {
    const h = createParserHarness();
    h.stream.write(`${OUTPUT_START_MARKER}not-json${OUTPUT_END_MARKER}\n`);
    h.stream.write(wrap(closedOutput()));
    await h.settle();

    expect(h.received).toEqual([{ status: 'closed', result: null }]);
    expect(h.state.hasClosedOutput).toBe(true);
  });

  test('marker 之外的裸输出（agent 调试打印）不进入 onOutput，仅累积到 stdout', async () => {
    const h = createParserHarness();
    h.stream.write('random debug noise\n');
    h.stream.write(wrap(closedOutput()));
    await h.settle();

    expect(h.received).toHaveLength(1);
    expect(h.state.stdout).toContain('random debug noise');
    expect(h.resetCount()).toBe(1); // 裸输出不重置超时
  });
});

// ─── stderr 处理 ─────────────────────────────────────────────────────

describe('attachStderrHandler', () => {
  test('累积 stderr 文本', async () => {
    const stream = new PassThrough();
    const state = createStderrState();
    attachStderrHandler(stream, state, 'test-group', { host: 'test-group' });
    stream.write('line one\n');
    stream.write('line two\n');
    await new Promise((r) => setImmediate(r));

    expect(state.stderr).toBe('line one\nline two\n');
    expect(state.stderrTruncated).toBe(false);
  });
});

// ─── close 生命周期 ──────────────────────────────────────────────────

describe('close handlers', () => {
  test('handleSuccessClose（streaming）：hasClosedOutput → 终态 closed', async () => {
    const state = createStdoutParserState();
    state.hasClosedOutput = true;
    state.newSessionId = 'thread-c';
    const { ctx, resolved } = createCloseCtx(state);
    handleSuccessClose(ctx, 123);
    const out = await resolved;

    expect(out.status).toBe('closed');
    expect(out.result).toBeNull();
    expect(out.newSessionId).toBe('thread-c');
  });

  test('handleSuccessClose（streaming）：无 closed 标志 → 终态 success', async () => {
    const state = createStdoutParserState();
    state.newSessionId = 'thread-s';
    const { ctx, resolved } = createCloseCtx(state);
    handleSuccessClose(ctx, 123);
    const out = await resolved;

    expect(out.status).toBe('success');
    expect(out.newSessionId).toBe('thread-s');
  });

  test('handleSuccessClose（legacy，无 onOutput）：从累积 stdout 解析最后一对 marker', async () => {
    const state = createStdoutParserState();
    state.stdout = `noise\n${wrap({ status: 'success', result: 'done', newSessionId: 'thread-l' })}`;
    const { ctx, resolved } = createCloseCtx(state, { onOutput: undefined });
    handleSuccessClose(ctx, 123);
    const out = await resolved;

    expect(out).toEqual({
      status: 'success',
      result: 'done',
      newSessionId: 'thread-l',
    });
  });

  test('handleNonZeroExit：interrupted 标志 → 按 success 收尾并带 newSessionId', async () => {
    const state = createStdoutParserState();
    state.hasInterruptedOutput = true;
    state.newSessionId = 'thread-i';
    const { ctx, resolved } = createCloseCtx(state);
    const handled = handleNonZeroExit(ctx, null, 'SIGTERM', 50, '/tmp/x.log');
    expect(handled).toBe(true);
    const out = await resolved;

    expect(out).toEqual({
      status: 'success',
      result: null,
      newSessionId: 'thread-i',
    });
  });

  test('handleNonZeroExit：SIGTERM 且已有输出 → 优雅停机按 success 收尾', async () => {
    const state = createStdoutParserState();
    state.hasSuccessOutput = true;
    state.newSessionId = 'thread-k';
    const { ctx, resolved } = createCloseCtx(state);
    const handled = handleNonZeroExit(ctx, null, 'SIGTERM', 50, '/tmp/x.log');
    expect(handled).toBe(true);
    const out = await resolved;

    expect(out.status).toBe('success');
    expect(out.newSessionId).toBe('thread-k');
  });

  test('handleNonZeroExit：SIGTERM 但毫无输出（初始化即死）→ 按 error 收尾', async () => {
    const state = createStdoutParserState();
    const { ctx, resolved } = createCloseCtx(state);
    const handled = handleNonZeroExit(ctx, null, 'SIGTERM', 50, '/tmp/x.log');
    expect(handled).toBe(true);
    const out = await resolved;

    expect(out.status).toBe('error');
    expect(out.error).toContain('signal SIGTERM');
  });

  test('handleNonZeroExit：code 0 → 不处理（返回 false）', () => {
    const state = createStdoutParserState();
    const { ctx } = createCloseCtx(state);
    expect(handleNonZeroExit(ctx, 0, null, 50, '/tmp/x.log')).toBe(false);
  });
});

// ─── isApiError — stderr classification（搬迁自上游，ANTHROPIC → codex/OpenAI） ───

describe('isApiError — stderr classification still detects provider issues', () => {
  // isApiError runs against STDERR (process error stream), not the agent's
  // reply body, so generic rate-limit/quota matching is appropriate there.
  test('detects rate limit in stderr', () => {
    expect(isApiError('Error: rate limit exceeded (429)')).toBe(true);
  });

  test('detects quota exhausted in stderr', () => {
    expect(isApiError('quota exhausted for this API key')).toBe(true);
  });

  test('detects extra-usage phrasing in stderr', () => {
    expect(isApiError("You're out of extra usage")).toBe(true);
  });

  test('detects connection errors in stderr', () => {
    expect(isApiError('connect ECONNREFUSED 127.0.0.1:443')).toBe(true);
  });

  test('returns false for empty stderr', () => {
    expect(isApiError('')).toBe(false);
  });

  // happycodex：上游 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 断言换成 codex/OpenAI 等价。
  test('detects missing OPENAI_API_KEY in stderr', () => {
    expect(isApiError('Error: OPENAI_API_KEY environment variable not set')).toBe(
      true,
    );
  });

  test('detects codex login prompt in stderr', () => {
    expect(isApiError('Not authenticated. Run `codex login` to sign in.')).toBe(
      true,
    );
  });

  test('detects 401 unauthorized in stderr', () => {
    expect(isApiError('Request failed: 401 Unauthorized')).toBe(true);
  });

  test('does not flag ordinary agent stderr noise', () => {
    expect(isApiError('compiled 12 files, watching for changes')).toBe(false);
  });
});
