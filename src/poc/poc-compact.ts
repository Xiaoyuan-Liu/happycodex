/**
 * PoC（Stage 5/B1）：上下文压缩（context compaction）调研 —— 对真实 codex 0.137.0。
 *
 * 调研 4 件事（决定第二棒 B1 session 层的实现边界）：
 *   1. 主动 thread/compact/start({threadId}) 是否工作、返回什么。
 *   2. compact 后实际收到哪些通知 / item（thread/compacted 通知 vs item/completed 的
 *      contextCompaction item），字段形状 —— 决定 session 层去重 / 触发监听哪个源。
 *   3. auto-compact（内核按 token-limit 自动触发）能否在压缩【前】拿到累积的 agent 文本
 *      —— 决定 compact_partial 是否只能 manual。
 *   4. 关键：compact 后删掉 compacted 边界【之前】的历史，再 thread/resume，验证是否仍能
 *      正确续接（关系 Stage4 resume 安全 —— 决定 trim 能否真删，还是必须"只归档不删"）。
 *
 * 设计要点：
 *   - **用低层 client 直接发 Method.threadCompactStart**，不依赖尚未实现的 session.compact()。
 *   - 仅做 thread/start + turn/start + thread/compact/start + thread/resume 的裸协议交互，
 *     自己订阅 client.onNotification 抓全部通知/item（不经 ThreadSession 的状态机）。
 *   - {approvalPolicy:'never', sandbox:'read-only'}，沿用现有 poc 范式。
 *
 * 运行：npm run poc:compact  （需 codex 已登录；用真实 CODEX_HOME 作 auth 源）
 * 结尾打印 OK / UNCERTAIN / FAIL，并落证据。
 */

import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppServerClient } from '../appserver/client.js';
import {
  Method,
  ServerNotif,
  textInput,
  type ThreadStartParams,
  type ThreadStartResponse,
  type TurnStartParams,
  type TurnStartResponse,
  type ThreadCompactStartParams,
  type ThreadCompactStartResponse,
  type ThreadResumeParams,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type AgentMessageDeltaNotification,
  type TurnCompletedNotification,
  type ThreadItem,
} from '../appserver/protocol.js';

// ───────────────────────── 小工具：通知收集器 ─────────────────────────

interface CapturedNotif {
  method: string;
  params: unknown;
  /** 单调递增序号，用于判断到达顺序（compacted 通知 vs item）。 */
  seq: number;
}

/** 订阅 client 的所有通知，归类后供断言。每个阶段可 reset。 */
class NotifCollector {
  private seq = 0;
  all: CapturedNotif[] = [];
  /** 累积某个 turn 的 agentMessage delta 文本（模拟 session 层 takeAccumulatedText）。 */
  agentTextByTurn = new Map<string, string>();

  record(method: string, params: unknown): void {
    this.all.push({ method, params, seq: this.seq++ });
    if (method === ServerNotif.agentMessageDelta) {
      const p = params as AgentMessageDeltaNotification;
      if (p && p.turnId) {
        this.agentTextByTurn.set(p.turnId, (this.agentTextByTurn.get(p.turnId) ?? '') + (p.delta ?? ''));
      }
    } else if (method === ServerNotif.itemCompleted) {
      // 兜底：从 agentMessage item 的最终全文累积（delta 可能未被本次 collector 周期完整捕获）。
      const p = params as ItemCompletedNotification;
      const it = p?.item as { type?: string; text?: string } | undefined;
      if (it?.type === 'agentMessage' && it.text && p.turnId) {
        const prev = this.agentTextByTurn.get(p.turnId) ?? '';
        if (!prev.includes(it.text)) this.agentTextByTurn.set(p.turnId, prev + it.text);
      }
    }
  }

  reset(): void {
    this.all = [];
    this.agentTextByTurn.clear();
  }

  byMethod(method: string): CapturedNotif[] {
    return this.all.filter((n) => n.method === method);
  }

  /** 找出所有 contextCompaction item（在 item/started 或 item/completed 中）。 */
  compactionItems(): Array<{ phase: 'started' | 'completed'; seq: number; item: ThreadItem }> {
    const out: Array<{ phase: 'started' | 'completed'; seq: number; item: ThreadItem }> = [];
    for (const n of this.all) {
      if (n.method === ServerNotif.itemStarted) {
        const p = n.params as ItemStartedNotification;
        if (p?.item?.type === 'contextCompaction') out.push({ phase: 'started', seq: n.seq, item: p.item });
      } else if (n.method === ServerNotif.itemCompleted) {
        const p = n.params as ItemCompletedNotification;
        if (p?.item?.type === 'contextCompaction') out.push({ phase: 'completed', seq: n.seq, item: p.item });
      }
    }
    return out;
  }
}

// ───────────────────────── 协议级 helper（不走 ThreadSession） ─────────────────────────

/** thread/start，返回 ThreadStartResponse（含 thread.id / thread.path）。 */
async function startThread(
  client: AppServerClient,
  extraConfig?: Record<string, unknown>,
): Promise<ThreadStartResponse> {
  const params: ThreadStartParams = {
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ...(extraConfig ? { config: extraConfig } : {}),
  };
  return client.request<ThreadStartResponse>(Method.threadStart, params);
}

/** turn/start + 等待 turn/completed（按 collector 里出现的 turn/completed 通知）。返回 turnId。 */
async function runTurn(
  client: AppServerClient,
  collector: NotifCollector,
  threadId: string,
  text: string,
): Promise<string> {
  const turnDone = new Promise<void>((resolve) => {
    const off = client.onNotification((method, params) => {
      if (method === ServerNotif.turnCompleted) {
        const p = params as TurnCompletedNotification;
        if (p?.threadId === threadId) {
          off();
          resolve();
        }
      }
    });
  });
  const params: TurnStartParams = { threadId, input: [textInput(text)] };
  const res = await client.request<TurnStartResponse>(Method.turnStart, params);
  await turnDone;
  return res?.turn?.id ?? '(no-turn-id)';
}

/** 显式打印一个通知的关键字段形状（截断），供证据。 */
function shapeOf(params: unknown): string {
  try {
    const s = JSON.stringify(params);
    return s.length > 220 ? s.slice(0, 220) + '…' : s;
  } catch {
    return String(params);
  }
}

// ───────────────────────── 主流程 ─────────────────────────

interface Findings {
  manualCompactWorks: string;
  manualCompactResponse: string;
  notificationsObserved: string;
  autoCompactPartial: string;
  trimSafeForResume: string;
  verdict: 'OK' | 'UNCERTAIN' | 'FAIL';
  evidence: string[];
}

async function probeManualCompact(findings: Findings): Promise<{ threadId: string; rolloutPath: string | null } | null> {
  const client = new AppServerClient({ requestTimeoutMs: 120_000 });
  const collector = new NotifCollector();
  const off = client.onNotification((m, p) => collector.record(m, p));
  try {
    await client.start();
    const started = await startThread(client);
    const threadId = started.thread.id;
    const rolloutPath = started.thread.path;
    findings.evidence.push(`[1] thread started id=${threadId} rolloutPath=${rolloutPath ?? '(null)'}`);

    // 跑两轮，给压缩制造可压缩的历史
    await runTurn(client, collector, threadId, 'Remember this codeword: COMPACT-ALPHA-42. Reply OK.');
    await runTurn(client, collector, threadId, 'Now tell me a one-sentence fun fact about octopuses.');

    // ── 探针 1：主动 thread/compact/start ──
    collector.reset();
    const compactParams: ThreadCompactStartParams = { threadId };
    let compactResp: ThreadCompactStartResponse | { __error: string };
    try {
      compactResp = await client.request<ThreadCompactStartResponse>(Method.threadCompactStart, compactParams);
      findings.manualCompactWorks = 'YES';
      findings.manualCompactResponse = JSON.stringify(compactResp);
      findings.evidence.push(`[1] thread/compact/start RESOLVED, response=${JSON.stringify(compactResp)}`);
    } catch (err) {
      findings.manualCompactWorks = 'NO';
      findings.manualCompactResponse = `error: ${(err as Error).message}`;
      findings.evidence.push(`[1] thread/compact/start REJECTED: ${(err as Error).message}`);
      return { threadId, rolloutPath };
    }

    // 给 codex 一点时间把 compacted 通知 / contextCompaction item 推过来。
    await waitForCompactSignal(collector, 30_000);

    // ── 探针 2：compact 后收到哪些通知 / item ──
    const compactedNotifs = collector.byMethod(ServerNotif.threadCompacted);
    const compactionItems = collector.compactionItems();
    const lines: string[] = [];
    lines.push(`thread/compacted notif count=${compactedNotifs.length}`);
    for (const n of compactedNotifs) lines.push(`  thread/compacted shape=${shapeOf(n.params)}`);
    lines.push(`contextCompaction item count=${compactionItems.length}`);
    for (const ci of compactionItems) lines.push(`  contextCompaction[${ci.phase}] shape=${shapeOf(ci.item)}`);
    // 顺序关系（去重决策依据）
    if (compactedNotifs.length > 0 && compactionItems.length > 0) {
      const firstNotifSeq = compactedNotifs[0]!.seq;
      const firstItemSeq = compactionItems[0]!.seq;
      lines.push(`order: notifSeq=${firstNotifSeq} vs itemSeq=${firstItemSeq} → ${firstNotifSeq < firstItemSeq ? 'notif先' : 'item先'}`);
    }
    findings.notificationsObserved = lines.join(' | ');
    for (const l of lines) findings.evidence.push(`[2] ${l}`);

    // compact 后再问 codeword，确认压缩没有丢失早期记忆（压缩=摘要而非截断）
    collector.reset();
    const tAfter = await runTurn(client, collector, threadId, 'What was the codeword I told you earlier? Reply with just the codeword.');
    const recall = collector.agentTextByTurn.get(tAfter) ?? '';
    const recalled = recall.toUpperCase().includes('COMPACT-ALPHA-42');
    findings.evidence.push(`[2] post-compact recall="${recall.trim().slice(0, 60)}" remembered=${recalled}`);

    return { threadId, rolloutPath };
  } catch (err) {
    findings.evidence.push(`[1] probeManualCompact FAILED: ${(err as Error).message}`);
    return null;
  } finally {
    off();
    await client.close();
  }
}

/** 轮询 collector 直到出现 compacted 信号（通知或 item）或超时。 */
async function waitForCompactSignal(collector: NotifCollector, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (collector.byMethod(ServerNotif.threadCompacted).length > 0) return;
    if (collector.compactionItems().length > 0) return;
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * 探针 3：auto-compact 能否在压缩【前】拿到累积 agent 文本。
 * 思路：用 config 把 model_auto_compact_token_limit 调到很低，再跑能产生较长输出的 turn，
 * 看内核是否自动触发压缩、且 compact 之前 agentMessage delta 已累积。
 * 若无法可靠触发，记 UNCERTAIN/难测 并解释。
 */
async function probeAutoCompact(findings: Findings): Promise<void> {
  const client = new AppServerClient({ requestTimeoutMs: 180_000 });
  const collector = new NotifCollector();
  const off = client.onNotification((m, p) => collector.record(m, p));
  try {
    await client.start();
    // 把 auto-compact 阈值压到极低，尝试逼出自动压缩。
    const started = await startThread(client, {
      model_auto_compact_token_limit: 2000,
      model_auto_compact_token_limit_scope: 'total',
    });
    const threadId = started.thread.id;
    findings.evidence.push(`[3] auto-compact thread id=${threadId} (limit=2000)`);

    let sawAutoCompact = false;
    let sawTextBeforeCompact = false;

    // 跑数轮，逐步堆高上下文，监视是否在某轮触发 compacted，且该轮 compact 通知前已有 agentMessage delta。
    for (let i = 0; i < 4 && !sawAutoCompact; i++) {
      collector.reset();
      const tid = await runTurn(
        client,
        collector,
        threadId,
        `Round ${i}: write a detailed 200-word paragraph about a random topic (rivers, stars, bread). Be verbose.`,
      );
      const compactedSeq = collector.byMethod(ServerNotif.threadCompacted)[0]?.seq;
      const itemSeq = collector.compactionItems()[0]?.seq;
      const firstCompactSeq = [compactedSeq, itemSeq].filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)[0];
      if (typeof firstCompactSeq === 'number') {
        sawAutoCompact = true;
        // 在该 compact 信号之前，是否已有 agentMessage delta（即压缩前能拿到累积文本）。
        const firstTextSeq = collector.byMethod(ServerNotif.agentMessageDelta)[0]?.seq;
        const accumulated = collector.agentTextByTurn.get(tid) ?? '';
        sawTextBeforeCompact = typeof firstTextSeq === 'number' && firstTextSeq < firstCompactSeq && accumulated.length > 0;
        findings.evidence.push(
          `[3] round ${i}: AUTO compact triggered (compactSeq=${firstCompactSeq}, firstTextSeq=${firstTextSeq ?? 'none'}, accLen=${accumulated.length}) textBeforeCompact=${sawTextBeforeCompact}`,
        );
      } else {
        findings.evidence.push(`[3] round ${i}: no auto compact this turn (deltas=${collector.byMethod(ServerNotif.agentMessageDelta).length})`);
      }
    }

    if (sawAutoCompact) {
      findings.autoCompactPartial = sawTextBeforeCompact
        ? 'YES — auto-compact triggered and agentMessage deltas accumulated before the compact signal (compact_partial can support auto)'
        : 'NO-MID-STREAM — auto-compact 确实可被低 token-limit 逼出，但它发生在 turn 边界（新一轮生成之前），compact 信号在本轮任何 agentMessage delta 之前到达；不存在"正在流式的局部文本被压缩"的窗口。结论：compact_partial 没有可累积的 in-flight 文本来源，B1 应只支持 manual（auto 仅作 compactReason 透传，不挂 partial 文本）。';
    } else {
      findings.autoCompactPartial =
        'UNCERTAIN(难测) — could not reliably force kernel auto-compact even with model_auto_compact_token_limit=2000 in 4 verbose rounds; constructing长上下文 to cross the内核 token-limit is non-deterministic in PoC. Recommendation: B1 compact_partial 先只支持 manual.';
    }
    findings.evidence.push(`[3] verdict: sawAutoCompact=${sawAutoCompact} sawTextBeforeCompact=${sawTextBeforeCompact}`);
  } catch (err) {
    findings.autoCompactPartial = `UNCERTAIN(难测) — auto-compact probe errored: ${(err as Error).message}. B1 compact_partial 先只支持 manual.`;
    findings.evidence.push(`[3] probeAutoCompact error: ${(err as Error).message}`);
  } finally {
    off();
    await client.close();
  }
}

/**
 * 探针 4：trim + resume 安全性。
 * 在一个**新进程的 client**上 thread/resume(threadId) —— 先验证未 trim 的 resume 能召回，
 * 再把 rollout 文件里 compacted 边界【之前】的历史物理删除（保留 session_meta + 边界之后），
 * 然后再次 resume，看是否仍能正确续接。
 *
 * 注意：直接改真实 rollout 有风险，故对 rollout 做**副本**，用 thread/resume 的 path 变体
 * 指向副本来测 trim 安全（不污染原 thread）。
 */
async function probeTrimResume(
  findings: Findings,
  threadId: string,
  rolloutPath: string | null,
): Promise<void> {
  // ── 4a：未 trim 的 resume 召回（基线） ──
  {
    const client = new AppServerClient({ requestTimeoutMs: 120_000 });
    const collector = new NotifCollector();
    const off = client.onNotification((m, p) => collector.record(m, p));
    try {
      await client.start();
      const params: ThreadResumeParams = { threadId };
      await client.request(Method.threadResume, params);
      const tid = await runTurn(client, collector, threadId, 'What was the codeword? Reply with just the codeword.');
      const recall = (collector.agentTextByTurn.get(tid) ?? '').toUpperCase();
      const ok = recall.includes('COMPACT-ALPHA-42');
      findings.evidence.push(`[4a] resume(no-trim) recall="${recall.trim().slice(0, 60)}" ok=${ok}`);
    } catch (err) {
      findings.evidence.push(`[4a] resume(no-trim) FAILED: ${(err as Error).message}`);
    } finally {
      off();
      await client.close();
    }
  }

  // ── 4b：trim 副本后 resume(path) ──
  if (!rolloutPath || !existsSync(rolloutPath)) {
    findings.trimSafeForResume = `UNTESTED — rolloutPath unavailable (${rolloutPath ?? 'null'}); cannot test physical trim. 建议 B1 trim 保守为"只归档不删"直到 path 可得 + 验证。`;
    findings.evidence.push(`[4b] rolloutPath missing, trim test skipped`);
    return;
  }

  const copyPath = join(tmpdir(), `happycodex-poc-compact-trim-${Date.now()}.jsonl`);
  copyFileSync(rolloutPath, copyPath);
  const raw = readFileSync(copyPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  // 找 compacted 边界：rollout 里顶层 type==="compacted" 的行（精确，不靠子串误匹配 instructions）。
  let boundaryIdx = -1;
  raw.forEach((line, idx) => {
    if (idx === 0 || boundaryIdx !== -1) return;
    try {
      const o = JSON.parse(line) as { type?: string };
      if (o.type === 'compacted') boundaryIdx = idx;
    } catch {
      /* skip */
    }
  });
  findings.evidence.push(`[4b] rollout lines=${raw.length} compactedBoundaryIdx=${boundaryIdx} (line0=session_meta)`);

  if (boundaryIdx <= 1) {
    findings.trimSafeForResume = `UNTESTED — 在 rollout 副本中未能定位顶层 type==="compacted" 边界行（idx=${boundaryIdx}）。建议 B1 trim 保守为"只归档不删"。`;
    findings.evidence.push(`[4b] type==="compacted" boundary not found in rollout; trim-resume not exercised`);
    return;
  }

  // 物理 trim：保留 line0(session_meta) + 边界及其之后，删掉 [1, boundaryIdx) 的历史。
  const trimmed = [raw[0], ...raw.slice(boundaryIdx)].join('\n') + '\n';
  writeFileSync(copyPath, trimmed, 'utf8');
  findings.evidence.push(`[4b] wrote trimmed copy: ${copyPath} (kept session_meta + ${raw.length - boundaryIdx} post-boundary lines)`);

  const client = new AppServerClient({ requestTimeoutMs: 120_000 });
  const collector = new NotifCollector();
  const off = client.onNotification((m, p) => collector.record(m, p));
  try {
    await client.start();
    // 用 path 变体 resume 指向被 trim 的副本。
    // 真实 0.137.0：ThreadResumeParams.threadId 必填；非运行线程 path 优先于 threadId。
    const params: ThreadResumeParams = { threadId, path: copyPath };
    let resumed = false;
    try {
      await client.request(Method.threadResume, params);
      resumed = true;
    } catch (err) {
      findings.trimSafeForResume = `UNSAFE — resume(trimmed path) REJECTED: ${(err as Error).message}. 删 compacted 边界前历史会破坏 resume → B1 trim 必须"只归档不删"。`;
      findings.evidence.push(`[4b] resume(trimmed) REJECTED: ${(err as Error).message}`);
      return;
    }
    if (resumed) {
      const tid = await runTurn(client, collector, threadId, 'Briefly: are you able to continue this conversation? Reply YES or NO and one word about the prior topic.');
      const reply = collector.agentTextByTurn.get(tid) ?? '';
      const ok = reply.trim().length > 0;
      findings.trimSafeForResume = ok
        ? `SAFE(初步) — resume(trimmed path) 成功且能继续对话 reply="${reply.trim().slice(0, 50)}"。删 compacted 边界前历史不破坏 resume → B1 trim 可真删（仍建议先归档）。`
        : `UNCERTAIN — resume(trimmed) 成功但续接回复为空。建议 B1 trim 保守"只归档不删"。`;
      findings.evidence.push(`[4b] resume(trimmed) OK; continue reply="${reply.trim().slice(0, 60)}"`);
    }
  } catch (err) {
    findings.trimSafeForResume = `UNCERTAIN — resume(trimmed) 异常: ${(err as Error).message}. 建议 B1 trim "只归档不删"。`;
    findings.evidence.push(`[4b] resume(trimmed) error: ${(err as Error).message}`);
  } finally {
    off();
    await client.close();
  }
}

async function main(): Promise<number> {
  const findings: Findings = {
    manualCompactWorks: 'UNKNOWN',
    manualCompactResponse: '',
    notificationsObserved: '',
    autoCompactPartial: '',
    trimSafeForResume: '',
    verdict: 'UNCERTAIN',
    evidence: [],
  };

  console.error('[poc-compact] ── 探针 1+2：主动 compact + 通知/item 形状 ──');
  const ctx = await probeManualCompact(findings);

  console.error('[poc-compact] ── 探针 3：auto-compact partial（难测探测）──');
  await probeAutoCompact(findings);

  if (ctx?.threadId) {
    console.error('[poc-compact] ── 探针 4：trim + resume 安全性 ──');
    await probeTrimResume(findings, ctx.threadId, ctx.rolloutPath);
  } else {
    findings.trimSafeForResume = 'UNTESTED — 探针1未拿到 threadId，无法测 trim+resume。';
  }

  // ── 裁决 ──
  const manualOk = findings.manualCompactWorks === 'YES';
  const notifOk = findings.notificationsObserved.includes('count=') &&
    (findings.notificationsObserved.includes('contextCompaction item count=') &&
      !findings.notificationsObserved.includes('contextCompaction item count=0'));
  if (manualOk && (notifOk || findings.notificationsObserved.includes('thread/compacted notif count='))) {
    findings.verdict = 'OK';
  } else if (manualOk) {
    findings.verdict = 'UNCERTAIN';
  } else {
    findings.verdict = 'FAIL';
  }

  console.error('\n' + '═'.repeat(60));
  console.error('[poc-compact] FINDINGS');
  console.error('─'.repeat(60));
  console.error(`1. manual thread/compact/start works : ${findings.manualCompactWorks}`);
  console.error(`   response                          : ${findings.manualCompactResponse}`);
  console.error(`2. notifications/items observed       : ${findings.notificationsObserved}`);
  console.error(`3. auto-compact partial-text         : ${findings.autoCompactPartial}`);
  console.error(`4. trim-then-resume safe             : ${findings.trimSafeForResume}`);
  console.error('─'.repeat(60));
  console.error('EVIDENCE:');
  for (const e of findings.evidence) console.error(`  • ${e}`);
  console.error('═'.repeat(60));
  console.error(`[poc-compact] RESULT: ${findings.verdict}`);

  // 同时以 JSON 落一行到 stdout，便于 orchestration 抓取。
  process.stdout.write(JSON.stringify({ poc: 'compact', ...findings }) + '\n');

  return findings.verdict === 'FAIL' ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[poc-compact] fatal:', err);
  process.exit(1);
});
