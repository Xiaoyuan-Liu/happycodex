/**
 * PoC（Stage 5 / B2 调研）：对真实 codex 0.137.0 验证三个未知，决定 B2-A vs B2-B。
 *
 * 验证什么（用低层 AppServerClient 直接发请求，不依赖尚未实现的 session.compact/decorateScope）：
 *   ① CODEX_HOME 里【如何定义一个子代理】使模型真的会 spawn 它。
 *      做法：在 per-PoC 的 CODEX_HOME/agents/ 写两个 TOML（code-reviewer / web-researcher，
 *      对齐 happyclaw PREDEFINED_AGENTS 的人设），multi_agent 特性 stable=true。然后用文本
 *      请求模型去 spawn code-reviewer，监听所有 thread/started 通知，看是否出现
 *      source = { subAgent: { thread_spawn: {...} } }（即 SubAgentSource::thread_spawn）。
 *   ② codex 默认是否带【web 搜索工具】（web-researcher 依赖）。
 *      做法：thread/start.config 打开 web_search="live"，请模型做一次 web 搜索，观察是否出现
 *      webSearch item（item/started|completed item.type==='webSearch'）。
 *   ③ thread/fork 是否可用、语义如何。
 *      做法：先建一个有上下文（codeword）的 thread，发 Method.threadFork，检查响应里
 *      thread.id 是否新、forkedFromId/sessionId 关系，并对 fork 出的 thread 发一轮确认它继承上下文。
 *
 * 判据（用户规则）：①②③ 足以支撑移植 code-reviewer/web-researcher + fork
 *   → feasibleForB2B=true / recommendation 'B2-B'；否则 'B2-A'。
 *
 * 运行前置：codex 已登录（~/.codex/auth.json）。本 PoC 用临时 CODEX_HOME，仅拷贝 auth.json
 *   复用登录态，不污染用户真实配置。
 * 运行：npm run poc:subagent  /  tsx src/poc/poc-subagent.ts
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppServerClient } from '../appserver/client.js';
import {
  Method,
  ServerReq,
  textInput,
  type Thread,
  type ThreadStartParams,
  type ThreadStartResponse,
  type TurnStartParams,
  type TurnStartResponse,
} from '../appserver/protocol.js';

// ───────────────────────── 临时 CODEX_HOME 准备 ─────────────────────────

/** 拷 auth.json + 写两个 agent TOML，返回临时 CODEX_HOME 路径。 */
function prepareCodexHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'happycodex-subagent-'));
  // 复用登录态
  const realAuth = join(homedir(), '.codex', 'auth.json');
  if (!existsSync(realAuth)) {
    throw new Error(`需要 codex 登录态：未找到 ${realAuth}`);
  }
  copyFileSync(realAuth, join(home, 'auth.json'));

  // 子代理定义：CODEX_HOME/agents/<stem>.toml（实测格式：description + developer_instructions + name）
  const agentsDir = join(home, 'agents');
  mkdirSync(agentsDir, { recursive: true });

  // code-reviewer —— 对齐 happyclaw agent-definitions.ts PREDEFINED_AGENTS['code-reviewer']
  writeFileSync(
    join(agentsDir, 'code-reviewer.toml'),
    [
      'name = "code-reviewer"',
      'description = "Code review agent that analyzes code quality, best practices, and potential issues"',
      'developer_instructions = """',
      'You are a strict code reviewer. Focus on correctness, security, performance, and maintainability.',
      'Point out specific issues with file:line references. Be concise and actionable.',
      'When asked, reply with the marker token CR-SPAWNED so the caller can confirm you ran.',
      '"""',
      '',
    ].join('\n'),
    'utf8',
  );

  // web-researcher —— 对齐 PREDEFINED_AGENTS['web-researcher']
  writeFileSync(
    join(agentsDir, 'web-researcher.toml'),
    [
      'name = "web-researcher"',
      'description = "Web research agent that searches and extracts information from web pages"',
      'developer_instructions = """',
      'You are an efficient web researcher. Search for information, extract key facts, and summarize findings.',
      'Always cite sources with URLs. Prefer authoritative sources.',
      '"""',
      '',
    ].join('\n'),
    'utf8',
  );

  return home;
}

// ───────────────────────── 通知探测器 ─────────────────────────

interface SpawnObservation {
  /** 监听到的所有 thread/started thread（含主 thread + 任何子 thread）。 */
  startedThreads: Thread[];
  /** 检测到的 subAgent thread_spawn source（若有）。 */
  subAgentSpawns: { threadId: string; source: unknown }[];
  /** collabAgentToolCall item（multi-agent 工具调用：spawnAgent/sendInput/wait/...）。 */
  collabCalls: Record<string, unknown>[];
  /** spawnAgent 收到的 receiverThreadIds（= 新 spawn 的子代理 thread id）。 */
  spawnedThreadIds: Set<string>;
  /** webSearch item 是否出现过。 */
  sawWebSearchItem: boolean;
  /** 观察到的所有 item.type（去重，用于诊断）。 */
  itemTypes: Set<string>;
  /** 观察到的工具调用 / mcpToolCall / dynamicToolCall 名（诊断 multi-agent 工具名）。 */
  toolNames: Set<string>;
}

function isSubAgentSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false;
  return 'subAgent' in (source as Record<string, unknown>);
}

function extractThreadSpawn(source: unknown): unknown {
  if (typeof source !== 'object' || source === null) return null;
  const sa = (source as Record<string, unknown>).subAgent;
  if (typeof sa === 'object' && sa !== null && 'thread_spawn' in (sa as Record<string, unknown>)) {
    return (sa as Record<string, unknown>).thread_spawn;
  }
  return sa ?? null;
}

/** 在 client 上挂全局通知监听，记录 thread/started 与 item 事件。 */
function attachProbe(client: AppServerClient, obs: SpawnObservation): () => void {
  return client.onNotification((method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'thread/started') {
      const thread = p.thread as Thread | undefined;
      if (thread) {
        obs.startedThreads.push(thread);
        if (isSubAgentSource(thread.source)) {
          obs.subAgentSpawns.push({ threadId: thread.id, source: thread.source });
        }
      }
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = p.item as Record<string, unknown> | undefined;
      const t = typeof item?.type === 'string' ? (item.type as string) : undefined;
      if (t) {
        obs.itemTypes.add(t);
        if (t === 'webSearch') obs.sawWebSearchItem = true;
        // 工具名诊断
        if (t === 'mcpToolCall' && typeof item?.tool === 'string') obs.toolNames.add(item.tool as string);
        if (t === 'dynamicToolCall' && typeof item?.tool === 'string') obs.toolNames.add(item.tool as string);
        if (t === 'commandExecution' && typeof item?.command === 'string') {
          obs.toolNames.add('shell:' + (item.command as string).slice(0, 24));
        }
        // ★ multi-agent：collabAgentToolCall 是 codex 的子代理派生机制
        if (t === 'collabAgentToolCall' && item) {
          obs.collabCalls.push(item);
          const tool = typeof item.tool === 'string' ? (item.tool as string) : '?';
          obs.toolNames.add('collab:' + tool);
          const recv = item.receiverThreadIds;
          if (Array.isArray(recv)) {
            for (const id of recv) if (typeof id === 'string') obs.spawnedThreadIds.add(id);
          }
        }
      }
    }
  });
}

// ───────────────────────── 低层 turn 驱动（不经 ThreadSession） ─────────────────────────

const SANDBOX_CONFIG = { approvalPolicy: 'never' as const, sandbox: 'read-only' as const };

/** 自动放行任何 server→client 审批请求（PoC：sandbox read-only，approval never 已基本不会发）。 */
function autoApprove(client: AppServerClient): () => void {
  return client.onServerRequest((req, respond) => {
    // 不同审批请求响应形状不同，但都接受一个 decision='approved'/'allow'。给最宽松回复。
    switch (req.method) {
      case ServerReq.commandExecutionRequestApproval:
      case ServerReq.fileChangeRequestApproval:
      case ServerReq.permissionsRequestApproval:
        respond({ decision: 'approved' });
        break;
      default:
        respond({});
        break;
    }
  });
}

/** thread/start，返回 thread。 */
async function startThread(
  client: AppServerClient,
  extraConfig?: Record<string, unknown>,
): Promise<{ thread: Thread; raw: ThreadStartResponse }> {
  const params: ThreadStartParams = {
    approvalPolicy: SANDBOX_CONFIG.approvalPolicy,
    sandbox: SANDBOX_CONFIG.sandbox,
    cwd: process.cwd(),
  };
  if (extraConfig) params.config = extraConfig;
  const raw = await client.request<ThreadStartResponse>(Method.threadStart, params);
  return { thread: raw.thread, raw };
}

/** turn/start 并等待该 turn 完成，收集 agentMessage 文本。需在调用前订阅好通知。 */
async function runTurn(client: AppServerClient, threadId: string, text: string): Promise<string> {
  let collected = '';
  const offText = client.onNotification((method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'item/agentMessage/delta' && p.threadId === threadId) {
      collected += typeof p.delta === 'string' ? p.delta : '';
    }
  });

  const done = new Promise<void>((resolve) => {
    const offDone = client.onNotification((method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === 'turn/completed' && p.threadId === threadId) {
        offDone();
        resolve();
      }
    });
  });

  const turnParams: TurnStartParams = { threadId, input: [textInput(text)] };
  await client.request<TurnStartResponse>(Method.turnStart, turnParams);
  await done;
  offText();
  return collected;
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<number> {
  const codexHome = prepareCodexHome();
  const client = new AppServerClient({
    env: { CODEX_HOME: codexHome },
    requestTimeoutMs: 0, // subagent / web 搜索可能较久，关看门狗
  });

  const obs: SpawnObservation = {
    startedThreads: [],
    subAgentSpawns: [],
    collabCalls: [],
    spawnedThreadIds: new Set(),
    sawWebSearchItem: false,
    itemTypes: new Set(),
    toolNames: new Set(),
  };

  const result = {
    multiAgentFeature: 'unknown' as string,
    agentFormat: 'CODEX_HOME/agents/<name>.toml (description + developer_instructions + name)',
    q1_subagentSpawn: false as boolean,
    q1_detail: '' as string,
    q2_webTool: false as boolean,
    q2_detail: '' as string,
    q3_fork: false as boolean,
    q3_detail: '' as string,
  };

  try {
    // 先记录 multi_agent 特性 stable 状态（从 codex features list 读，作为证据）
    const feat = spawnSync('codex', ['features', 'list'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    const featLine = (feat.stdout || '')
      .split('\n')
      .find((l) => /^multi_agent\s/.test(l));
    result.multiAgentFeature = (featLine ?? 'multi_agent (not found)').trim().replace(/\s+/g, ' ');

    const init = await client.start();
    console.error(`[poc-subagent] app-server up; codexHome=${init.codexHome}`);

    const offProbe = attachProbe(client, obs);
    const offApprove = autoApprove(client);

    // ───── Q1：子代理 spawn ─────
    console.error('\n[poc-subagent] Q1: 请模型 spawn code-reviewer 子代理 ...');
    const { thread: mainThread } = await startThread(client);
    console.error(`[poc-subagent] main thread = ${mainThread.id} source=${JSON.stringify(mainThread.source)}`);

    const q1Reply = await runTurn(
      client,
      mainThread.id,
      'Use your multi-agent / subagent capability to spawn the predefined agent named ' +
        '"code-reviewer" as a sub-agent and ask it to introduce itself in one sentence. ' +
        'Spawn it as a separate sub-agent thread (do not just answer yourself). ' +
        'After the sub-agent replies, summarize what it said.',
    );
    console.error(`[poc-subagent] Q1 reply (head): ${q1Reply.slice(0, 120).replace(/\n/g, ' ')}`);
    console.error(`[poc-subagent] thread/started count = ${obs.startedThreads.length}`);
    console.error(`[poc-subagent] subAgent thread/started = ${obs.subAgentSpawns.length}`);
    console.error(`[poc-subagent] collabAgentToolCall items = ${obs.collabCalls.length}`);
    console.error(`[poc-subagent] spawned thread ids = ${[...obs.spawnedThreadIds].join(', ') || '(none)'}`);
    console.error(`[poc-subagent] item types seen = ${[...obs.itemTypes].join(', ')}`);
    console.error(`[poc-subagent] tool names seen = ${[...obs.toolNames].join(' | ')}`);
    // dump 每个 collab call 的关键字段
    for (const c of obs.collabCalls) {
      console.error(
        `[poc-subagent]   collab: tool=${String(c.tool)} status=${String(c.status)} ` +
          `sender=${String(c.senderThreadId)} receivers=${JSON.stringify(c.receiverThreadIds)} ` +
          `prompt=${typeof c.prompt === 'string' ? JSON.stringify((c.prompt as string).slice(0, 50)) : 'null'} ` +
          `agentsStates=${JSON.stringify(c.agentsStates)}`,
      );
    }

    // codex 的子代理派生 = collabAgentToolCall(tool='spawnAgent')，其 receiverThreadIds 为新子代理 thread。
    const spawnCalls = obs.collabCalls.filter((c) => c.tool === 'spawnAgent');
    const spawnWithReceiver = spawnCalls.some(
      (c) => Array.isArray(c.receiverThreadIds) && (c.receiverThreadIds as unknown[]).length > 0,
    );
    if (obs.subAgentSpawns.length > 0) {
      result.q1_subagentSpawn = true;
      result.q1_detail =
        `观察到 ${obs.subAgentSpawns.length} 个 subAgent thread/started；` +
        `source 示例=${JSON.stringify(obs.subAgentSpawns[0]?.source)} ` +
        `thread_spawn=${JSON.stringify(extractThreadSpawn(obs.subAgentSpawns[0]?.source))}`;
    } else if (spawnWithReceiver) {
      // 主路径：模型用 collab spawnAgent 工具真的派生了子代理，receiverThreadIds 即新子线程。
      result.q1_subagentSpawn = true;
      result.q1_detail =
        `模型通过 collabAgentToolCall(tool='spawnAgent') 派生子代理；` +
        `spawn 调用数=${spawnCalls.length}，receiverThreadIds(新子线程)=${[...obs.spawnedThreadIds].join(',')}；` +
        `（子代理派生机制 = CollabAgentTool 'spawnAgent'，子线程 id 在 receiverThreadIds）`;
    } else {
      const sawSpawnTool = spawnCalls.length > 0;
      result.q1_detail =
        `未观察到 subAgent thread/started，也无 spawnAgent+receiver。` +
        `collabCalls=${obs.collabCalls.length}(spawnAgent=${spawnCalls.length}), ` +
        `tools=[${[...obs.toolNames].join(',')}], sawSpawnTool=${sawSpawnTool}`;
      result.q1_subagentSpawn = false;
    }

    // ───── Q2：web 搜索工具 ─────
    console.error('\n[poc-subagent] Q2: 验证默认 web 搜索工具 ...');
    obs.itemTypes.clear();
    const { thread: webThread } = await startThread(client, { web_search: 'live' });
    const q2Reply = await runTurn(
      client,
      webThread.id,
      'Use your web search tool to find the official latest stable version number of Node.js, ' +
        'then reply with just that version and the source URL. If you do not have a web search tool, ' +
        'reply exactly: NO_WEB_TOOL',
    );
    console.error(`[poc-subagent] Q2 reply (head): ${q2Reply.slice(0, 160).replace(/\n/g, ' ')}`);
    console.error(`[poc-subagent] webSearch item seen = ${obs.sawWebSearchItem}`);
    const deniedWeb = /NO_WEB_TOOL/.test(q2Reply);
    if (obs.sawWebSearchItem) {
      result.q2_webTool = true;
      result.q2_detail = '出现 webSearch item（item/started|completed item.type==="webSearch"）→ 默认带 web 搜索工具';
    } else if (!deniedWeb && /https?:\/\//.test(q2Reply)) {
      // 没看到 webSearch item 但回复里带 URL 且没说没工具——保守标 true 并注明不确定
      result.q2_webTool = true;
      result.q2_detail = '未捕获 webSearch item，但回复含 URL 且未声明无工具（可能工具以其它 item 形态出现）';
    } else {
      result.q2_webTool = false;
      result.q2_detail = `未出现 webSearch item${deniedWeb ? '，且模型回复 NO_WEB_TOOL' : ''}`;
    }

    // ───── Q3：thread/fork ─────
    console.error('\n[poc-subagent] Q3: 验证 thread/fork ...');
    const { thread: baseThread } = await startThread(client);
    await runTurn(client, baseThread.id, 'Remember this codeword: FORK-9911. Reply OK.');

    let forkThread: Thread | null = null;
    try {
      const forkResp = await client.request<{ thread: Thread; [k: string]: unknown }>(Method.threadFork, {
        threadId: baseThread.id,
      });
      forkThread = forkResp.thread;
      console.error(
        `[poc-subagent] fork ok: base=${baseThread.id} fork=${forkThread.id} ` +
          `forkedFromId=${forkThread.forkedFromId ?? '(none)'} ` +
          `sessionId base=${baseThread.sessionId} fork=${forkThread.sessionId}`,
      );
      const newId = forkThread.id !== baseThread.id;
      // fork 出的 thread 是否继承上下文（codeword）
      const recall = await runTurn(client, forkThread.id, 'What codeword did I tell you? Reply with just the token.');
      console.error(`[poc-subagent] fork recall: ${recall.slice(0, 60).replace(/\n/g, ' ')}`);
      const inherited = recall.includes('FORK-9911');
      result.q3_fork = newId; // fork 可用 = 返回了新 thread id
      result.q3_detail =
        `thread/fork 返回新 thread id=${newId}（base=${baseThread.id} → fork=${forkThread.id}）；` +
        `forkedFromId=${forkThread.forkedFromId ?? 'null'}；` +
        `sessionId ${baseThread.sessionId === forkThread.sessionId ? '相同(同 session tree)' : '不同'}；` +
        `上下文继承(codeword recall)=${inherited}`;
    } catch (err) {
      result.q3_fork = false;
      result.q3_detail = `thread/fork 调用失败：${err instanceof Error ? err.message : String(err)}`;
      console.error(`[poc-subagent] fork FAILED: ${result.q3_detail}`);
    }

    offProbe();
    offApprove();
  } catch (err) {
    console.error('[poc-subagent] FATAL:', err);
    rmSync(codexHome, { recursive: true, force: true });
    return 1;
  } finally {
    await client.close();
  }

  rmSync(codexHome, { recursive: true, force: true });

  // ───────────────────────── 结论 ─────────────────────────
  const feasible = result.q1_subagentSpawn && result.q2_webTool && result.q3_fork;
  const recommendation = feasible ? 'B2-B' : 'B2-A';

  console.error('\n' + '═'.repeat(60));
  console.error('[poc-subagent] 结论');
  console.error(`  feature       : ${result.multiAgentFeature}`);
  console.error(`  agent format  : ${result.agentFormat}`);
  console.error(`  Q1 subagent   : ${result.q1_subagentSpawn ? 'OK' : 'FAIL'} — ${result.q1_detail}`);
  console.error(`  Q2 web tool   : ${result.q2_webTool ? 'OK' : 'FAIL'} — ${result.q2_detail}`);
  console.error(`  Q3 fork       : ${result.q3_fork ? 'OK' : 'FAIL'} — ${result.q3_detail}`);
  console.error('─'.repeat(60));
  console.error(`  feasibleForB2B = ${feasible}`);
  console.error(`  recommendation = ${recommendation}`);
  const verdict = feasible ? 'OK' : result.q1_subagentSpawn || result.q3_fork ? 'UNCERTAIN' : 'FAIL';
  console.error(`  VERDICT: ${verdict}`);
  console.error('═'.repeat(60));

  return feasible ? 0 : 2;
}

main().then((code) => process.exit(code));
