/**
 * PoC: poc-steer —— 验证 R2（运行中注入 / turn steer）。
 *
 * 验证什么：
 *   针对**真实 codex app-server**，确认在一个 active turn 进行中（已收到 ≥1 个
 *   text_delta），调用 ThreadSession.sendUserMessage() 能否走 `turn/steer`
 *   （携带 expectedTurnId）把新指令注入正在运行的 turn，并被模型采纳。
 *   对应 docs/CODEX-PORT-PLAN.md §9 待验证点 R2。
 *
 * 期望现象：
 *   - 第一条任务（写诗）开始流式输出。
 *   - 注入「包含 PINEAPPLE」后，本轮最终输出包含 PINEAPPLE → STEER OK。
 *   - 若 steer 报错（expectedTurnId 不匹配 / 方法不可见等）则捕获并打印。
 *
 * 运行前置：codex 已登录、CODEX_HOME 指向有效配置目录。
 * 运行：npm run poc:steer  /  make poc-steer
 */

import { AppServerClient } from '../appserver/client.js';
import { ThreadSession } from '../runtime/session.js';
import type { ThreadSessionConfig } from '../contracts.js';

const SESSION_CONFIG: ThreadSessionConfig = {
  approvalPolicy: 'never',
  sandbox: 'read-only',
};

const STEER_WORD = 'PINEAPPLE';

async function main(): Promise<number> {
  const client = new AppServerClient();

  try {
    await client.start();

    const session = new ThreadSession(client, SESSION_CONFIG);

    let collected = '';
    let deltaCount = 0;
    let steerSent = false;
    let steerError: unknown = null;

    // 收到第一个 text_delta 后触发注入；只注入一次
    const trySteer = (): void => {
      if (steerSent) return;
      steerSent = true;
      // 不 await（在事件回调里）；通过 catch 捕获 steer 失败
      session
        .sendUserMessage(`Also include the word ${STEER_WORD} somewhere.`)
        .then(() => {
          process.stderr.write(`\n[poc-steer] steer injected (${STEER_WORD})\n`);
        })
        .catch((err) => {
          steerError = err;
          process.stderr.write(`\n[poc-steer] steer injection ERROR: ${String(err)}\n`);
        });
    };

    session.onStreamEvent((ev) => {
      if (ev.eventType === 'text_delta' && ev.text) {
        deltaCount += 1;
        collected += ev.text;
        process.stdout.write(ev.text);
        if (deltaCount >= 1) {
          trySteer();
        }
      } else if (ev.eventType === 'thinking_delta' && ev.text) {
        process.stderr.write(ev.text);
      }
    });

    const turnDone = new Promise<{ turnId: string; subtype: string }>((resolve) => {
      session.onTurnCompleted((info) => resolve(info));
    });

    await session.start();
    await session.sendUserMessage(
      'Write a short 6-line poem about the ocean, one line at a time, pausing between lines.',
    );

    const info = await turnDone;

    process.stdout.write('\n');
    console.log('────────────────────────────────────────');
    console.log(`[poc-steer] turn completed: turnId=${info.turnId} subtype=${info.subtype}`);
    console.log(`[poc-steer] text_delta count = ${deltaCount}`);
    console.log(`[poc-steer] steer sent       = ${steerSent}`);

    if (steerError) {
      console.log(`[poc-steer] STEER ERROR —— 注入失败: ${String(steerError)}`);
      return 1;
    }

    const hit = collected.toUpperCase().includes(STEER_WORD);
    console.log(
      hit
        ? `[poc-steer] STEER OK —— 输出包含 ${STEER_WORD}，运行中注入被采纳`
        : `[poc-steer] STEER UNCERTAIN —— 输出未包含 ${STEER_WORD}（可能注入太晚/未走 steer，需检查）`,
    );

    return 0;
  } catch (err) {
    console.error('[poc-steer] FAILED:', err);
    return 1;
  } finally {
    await client.close();
  }
}

main().then((code) => process.exit(code));
