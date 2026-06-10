/**
 * ContainerOutput —— 引擎进程边界的输出信封协议（忠实对齐上游 HappyClaw）。
 *
 * 上游契约（upstream-happyclaw/src/container-runner.ts 的 ContainerOutput +
 * container/agent-runner/src/index.ts 的 writeOutput/emit）：
 *   - 流式：   { status:'stream',  result:null, streamEvent }            —— 每条 StreamEvent 一封
 *   - 成功终态：{ status:'success', result:正文文本, newSessionId }       —— 一轮（turn）完成
 *   - 失败终态：{ status:'error',   result:null, error:消息 }             —— 执行失败 / fatal
 *   - 中断：   { status:'stream',  streamEvent:{eventType:'status',statusText:'interrupted'},
 *               newSessionId }                                           —— 上游把"被中断"作为
 *               stream 信封发（agent-output-parser 靠 streamEvent.statusText==='interrupted' 检测，
 *               并带 newSessionId 让主进程持久化 session）
 *   - 关闭：   { status:'closed',  result:null }                         —— _close/_drain 收尾标记
 *
 * happycodex 适配（codex 引擎 → 上游信封）：
 *   - StreamEvent 流自 src/runtime/stream-mapper.ts（codex app-server 通知映射），其中
 *     eventType:'result'（turn 终态，happycodex 扩展）在本层被"翻译"成上游终态信封，
 *     不再以 stream 信封透传 —— 上游消费端没有 'result' 事件概念，终态语义由信封 status 承载。
 *   - newSessionId 携带 codex 主线程 threadId（上游为 Claude session id；resume 语义等价：
 *     主进程持久化后作为下次 ContainerInput.sessionId → resumeThreadId）。
 *   - 上游有而我们暂不产的字段（providerFailure / sdkMessageUuid / sessionId 等）保留为可选，
 *     形状对齐让后续搬入的应用层（agent-output-parser / message orchestrator）零改动。
 *
 * 映射器为**纯函数**：(state, event) → { state', outputs }，不持有/不修改外部状态，可单测。
 */

import type { StreamEvent } from './shared/stream-event.js';
import type { MessageSourceKind } from './types.js';

// ───────────────────────── 类型（对齐上游 ContainerOutput 形状） ─────────────────────────

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  /** 会话标识（codex threadId）；主进程持久化后用于 resume。 */
  newSessionId?: string;
  error?: string;
  /** 上游 provider failover 维度；happycodex 无 provider pool，暂不产，保留对齐形状。 */
  providerFailure?: boolean;
  streamEvent?: StreamEvent;
  turnId?: string;
  /** 上游 emit 装饰维度（sessionId = newSessionId || sessionId）；暂不产。 */
  sessionId?: string;
  /** 上游 SDK 消息 uuid（resumeAt 锚点）；codex 无对应概念，暂不产。 */
  sdkMessageUuid?: string;
  sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
  finalizationReason?: 'completed' | 'interrupted' | 'error';
}

// ───────────────────────── 映射器状态（显式传入传出，保持纯函数） ─────────────────────────

export interface ContainerOutputMapperState {
  /** 本轮已累积的主线程可见正文（text_delta；子代理 scope 不混入）。result completed 时作为 result 文本，终态后清零。 */
  readonly accumulatedText: string;
  /** 主线程 threadId（newSessionId 数据源）。init 事件主导采纳；子代理事件不参与，避免劫持 resume 标识。 */
  readonly threadId: string | undefined;
}

export function createContainerOutputState(): ContainerOutputMapperState {
  return { accumulatedText: '', threadId: undefined };
}

export interface ContainerOutputMapResult {
  state: ContainerOutputMapperState;
  outputs: ContainerOutput[];
}

// ───────────────────────── 纯函数映射：StreamEvent → 0..N 个信封 ─────────────────────────

/**
 * 把一条 StreamEvent 映射为 ContainerOutput 信封（纯函数，返回新 state，不修改入参）。
 *
 *   - 非 result 事件 → stream 信封透传（已知 threadId 时附 newSessionId，便于主进程尽早持久化）。
 *   - result completed → success 终态（result=本轮累积 text_delta，空则 null）。
 *   - result failed    → error 终态（error=statusText ?? 'agent failed'）。
 *   - result interrupted → 上游做法：stream 信封 + 合成 status/interrupted 事件 + newSessionId。
 *   - 子代理 scope（agentScope='subagent'）的 result 不触发终态（主轮还在飞），仅 stream 透传；
 *     其 text_delta 也不计入主轮累积正文。
 */
export function mapStreamEventToOutputs(
  state: ContainerOutputMapperState,
  ev: StreamEvent,
): ContainerOutputMapResult {
  const isSubagent = ev.agentScope === 'subagent';

  // 主线程 threadId 采纳：init 事件无条件采纳（thread/started 是主会话）；
  // 其余主线程事件仅在尚未确立时兜底采纳（resume 路径可能没有 init 通知）。
  let threadId = state.threadId;
  if (ev.threadId && !isSubagent && (ev.eventType === 'init' || threadId === undefined)) {
    threadId = ev.threadId;
  }

  const withSession = (out: ContainerOutput): ContainerOutput =>
    threadId ? { ...out, newSessionId: threadId } : out;

  // 终态：result 事件被翻译成上游终态信封（不以 stream 透传——上游无 'result' 事件概念）。
  if (ev.eventType === 'result' && !isSubagent) {
    const subtype = ev.subtype ?? 'completed';

    if (subtype === 'interrupted') {
      // 上游中断发法：stream 信封 + status/interrupted 事件 + newSessionId（主进程据此持久化 session）。
      const marker: StreamEvent = {
        eventType: 'status',
        statusText: 'interrupted',
        ...(ev.turnId ? { turnId: ev.turnId } : {}),
        ...(threadId ? { threadId } : {}),
      };
      return {
        state: { accumulatedText: '', threadId },
        outputs: [withSession({ status: 'stream', result: null, streamEvent: marker })],
      };
    }

    if (subtype === 'failed') {
      return {
        state: { accumulatedText: '', threadId },
        outputs: [
          withSession({
            status: 'error',
            result: null,
            error: ev.statusText ?? 'agent failed',
            finalizationReason: 'error',
            ...(ev.turnId ? { turnId: ev.turnId } : {}),
          }),
        ],
      };
    }

    // completed → success（result=本轮累积正文；与上游 sdk_final 对齐携带 sourceKind/finalizationReason）。
    const text = state.accumulatedText;
    return {
      state: { accumulatedText: '', threadId },
      outputs: [
        withSession({
          status: 'success',
          result: text.length > 0 ? text : null,
          sourceKind: 'sdk_final',
          finalizationReason: 'completed',
          ...(ev.turnId ? { turnId: ev.turnId } : {}),
        }),
      ],
    };
  }

  // 流式：累积主线程 text_delta（thinking/工具进度不入正文），事件原样裹进 stream 信封。
  const accumulatedText =
    ev.eventType === 'text_delta' && !isSubagent
      ? state.accumulatedText + (ev.text ?? '')
      : state.accumulatedText;

  return {
    state: { accumulatedText, threadId },
    outputs: [withSession({ status: 'stream', result: null, streamEvent: ev })],
  };
}

// ───────────────────────── 进程边界自身的收尾/错误信封（不经事件流） ─────────────────────────

/** _close/_drain 收尾标记（对齐上游：区分 _close 退出与静默成功，避免"吞消息"）。 */
export function closedOutput(): ContainerOutput {
  return { status: 'closed', result: null };
}

/** fatal / stdin 解析失败等进程级错误（已知主线程 threadId 时附 newSessionId 供持久化）。 */
export function errorOutput(error: string, newSessionId?: string): ContainerOutput {
  return {
    status: 'error',
    result: null,
    error,
    ...(newSessionId ? { newSessionId } : {}),
  };
}
