/**
 * Stage 3 工具层契约（冻结；A4 扩展见下）。
 *
 * HappyClaw 的 Agent 通过 in-process MCP 工具对系统施加副作用（主动发消息、调度任务、
 * 记忆读写等）。Codex 没有同进程工具注册，改走 **dynamicTools**（R3 路 A，已对真实 codex 0.137.0
 * 验证）：在 thread/start.dynamicTools 注册 schema；模型调用时 app-server 发 server→client 请求
 * item/tool/call；happycodex 在进程内执行并回填 DynamicToolCallResponse。
 *
 * A4 契约扩展（12 → 17 工具，对齐上游 mcp-tools.ts 完整面）：
 *   - ToolBridge 新增 sendImage / sendFile / discordGetHistory / discordGetChannelInfo /
 *     discordGetServerInfo 五个方法（同步实现方：IpcToolBridge、FixedFolderToolBridge、
 *     FakeToolBridge）。
 *   - installSkill 返回值从 void 升级为 { installed?: string[] }（上游 pollIpcResult 回执的
 *     installed 列表；fire-and-forget 时代无返回数据）。
 *   - 读类工具（listTasks / installSkill / uninstallSkill / discord*）走上游请求-响应协议：
 *     写 {type, requestId, …} 请求文件 → 主进程写回 {type}_result_{requestId}.json → poll 读取。
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

/** send_image 成功后的回执元数据（builtin handler 用于组装 "Image sent: …" 文案）。 */
export interface SendImageResult {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/** discord_get_history 的可选分页参数（对齐上游工具 schema：limit 1-100、before 为 snowflake）。 */
export interface DiscordHistoryOptions {
  limit?: number;
  before?: string;
}

/** discord_get_history 回执的单条消息（字段对齐主进程 list 写回端：authorId 已脱敏剥除）。 */
export interface DiscordHistoryMessage {
  id: string;
  authorName: string;
  authorBot: boolean;
  content: string;
  timestamp: string;
  attachments: Array<{ name: string; url: string }>;
  replyToId?: string;
  edited: boolean;
}

/**
 * 副作用边界 —— 17 个工具最终落到的操作。
 * IpcToolBridge：动作类（send/schedule/...）原子写 HappyClaw IPC 文件，记忆类直接文件操作，
 * 读类（listTasks/installSkill/uninstallSkill/discord*）走请求-响应协议（pollIpcResult）。
 * Stage 4 可换成直连主进程的实现。
 */
export interface ToolBridge {
  sendMessage(folder: string, message: string): Promise<void>;
  /** A4：发送工作区内的图片（读文件 → base64 → messages 通道 type:'image'）。失败抛错。 */
  sendImage(folder: string, filePath: string, caption?: string): Promise<SendImageResult>;
  /** A4：发送工作区内的文件（tasks 通道 type:'send_file'，filePath 以相对路径落盘）。失败抛错。 */
  sendFile(folder: string, filePath: string, fileName: string): Promise<void>;
  scheduleTask(folder: string, input: ScheduleTaskInput): Promise<{ taskId: string }>;
  listTasks(folder: string): Promise<TaskSummary[]>;
  pauseTask(folder: string, taskId: string): Promise<void>;
  resumeTask(folder: string, taskId: string): Promise<void>;
  cancelTask(folder: string, taskId: string): Promise<void>;
  registerGroup(folder: string, jid: string, name?: string): Promise<void>;
  /** A4：升级为请求-响应协议；返回主进程回执的 installed 包列表（可能为空）。 */
  installSkill(folder: string, name: string): Promise<{ installed?: string[] }>;
  uninstallSkill(folder: string, name: string): Promise<void>;
  memoryAppend(folder: string, content: string, scope?: string): Promise<void>;
  memorySearch(folder: string, query: string): Promise<MemoryHit[]>;
  memoryGet(folder: string, path: string): Promise<string | null>;
  /** A4：拉取当前 Discord 频道历史（请求-响应协议；非 discord 聊天抛错）。 */
  discordGetHistory(folder: string, opts?: DiscordHistoryOptions): Promise<DiscordHistoryMessage[]>;
  /** A4：当前 Discord 频道元数据（请求-响应协议；非 discord 聊天抛错）。 */
  discordGetChannelInfo(folder: string): Promise<unknown>;
  /** A4：当前 Discord 服务器（guild）元数据；DM 频道返回 null（请求-响应协议）。 */
  discordGetServerInfo(folder: string): Promise<unknown | null>;
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
