/**
 * PoC（Stage 4）：SessionManager 多租户，对真实 codex 端到端验证。
 *
 * 并发起两个 folder（home-alice / home-bob），各自隔离 CODEX_HOME + thread + 工具，验证：
 *   ① 两个 folder 拿到不同 threadId（会话隔离）
 *   ② 记忆隔离：alice 存的秘密，bob 看不到（per-folder memory）
 *   ③ 并发发送互不串、各自完成
 *   ④ 跨"进程"resume：关掉 alice 再重建，从 SessionStore 续接同一 thread，召回记忆
 * 跑：npm run poc:multitenant  （需 codex 已登录；用真实 CODEX_HOME 作共享 auth 源）
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../runtime/multitenant/session-manager.js';
import type { ManagedSessionHandle } from '../runtime/multitenant/types.js';

/** 发一条消息并收集本轮文本，turn/completed 时返回。 */
async function ask(handle: ManagedSessionHandle, text: string): Promise<string> {
  let buf = '';
  const offEv = handle.onStreamEvent((ev) => {
    if (ev.eventType === 'text_delta') buf += ev.text ?? '';
  });
  const done = new Promise<void>((resolve) => {
    const offDone = handle.onTurnCompleted(() => {
      offDone();
      resolve();
    });
  });
  await handle.send(text);
  await done;
  offEv();
  return buf;
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'happycodex-mt-'));
  const manager = new SessionManager({
    dataDir,
    sessionConfig: { approvalPolicy: 'never', sandbox: 'read-only' },
    enableTools: true,
    idleTimeoutMs: 0, // PoC 期间不自动回收
  });

  const checks: Record<string, boolean> = {};
  try {
    const alice = await manager.getOrCreate('home-alice');
    const bob = await manager.getOrCreate('home-bob');

    // ① 不同 thread
    const tA = alice.threadId;
    const tB = bob.threadId;
    console.error(`[mt] alice thread=${tA}`);
    console.error(`[mt] bob   thread=${tB}`);
    checks['distinct_threads'] = !!tA && !!tB && tA !== tB;

    // ② + ③ 并发：alice 存秘密、bob 查秘密（应查不到）
    const [aliceRes, bobRes] = await Promise.all([
      ask(
        alice,
        'Call the memory_append tool with content exactly "secret fruit is DURIAN". After the tool succeeds, reply with the single word STORED.',
      ),
      ask(
        bob,
        'Call the memory_search tool with query "secret fruit". If the results are empty, reply with the single word NONE. Otherwise reply with what you found.',
      ),
    ]);
    console.error(`[mt] alice store reply: ${aliceRes.trim().slice(0, 40)}`);
    console.error(`[mt] bob   search reply: ${bobRes.trim().slice(0, 40)}`);
    // ③ 并发：两个 folder 的 turn 同时在飞且各自正常完成（Promise.all 已解 + 都有回复）。
    checks['concurrent_ok'] = aliceRes.trim().length > 0 && bobRes.trim().length > 0;

    // 记忆文件落在各自 folder 下，确定性校验隔离
    const aliceMem = join(dataDir, 'memory', 'home-alice', 'CLAUDE.md');
    const bobMemDir = join(dataDir, 'memory', 'home-bob');
    const aliceHasSecret = existsSync(aliceMem) && readFileSync(aliceMem, 'utf8').includes('DURIAN');
    const bobLeaks = !bobRes.includes('NONE') && bobRes.includes('DURIAN');
    checks['alice_stored'] = aliceHasSecret;
    checks['memory_isolated'] = aliceHasSecret && !existsSync(join(bobMemDir, 'CLAUDE.md')) && !bobLeaks;

    // ④ 跨进程 resume：关掉 alice，重建，召回记忆
    await manager.shutdown('home-alice');
    console.error(`[mt] alice shut down; active=${JSON.stringify(manager.activeFolders())}`);
    const alice2 = await manager.getOrCreate('home-alice');
    console.error(`[mt] alice resumed thread=${alice2.threadId} (was ${tA})`);
    checks['resume_same_thread'] = alice2.threadId === tA;
    const recall = await ask(alice2, 'What is my secret fruit? Reply with just the fruit name.');
    console.error(`[mt] alice recall: ${recall.trim().slice(0, 40)}`);
    checks['resume_recall'] = recall.includes('DURIAN');
  } finally {
    await manager.shutdownAll();
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.error('\n' + '─'.repeat(40));
  for (const [k, v] of Object.entries(checks)) console.error(`[mt] ${k.padEnd(20)} : ${v ? 'OK' : 'FAIL'}`);
  const pass = Object.values(checks).every(Boolean) && Object.keys(checks).length === 6;
  console.error(`[mt] RESULT: ${pass ? 'MULTITENANT OK —— 隔离 + 并发 + 跨进程 resume 全过' : 'NEEDS INVESTIGATION'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('[mt] error:', err);
  process.exit(1);
});
