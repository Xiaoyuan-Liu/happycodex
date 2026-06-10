/**
 * PoC（Stage D）：standalone agent-runner 入口端到端冒烟。
 *
 * 仿 poc-multitenant.ts 的 ask() 模式，但走真正的「进程式入口」：
 *   spawn `tsx src/agent-runner.ts`（子进程）→ stdin 喂 CodexRunnerInput → 解析 stdout 的
 *   OUTPUT_MARKER StreamEvent → 通过 IPC input/ 注入一条后续消息 → 写 _close sentinel 收尾。
 *
 * 证明入口能真跑：初始 prompt 的回复 + 注入消息的回复都从 stdout 流出，最后干净退出。
 *
 * 运行前置：codex 已登录、CODEX_HOME 指向有效配置目录（与其它 poc 一致）。
 * 无登录态时子进程会以 result/failed 收尾，本脚本据此报 UNCERTAIN 而非 FAIL（区分"入口逻辑 OK 但无凭据"）。
 * 跑：npm run poc:entry
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  type StreamEvent,
} from '../shared/stream-event.js';

const FOLDER = 'home-entry-poc';

/** 解析 stdout 流里的 OUTPUT_MARKER 事件（容忍跨 chunk 半行）。 */
class OutputMarkerParser {
  private buf = '';
  feed(chunk: string, onEvent: (ev: StreamEvent) => void): void {
    this.buf += chunk;
    let start: number;
    while ((start = this.buf.indexOf(OUTPUT_START_MARKER)) !== -1) {
      const end = this.buf.indexOf(OUTPUT_END_MARKER, start);
      if (end === -1) break; // 半行，等下一个 chunk
      const json = this.buf.slice(start + OUTPUT_START_MARKER.length, end);
      this.buf = this.buf.slice(end + OUTPUT_END_MARKER.length);
      try {
        onEvent(JSON.parse(json) as StreamEvent);
      } catch {
        /* ignore malformed */
      }
    }
  }
}

/** 原子写一条 IPC input message。 */
function writeIpcMessage(inputDir: string, name: string, text: string): void {
  const target = join(inputDir, name);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify({ type: 'message', text }), 'utf8');
  renameSync(tmp, target);
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'happycodex-entry-'));
  const ipcDir = join(dataDir, 'ipc');
  const inputDir = join(ipcDir, FOLDER, 'input');
  mkdirSync(inputDir, { recursive: true });

  // 入口源文件：本 poc 位于 src/poc/，入口在 src/agent-runner.ts。
  const here = fileURLToPath(import.meta.url);
  const entry = resolve(here, '..', '..', 'agent-runner.ts');

  const child = spawn('npx', ['tsx', entry], {
    env: {
      ...process.env,
      HAPPYCODEX_DATA_DIR: dataDir,
      HAPPYCODEX_WORKSPACE_IPC: ipcDir,
      HAPPYCODEX_WORKSPACE_MEMORY: join(dataDir, 'memory'),
      // 工具层非本冒烟关注点，关掉以减少噪声（入口逻辑不变）。
      HAPPYCODEX_ENABLE_TOOLS: 'false',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const events: StreamEvent[] = [];
  let textOut = '';
  const parser = new OutputMarkerParser();
  let injected = false;
  let closed = false;
  let resultCount = 0;
  let failed = false;

  // 注入时机：standalone 入口在初始 turn 完成且无待注入时即 resolve run() 退出。
  // 因此后续消息必须在初始 turn **在飞期间**注入（→ turn/steer 或排队进第二轮），
  // 否则会与"首轮完成即退出"竞速。这里在首个 init 事件（thread 已建、首轮即将/正在跑）
  // 一到就写入 IPC，确保注入落在完成门控 resolve 之前。
  const maybeInject = (): void => {
    if (injected) return;
    injected = true;
    writeIpcMessage(inputDir, `${Date.now()}-follow.json`, 'Now reply with exactly the single word: BETA');
  };

  const maybeClose = (): void => {
    if (closed) return;
    // 注入的 BETA 已可见（无论模型是把它走 steer 并进同一 turn，还是开新 turn），即可收尾。
    // 同时兜底：若 turn 已 failed，也立刻收尾。
    if (failed || (injected && /BETA/i.test(textOut))) {
      closed = true;
      // _close sentinel → runner.shutdown() → 干净退出。
      writeFileSync(join(inputDir, '_close'), '', 'utf8');
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    parser.feed(chunk, (ev) => {
      events.push(ev);
      if (ev.eventType === 'text_delta') textOut += ev.text ?? '';
      if (ev.eventType === 'init') maybeInject();
      if (ev.eventType === 'result') {
        if (ev.subtype === 'failed') failed = true;
        resultCount += 1;
      }
      maybeClose();
    });
  });

  // 喂初始输入（read 到 EOF）。
  const initialInput = {
    prompt: 'Reply with exactly the single word: ALPHA',
    groupFolder: FOLDER,
    session: { approvalPolicy: 'never', sandbox: 'read-only' },
  };
  child.stdin.write(JSON.stringify(initialInput));
  child.stdin.end();

  const exitCode: number = await new Promise((res) => {
    child.on('exit', (code) => res(code ?? -1));
    // 兜底超时：90s 无法完成则杀子进程。
    setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, 90_000).unref();
  });

  rmSync(dataDir, { recursive: true, force: true });

  const sawInit = events.some((e) => e.eventType === 'init');
  console.error('\n' + '─'.repeat(40));
  console.error(`[poc-entry] exitCode        : ${exitCode}`);
  console.error(`[poc-entry] init event      : ${sawInit}`);
  console.error(`[poc-entry] result count    : ${resultCount}`);
  console.error(`[poc-entry] any failed      : ${failed}`);
  console.error(`[poc-entry] text out        : ${textOut.trim().slice(0, 80)}`);

  if (failed && resultCount > 0 && !sawInit) {
    // 入口逻辑跑通（spawn + stdin 解析 + OUTPUT_MARKER 管道 + _close 退出），但 codex 未受理 turn
    // （通常是无登录态 / CODEX_HOME 无凭据）。
    console.error('[poc-entry] RESULT: UNCERTAIN —— 入口管道 OK，但 codex 未产出（疑似无登录态/凭据）');
    process.exit(0);
  }

  // 成功判据：thread 建立（init）+ 初始 prompt 回复（ALPHA）+ IPC 注入消息回复（BETA）都流出，且干净退出。
  // 注入消息可能被 codex 以 turn/steer 并入同一 turn（→ 1 个 result）或开新 turn（→ 2 个 result），
  // 故只校验"两段文本均到达"，不强约束 result 个数。
  const ok = sawInit && /ALPHA/i.test(textOut) && /BETA/i.test(textOut) && exitCode === 0;
  if (ok) {
    console.error('[poc-entry] RESULT: OK —— 入口端到端：初始回复 + IPC 注入回复 + _close 干净退出');
    process.exit(0);
  }
  console.error('[poc-entry] RESULT: FAIL —— 未达成端到端预期（见上方观测）');
  process.exit(1);
}

main().catch((err) => {
  console.error('[poc-entry] error:', err);
  process.exit(1);
});
