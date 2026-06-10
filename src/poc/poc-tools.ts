/**
 * PoC（Stage 3）：12 个 HappyClaw 工具走 dynamicTools，对真实 codex 端到端验证。
 *
 * 组装 AppServerClient + ToolRegistry(createBuiltinTools) + ToolDispatcher + ThreadSession(IpcToolBridge)，
 * 让模型调用 memory_append + send_message，验证：
 *   ① item/tool/call 往返、tool_use 事件流出
 *   ② IpcToolBridge 真把副作用落地（messages/*.json + 记忆文件）
 *   ③ 模型能用工具返回值继续作答
 * 跑：npm run poc:tools
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppServerClient } from '../appserver/client.js';
import { ThreadSession } from '../runtime/session.js';
import { ToolRegistry } from '../runtime/tools/registry.js';
import { ToolDispatcher } from '../runtime/tools/dispatcher.js';
import { IpcToolBridge } from '../runtime/tools/ipc-bridge.js';
import { createBuiltinTools } from '../runtime/tools/builtin.js';

const FOLDER = 'home-poc';

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'happycodex-poc-'));
  const ipcDir = join(root, 'ipc');
  const memoryDir = join(root, 'memory');

  const bridge = new IpcToolBridge({ ipcDir, memoryDir });
  const registry = new ToolRegistry();
  for (const def of createBuiltinTools()) registry.register(def);
  console.error(`[poc-tools] registered ${registry.specs().length} dynamic tools`);

  const client = new AppServerClient();
  const toolCalls: string[] = [];

  await client.start();
  const session = new ThreadSession(client, {
    approvalPolicy: 'never',
    sandbox: 'read-only',
    dynamicTools: registry.specs(),
  });
  const dispatcher = new ToolDispatcher(client, registry, {
    groupFolder: FOLDER,
    bridge,
    getThreadId: () => session.state.threadId,
  });

  session.onStreamEvent((ev) => {
    if (ev.eventType === 'text_delta') process.stdout.write(ev.text ?? '');
    else if (ev.eventType === 'tool_use_start') {
      const name = ev.toolName ?? '';
      toolCalls.push(name);
      console.error(`\n[poc-tools] tool_use_start: ${name}`);
    }
  });

  let resolveTurn!: () => void;
  const turnDone = new Promise<void>((r) => {
    resolveTurn = r;
  });
  session.onTurnCompleted(() => resolveTurn());

  await session.start();
  await session.sendUserMessage(
    'Do these steps using your tools, in order: ' +
      '1) call memory_append with content "codeword is ZEBRA-1234". ' +
      '2) call send_message with the text "memory saved". ' +
      '3) Then reply with the single word DONE. Use the tools, do not just describe them.',
  );
  await turnDone;
  dispatcher.dispose();
  await client.close();

  // ── 验证副作用真落地 ──
  const msgDir = join(ipcDir, FOLDER, 'messages');
  const sentMessages = existsSync(msgDir)
    ? readdirSync(msgDir).map((f) => readFileSync(join(msgDir, f), 'utf8'))
    : [];
  const memFile = join(memoryDir, FOLDER, 'CLAUDE.md');
  const memContent = existsSync(memFile) ? readFileSync(memFile, 'utf8') : '';

  console.error('\n' + '─'.repeat(40));
  console.error(`[poc-tools] tool_use events       : ${JSON.stringify(toolCalls)}`);
  console.error(`[poc-tools] IPC messages written  : ${sentMessages.length}`);
  const sentOk = sentMessages.some((m) => m.includes('memory saved'));
  const memOk = memContent.includes('ZEBRA-1234');
  console.error(`[poc-tools] send_message landed    : ${sentOk}`);
  console.error(`[poc-tools] memory_append landed   : ${memOk}`);
  const pass = sentOk && memOk && toolCalls.length >= 2;
  console.error(`[poc-tools] RESULT: ${pass ? 'TOOLS OK —— dynamicTools 端到端往返 + 副作用落地' : 'NEEDS INVESTIGATION'}`);

  rmSync(root, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('[poc-tools] error:', err);
  process.exit(1);
});
