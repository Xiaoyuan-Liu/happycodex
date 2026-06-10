/**
 * happycodex standalone agent-runner —— 进程式可运行入口（spawn-per-session，非长驻 daemon）。
 *
 * 与主仓 HappyClaw container-runner spawn 的可执行产物同构：
 *   stdin（读到 EOF）= 初始输入（CodexRunnerInput / 主仓 ContainerInput 的超集，宽松忽略多余字段）
 *   stdout          = StreamEvent 经 wrapStreamEvent（OUTPUT_MARKER）逐行输出
 *   IPC input/      = 后续用户消息 + 三 sentinel（_close / _interrupt / _drain）
 *
 * 数据流：
 *   stdin → CodexRunnerInput → AppServerClient + CodexRunner.run()（StreamEvent → sink → stdout）
 *   {ipcDir}/{folder}/input/*.json → IpcInputLoop → runner.inject()
 *   _close → runner.shutdown()；_interrupt → turn/interrupt（client）；_drain → 收尾（shutdown）
 *
 * 构造范式照 src/poc/poc-stream.ts、poc-tools.ts、poc-multitenant.ts 与 src/runtime/codex-runner.ts。
 * 本文件只新增，不改任何冻结契约 / C-Fix 逻辑文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AppServerClient } from './appserver/client.js';
import { Method, type TurnInterruptParams } from './appserver/protocol.js';
import { CodexRunner } from './runtime/codex-runner.js';
import { ToolRegistry } from './runtime/tools/registry.js';
import { IpcToolBridge } from './runtime/tools/ipc-bridge.js';
import { createBuiltinTools } from './runtime/tools/builtin.js';
import { IpcInputLoop, ipcInputDir, type IpcInputMessage } from './runtime/ipc-input.js';
import {
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  type StreamEvent,
} from './shared/stream-event.js';
import type { CodexRunnerInput, ThreadSessionConfig } from './contracts.js';

// ───────────────────────── 路径解析（env 覆盖 + 默认 data/ 根） ─────────────────────────

/** 运行时数据根（ipc/memory 都在其下）。对齐主仓 data/ 语义；env 优先，默认 ./data。 */
const DATA_DIR = process.env.HAPPYCODEX_DATA_DIR || path.resolve(process.cwd(), 'data');
/** IPC 根目录（输入侧 input/ + 输出侧 messages/ tasks/ 都在 {ipcDir}/{folder}/ 下）。 */
const IPC_DIR = process.env.HAPPYCODEX_WORKSPACE_IPC || path.join(DATA_DIR, 'ipc');
/** 记忆根目录（per-folder .md）。 */
const MEMORY_DIR = process.env.HAPPYCODEX_WORKSPACE_MEMORY || path.join(DATA_DIR, 'memory');

// ───────────────────────── stdin / stdout ─────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function log(msg: string): void {
  // 日志走 stderr，stdout 只承载 OUTPUT_MARKER 包裹的 StreamEvent（与解析端约定一致）。
  process.stderr.write(`[happycodex-agent-runner] ${msg}\n`);
}

/** 直接向 stdout 写一条 OUTPUT_MARKER 事件（与 wrapStreamEvent 同格式，用于入口自身的收尾/错误事件）。 */
function writeStreamEvent(ev: StreamEvent): void {
  process.stdout.write(`${OUTPUT_START_MARKER}${JSON.stringify(ev)}${OUTPUT_END_MARKER}\n`);
}

// ───────────────────────── 输入解析（CodexRunnerInput；吃主仓 ContainerInput 超集） ─────────────────────────

/**
 * 把 stdin JSON 宽松解析为 CodexRunnerInput。
 * - 兼容主仓 ContainerInput 的字段名：prompt / groupFolder（必有），以及 sessionId / model / cwd 等。
 * - 多余字段一律忽略；缺失字段给安全默认（folder 默认 'default'，prompt 默认空串）。
 */
export function parseRunnerInput(raw: string): CodexRunnerInput {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    throw new Error(`failed to parse stdin as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const prompt = typeof obj.prompt === 'string' ? obj.prompt : '';
  // 主仓字段名是 groupFolder；兼容 folder 别名。
  const groupFolder =
    (typeof obj.groupFolder === 'string' && obj.groupFolder) ||
    (typeof obj.folder === 'string' && obj.folder) ||
    'default';

  // session 配置：可由顶层字段（主仓 ContainerInput 风格）或嵌套 session 对象提供，后者优先。
  const nested = obj.session && typeof obj.session === 'object' ? (obj.session as Record<string, unknown>) : {};
  const pick = <T>(key: string, guard: (v: unknown) => v is T): T | undefined => {
    if (guard(nested[key])) return nested[key] as T;
    if (guard(obj[key])) return obj[key] as T;
    return undefined;
  };
  const isStr = (v: unknown): v is string => typeof v === 'string';

  const session: ThreadSessionConfig = {};
  const model = pick('model', isStr);
  if (model) session.model = model;
  const cwd = pick('cwd', isStr);
  if (cwd) session.cwd = cwd;
  const approvalPolicy = pick('approvalPolicy', isStr) as ThreadSessionConfig['approvalPolicy'] | undefined;
  if (approvalPolicy) session.approvalPolicy = approvalPolicy;
  const sandbox = pick('sandbox', isStr) as ThreadSessionConfig['sandbox'] | undefined;
  if (sandbox) session.sandbox = sandbox;
  const baseInstructions = pick('baseInstructions', isStr);
  if (baseInstructions) session.baseInstructions = baseInstructions;
  const developerInstructions = pick('developerInstructions', isStr);
  if (developerInstructions) session.developerInstructions = developerInstructions;
  // 恢复续接：主仓用 sessionId 表示既有会话；这里映射到 resumeThreadId（codex thread）。
  const resumeThreadId =
    pick('resumeThreadId', isStr) ?? (isStr(obj.sessionId) ? obj.sessionId : undefined);
  if (resumeThreadId) session.resumeThreadId = resumeThreadId;

  return { prompt, groupFolder, session };
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  const enableTools = process.env.HAPPYCODEX_ENABLE_TOOLS !== 'false';

  let input: CodexRunnerInput;
  try {
    const stdinData = await readStdin();
    input = parseRunnerInput(stdinData);
  } catch (err) {
    writeStreamEvent({
      eventType: 'result',
      subtype: 'failed',
      statusText: `input parse failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }
  log(`input parsed: folder=${input.groupFolder} promptChars=${input.prompt.length} enableTools=${enableTools}`);

  const folder = input.groupFolder;

  // ── 构造 codex 运行时（per-folder CODEX_HOME 隔离交由调用方/多租户层；standalone 入口用进程默认 CODEX_HOME） ──
  const client = new AppServerClient();

  // 可选工具层（Stage 3）：IpcToolBridge 写输出侧 messages/ tasks/ + 记忆。
  let tools: { registry: ToolRegistry; bridge: IpcToolBridge } | undefined;
  if (enableTools) {
    const registry = new ToolRegistry();
    for (const def of createBuiltinTools()) registry.register(def);
    const bridge = new IpcToolBridge({ ipcDir: IPC_DIR, memoryDir: MEMORY_DIR });
    tools = { registry, bridge };
    log(`tools enabled: ${registry.specs().length} dynamic tools, ipcDir=${IPC_DIR}`);
  }

  // 捕获 threadId：从流经 sink 的 StreamEvent（init / result 等带 threadId）记录，供 _interrupt 直接发 turn/interrupt。
  let threadId: string | null = null;
  const sink = (line: string): void => {
    try {
      // line = OUTPUT_START + JSON + OUTPUT_END + '\n'；提取中间 JSON 取 threadId。
      const json = line.slice(OUTPUT_START_MARKER.length, line.length - OUTPUT_END_MARKER.length - 1);
      const ev = JSON.parse(json) as StreamEvent;
      if (ev.threadId) threadId = ev.threadId;
    } catch {
      /* 透传输出不受解析失败影响 */
    }
    process.stdout.write(line);
  };

  const runner = new CodexRunner({
    client,
    config: input.session,
    sink,
    ...(tools ? { tools } : {}),
  });

  // ── IPC 输入循环：input/*.json → runner.inject()；三 sentinel 映射 ──
  const inputDir = ipcInputDir(IPC_DIR, folder);
  let shuttingDown = false;

  const beginShutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown requested: ${reason}`);
    inputLoop.stop();
    runner.shutdown();
  };

  const interruptCurrentTurn = (): void => {
    // _interrupt → session.interrupt() 的等价调用：直接对 client 发 turn/interrupt（与 ThreadSession.interrupt 同一 RPC）。
    // runner 内部 session 不可达（冻结契约只暴露 run/inject/shutdown），故用我们持有的 client + 捕获的 threadId。
    if (!threadId) {
      log('interrupt ignored: no active thread yet');
      return;
    }
    const params: TurnInterruptParams = { threadId };
    log(`interrupt: turn/interrupt threadId=${threadId}`);
    void client.request(Method.turnInterrupt, params).catch((err) => {
      log(`interrupt failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const inputLoop = new IpcInputLoop(inputDir, {
    onMessage: (msg: IpcInputMessage) => {
      // standalone 入口只桥接文本（图片/sourceJid 透传给主仓阶段再接；inject 契约只吃 text）。
      log(`inject message (${msg.text.length} chars)`);
      runner.inject(msg.text);
    },
    onClose: () => beginShutdown('_close sentinel'),
    onInterrupt: () => interruptCurrentTurn(),
    onDrain: () => beginShutdown('_drain sentinel'),
  });

  // ── 信号处理：SIGTERM/SIGINT → runner.shutdown()（兜底 process.exit） ──
  const onSignal = (sig: string): void => {
    log(`received ${sig}`);
    beginShutdown(sig);
    // 兜底：若 shutdown 未在宽限期内让 run() 结算，强制退出。
    setTimeout(() => {
      log('shutdown grace exceeded, forcing exit');
      process.exit(0);
    }, 5000).unref();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  try {
    await client.start();
    // run() 前启动输入循环：start() 立即 tick 一次，处理 boot 期间已落地的 input 文件 / sentinel。
    inputLoop.start();
    await runner.run(input);
    log('run() completed');
    process.exit(0);
  } catch (err) {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    writeStreamEvent({
      eventType: 'result',
      subtype: 'failed',
      statusText: `agent-runner error: ${err instanceof Error ? err.message : String(err)}`,
    });
    try {
      runner.shutdown();
    } catch {
      /* ignore */
    }
    process.exit(1);
  } finally {
    inputLoop.stop();
  }
}

// EPIPE（父进程关闭管道）静默退出，避免无意义的 code 1。
(process.stdout as NodeJS.WriteStream).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

// 仅在作为主入口被直接执行时运行 main()（被 import 进单测时不自动跑）。
const invokedAsMain = (() => {
  try {
    const argvPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    const selfPath = fs.realpathSync(new URL(import.meta.url).pathname);
    // tsx 跑 .ts、node 跑编译后的 .js：去扩展名比较，覆盖两种入口。
    const strip = (p: string): string => p.replace(/\.(ts|js|mjs|cjs)$/, '');
    return strip(argvPath) === strip(selfPath);
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  void main();
}
