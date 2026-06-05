/**
 * PoC: poc-stream —— 验证 R1（token 级流式增量）。
 *
 * 验证什么：
 *   针对**真实 codex app-server**，确认 `item/agentMessage/delta` 通知是否逐 token
 *   增量到达（StreamMapper 映射为 StreamEvent.text_delta），而不是 turn 结束时一次性
 *   整段返回。对应 docs/CODEX-PORT-PLAN.md §9 待验证点 R1。
 *
 * 期望现象：
 *   - 数字 1..10 在 onTurnCompleted 之前就逐步出现在 stdout（边到边打）。
 *   - 收到的 text_delta 个数 > 1（理想情况下远大于 1）。
 *
 * 运行前置：codex 已登录、CODEX_HOME 指向有效配置目录。
 * 运行：npm run poc:stream  /  make poc-stream
 */

import { AppServerClient } from '../appserver/client.js';
import { ThreadSession } from '../runtime/session.js';
import type { ThreadSessionConfig } from '../contracts.js';

const SESSION_CONFIG: ThreadSessionConfig = {
  approvalPolicy: 'never', // 避免审批回环阻塞
  sandbox: 'read-only', // 只读，不动磁盘
};

async function main(): Promise<number> {
  const client = new AppServerClient();

  try {
    await client.start();

    const session = new ThreadSession(client, SESSION_CONFIG);

    let textDeltaCount = 0;
    let thinkingDeltaCount = 0;
    let toolEventCount = 0;

    session.onStreamEvent((ev) => {
      switch (ev.type) {
        case 'text_delta':
          if (ev.text) {
            textDeltaCount += 1;
            // 实时逐 delta 打印（不换行），观测是否增量到达
            process.stdout.write(ev.text);
          }
          break;
        case 'thinking_delta':
          if (ev.text) {
            thinkingDeltaCount += 1;
            process.stderr.write(ev.text);
          }
          break;
        case 'tool_use_start':
          toolEventCount += 1;
          process.stderr.write(`\n[tool_use_start ${ev.toolName ?? '?'}]\n`);
          break;
        case 'tool_use_end':
          toolEventCount += 1;
          process.stderr.write(`\n[tool_use_end ${ev.toolName ?? '?'} ok=${ev.ok ?? '?'}]\n`);
          break;
        case 'tool_progress':
          toolEventCount += 1;
          process.stderr.write('.');
          break;
        default:
          break;
      }
    });

    // 用 Promise 等待本轮结束
    const turnDone = new Promise<{ turnId: string; subtype: string }>((resolve) => {
      session.onTurnCompleted((info) => resolve(info));
    });

    await session.start();
    await session.sendUserMessage(
      'Count from 1 to 10, one number per line, with a short pause between each.',
    );

    const info = await turnDone;

    process.stdout.write('\n');
    console.log('────────────────────────────────────────');
    console.log(`[poc-stream] turn completed: turnId=${info.turnId} subtype=${info.subtype}`);
    console.log(`[poc-stream] text_delta count     = ${textDeltaCount}`);
    console.log(`[poc-stream] thinking_delta count = ${thinkingDeltaCount}`);
    console.log(`[poc-stream] tool event count      = ${toolEventCount}`);
    console.log(
      textDeltaCount > 1
        ? '[poc-stream] STREAM OK —— 文本逐增量到达（多个 text_delta）'
        : '[poc-stream] STREAM UNCERTAIN —— text_delta <= 1，疑似整段返回，需检查映射',
    );

    return 0;
  } catch (err) {
    console.error('[poc-stream] FAILED:', err);
    return 1;
  } finally {
    await client.close();
  }
}

main().then((code) => process.exit(code));
