/**
 * Stage 3 工具层契约（冻结）。
 *
 * HappyClaw 的 Agent 通过 12 个 in-process MCP 工具对系统施加副作用（主动发消息、调度任务、
 * 记忆读写等）。Codex 没有同进程工具注册，改走 **dynamicTools**（R3 路 A，已对真实 codex 0.137.0
 * 验证）：在 thread/start.dynamicTools 注册 schema；模型调用时 app-server 发 server→client 请求
 * item/tool/call；happycodex 在进程内执行并回填 DynamicToolCallResponse。
 *
 * 分层：
 * - ToolDefinition = DynamicToolSpec（注册给 codex 的 schema）+ ToolHandler（执行逻辑）。
 * - ToolHandler 只负责"解析 args → 调 ToolBridge → 组装结果"，不直接做 I/O。
 * - ToolBridge = 真正的副作用边界（写 IPC / 记忆文件）。IpcToolBridge 是面向 HappyClaw IPC 布局的
 *   实现；测试用 FakeToolBridge。这样 Stage 4 接入真实主进程时只换 Bridge 实现。
 */

import type {
  DynamicToolSpec,
  DynamicToolCallResponse,
} from '../../appserver/protocol.js';

/** 工具执行上下文。 */
export interface ToolContext {
  /** 调用方会话的 folder（main / home-{userId} 等）。 */
  groupFolder: string;
  /** 当前 thread id（可能尚未就绪）。 */
  threadId: string | null;
  /** 副作用边界。 */
  bridge: ToolBridge;
}

/** 工具处理器：解析 args、调用 bridge、组装回填结果。不应抛错（异常由 dispatcher 兜底为 success:false）。 */
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<DynamicToolCallResponse>;

/** 一个工具 = 注册 schema + 处理器。 */
export interface ToolDefinition {
  spec: DynamicToolSpec;
  handler: ToolHandler;
}

/** 定时任务调度输入（对齐 HappyClaw scheduled_tasks 的三种调度模式）。 */
export type ScheduleSpec =
  | { kind: 'cron'; expr: string }
  | { kind: 'interval'; seconds: number }
  | { kind: 'once'; at: string };

export interface ScheduleTaskInput {
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
}

export interface TaskSummary {
  id: string;
  name: string;
  status: string;
}

export interface MemoryHit {
  path: string;
  snippet: string;
}

/**
 * 副作用边界 —— 12 个工具最终落到的操作。
 * IpcToolBridge：动作类（send/schedule/...）原子写 HappyClaw IPC 文件，记忆类直接文件操作。
 * Stage 4 可换成直连主进程的实现。
 */
export interface ToolBridge {
  sendMessage(folder: string, message: string): Promise<void>;
  scheduleTask(folder: string, input: ScheduleTaskInput): Promise<{ taskId: string }>;
  listTasks(folder: string): Promise<TaskSummary[]>;
  pauseTask(folder: string, taskId: string): Promise<void>;
  resumeTask(folder: string, taskId: string): Promise<void>;
  cancelTask(folder: string, taskId: string): Promise<void>;
  registerGroup(folder: string, jid: string, name?: string): Promise<void>;
  installSkill(folder: string, name: string): Promise<void>;
  uninstallSkill(folder: string, name: string): Promise<void>;
  memoryAppend(folder: string, content: string, scope?: string): Promise<void>;
  memorySearch(folder: string, query: string): Promise<MemoryHit[]>;
  memoryGet(folder: string, path: string): Promise<string | null>;
}

/** 工具注册表：聚合 ToolDefinition，产出 dynamicTools schema，按名分发调用。 */
export interface IToolRegistry {
  register(def: ToolDefinition): void;
  /** 注册给 codex 的 schema 列表（传入 thread/start.dynamicTools）。 */
  specs(): DynamicToolSpec[];
  /** 按工具名分发；未知工具或 handler 抛错 → success:false 的结果（不抛）。 */
  dispatch(tool: string, args: unknown, ctx: ToolContext): Promise<DynamicToolCallResponse>;
  has(tool: string): boolean;
}

/** 工具分发器：订阅 client 的 item/tool/call server 请求 → registry.dispatch → respond。 */
export interface IToolDispatcher {
  /** 释放对 client.onServerRequest 的订阅。 */
  dispose(): void;
}

export type { DynamicToolSpec, DynamicToolCallResponse };
