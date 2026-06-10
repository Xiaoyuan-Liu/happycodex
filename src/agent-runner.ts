/**
 * happycodex standalone agent-runner —— 进程式可运行入口（spawn-per-session，非长驻 daemon）。
 *
 * 与主仓 HappyClaw container-runner spawn 的可执行产物同构：
 *   stdin（读到 EOF）= 初始输入（CodexRunnerInput / 主仓 ContainerInput 的超集，宽松忽略多余字段）
 *   stdout          = ContainerOutput 信封（OUTPUT_MARKER 包裹）逐封输出 —— 对齐上游
 *                     agent-output-parser 消费的 {status:'stream'|'success'|'error'|'closed'} 协议；
 *                     引擎内部 StreamEvent 在本进程边界经 src/container-output.ts 映射成信封
 *   IPC input/      = 后续用户消息 + 三 sentinel（_close / _interrupt / _drain）
 *
 * 数据流：
 *   stdin → CodexRunnerInput → AppServerClient + CodexRunner.run()
 *     （StreamEvent → sink → mapStreamEventToOutputs → ContainerOutput → stdout）
 *   {per-folder ipc}/input/*.json → IpcInputLoop → runner.inject()
 *     （per-folder ipc 由 HAPPYCLAW_WORKSPACE_IPC（上游名，per-folder 路径）直接给出，
 *       或由 HAPPYCODEX_WORKSPACE_IPC / data 根（旧 root 语义）+ groupFolder 拼接，
 *       见 resolveWorkspacePaths）
 *   _close → runner.shutdown() + closed 信封；_interrupt → turn/interrupt（client）；
 *   _drain → 收尾（shutdown + closed 信封）
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
import type {
  ToolBridge,
  ScheduleTaskInput,
  TaskSummary,
  MemoryHit,
} from './runtime/tools/types.js';
import { createBuiltinTools } from './runtime/tools/builtin.js';
import { IpcInputLoop, ipcInputDir, type IpcInputMessage } from './runtime/ipc-input.js';
import {
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
  type StreamEvent,
} from './shared/stream-event.js';
import {
  createContainerOutputState,
  mapStreamEventToOutputs,
  closedOutput,
  errorOutput,
  type ContainerOutput,
} from './container-output.js';
import type { CodexRunnerInput, ThreadSessionConfig } from './contracts.js';

// ───────────────────────── 路径解析（env 覆盖 + 默认 data/ 根） ─────────────────────────
//
// 两套 env 名、两种语义（container-runner 是上游应用层，注入上游名）：
//   - HAPPYCLAW_WORKSPACE_IPC / HAPPYCLAW_WORKSPACE_MEMORY（上游名，**per-folder 路径**：
//     …/ipc/{folder}[/agents/{aid}] 与 …/memory/{memoryFolder}）——存在时直接使用，
//     不再拼 {folder} 层（上游 container-runner 已完成 namespace 决策，含 agents/tasks-run 子空间）。
//   - HAPPYCODEX_WORKSPACE_IPC / HAPPYCODEX_WORKSPACE_MEMORY（happycodex 旧名，**根路径**语义：
//     下挂 {folder}/…）——保留双读兼容（poc-entry 等既有调用方）。

/** 运行时数据根（ipc/memory 都在其下）。对齐主仓 data/ 语义；env 优先，默认 ./data。 */
const DATA_DIR = process.env.HAPPYCODEX_DATA_DIR || path.resolve(process.cwd(), 'data');

/** 解析后的 per-folder 工作区路径（agent-runner 实际读写的目录）。 */
export interface ResolvedWorkspacePaths {
  /** IPC 输入目录（input/*.json + 三 sentinel）。 */
  inputDir: string;
  /** IpcToolBridge 的 ipc 根（bridge 内部 join folder）。 */
  bridgeIpcRoot: string;
  /** bridge ipc 调用使用的 folder（root + folder = per-folder IPC 目录）。 */
  bridgeIpcFolder: string;
  /** IpcToolBridge 的 memory 根。 */
  bridgeMemoryRoot: string;
  /** bridge memory 调用使用的 folder。 */
  bridgeMemoryFolder: string;
}

/**
 * 由 env + groupFolder 解析工作区路径。
 *
 * per-folder env 存在时：inputDir = {env}/input；bridge 用 dirname/basename 拆成
 * (root, folder) —— IpcToolBridge（冻结契约）按 {root}/{folder}/channel 寻址，
 * dirname/basename 恒等还原出 env 指定的 per-folder 目录（含 agents/{aid} 等子空间，
 * 此时 folder=aid，与上游"WORKSPACE_IPC 即最终 namespace"语义一致）。
 * env 缺失时：退回根语义（HAPPYCODEX_* root 或默认 data/），folder 由 groupFolder 提供。
 */
export function resolveWorkspacePaths(
  env: NodeJS.ProcessEnv,
  groupFolder: string,
  dataDir: string,
): ResolvedWorkspacePaths {
  const perFolderIpc = env.HAPPYCLAW_WORKSPACE_IPC;
  const perFolderMemory = env.HAPPYCLAW_WORKSPACE_MEMORY;
  const ipcRoot = env.HAPPYCODEX_WORKSPACE_IPC || path.join(dataDir, 'ipc');
  const memoryRoot = env.HAPPYCODEX_WORKSPACE_MEMORY || path.join(dataDir, 'memory');

  return {
    inputDir: perFolderIpc
      ? path.join(perFolderIpc, 'input')
      : ipcInputDir(ipcRoot, groupFolder),
    bridgeIpcRoot: perFolderIpc ? path.dirname(perFolderIpc) : ipcRoot,
    bridgeIpcFolder: perFolderIpc ? path.basename(perFolderIpc) : groupFolder,
    bridgeMemoryRoot: perFolderMemory ? path.dirname(perFolderMemory) : memoryRoot,
    bridgeMemoryFolder: perFolderMemory ? path.basename(perFolderMemory) : groupFolder,
  };
}

// ───────────────────────── per-folder 工具桥适配 ─────────────────────────

/**
 * FixedFolderToolBridge —— 把 ToolBridge 调用钉到解析好的 (root, folder) 上。
 *
 * 背景：builtin 工具用 ctx.groupFolder 作 bridge 的 folder 参数（冻结契约），但上游
 * per-folder env 的目标 folder 可能 ≠ groupFolder（agents/{aid} 子空间、非 home 群组的
 * memoryFolder=ownerHomeFolder）。本适配器忽略调用方 folder，分别用 ipc/memory 各自的
 * 固定 folder 委托给内层 IpcToolBridge——内层的越界校验/原子写/检索逻辑原样生效。
 * env 缺失时 fixed folder == groupFolder，行为与未包裹完全一致。
 */
class FixedFolderToolBridge implements ToolBridge {
  constructor(
    private readonly inner: ToolBridge,
    private readonly ipcFolder: string,
    private readonly memoryFolder: string,
  ) {}

  sendMessage(_folder: string, message: string): Promise<void> {
    return this.inner.sendMessage(this.ipcFolder, message);
  }
  scheduleTask(_folder: string, input: ScheduleTaskInput): Promise<{ taskId: string }> {
    return this.inner.scheduleTask(this.ipcFolder, input);
  }
  listTasks(_folder: string): Promise<TaskSummary[]> {
    return this.inner.listTasks(this.ipcFolder);
  }
  pauseTask(_folder: string, taskId: string): Promise<void> {
    return this.inner.pauseTask(this.ipcFolder, taskId);
  }
  resumeTask(_folder: string, taskId: string): Promise<void> {
    return this.inner.resumeTask(this.ipcFolder, taskId);
  }
  cancelTask(_folder: string, taskId: string): Promise<void> {
    return this.inner.cancelTask(this.ipcFolder, taskId);
  }
  registerGroup(_folder: string, jid: string, name?: string): Promise<void> {
    return name === undefined
      ? this.inner.registerGroup(this.ipcFolder, jid)
      : this.inner.registerGroup(this.ipcFolder, jid, name);
  }
  installSkill(_folder: string, name: string): Promise<void> {
    return this.inner.installSkill(this.ipcFolder, name);
  }
  uninstallSkill(_folder: string, name: string): Promise<void> {
    return this.inner.uninstallSkill(this.ipcFolder, name);
  }
  memoryAppend(_folder: string, content: string, scope?: string): Promise<void> {
    return scope === undefined
      ? this.inner.memoryAppend(this.memoryFolder, content)
      : this.inner.memoryAppend(this.memoryFolder, content, scope);
  }
  memorySearch(_folder: string, query: string): Promise<MemoryHit[]> {
    return this.inner.memorySearch(this.memoryFolder, query);
  }
  memoryGet(_folder: string, relPath: string): Promise<string | null> {
    return this.inner.memoryGet(this.memoryFolder, relPath);
  }
}

export { FixedFolderToolBridge };

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

/** 向 stdout 写一封 OUTPUT_MARKER 包裹的 ContainerOutput 信封（对齐上游 writeOutput）。
 *  返回写入完成的 Promise：紧邻 process.exit 的写入应 await，避免管道缓冲被 exit 截断。 */
function writeContainerOutput(out: ContainerOutput): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${OUTPUT_START_MARKER}${JSON.stringify(out)}${OUTPUT_END_MARKER}\n`, () =>
      resolve(),
    );
  });
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

  // IPC 工具路由上下文（主仓 ContainerInput 字段，IpcToolBridge 写盘时 stamp）。
  const chatJid = isStr(obj.chatJid) && obj.chatJid ? obj.chatJid : undefined;
  const messageTaskId = isStr(obj.messageTaskId) && obj.messageTaskId ? obj.messageTaskId : undefined;

  return {
    prompt,
    groupFolder,
    session,
    ...(chatJid ? { chatJid } : {}),
    ...(obj.isScheduledTask === true ? { isScheduledTask: true } : {}),
    ...(messageTaskId ? { messageTaskId } : {}),
  };
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  const enableTools = process.env.HAPPYCODEX_ENABLE_TOOLS !== 'false';

  let input: CodexRunnerInput;
  try {
    const stdinData = await readStdin();
    input = parseRunnerInput(stdinData);
  } catch (err) {
    // 对齐上游 stdin 解析失败发法：{status:'error', result:null, error:'Failed to parse input: …'}。
    await writeContainerOutput(
      errorOutput(`Failed to parse input: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }
  log(`input parsed: folder=${input.groupFolder} promptChars=${input.prompt.length} enableTools=${enableTools}`);

  const folder = input.groupFolder;
  // 工作区路径：HAPPYCLAW_*（上游名，per-folder）优先，HAPPYCODEX_*（旧名，root 语义）兜底。
  const ws = resolveWorkspacePaths(process.env, folder, DATA_DIR);

  // ── 构造 codex 运行时（per-folder CODEX_HOME 隔离交由调用方/多租户层；standalone 入口用进程默认 CODEX_HOME） ──
  const client = new AppServerClient();

  // 可选工具层（Stage 3）：IpcToolBridge 写输出侧 messages/ tasks/ + 记忆。
  // FixedFolderToolBridge 把工具调用钉到 env 解析出的 per-folder 目标（见适配器注释）。
  let tools: { registry: ToolRegistry; bridge: ToolBridge } | undefined;
  if (enableTools) {
    const registry = new ToolRegistry();
    // 对齐上游：HAPPYCLAW_DISABLE_MEMORY_LAYER === 'true' 时跳过 memory 工具注册
    // （admin host 场景由 container-runner 注入；上游 agent-runner index.ts:1272 同语义）。
    const disableMemoryLayer = process.env.HAPPYCLAW_DISABLE_MEMORY_LAYER === 'true';
    for (const def of createBuiltinTools()) {
      if (disableMemoryLayer && def.spec.name.startsWith('memory_')) continue;
      registry.register(def);
    }
    const inner = new IpcToolBridge({
      ipcDir: ws.bridgeIpcRoot,
      memoryDir: ws.bridgeMemoryRoot,
      // 路由上下文：send_message/schedule_task 的 chatJid/targetJid 来源（主进程 IPC 消费契约）。
      ...(input.chatJid ? { chatJid: input.chatJid } : {}),
      ...(input.isScheduledTask ? { isScheduledTask: true } : {}),
      ...(input.messageTaskId ? { currentTaskId: input.messageTaskId } : {}),
    });
    const bridge = new FixedFolderToolBridge(inner, ws.bridgeIpcFolder, ws.bridgeMemoryFolder);
    tools = { registry, bridge };
    log(
      `tools enabled: ${registry.specs().length} dynamic tools, ipcDir=${ws.bridgeIpcRoot}/${ws.bridgeIpcFolder}`,
    );
  }

  // 进程边界信封化：sink 收到 CodexRunner 的 wrapStreamEvent 行（OUTPUT_START + JSON + OUTPUT_END + '\n'），
  // 拆出 StreamEvent → mapStreamEventToOutputs（纯函数，state 显式滚动）→ 重包成 ContainerOutput 信封写 stdout。
  // 顺势从映射器 state 读主线程 threadId，供 _interrupt 直接发 turn/interrupt（子代理事件不会劫持该标识）。
  let envelopeState = createContainerOutputState();
  // 追踪最后一次信封写入：自然完成路径在 process.exit 前 await 它，防最后一封 success 被 exit 截断。
  let lastEnvelopeWrite: Promise<void> = Promise.resolve();
  const sink = (line: string): void => {
    let ev: StreamEvent;
    try {
      const json = line.slice(OUTPUT_START_MARKER.length, line.length - OUTPUT_END_MARKER.length - 1);
      ev = JSON.parse(json) as StreamEvent;
    } catch (err) {
      // 协议两端都归我们所有（wrapStreamEvent 产物必为合法 JSON），解析失败属编程错误：
      // 记日志丢弃，绝不把裸 StreamEvent 行混进信封协议污染下游解析。
      log(`drop malformed sink line (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    const { state, outputs } = mapStreamEventToOutputs(envelopeState, ev);
    envelopeState = state;
    for (const out of outputs) {
      lastEnvelopeWrite = writeContainerOutput(out);
    }
  };

  const runner = new CodexRunner({
    client,
    config: input.session,
    sink,
    ...(tools ? { tools } : {}),
  });

  // ── IPC 输入循环：input/*.json → runner.inject()；三 sentinel 映射 ──
  // per-folder env 存在时 inputDir = {env}/input（不再拼 {folder} 层，对齐上游语义）。
  const inputDir = ws.inputDir;
  let shuttingDown = false;
  // _close/_drain 触发的收尾需在退出前发 closed 信封（对齐上游：让主进程区分 _close 退出与静默成功）。
  let closeRequested = false;

  const beginShutdown = (reason: string, viaSentinel = false): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (viaSentinel) closeRequested = true;
    log(`shutdown requested: ${reason}`);
    inputLoop.stop();
    runner.shutdown();
  };

  const interruptCurrentTurn = (): void => {
    // _interrupt → session.interrupt() 的等价调用：直接对 client 发 turn/interrupt（与 ThreadSession.interrupt 同一 RPC）。
    // runner 内部 session 不可达（冻结契约只暴露 run/inject/shutdown），故用我们持有的 client + 信封映射器捕获的主线程 threadId。
    const threadId = envelopeState.threadId;
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
    onClose: () => beginShutdown('_close sentinel', true),
    onInterrupt: () => interruptCurrentTurn(),
    onDrain: () => beginShutdown('_drain sentinel', true),
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
    // 自然完成：先等最后一封信封（success/error）真正落管道，再退出，防 exit 截断。
    await lastEnvelopeWrite;
    // _close/_drain 收尾 → closed 信封（自然完成不发：终态 success/error 信封已在事件流中给出）。
    if (closeRequested) await writeContainerOutput(closedOutput());
    process.exit(0);
  } catch (err) {
    log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    await writeContainerOutput(
      errorOutput(
        `agent-runner error: ${err instanceof Error ? err.message : String(err)}`,
        envelopeState.threadId,
      ),
    );
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
