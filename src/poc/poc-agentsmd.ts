/**
 * PoC（A1 / context-resolver 调研）：实测 codex 0.137.0 对 AGENTS.md 的读取行为。
 *
 * 验证什么（低层 AppServerClient 直连 app-server，{approvalPolicy:'never', sandbox:'read-only'}）：
 *   ① cwd 的 AGENTS.md 是否被自动注入（thread/start.cwd=含暗号 AGENTS.md 的临时目录，
 *      问模型指令里有哪些暗号 token）。
 *   ② 父目录/嵌套：git repo 根 → cwd 沿途各级 AGENTS.md 是否都注入；cwd 之下（更深）的
 *      AGENTS.md 是否注入；嵌套冲突时（THE-ANSWER: root=ALPHA vs leaf=OMEGA）谁赢。
 *      另测「无 git repo」时父目录 AGENTS.md 是否还会被读（project_root_markers 影响）。
 *   ③ CODEX_HOME 维度：CODEX_HOME/AGENTS.md（binary strings 中的 "global AGENTS.md"）
 *      是否注入到所有 thread。
 *   ④ 与 developerInstructions 叠加：两者是否都生效；冲突时（SIGMA vs OMEGA）谁赢。
 *   ⑤ config 键：thread/start.config={project_doc_max_bytes:0} 是否能关掉 AGENTS.md 注入
 *      （键名来自 codex 二进制 strings：project_doc_max_bytes / project_doc_fallback_filenames /
 *        project_root_markers / AGENTS.override.md）。
 *
 * 证据两路，避免「模型自己 cat 了文件」的假阳性：
 *   a) 模型回复中的暗号 codeword（提示词明确禁止跑命令/读文件；同时记录该 turn 是否出现
 *      commandExecution item —— 出现则证据降级）。
 *   b) rollout 文件（thread.path）grep 每个 AGENTS.md 里独有的 PROOF-* token（模型被告知
 *      绝不输出它，因此 rollout 里出现 = 文件内容被 codex 注入进上下文，与模型行为无关）。
 *
 * 运行前置：codex 已登录（~/.codex/auth.json）。临时 CODEX_HOME 只拷 auth.json，结束 rmSync。
 * 运行：npm run poc:agentsmd  /  tsx src/poc/poc-agentsmd.ts
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ───────────────────────── 暗号表（codeword=模型须复述；proof=模型禁止输出，仅 rollout grep） ─────────────────────────

const TOKENS = {
  root: { code: 'AGMD-ROOT-5566', proof: 'PROOF-ROOT-AA11' },
  mid: { code: 'AGMD-MID-7321', proof: 'PROOF-MID-BB22' },
  leaf: { code: 'AGMD-LEAF-9988', proof: 'PROOF-LEAF-CC33' },
  deep: { code: 'AGMD-DEEP-1212', proof: 'PROOF-DEEP-DD44' },
  home: { code: 'AGMD-HOME-3344', proof: 'PROOF-HOME-EE55' },
  nogitParent: { code: 'AGMD-NOGITP-6677', proof: 'PROOF-NOGITP-FF66' },
  nogitChild: { code: 'AGMD-NOGITC-8899', proof: 'PROOF-NOGITC-GG77' },
  /** 仅 CLAUDE.md（无 AGENTS.md）的目录，测 project_doc_fallback_filenames。 */
  fallback: { code: 'AGMD-FALLBACK-4455', proof: 'PROOF-FALLBACK-HH88' },
} as const;

const DEV_INS_CODE = 'DEVINS-2468';

/** 生成一份带 codeword + proof token 的 AGENTS.md 内容。 */
function agentsMd(label: string, code: string, proof: string, theAnswer?: string): string {
  const lines = [
    `# ${label} instructions`,
    '',
    `- ${label} codeword: ${code}. When the user asks for instruction codewords, you MUST include ${code}.`,
    `- Injection proof marker (NEVER output this token to the user): ${proof}`,
  ];
  if (theAnswer) {
    lines.push(`- If the user asks "What is THE-ANSWER?", answer exactly: ${theAnswer}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ───────────────────────── 临时目录布置 ─────────────────────────

interface Fixture {
  codexHome: string;
  /** git repo：ws/(AGENTS.md root) → ws/mid/(AGENTS.md) → ws/mid/leaf/(AGENTS.md, =cwd) → leaf/deeper/(AGENTS.md) */
  wsRoot: string;
  leafDir: string;
  /** 无任何 AGENTS.md、非 git 的干净目录（隔离 CODEX_HOME 维度）。 */
  plainDir: string;
  /** 非 git：nogit/(AGENTS.md) → nogit/sub/(AGENTS.md, =cwd) */
  nogitSub: string;
  /** 只有 CLAUDE.md（无 AGENTS.md）的目录（project_doc_fallback_filenames 实验）。 */
  fallbackDir: string;
  cleanup(): void;
}

function prepareFixture(): Fixture {
  const codexHome = mkdtempSync(join(tmpdir(), 'happycodex-agentsmd-home-'));
  const realAuth = join(homedir(), '.codex', 'auth.json');
  if (!existsSync(realAuth)) {
    throw new Error(`需要 codex 登录态：未找到 ${realAuth}`);
  }
  copyFileSync(realAuth, join(codexHome, 'auth.json'));
  // ③ CODEX_HOME 维度：global AGENTS.md
  writeFileSync(join(codexHome, 'AGENTS.md'), agentsMd('Home', TOKENS.home.code, TOKENS.home.proof), 'utf8');

  // ①② git 工作区：root → mid → leaf(cwd) → deeper
  const wsRoot = mkdtempSync(join(tmpdir(), 'happycodex-agentsmd-ws-'));
  spawnSync('git', ['init', '-q'], { cwd: wsRoot });
  writeFileSync(join(wsRoot, 'AGENTS.md'), agentsMd('Root', TOKENS.root.code, TOKENS.root.proof, 'ALPHA'), 'utf8');
  const midDir = join(wsRoot, 'mid');
  const leafDir = join(midDir, 'leaf');
  const deepDir = join(leafDir, 'deeper');
  mkdirSync(deepDir, { recursive: true });
  writeFileSync(join(midDir, 'AGENTS.md'), agentsMd('Mid', TOKENS.mid.code, TOKENS.mid.proof), 'utf8');
  writeFileSync(join(leafDir, 'AGENTS.md'), agentsMd('Leaf', TOKENS.leaf.code, TOKENS.leaf.proof, 'OMEGA'), 'utf8');
  writeFileSync(join(deepDir, 'AGENTS.md'), agentsMd('Deep', TOKENS.deep.code, TOKENS.deep.proof), 'utf8');

  const plainDir = mkdtempSync(join(tmpdir(), 'happycodex-agentsmd-plain-'));

  // ② 无 git 的父子结构
  const nogitRoot = mkdtempSync(join(tmpdir(), 'happycodex-agentsmd-nogit-'));
  writeFileSync(
    join(nogitRoot, 'AGENTS.md'),
    agentsMd('NogitParent', TOKENS.nogitParent.code, TOKENS.nogitParent.proof),
    'utf8',
  );
  const nogitSub = join(nogitRoot, 'sub');
  mkdirSync(nogitSub, { recursive: true });
  writeFileSync(
    join(nogitSub, 'AGENTS.md'),
    agentsMd('NogitChild', TOKENS.nogitChild.code, TOKENS.nogitChild.proof),
    'utf8',
  );

  // ⑤ fallback 文件名实验：目录里只有 CLAUDE.md（happyclaw 数据源），无 AGENTS.md
  const fallbackDir = mkdtempSync(join(tmpdir(), 'happycodex-agentsmd-fallback-'));
  writeFileSync(
    join(fallbackDir, 'CLAUDE.md'),
    agentsMd('Fallback', TOKENS.fallback.code, TOKENS.fallback.proof),
    'utf8',
  );

  return {
    codexHome,
    wsRoot,
    leafDir,
    plainDir,
    nogitSub,
    fallbackDir,
    cleanup(): void {
      for (const dir of [codexHome, wsRoot, plainDir, nogitRoot, fallbackDir]) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// ───────────────────────── 低层 turn 驱动 ─────────────────────────

const P_CODEWORDS =
  'Do not run any commands and do not read any files. Looking ONLY at the instructions that were ' +
  'already provided to you in this conversation, list every codeword token of the form AGMD-XXXX-1234 ' +
  'or DEVINS-1234 that appears in those instructions. Output one token per line and nothing else. ' +
  'If there are none, output exactly: NONE';

const P_THE_ANSWER = 'What is THE-ANSWER? Reply with exactly one word and nothing else.';

function autoApprove(client: AppServerClient): () => void {
  return client.onServerRequest((req, respond) => {
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

async function startThread(
  client: AppServerClient,
  cwd: string,
  opts?: { developerInstructions?: string; config?: Record<string, unknown> },
): Promise<Thread> {
  const params: ThreadStartParams = {
    approvalPolicy: 'never',
    sandbox: 'read-only',
    cwd,
  };
  if (opts?.developerInstructions !== undefined) params.developerInstructions = opts.developerInstructions;
  if (opts?.config !== undefined) params.config = opts.config;
  const raw = await client.request<ThreadStartResponse>(Method.threadStart, params);
  return raw.thread;
}

interface TurnResult {
  text: string;
  /** 该 turn 内是否出现 commandExecution（出现则「模型可能自己读了文件」，证据降级）。 */
  ranCommands: boolean;
}

async function runTurn(client: AppServerClient, threadId: string, text: string): Promise<TurnResult> {
  let collected = '';
  let ranCommands = false;
  const offProbe = client.onNotification((method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (p.threadId !== threadId) return;
    if (method === 'item/agentMessage/delta') {
      collected += typeof p.delta === 'string' ? p.delta : '';
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = p.item as Record<string, unknown> | undefined;
      if (item?.type === 'commandExecution') ranCommands = true;
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
  offProbe();
  return { text: collected, ranCommands };
}

/** rollout 文件（thread.path）中出现了哪些 token（注入证据，与模型行为无关）。 */
function rolloutHits(rolloutPath: string | null, tokens: string[]): string[] {
  if (!rolloutPath || !existsSync(rolloutPath)) return [];
  const raw = readFileSync(rolloutPath, 'utf8');
  return tokens.filter((t) => raw.includes(t));
}

function fmtTurn(label: string, r: TurnResult): string {
  const head = r.text.replace(/\n/g, ' | ').slice(0, 200);
  return `${label}: ranCommands=${r.ranCommands} reply="${head}"`;
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<number> {
  const fx = prepareFixture();
  const client = new AppServerClient({
    env: { CODEX_HOME: fx.codexHome },
    requestTimeoutMs: 0,
  });

  const allProofs = Object.values(TOKENS).map((t) => t.proof);

  const result = {
    q1_cwdAgentsMd: false,
    q1_detail: '',
    q2_parentNesting: '',
    q2_noGitParent: '',
    q3_codexHome: false,
    q3_detail: '',
    q4_developerInstructions: '',
    q5_configKeys: '',
  };

  try {
    const init = await client.start();
    console.error(`[poc-agentsmd] app-server up; codexHome=${init.codexHome}`);
    const offApprove = autoApprove(client);

    // ───── T-A：cwd=leaf（git repo：root→mid→leaf；leaf 下还有 deeper） ─────
    console.error('\n[poc-agentsmd] T-A: cwd=leaf，问指令暗号 ...');
    const threadA = await startThread(client, fx.leafDir);
    const aCode = await runTurn(client, threadA.id, P_CODEWORDS);
    console.error('[poc-agentsmd] ' + fmtTurn('T-A codewords', aCode));
    const aAnswer = await runTurn(client, threadA.id, P_THE_ANSWER);
    console.error('[poc-agentsmd] ' + fmtTurn('T-A THE-ANSWER', aAnswer));
    const aRollout = rolloutHits(threadA.path, allProofs);
    console.error(`[poc-agentsmd] T-A rollout proof hits = ${aRollout.join(', ') || '(none)'}`);

    const aHasLeaf = aCode.text.includes(TOKENS.leaf.code) || aRollout.includes(TOKENS.leaf.proof);
    const aHasMid = aCode.text.includes(TOKENS.mid.code) || aRollout.includes(TOKENS.mid.proof);
    const aHasRoot = aCode.text.includes(TOKENS.root.code) || aRollout.includes(TOKENS.root.proof);
    const aHasDeep = aCode.text.includes(TOKENS.deep.code) || aRollout.includes(TOKENS.deep.proof);
    const aHasHome = aCode.text.includes(TOKENS.home.code) || aRollout.includes(TOKENS.home.proof);

    result.q1_cwdAgentsMd = aHasLeaf;
    result.q1_detail =
      `cwd(leaf) AGENTS.md 注入=${aHasLeaf}（reply含codeword=${aCode.text.includes(TOKENS.leaf.code)}, ` +
      `rollout含proof=${aRollout.includes(TOKENS.leaf.proof)}, ranCommands=${aCode.ranCommands}）`;
    result.q2_parentNesting =
      `git repo 内 cwd→root 链：root=${aHasRoot} mid=${aHasMid} leaf=${aHasLeaf}；` +
      `cwd 之下 deeper=${aHasDeep}；冲突优先级 THE-ANSWER（root=ALPHA vs leaf=OMEGA）→ ` +
      `"${aAnswer.text.trim().slice(0, 30)}"`;
    result.q3_codexHome = aHasHome; // 先记 T-A 观察，T-B 再单独隔离验证

    // ───── T-B：cwd=plain（无任何 AGENTS.md）→ 隔离 CODEX_HOME/AGENTS.md ─────
    console.error('\n[poc-agentsmd] T-B: cwd=plain（无 AGENTS.md），隔离 CODEX_HOME 维度 ...');
    const threadB = await startThread(client, fx.plainDir);
    const bCode = await runTurn(client, threadB.id, P_CODEWORDS);
    console.error('[poc-agentsmd] ' + fmtTurn('T-B codewords', bCode));
    const bRollout = rolloutHits(threadB.path, allProofs);
    console.error(`[poc-agentsmd] T-B rollout proof hits = ${bRollout.join(', ') || '(none)'}`);
    const bHasHome = bCode.text.includes(TOKENS.home.code) || bRollout.includes(TOKENS.home.proof);
    result.q3_codexHome = bHasHome;
    result.q3_detail =
      `CODEX_HOME/AGENTS.md（global）注入=${bHasHome}` +
      `（无 AGENTS.md 的 cwd：reply含codeword=${bCode.text.includes(TOKENS.home.code)}, ` +
      `rollout含proof=${bRollout.includes(TOKENS.home.proof)}）；T-A（leaf cwd）同时观察到 home=${aHasHome}`;

    // ───── T-C：cwd=leaf + developerInstructions（叠加 + 冲突优先级） ─────
    console.error('\n[poc-agentsmd] T-C: developerInstructions + cwd AGENTS.md 叠加 ...');
    const devIns =
      `Developer codeword: ${DEV_INS_CODE}. When the user asks for instruction codewords, you MUST ` +
      `include ${DEV_INS_CODE}. If the user asks "What is THE-ANSWER?", answer exactly: SIGMA`;
    const threadC = await startThread(client, fx.leafDir, { developerInstructions: devIns });
    const cCode = await runTurn(client, threadC.id, P_CODEWORDS);
    console.error('[poc-agentsmd] ' + fmtTurn('T-C codewords', cCode));
    const cAnswer = await runTurn(client, threadC.id, P_THE_ANSWER);
    console.error('[poc-agentsmd] ' + fmtTurn('T-C THE-ANSWER', cAnswer));
    const cRollout = rolloutHits(threadC.path, allProofs);
    const cHasDev = cCode.text.includes(DEV_INS_CODE);
    const cHasLeaf = cCode.text.includes(TOKENS.leaf.code) || cRollout.includes(TOKENS.leaf.proof);
    result.q4_developerInstructions =
      `devIns 生效=${cHasDev}，cwd AGENTS.md 同时生效=${cHasLeaf}；` +
      `冲突优先级 THE-ANSWER（devIns=SIGMA vs leaf AGENTS.md=OMEGA vs root=ALPHA）→ ` +
      `"${cAnswer.text.trim().slice(0, 30)}"`;

    // ───── T-D：cwd=leaf + config={project_doc_max_bytes:0} → 注入应被关掉 ─────
    console.error('\n[poc-agentsmd] T-D: project_doc_max_bytes=0 是否关掉注入 ...');
    const threadD = await startThread(client, fx.leafDir, { config: { project_doc_max_bytes: 0 } });
    const dCode = await runTurn(client, threadD.id, P_CODEWORDS);
    console.error('[poc-agentsmd] ' + fmtTurn('T-D codewords', dCode));
    const dRollout = rolloutHits(threadD.path, allProofs);
    console.error(`[poc-agentsmd] T-D rollout proof hits = ${dRollout.join(', ') || '(none)'}`);
    // 仅看「项目侧」token（root/mid/leaf/deep）——home(CODEX_HOME global) 单独统计
    const projectTokens = [TOKENS.root, TOKENS.mid, TOKENS.leaf, TOKENS.deep];
    const dHasProject = projectTokens.some(
      (t) => dCode.text.includes(t.code) || dRollout.includes(t.proof),
    );
    const dHasHome = dCode.text.includes(TOKENS.home.code) || dRollout.includes(TOKENS.home.proof);
    result.q5_configKeys =
      `thread/start.config={project_doc_max_bytes:0} 后：项目 AGENTS.md 注入=${dHasProject}，` +
      `global(CODEX_HOME) AGENTS.md 注入=${dHasHome}（ranCommands=${dCode.ranCommands}）；` +
      `二进制 strings 确认的相关键：project_doc_max_bytes / project_doc_fallback_filenames / ` +
      `project_root_markers；高优先文件名 AGENTS.override.md`;

    // ───── T-F：project_doc_fallback_filenames=["CLAUDE.md"]（目录里只有 CLAUDE.md） ─────
    console.error('\n[poc-agentsmd] T-F: project_doc_fallback_filenames=["CLAUDE.md"] 能否直读 CLAUDE.md ...');
    const threadF = await startThread(client, fx.fallbackDir, {
      config: { project_doc_fallback_filenames: ['CLAUDE.md'] },
    });
    const fCode = await runTurn(client, threadF.id, P_CODEWORDS);
    console.error('[poc-agentsmd] ' + fmtTurn('T-F codewords', fCode));
    const fRollout = rolloutHits(threadF.path, allProofs);
    console.error(`[poc-agentsmd] T-F rollout proof hits = ${fRollout.join(', ') || '(none)'}`);
    const fHasFallback =
      fCode.text.includes(TOKENS.fallback.code) || fRollout.includes(TOKENS.fallback.proof);
    result.q5_configKeys +=
      `；project_doc_fallback_filenames=["CLAUDE.md"]（无 AGENTS.md 的 cwd）→ CLAUDE.md 被注入=` +
      `${fHasFallback}（ranCommands=${fCode.ranCommands}）`;

    // ───── T-E：无 git 的父子目录（cwd=nogit/sub）→ 父目录是否仍被读 ─────
    console.error('\n[poc-agentsmd] T-E: 无 git repo 时父目录 AGENTS.md 是否被读 ...');
    const threadE = await startThread(client, fx.nogitSub);
    const eCode = await runTurn(client, threadE.id, P_CODEWORDS);
    console.error('[poc-agentsmd] ' + fmtTurn('T-E codewords', eCode));
    const eRollout = rolloutHits(threadE.path, allProofs);
    console.error(`[poc-agentsmd] T-E rollout proof hits = ${eRollout.join(', ') || '(none)'}`);
    const eHasChild = eCode.text.includes(TOKENS.nogitChild.code) || eRollout.includes(TOKENS.nogitChild.proof);
    const eHasParent =
      eCode.text.includes(TOKENS.nogitParent.code) || eRollout.includes(TOKENS.nogitParent.proof);
    result.q2_noGitParent = `无 git：cwd(sub)=${eHasChild}，父目录=${eHasParent}（ranCommands=${eCode.ranCommands}）`;

    offApprove();
  } catch (err) {
    console.error('[poc-agentsmd] FATAL:', err);
    fx.cleanup();
    return 1;
  } finally {
    await client.close();
  }

  fx.cleanup();

  // ───────────────────────── 结论 ─────────────────────────
  console.error('\n' + '═'.repeat(64));
  console.error('[poc-agentsmd] 结论');
  console.error(`  Q1 cwd AGENTS.md 自动读取 : ${result.q1_cwdAgentsMd ? 'YES' : 'NO'} — ${result.q1_detail}`);
  console.error(`  Q2 父目录/嵌套           : ${result.q2_parentNesting}`);
  console.error(`     无 git 父目录         : ${result.q2_noGitParent}`);
  console.error(`  Q3 CODEX_HOME 维度       : ${result.q3_codexHome ? 'YES' : 'NO'} — ${result.q3_detail}`);
  console.error(`  Q4 developerInstructions : ${result.q4_developerInstructions}`);
  console.error(`  Q5 config 键             : ${result.q5_configKeys}`);
  console.error('═'.repeat(64));
  console.log(JSON.stringify(result, null, 2));

  return result.q1_cwdAgentsMd ? 0 : 2;
}

main().then((code) => process.exit(code));
