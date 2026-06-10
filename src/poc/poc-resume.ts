/**
 * PoC: poc-resume —— 验证跨进程续接（thread/resume）。
 *
 * 验证什么：
 *   针对**真实 codex app-server**，确认一个进程里建立 thread 并写入上下文（codeword）
 *   后，**关闭整个 client（含子进程）**，再用新 client + ThreadSession({ resumeThreadId })
 *   按 threadId 续接，模型是否仍记得此前的上下文。
 *   对应 docs/CODEX-PORT-PLAN.md §9 跨进程续接验证点。
 *
 * 期望现象：
 *   - client2 续接后回答能复述出 codeword（HAPPYCODEX-7788）→ RESUME OK。
 *
 * 运行前置：codex 已登录、CODEX_HOME 指向有效配置目录（两次 client 必须同一 CODEX_HOME，
 *   resume 才能读到第一次写入的 rollout）。
 * 运行：npm run poc:resume  /  make poc-resume
 */

import { AppServerClient } from '../appserver/client.js';
import { ThreadSession } from '../runtime/session.js';
import type { ThreadSessionConfig } from '../contracts.js';

const CODEWORD = 'HAPPYCODEX-7788';

const BASE_CONFIG: ThreadSessionConfig = {
  approvalPolicy: 'never',
  sandbox: 'read-only',
};

/** 在给定 session 上发一条消息并等待 turn 结束，返回本轮累计文本。 */
async function ask(session: ThreadSession, text: string): Promise<string> {
  let collected = '';
  const off = session.onStreamEvent((ev) => {
    if (ev.eventType === 'text_delta' && ev.text) {
      collected += ev.text;
      process.stdout.write(ev.text);
    }
  });
  const turnDone = new Promise<void>((resolve) => {
    const offDone = session.onTurnCompleted(() => {
      offDone();
      resolve();
    });
  });
  await session.sendUserMessage(text);
  await turnDone;
  off();
  process.stdout.write('\n');
  return collected;
}

async function main(): Promise<number> {
  // ── 阶段 1：进程 A，写入 codeword，取 threadId，然后关闭 ──
  const client1 = new AppServerClient();
  let threadId: string | null = null;

  try {
    await client1.start();
    const session1 = new ThreadSession(client1, { ...BASE_CONFIG });
    await session1.start();

    threadId = session1.state.threadId;
    console.log(`[poc-resume] phase1 threadId = ${threadId ?? '(null)'}`);

    await ask(session1, `Remember this codeword: ${CODEWORD}. Reply OK.`);
  } catch (err) {
    console.error('[poc-resume] phase1 FAILED:', err);
    await client1.close();
    return 1;
  } finally {
    await client1.close();
  }

  if (!threadId) {
    console.error('[poc-resume] FAILED —— phase1 未拿到 threadId，无法续接');
    return 1;
  }

  console.log('────────────────────────────────────────');
  console.log('[poc-resume] client1 closed; opening client2 to resume...');

  // ── 阶段 2：进程 B（新 client + 新 ThreadSession），按 threadId 续接 ──
  const client2 = new AppServerClient();

  try {
    await client2.start();
    const resumeConfig: ThreadSessionConfig = { ...BASE_CONFIG, resumeThreadId: threadId };
    const session2 = new ThreadSession(client2, resumeConfig);
    await session2.start();

    const answer = await ask(session2, 'What was the codeword I told you?');

    console.log('────────────────────────────────────────');
    const ok = answer.toUpperCase().includes(CODEWORD);
    console.log(
      ok
        ? `[poc-resume] RESUME OK —— 续接后模型复述出 codeword (${CODEWORD})`
        : `[poc-resume] RESUME FAIL —— 续接后未复述出 codeword (${CODEWORD})`,
    );
    return ok ? 0 : 1;
  } catch (err) {
    console.error('[poc-resume] phase2 FAILED:', err);
    return 1;
  } finally {
    await client2.close();
  }
}

main().then((code) => process.exit(code));
