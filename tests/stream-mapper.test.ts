/**
 * StreamMapper 单测 —— 纯逻辑，对每种 method 喂构造 params，断言输出 StreamEvent 形状。
 */

import { describe, expect, it } from 'vitest';
import { ServerNotif } from '../src/appserver/protocol.js';
import {
  StreamMapper,
  extractHookEventName,
  extractHookStatus,
  extractToolName,
  extractToolOk,
  mapTurnStatus,
  normalizeTokenUsage,
  stringifyStatus,
} from '../src/runtime/stream-mapper.js';
import type { StreamEvent } from '../src/shared/stream-event.js';

const mapper = new StreamMapper();
const map = (method: string, params: unknown): StreamEvent[] => mapper.map(method, params);

describe('StreamMapper — text / thinking / progress deltas', () => {
  it('item/agentMessage/delta → text_delta', () => {
    const out = map(ServerNotif.agentMessageDelta, {
      threadId: 'th_1',
      turnId: 'tn_1',
      itemId: 'it_1',
      delta: 'hello',
    });
    expect(out).toEqual([
      {
        eventType: 'text_delta',
        text: 'hello',
        toolUseId: 'it_1',
        turnId: 'tn_1',
        threadId: 'th_1',
      },
    ]);
  });

  it('item/reasoning/textDelta → thinking_delta', () => {
    const out = map(ServerNotif.reasoningTextDelta, {
      threadId: 'th_1',
      turnId: 'tn_1',
      itemId: 'it_2',
      delta: 'thinking…',
      contentIndex: 0,
    });
    expect(out).toEqual([
      {
        eventType: 'thinking_delta',
        text: 'thinking…',
        toolUseId: 'it_2',
        turnId: 'tn_1',
        threadId: 'th_1',
      },
    ]);
  });

  it('item/reasoning/summaryTextDelta → thinking_delta (同样映射)', () => {
    const out = map(ServerNotif.reasoningSummaryTextDelta, {
      threadId: 'th_1',
      turnId: 'tn_1',
      itemId: 'it_3',
      delta: 'summary',
      summaryIndex: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ eventType: 'thinking_delta', text: 'summary', toolUseId: 'it_3' });
  });

  it('两种 reasoning delta 都映射为 thinking_delta', () => {
    const a = map(ServerNotif.reasoningTextDelta, { itemId: 'x', delta: 'a' });
    const b = map(ServerNotif.reasoningSummaryTextDelta, { itemId: 'x', delta: 'b' });
    expect(a[0]?.eventType).toBe('thinking_delta');
    expect(b[0]?.eventType).toBe('thinking_delta');
  });

  it('item/commandExecution/outputDelta → tool_progress', () => {
    const out = map(ServerNotif.commandExecutionOutputDelta, {
      threadId: 'th_1',
      turnId: 'tn_1',
      itemId: 'it_4',
      delta: 'stdout line\n',
    });
    expect(out).toEqual([
      { eventType: 'tool_progress', text: 'stdout line\n', toolUseId: 'it_4', threadId: 'th_1' },
    ]);
  });

  it('缺失 delta 时 text 回退为空串', () => {
    const out = map(ServerNotif.agentMessageDelta, { itemId: 'x' });
    expect(out[0]).toMatchObject({ eventType: 'text_delta', text: '' });
  });
});

describe('StreamMapper — item/started', () => {
  it('commandExecution → tool_use_start，toolName 为命令（截断）', () => {
    const out = map(ServerNotif.itemStarted, {
      threadId: 'th',
      turnId: 'tn',
      startedAtMs: 1,
      item: { type: 'commandExecution', id: 'c1', command: 'ls -la', status: 'inProgress' },
    });
    expect(out).toEqual([
      {
        eventType: 'tool_use_start',
        toolName: 'ls -la',
        toolUseId: 'c1',
        toolInputSummary: 'ls -la',
        threadId: 'th',
      },
    ]);
  });

  it('mcpToolCall → tool_use_start，toolName 为 server.tool', () => {
    const out = map(ServerNotif.itemStarted, {
      item: { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'create_pr', status: 'inProgress' },
    });
    expect(out[0]).toMatchObject({
      eventType: 'tool_use_start',
      toolName: 'github.create_pr',
      toolUseId: 'm1',
    });
  });

  it('dynamicToolCall → tool_use_start，toolName 为 tool', () => {
    const out = map(ServerNotif.itemStarted, {
      item: { type: 'dynamicToolCall', id: 'd1', tool: 'send_message', status: 'inProgress' },
    });
    expect(out[0]).toMatchObject({ eventType: 'tool_use_start', toolName: 'send_message', toolUseId: 'd1' });
  });

  it('fileChange → tool_use_start，toolName 为 apply_patch', () => {
    const out = map(ServerNotif.itemStarted, {
      item: { type: 'fileChange', id: 'f1', status: 'inProgress' },
    });
    expect(out[0]).toMatchObject({ eventType: 'tool_use_start', toolName: 'apply_patch', toolUseId: 'f1' });
  });

  it('webSearch → tool_use_start，toolName 为 web_search', () => {
    const out = map(ServerNotif.itemStarted, {
      item: { type: 'webSearch', id: 'w1', query: 'codex app-server' },
    });
    expect(out[0]).toMatchObject({ eventType: 'tool_use_start', toolName: 'web_search', toolUseId: 'w1' });
    expect(out[0]?.toolInputSummary).toBe('codex app-server');
  });

  it('agentMessage item/started → [] (增量已覆盖)', () => {
    const out = map(ServerNotif.itemStarted, {
      item: { type: 'agentMessage', id: 'a1', text: 'hi' },
    });
    expect(out).toEqual([]);
  });

  it('reasoning / plan / userMessage item/started → []', () => {
    expect(map(ServerNotif.itemStarted, { item: { type: 'reasoning', id: 'r1', summary: [], content: [] } })).toEqual([]);
    expect(map(ServerNotif.itemStarted, { item: { type: 'plan', id: 'p1', text: 'x' } })).toEqual([]);
    expect(map(ServerNotif.itemStarted, { item: { type: 'userMessage', id: 'u1', content: [] } })).toEqual([]);
  });

  it('长命令的 toolInputSummary 被截断到 ~80 字符', () => {
    const longCmd = 'echo ' + 'A'.repeat(200);
    const out = map(ServerNotif.itemStarted, {
      item: { type: 'commandExecution', id: 'c2', command: longCmd, status: 'inProgress' },
    });
    expect(out[0]?.toolInputSummary?.length).toBeLessThanOrEqual(80);
    expect(out[0]?.toolInputSummary?.endsWith('…')).toBe(true);
  });
});

describe('StreamMapper — item/completed', () => {
  it('commandExecution exitCode=0 → tool_use_end ok=true', () => {
    const out = map(ServerNotif.itemCompleted, {
      item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed', exitCode: 0 },
    });
    expect(out).toEqual([{ eventType: 'tool_use_end', toolName: 'ls', toolUseId: 'c1', ok: true }]);
  });

  it('commandExecution exitCode!=0 → ok=false', () => {
    const out = map(ServerNotif.itemCompleted, {
      item: { type: 'commandExecution', id: 'c2', command: 'false', status: 'failed', exitCode: 1 },
    });
    expect(out[0]).toMatchObject({ eventType: 'tool_use_end', ok: false });
  });

  it('commandExecution 无 exitCode 时按 status 判定', () => {
    const ok = map(ServerNotif.itemCompleted, {
      item: { type: 'commandExecution', id: 'c3', command: 'x', status: 'completed', exitCode: null },
    });
    expect(ok[0]).toMatchObject({ ok: true });
    const bad = map(ServerNotif.itemCompleted, {
      item: { type: 'commandExecution', id: 'c4', command: 'x', status: 'failed', exitCode: null },
    });
    expect(bad[0]).toMatchObject({ ok: false });
  });

  it('mcpToolCall status=completed → ok=true', () => {
    const out = map(ServerNotif.itemCompleted, {
      item: { type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', status: 'completed' },
    });
    expect(out[0]).toMatchObject({ eventType: 'tool_use_end', toolName: 's.t', ok: true });
  });

  it('mcpToolCall status=failed → ok=false', () => {
    const out = map(ServerNotif.itemCompleted, {
      item: { type: 'mcpToolCall', id: 'm2', server: 's', tool: 't', status: 'failed' },
    });
    expect(out[0]).toMatchObject({ ok: false });
  });

  it('agentMessage / reasoning / plan item/completed → []', () => {
    expect(map(ServerNotif.itemCompleted, { item: { type: 'agentMessage', id: 'a', text: 'x' } })).toEqual([]);
    expect(map(ServerNotif.itemCompleted, { item: { type: 'reasoning', id: 'r', summary: [], content: [] } })).toEqual([]);
    expect(map(ServerNotif.itemCompleted, { item: { type: 'plan', id: 'p', text: 'x' } })).toEqual([]);
  });
});

describe('StreamMapper — thread / turn lifecycle', () => {
  it('thread/started → init', () => {
    const out = map(ServerNotif.threadStarted, {
      thread: { id: 'th_42', sessionId: 's', path: null, source: 'app-server', ephemeral: false, cwd: '/w', cliVersion: '0.137.0' },
    });
    expect(out).toEqual([{ eventType: 'init', threadId: 'th_42' }]);
  });

  it('turn/started → []（W2 ①：上游 task_start=SDK Task 启动，codex 轮次边界不产事件）', () => {
    const out = map(ServerNotif.turnStarted, {
      threadId: 'th',
      turn: { id: 'tn_7', status: 'inProgress' },
    });
    expect(out).toEqual([]);
  });

  it('turn/started 不产 task_start（防回归：每轮一条「Task 启动」噪声 trace）', () => {
    const main = map(ServerNotif.turnStarted, { threadId: 'th_main', turn: { id: 't1' } });
    const child = map(ServerNotif.turnStarted, { threadId: 'th_child', turn: { id: 't2' } });
    const bare = map(ServerNotif.turnStarted, { turn: { id: 't3' } });
    for (const out of [main, child, bare]) {
      expect(out.some((e) => e.eventType === 'task_start')).toBe(false);
      expect(out).toEqual([]);
    }
  });

  it('turn/completed status=completed → result completed', () => {
    const out = map(ServerNotif.turnCompleted, {
      threadId: 'th',
      turn: { id: 'tn_1', status: 'completed' },
    });
    expect(out).toEqual([{ eventType: 'result', subtype: 'completed', turnId: 'tn_1', threadId: 'th' }]);
  });

  it('turn/completed status=interrupted → result interrupted', () => {
    const out = map(ServerNotif.turnCompleted, { turn: { id: 'tn_2', status: 'interrupted' } });
    expect(out[0]).toMatchObject({ eventType: 'result', subtype: 'interrupted' });
  });

  it('turn/completed status=failed → result failed', () => {
    const out = map(ServerNotif.turnCompleted, { turn: { id: 'tn_3', status: 'failed' } });
    expect(out[0]).toMatchObject({ subtype: 'failed' });
  });

  it('turn/completed status 未知/inProgress → result completed (fallback)', () => {
    expect(map(ServerNotif.turnCompleted, { turn: { id: 't', status: 'inProgress' } })[0]).toMatchObject({ subtype: 'completed' });
    expect(map(ServerNotif.turnCompleted, { turn: { id: 't', status: 'weird' } })[0]).toMatchObject({ subtype: 'completed' });
    expect(map(ServerNotif.turnCompleted, { turn: { id: 't' } })[0]).toMatchObject({ subtype: 'completed' });
  });
});

describe('StreamMapper — status / usage', () => {
  it('thread/status/changed → status，tagged object 取 .type，threadId 透传', () => {
    const out = map(ServerNotif.threadStatusChanged, {
      threadId: 'th',
      status: { type: 'active', activeFlags: ['turn'] },
    });
    expect(out).toEqual([{ eventType: 'status', statusText: 'active', threadId: 'th' }]);
  });

  it('thread/status/changed status=idle（W2 ②：上游前端清流式残留的关键信号）', () => {
    const out = map(ServerNotif.threadStatusChanged, { threadId: 'th', status: { type: 'idle' } });
    expect(out).toEqual([{ eventType: 'status', statusText: 'idle', threadId: 'th' }]);
  });

  it('thread/status/changed 透传 threadId（W2 ②：decorateScope 标注子代理 idle 的前提）', () => {
    const out = map(ServerNotif.threadStatusChanged, {
      threadId: 'th_child',
      status: { type: 'idle' },
    });
    expect(out[0]?.threadId).toBe('th_child');
  });

  it('thread/status/changed 缺 threadId 时不附该字段（防御）', () => {
    const out = map(ServerNotif.threadStatusChanged, { status: { type: 'systemError' } });
    expect(out).toEqual([{ eventType: 'status', statusText: 'systemError' }]);
  });

  it('thread/tokenUsage/updated → usage 归一化为上游结构化形状（W2 ③）', () => {
    const out = map(ServerNotif.threadTokenUsageUpdated, {
      threadId: 'th',
      turnId: 'tn',
      tokenUsage: {
        total: { totalTokens: 999, inputTokens: 900, cachedInputTokens: 50, outputTokens: 99, reasoningOutputTokens: 9 },
        last: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 5 },
        modelContextWindow: 272000,
      },
    });
    expect(out).toEqual([
      {
        eventType: 'usage',
        usage: {
          // token 取 last（增量）而非 total（线程累计）：billing/usage_records 累加语义。
          inputTokens: 100,
          outputTokens: 30,
          // 字段名归一：codex cachedInputTokens → 上游 cacheReadInputTokens。
          cacheReadInputTokens: 20,
          // 无 codex 数据源（billing token-only：costUSD 恒 0）。
          cacheCreationInputTokens: 0,
          costUSD: 0,
          durationMs: 0,
          numTurns: 0,
        },
        turnId: 'tn',
        threadId: 'th',
      },
    ]);
  });

  it('thread/tokenUsage/updated 缺 tokenUsage/last 时各项回退 0（防御，不抛）', () => {
    const noTokenUsage = map(ServerNotif.threadTokenUsageUpdated, { threadId: 'th', turnId: 'tn' });
    expect(noTokenUsage[0]?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      durationMs: 0,
      numTurns: 0,
    });

    const totalOnly = map(ServerNotif.threadTokenUsageUpdated, {
      threadId: 'th',
      tokenUsage: { total: { inputTokens: 10, outputTokens: 5 } },
    });
    // 只认 last（增量），total-only 不回退到累计值（避免重复计数）。
    expect(totalOnly[0]?.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('thread/tokenUsage/updated 透传 turnId/threadId（前端按 turn 绑定 token_usage）', () => {
    const out = map(ServerNotif.threadTokenUsageUpdated, {
      threadId: 'th_x',
      turnId: 'tn_x',
      tokenUsage: {
        total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow: null,
      },
    });
    expect(out[0]).toMatchObject({ eventType: 'usage', turnId: 'tn_x', threadId: 'th_x' });
  });
});

describe('StreamMapper — tool 事件透传 threadId（B2 scope 归属前提）', () => {
  it('tool_use_start 透传 item/started 的 threadId（mcpToolCall）', () => {
    const out = map(ServerNotif.itemStarted, {
      threadId: 'th_99',
      turnId: 'tn',
      startedAtMs: 1,
      item: { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'create_pr', status: 'inProgress' },
    });
    expect(out[0]).toMatchObject({ eventType: 'tool_use_start', toolUseId: 'm1', threadId: 'th_99' });
  });

  it('tool_use_end 透传 item/completed 的 threadId', () => {
    const out = map(ServerNotif.itemCompleted, {
      threadId: 'th_99',
      turnId: 'tn',
      completedAtMs: 2,
      item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed', exitCode: 0 },
    });
    expect(out).toEqual([
      { eventType: 'tool_use_end', toolName: 'ls', toolUseId: 'c1', ok: true, threadId: 'th_99' },
    ]);
  });

  it('tool_progress 透传 outputDelta 的 threadId', () => {
    const out = map(ServerNotif.commandExecutionOutputDelta, {
      threadId: 'th_99',
      turnId: 'tn',
      itemId: 'it_4',
      delta: 'x',
    });
    expect(out[0]).toMatchObject({ eventType: 'tool_progress', toolUseId: 'it_4', threadId: 'th_99' });
  });
});

describe('StreamMapper — 上下文压缩（B1 边界，非文本）', () => {
  it('(a) thread/compacted → statusText:compacted，携带 threadId/turnId', () => {
    const out = map(ServerNotif.threadCompacted, { threadId: 'th_1', turnId: 'tn_1' });
    expect(out).toEqual([{ eventType: 'status', statusText: 'compacted', threadId: 'th_1', turnId: 'tn_1' }]);
  });

  it('(b) contextCompaction item（item/completed）→ statusText:compacted，与 (a) 等价', () => {
    const out = map(ServerNotif.itemCompleted, {
      threadId: 'th_2',
      turnId: 'tn_2',
      completedAtMs: 1,
      item: { type: 'contextCompaction', id: 'cc1' },
    });
    expect(out).toEqual([{ eventType: 'status', statusText: 'compacted', threadId: 'th_2', turnId: 'tn_2' }]);
  });

  it('(b) contextCompaction 不被 tool-item 过滤吞掉（即使 isToolItem=false）', () => {
    const out = map(ServerNotif.itemCompleted, {
      threadId: 'th_3',
      item: { type: 'contextCompaction', id: 'cc2' },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ eventType: 'status', statusText: 'compacted' });
  });

  it('compact_partial 的文本 flush 不在 mapper 产出（不变量 i：留给有状态 session 层）', () => {
    // mapper 对压缩 item 只产边界 status，不产任何 text/compact_partial 事件。
    const out = map(ServerNotif.itemCompleted, {
      threadId: 'th',
      item: { type: 'contextCompaction', id: 'cc3' },
    });
    expect(out.some((e) => e.eventType === 'compact_partial' || e.eventType === 'text_delta')).toBe(false);
  });
});

describe('StreamMapper — Hooks（B3 过滤噪声）', () => {
  it('hook/started preCompact → statusText:hook:preCompact:running', () => {
    const out = map(ServerNotif.hookStarted, {
      threadId: 'th',
      turnId: 'tn',
      run: { eventName: 'preCompact', status: 'running' },
    });
    expect(out).toEqual([{ eventType: 'status', statusText: 'hook:preCompact:running' }]);
  });

  it('hook/completed postCompact → statusText:hook:postCompact:completed', () => {
    const out = map(ServerNotif.hookCompleted, {
      threadId: 'th',
      turnId: 'tn',
      run: { eventName: 'postCompact', status: 'completed' },
    });
    expect(out).toEqual([{ eventType: 'status', statusText: 'hook:postCompact:completed' }]);
  });

  it('hook 异常终态 blocked / failed 总是产出（即使非压缩事件）', () => {
    const blocked = map(ServerNotif.hookCompleted, {
      threadId: 'th',
      turnId: 'tn',
      run: { eventName: 'preToolUse', status: 'blocked' },
    });
    expect(blocked).toEqual([{ eventType: 'status', statusText: 'hook:preToolUse:blocked' }]);

    const failed = map(ServerNotif.hookCompleted, {
      threadId: 'th',
      turnId: null,
      run: { eventName: 'postToolUse', status: 'failed' },
    });
    expect(failed).toEqual([{ eventType: 'status', statusText: 'hook:postToolUse:failed' }]);
  });

  it('B3 MVP：会话生命周期 hook sessionStart / stop 端到端产出 status', () => {
    expect(
      map(ServerNotif.hookStarted, {
        threadId: 'th',
        turnId: null,
        run: { eventName: 'sessionStart', status: 'running' },
      }),
    ).toEqual([{ eventType: 'status', statusText: 'hook:sessionStart:running' }]);
    expect(
      map(ServerNotif.hookCompleted, {
        threadId: 'th',
        turnId: null,
        run: { eventName: 'sessionStart', status: 'completed' },
      }),
    ).toEqual([{ eventType: 'status', statusText: 'hook:sessionStart:completed' }]);
    expect(
      map(ServerNotif.hookCompleted, {
        threadId: 'th',
        turnId: null,
        run: { eventName: 'stop', status: 'completed' },
      }),
    ).toEqual([{ eventType: 'status', statusText: 'hook:stop:completed' }]);
  });

  it('hook 噪声事件（非压缩/非生命周期 + 正常终态）→ [] 被过滤', () => {
    expect(
      map(ServerNotif.hookStarted, { threadId: 'th', turnId: 'tn', run: { eventName: 'preToolUse', status: 'running' } }),
    ).toEqual([]);
    expect(
      map(ServerNotif.hookCompleted, { threadId: 'th', turnId: 'tn', run: { eventName: 'postToolUse', status: 'completed' } }),
    ).toEqual([]);
    expect(
      map(ServerNotif.hookCompleted, { threadId: 'th', turnId: null, run: { eventName: 'userPromptSubmit', status: 'completed' } }),
    ).toEqual([]);
  });

  it('hook run 缺失字段不抛、被安全过滤为 []', () => {
    expect(map(ServerNotif.hookStarted, { threadId: 'th', turnId: 'tn' })).toEqual([]);
    expect(map(ServerNotif.hookCompleted, { threadId: 'th', turnId: 'tn', run: {} })).toEqual([]);
  });
});

describe('StreamMapper — 未知 / 缺省', () => {
  it('未知 method → []', () => {
    expect(map('item/somethingNew/delta', { foo: 'bar' })).toEqual([]);
    expect(map('thread/closed', { threadId: 'th' })).toEqual([]);
  });

  it('params 为 undefined 也不抛', () => {
    expect(map('totally/unknown', undefined)).toEqual([]);
    expect(map(ServerNotif.threadStatusChanged, undefined)[0]).toMatchObject({ eventType: 'status', statusText: '' });
  });
});

describe('helper 函数', () => {
  it('extractToolName 各分支', () => {
    expect(extractToolName({ type: 'commandExecution', id: 'x', command: 'pwd', status: 'completed', aggregatedOutput: null, exitCode: 0 })).toBe('pwd');
    expect(extractToolName({ type: 'mcpToolCall', id: 'x', server: 'a', tool: 'b', status: 'completed' })).toBe('a.b');
    expect(extractToolName({ type: 'dynamicToolCall', id: 'x', tool: 'c', status: 'completed' })).toBe('c');
    expect(extractToolName({ type: 'fileChange', id: 'x' } as never)).toBe('apply_patch');
    expect(extractToolName({ type: 'webSearch', id: 'x', query: 'q' })).toBe('web_search');
  });

  it('extractToolOk 各分支', () => {
    expect(extractToolOk({ type: 'commandExecution', id: 'x', command: 'a', status: 'completed', aggregatedOutput: null, exitCode: 0 })).toBe(true);
    expect(extractToolOk({ type: 'commandExecution', id: 'x', command: 'a', status: 'failed', aggregatedOutput: null, exitCode: 2 })).toBe(false);
    expect(extractToolOk({ type: 'mcpToolCall', id: 'x', server: 's', tool: 't', status: 'completed' })).toBe(true);
    expect(extractToolOk({ type: 'mcpToolCall', id: 'x', server: 's', tool: 't', status: 'failed' })).toBe(false);
    expect(extractToolOk({ type: 'dynamicToolCall', id: 'x', tool: 't', status: 'success' } as never)).toBe(true);
  });

  it('mapTurnStatus', () => {
    expect(mapTurnStatus('completed')).toBe('completed');
    expect(mapTurnStatus('interrupted')).toBe('interrupted');
    expect(mapTurnStatus('failed')).toBe('failed');
    expect(mapTurnStatus('inProgress')).toBe('completed');
    expect(mapTurnStatus(undefined)).toBe('completed');
  });

  it('stringifyStatus', () => {
    expect(stringifyStatus('idle')).toBe('idle');
    expect(stringifyStatus({ type: 'active' })).toBe('active');
    expect(stringifyStatus(null)).toBe('');
    expect(stringifyStatus(undefined)).toBe('');
    expect(stringifyStatus(42)).toBe('42');
  });

  it('normalizeTokenUsage：last 增量 + 字段名归一 + 缺省回退 0', () => {
    expect(
      normalizeTokenUsage({
        total: { totalTokens: 200, inputTokens: 150, cachedInputTokens: 40, outputTokens: 50, reasoningOutputTokens: 10 },
        last: { totalTokens: 42, inputTokens: 30, cachedInputTokens: 8, outputTokens: 12, reasoningOutputTokens: 2 },
        modelContextWindow: 128000,
      }),
    ).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      cacheReadInputTokens: 8,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      durationMs: 0,
      numTurns: 0,
    });
    // 防御：非对象 / null / 字段非数字 → 全 0。
    for (const bad of [undefined, null, 'x', 42, { last: { inputTokens: 'NaN-ish' } }]) {
      expect(normalizeTokenUsage(bad)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        durationMs: 0,
        numTurns: 0,
      });
    }
  });

  it('extractHookEventName / extractHookStatus 容错', () => {
    expect(extractHookEventName({ eventName: 'preCompact', status: 'running' })).toBe('preCompact');
    expect(extractHookStatus({ eventName: 'preCompact', status: 'blocked' })).toBe('blocked');
    expect(extractHookEventName(undefined)).toBe('');
    expect(extractHookStatus(undefined)).toBe('');
    expect(extractHookEventName({})).toBe('');
    expect(extractHookStatus({ status: 42 })).toBe('');
  });
});
