/**
 * IpcToolBridge —— ToolBridge 的 HappyClaw IPC 实现。
 *
 * 动作类工具（send / schedule / pause / resume / cancel / install / uninstall）
 * 落成 HappyClaw 风格的 IPC 请求文件（原子写：先写 `<target>.tmp` 再 rename 到 `<target>`），
 * 由主进程消费。记忆类工具（memoryAppend / memorySearch / memoryGet）直接对
 * `{memoryDir}/{folder}/` 下的 .md 文件做读写。
 * register_group 例外（#17/#23）：冻结 schema 缺主进程必填的 folder 参数，请求必被拒且无回执
 * → 当前版本直接抛错（诚实失败），不写 IPC；A4/A5 扩展 schema 后恢复。
 *
 * IPC 布局与**线格式**对齐主进程消费端（src/index.ts processTaskIpc / messages 分支，
 * 即上游 container/agent-runner/src/mcp-tools.ts 的写出格式）：
 *   {ipcDir}/{folder}/messages/{uuid}.json   —— `{type:'message', chatJid, groupFolder, text, …}`
 *   {ipcDir}/{folder}/tasks/{uuid}.json      —— `{type:'schedule_task'|'pause_task'|'resume_task'|
 *                                                 'cancel_task'|'register_group'|'install_skill'|
 *                                                 'uninstall_skill', …}`（字段名跟上游 flat 格式）
 *
 * chatJid/isScheduledTask/currentTaskId 由构造方（agent-runner ← ContainerInput）注入；
 * 缺 chatJid 时 send_message / schedule_task / send_image / send_file / discord_* 抛错
 * （主进程会静默丢弃无路由的请求，抛错让模型得到诚实失败而非假成功）。
 *
 * A4 请求-响应协议（pollIpcResult，对齐上游 mcp-tools.ts:60）：
 *   listTasks / installSkill / uninstallSkill / discordGet* 写 {type, requestId, …} 请求文件到
 *   tasks 通道 → 主进程处理后原子写回 {type}_result_{requestId}.json → 本进程 poll 读取并删除。
 *   超时（无主进程应答）：listTasks 降级为本地 best-effort 排队快照（standalone 模式），
 *   其余工具抛上游同文案的超时错误。请求文件超时后**不删**（对齐上游：主进程可能只是慢，
 *   迟到的执行仍有效；孤儿 result 文件由主进程 10 分钟清理逻辑兜底）。
 */

import { randomUUID } from 'node:crypto';
import {
  mkdir,
  rename,
  writeFile,
  readdir,
  readFile,
  appendFile,
  lstat,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';

import { detectImageMimeTypeFromBase64Strict } from '../../image-detector.js';
import { INSTALL_SKILL_POLL_TIMEOUT_MS } from './types.js';
import type {
  ToolBridge,
  ScheduleTaskInput,
  TaskSummary,
  MemoryHit,
  SendImageResult,
  DiscordHistoryOptions,
  DiscordHistoryMessage,
} from './types.js';

/** memorySearch 返回的最大命中条数。 */
const MAX_MEMORY_HITS = 50;

/** send_image 的图片大小上限（对齐上游：飞书 / Telegram 共同的 10MB 限制）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** pollIpcResult 默认轮询间隔 / 超时（对齐上游 mcp-tools.ts：500ms / 30s；install_skill 120s）。 */
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;

/** 上游 newRequestId()：时间戳 + 随机段；命中主进程 SAFE_REQUEST_ID_RE（[A-Za-z0-9_-]+）。 */
function newRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** pollIpcResult 超时错误（listTasks 据此判定走 standalone 降级快照）。 */
export class IpcPollTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timeout waiting for IPC result (${timeoutMs / 1000}s)`);
    this.name = 'IpcPollTimeoutError';
  }
}

export interface IpcToolBridgeOptions {
  /** IPC 根目录（对齐 HappyClaw `data/ipc/`）。 */
  ipcDir: string;
  /** 记忆根目录（对齐 HappyClaw `data/groups/`，per-folder 下挂 .md）。 */
  memoryDir: string;
  /**
   * A4：群组工作区目录（**per-folder 绝对路径**，对齐上游 McpContext.workspaceGroup，
   * 即主进程 `data/groups/{folder}` / 容器 `/workspace/group`）。
   * send_image / send_file 的文件路径解析与越界校验锚点；缺省时这两个工具抛错（诚实失败）。
   */
  workspaceGroupDir?: string;
  /** 当前会话 chat JID（ContainerInput.chatJid）：message 的 chatJid / schedule_task 的 targetJid。 */
  chatJid?: string;
  /** A4：调用方是否 admin 主容器（ContainerInput.isAdminHome）：list_tasks 请求 stamp（上游同名字段）。 */
  isAdminHome?: boolean;
  /** 定时任务运行标记（ContainerInput.isScheduledTask）：message 上条件 stamp。 */
  isScheduledTask?: boolean;
  /** 触发本轮的任务 id（ContainerInput.messageTaskId）：message 上条件 stamp 为 taskId。 */
  currentTaskId?: string;
  /** pollIpcResult 轮询间隔（毫秒，默认 500；单测可调小）。 */
  pollIntervalMs?: number;
  /** pollIpcResult 超时（毫秒）。缺省按上游默认：30s（install_skill 120s）；显式设置则统一覆盖。 */
  pollTimeoutMs?: number;
}

export class IpcToolBridge implements ToolBridge {
  private readonly ipcDir: string;
  private readonly memoryDir: string;
  private readonly workspaceGroupDir: string | null;
  private chatJid: string;
  private readonly isAdminHome: boolean;
  private readonly isScheduledTask: boolean;
  private readonly currentTaskId: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly installPollTimeoutMs: number;

  constructor(opts: IpcToolBridgeOptions) {
    this.ipcDir = opts.ipcDir;
    this.memoryDir = opts.memoryDir;
    this.workspaceGroupDir = opts.workspaceGroupDir ?? null;
    this.chatJid = opts.chatJid ?? '';
    this.isAdminHome = opts.isAdminHome ?? false;
    this.isScheduledTask = opts.isScheduledTask ?? false;
    this.currentTaskId = opts.currentTaskId ?? '';
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.installPollTimeoutMs = opts.pollTimeoutMs ?? INSTALL_SKILL_POLL_TIMEOUT_MS;
  }

  /**
   * A4：更新当前聊天标识（对齐上游 agent-runner 主循环对 mcpToolsConfig.chatJid 的就地变更：
   * IPC input 消息带 sourceJid 时，per-channel 工具（discord_*）应看到最新的来源聊天）。
   */
  setChatJid(jid: string): void {
    if (jid) this.chatJid = jid;
  }

  /** 取路由 chatJid；未绑定 → 抛错（对应工具诚实失败，绝不写主进程会静默丢弃的请求）。 */
  private requireChatJid(tool: string): string {
    if (!this.chatJid) {
      throw new Error(`${tool}: no chatJid bound for this run (cannot route IPC request)`);
    }
    return this.chatJid;
  }

  // ───────────────────────── IPC 动作类 ─────────────────────────

  async sendMessage(folder: string, message: string): Promise<void> {
    // 线格式对齐上游 buildSendMessageData（mcp-tools.ts）：chatJid/groupFolder/timestamp 恒 stamp，
    // isScheduledTask/taskId 条件 stamp（taskId 存在与否决定主进程的任务广播分支）。
    const chatJid = this.requireChatJid('send_message');
    await this.writeIpc(folder, 'messages', {
      chatJid,
      groupFolder: folder,
      timestamp: new Date().toISOString(),
      type: 'message',
      text: message,
      ...(this.isScheduledTask ? { isScheduledTask: true } : {}),
      ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
    });
  }

  async sendImage(folder: string, filePath: string, caption?: string): Promise<SendImageResult> {
    // 线格式对齐上游 send_image 工具（mcp-tools.ts）：messages 通道、buildSendMessageData 字段序
    // （chatJid/groupFolder/timestamp 恒 stamp + type:'image'/imageBase64/mimeType/caption/fileName
    //  + 条件 isScheduledTask/taskId）。消费端命中 src/index.ts processGroupIpc 的
    // `data.type === 'image' && data.chatJid && data.imageBase64` 分支。
    const chatJid = this.requireChatJid('send_image');
    const wsDir = this.requireWorkspaceDir('send_image');

    // 路径解析与越界校验（对齐上游：绝对路径直接用，相对路径锚定工作区；path.sep 后缀防前缀绕过）。
    const resolved = path.resolve(
      path.isAbsolute(filePath) ? filePath : path.join(wsDir, filePath),
    );
    if (!this.isWithin(resolved, wsDir)) {
      throw new Error('file path must be within workspace directory.');
    }

    let st;
    try {
      st = await stat(resolved);
    } catch {
      throw new Error(`file not found: ${filePath}`);
    }
    if (!st.isFile()) {
      throw new Error(`file not found: ${filePath}`);
    }
    if (st.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `image file too large (${(st.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
      );
    }
    if (st.size === 0) {
      throw new Error('image file is empty.');
    }

    const base64 = (await readFile(resolved)).toString('base64');
    // magic bytes 检测（与上游 detectImageMimeTypeFromBase64Strict 同源实现）。
    const mimeType = detectImageMimeTypeFromBase64Strict(base64);
    if (!mimeType) {
      throw new Error(
        'file does not appear to be a supported image format (PNG, JPEG, GIF, WebP, TIFF, BMP).',
      );
    }

    const fileName = path.basename(resolved);
    await this.writeIpc(folder, 'messages', {
      chatJid,
      groupFolder: folder,
      timestamp: new Date().toISOString(),
      type: 'image',
      imageBase64: base64,
      mimeType,
      ...(caption ? { caption } : {}),
      fileName,
      ...(this.isScheduledTask ? { isScheduledTask: true } : {}),
      ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
    });
    return { fileName, mimeType, sizeBytes: st.size };
  }

  async sendFile(folder: string, filePath: string, fileName: string): Promise<void> {
    // 线格式对齐上游 send_file 工具：tasks 通道，{type:'send_file', chatJid, filePath, fileName,
    // timestamp}——filePath 必须是相对工作区路径（消费端按 GROUPS_DIR/{sourceGroup}/filePath 解析，
    // 见 src/index.ts processTaskIpc case 'send_file'）。
    const chatJid = this.requireChatJid('send_file');
    const wsDir = this.requireWorkspaceDir('send_file');

    let resolvedPath: string;
    let relativePath: string;
    if (path.isAbsolute(filePath)) {
      resolvedPath = path.resolve(filePath);
      if (!this.isWithin(resolvedPath, wsDir)) {
        throw new Error('file must be within the workspace/group directory.');
      }
      relativePath = path.relative(wsDir, resolvedPath);
    } else {
      relativePath = filePath;
      resolvedPath = path.resolve(wsDir, filePath);
      if (!this.isWithin(resolvedPath, wsDir)) {
        throw new Error('file must be within the workspace/group directory.');
      }
    }

    let exists = false;
    try {
      exists = (await stat(resolvedPath)).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      throw new Error(`file not found: ${filePath}`);
    }

    await this.writeIpc(folder, 'tasks', {
      type: 'send_file',
      chatJid,
      filePath: relativePath,
      fileName,
      timestamp: new Date().toISOString(),
    });
  }

  async scheduleTask(folder: string, input: ScheduleTaskInput): Promise<{ taskId: string }> {
    const targetJid = this.requireChatJid('schedule_task');
    // ScheduleSpec → 上游 flat 格式：cron→expr；interval 秒→毫秒字符串；once→本地时间戳。
    let scheduleType: 'cron' | 'interval' | 'once';
    let scheduleValue: string;
    const s = input.schedule;
    if (s.kind === 'cron') {
      scheduleType = 'cron';
      scheduleValue = s.expr;
    } else if (s.kind === 'interval') {
      scheduleType = 'interval';
      scheduleValue = String(Math.round(s.seconds * 1000));
    } else {
      scheduleType = 'once';
      scheduleValue = s.at;
    }
    // taskId 是本进程请求 id（listTasks 快照聚合用）；权威任务 id 由主进程生成，
    // 线上的 taskId/name 字段主进程忽略（processTaskIpc 只在 pause/resume/cancel 读 taskId）。
    const taskId = `task_${randomUUID().slice(0, 8)}`;
    await this.writeIpc(folder, 'tasks', {
      type: 'schedule_task',
      taskId,
      name: input.name,
      prompt: input.prompt,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      context_mode: 'group', // 对齐上游工具默认（zod default 'group'）
      execution_type: 'agent',
      targetJid,
      createdBy: folder,
      timestamp: new Date().toISOString(),
      ts: Date.now(), // 单调序：listTasks 据此让"最后动作"胜出（文件名是随机 UUID，无法据此定序）。
    });
    return { taskId };
  }

  async listTasks(folder: string): Promise<TaskSummary[]> {
    // A4：真协议——写 {type:'list_tasks', requestId, groupFolder, isAdminHome, timestamp} 请求
    // （字段对齐上游 mcp-tools.ts list_tasks 工具），poll 主进程写回的
    // list_tasks_result_{requestId}.json（src/index.ts processTaskIpc case 'list_tasks'）。
    // 注：主进程鉴权用 IPC 目录身份（sourceGroup / isAdminHome），线上的 groupFolder/isAdminHome
    // 字段仅协议保真；权威任务列表以主进程回执为准。
    // folder 越界：读类保持空结果契约（与 memorySearch 一致），不写任何请求。#7
    if (this.folderEscapes(this.ipcDir, folder)) return [];
    try {
      const result = await this.pollIpcResult(
        folder,
        {
          type: 'list_tasks',
          requestId: newRequestId(),
          groupFolder: folder,
          isAdminHome: this.isAdminHome,
          timestamp: new Date().toISOString(),
        },
        'list_tasks_result',
        this.pollTimeoutMs,
      );
      if (!result.success) {
        throw new Error(`Error listing tasks: ${String(result.error ?? 'Unknown error')}`);
      }
      const tasks = Array.isArray(result.tasks) ? result.tasks : [];
      return tasks.map((t) => {
        const rec = (t ?? {}) as { id?: unknown; prompt?: unknown; status?: unknown };
        const id = typeof rec.id === 'string' ? rec.id : '';
        return {
          id,
          // 主进程回执无 name 字段（上游 schema 即如此）：用 prompt 充当展示名，缺省回退 id。
          name: typeof rec.prompt === 'string' && rec.prompt ? rec.prompt : id,
          status: typeof rec.status === 'string' ? rec.status : 'unknown',
        };
      });
    } catch (err) {
      // standalone 降级：超时无主进程应答 → 回退本地 best-effort 排队快照（见下）。
      // 非超时错误（主进程显式回 success:false 等）原样抛出，模型得到诚实失败。
      if (!(err instanceof IpcPollTimeoutError)) throw err;
      return this.listTasksSnapshot(folder);
    }
  }

  /**
   * standalone 降级路径：返回本进程已排队的请求摘要（主进程消费后即删文件，集成态下快照基本为空）。
   * 按 taskId 聚合同 folder 下所有 schedule 动作文件，用"最后一个动作"决定状态，
   * 保证被 cancel 的任务绝不再报 queued（占位实现曾恒报 queued，与现实相反）。#10
   * 注：pollIpcResult 留下的 list_tasks 等请求文件无 taskId，聚合时天然被跳过。
   */
  private async listTasksSnapshot(folder: string): Promise<TaskSummary[]> {
    let dir: string;
    try {
      dir = this.channelDir(folder, 'tasks');
    } catch {
      return []; // folder 越界
    }
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    interface ActionRec {
      taskId: string;
      action: string;
      ts: number;
      name?: string;
    }
    const meta = new Map<string, { name: string }>(); // taskId -> create 元信息
    const last = new Map<string, ActionRec>(); // taskId -> 最后一次动作（按 ts，缺省按文件名兜底）

    let fallbackSeq = 0; // ts 缺失时的稳定兜底序（保持读取顺序）
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      let parsed: unknown;
      try {
        const raw = await readFile(path.join(dir, entry), 'utf8');
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const rec = parsed as {
        type?: unknown;
        taskId?: unknown;
        name?: unknown;
        ts?: unknown;
      };
      // 线格式（上游 flat）：type 即动作。schedule_task=create，{pause,resume,cancel}_task 同名动作。
      const TYPE_TO_ACTION: Record<string, string> = {
        schedule_task: 'create',
        pause_task: 'pause',
        resume_task: 'resume',
        cancel_task: 'cancel',
      };
      if (typeof rec.type !== 'string' || typeof rec.taskId !== 'string') continue;
      const action = TYPE_TO_ACTION[rec.type];
      if (!action) continue;
      const id = rec.taskId;
      const ts = typeof rec.ts === 'number' ? rec.ts : fallbackSeq;
      fallbackSeq += 1;
      if (action === 'create') {
        meta.set(id, { name: typeof rec.name === 'string' ? rec.name : id });
      }
      const prev = last.get(id);
      // 较新 ts 胜；ts 相同（同毫秒写入）时按动作"终态优先级"决胜，确保 cancel 绝不被 create 盖回。
      if (!prev || ts > prev.ts || (ts === prev.ts && actionRank(action) >= actionRank(prev.action))) {
        last.set(id, { taskId: id, action, ts });
      }
    }

    const statusOf: Record<string, string> = {
      create: 'queued',
      resume: 'queued',
      pause: 'paused',
      cancel: 'cancelled',
    };
    const out: TaskSummary[] = [];
    for (const [id, rec] of last) {
      const name = meta.get(id)?.name ?? id;
      out.push({ id, name, status: statusOf[rec.action] ?? 'unknown' });
    }
    return out;
  }

  async pauseTask(folder: string, taskId: string): Promise<void> {
    await this.writeScheduleAction(folder, 'pause', taskId);
  }

  async resumeTask(folder: string, taskId: string): Promise<void> {
    await this.writeScheduleAction(folder, 'resume', taskId);
  }

  async cancelTask(folder: string, taskId: string): Promise<void> {
    await this.writeScheduleAction(folder, 'cancel', taskId);
  }

  async registerGroup(_folder: string, jid: string, _name?: string): Promise<void> {
    // 上游走 tasks 通道（processTaskIpc case 'register_group'）。
    // 已知缺口（A4/A5，#17/#23）：主进程消费端要求 data.jid && data.name && data.folder
    // （src/index.ts case 'register_group'），冻结的工具 schema 无 folder 参数、name 可选
    // （本方法只能写 name ?? null，过不了真值检查）→ 集成态下请求 100% 被
    // "missing required fields" 拒绝；且该 case 是 fire-and-forget（无结果回执文件），
    // 假成功无从纠正。诚实失败：不写注定被拒的请求文件，直接抛错——registry.dispatch
    // 收敛为 success:false，模型得到真实状态并可引导用户走 Web 注册。
    // A4/A5 解冻 schema 补 folder（required，对齐上游 regex ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$）
    // + name 改 required 后，恢复写 IPC（tombstone：原实现见 git 历史）。
    throw new Error(
      `register_group 在当前版本不可用：冻结的工具 schema 缺少主进程必填的 folder 参数，` +
        `请求会被主进程以 missing required fields 拒绝。` +
        `请让管理员在 Web 界面注册群组（jid=${jid}）。`,
    );
  }

  async installSkill(folder: string, name: string): Promise<{ installed?: string[] }> {
    // A4：真协议——poll 主进程写回的 install_skill_result_{requestId}.json
    // （src/index.ts processTaskIpc case 'install_skill'）。超时 120s（上游默认：安装可能很慢）。
    let result: Record<string, unknown>;
    try {
      result = await this.pollIpcResult(
        folder,
        {
          type: 'install_skill',
          package: name,
          requestId: newRequestId(),
          groupFolder: folder,
          timestamp: new Date().toISOString(),
        },
        'install_skill_result',
        this.installPollTimeoutMs,
      );
    } catch (err) {
      if (err instanceof IpcPollTimeoutError) {
        // 上游同文案：安装可能仍在进行（主进程可能只是慢，请求文件不删）。
        throw new Error(
          `Timeout waiting for skill installation result (${this.installPollTimeoutMs / 1000}s). The installation may still be in progress.`,
        );
      }
      throw err;
    }
    if (!result.success) {
      throw new Error(`Failed to install skill "${name}": ${String(result.error ?? 'Unknown error')}`);
    }
    const installed = Array.isArray(result.installed)
      ? result.installed.filter((s): s is string => typeof s === 'string')
      : [];
    return { installed };
  }

  async uninstallSkill(folder: string, name: string): Promise<void> {
    let result: Record<string, unknown>;
    try {
      result = await this.pollIpcResult(
        folder,
        {
          type: 'uninstall_skill',
          skillId: name,
          requestId: newRequestId(),
          groupFolder: folder,
          timestamp: new Date().toISOString(),
        },
        'uninstall_skill_result',
        this.pollTimeoutMs,
      );
    } catch (err) {
      if (err instanceof IpcPollTimeoutError) {
        throw new Error('Timeout waiting for skill uninstall result.');
      }
      throw err;
    }
    if (!result.success) {
      throw new Error(`Failed to uninstall skill "${name}": ${String(result.error ?? 'Unknown error')}`);
    }
  }

  // ───────────────────────── Discord 读类（请求-响应协议） ─────────────────────────

  async discordGetHistory(
    folder: string,
    opts?: DiscordHistoryOptions,
  ): Promise<DiscordHistoryMessage[]> {
    const chatJid = this.requireDiscordChatJid('discord_get_history');
    let result: Record<string, unknown>;
    try {
      result = await this.pollIpcResult(
        folder,
        {
          type: 'discord_get_history',
          chatJid,
          ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts?.before !== undefined ? { before: opts.before } : {}),
          requestId: newRequestId(),
          timestamp: new Date().toISOString(),
        },
        'discord_get_history_result',
        this.pollTimeoutMs,
      );
    } catch (err) {
      if (err instanceof IpcPollTimeoutError) {
        throw new Error('Timeout waiting for Discord history response.');
      }
      throw err;
    }
    if (!result.success) {
      throw new Error(
        `Error fetching Discord history: ${String(result.error ?? 'Unknown error')}`,
      );
    }
    return (Array.isArray(result.messages) ? result.messages : []) as DiscordHistoryMessage[];
  }

  async discordGetChannelInfo(folder: string): Promise<unknown> {
    const chatJid = this.requireDiscordChatJid('discord_get_channel_info');
    let result: Record<string, unknown>;
    try {
      result = await this.pollIpcResult(
        folder,
        {
          type: 'discord_get_channel_info',
          chatJid,
          requestId: newRequestId(),
          timestamp: new Date().toISOString(),
        },
        'discord_get_channel_info_result',
        this.pollTimeoutMs,
      );
    } catch (err) {
      if (err instanceof IpcPollTimeoutError) {
        throw new Error('Timeout waiting for Discord channel info response.');
      }
      throw err;
    }
    if (!result.success) {
      throw new Error(
        `Error fetching Discord channel info: ${String(result.error ?? 'Unknown error')}`,
      );
    }
    return result.channel;
  }

  async discordGetServerInfo(folder: string): Promise<unknown | null> {
    const chatJid = this.requireDiscordChatJid('discord_get_server_info');
    let result: Record<string, unknown>;
    try {
      result = await this.pollIpcResult(
        folder,
        {
          type: 'discord_get_server_info',
          chatJid,
          requestId: newRequestId(),
          timestamp: new Date().toISOString(),
        },
        'discord_get_server_info_result',
        this.pollTimeoutMs,
      );
    } catch (err) {
      if (err instanceof IpcPollTimeoutError) {
        throw new Error('Timeout waiting for Discord server info response.');
      }
      throw err;
    }
    if (!result.success) {
      throw new Error(
        `Error fetching Discord server info: ${String(result.error ?? 'Unknown error')}`,
      );
    }
    return result.guild ?? null;
  }

  // ───────────────────────── 记忆类 ─────────────────────────

  async memoryAppend(folder: string, content: string, scope?: string): Promise<void> {
    const file = this.memoryFile(folder, scope);
    // 防穿越的 scope 必须**抛错**而非静默忽略：否则 builtin handler 会误报 success:true，
    // 模型以为记忆已写入（code-review #9）。抛错 → registry.dispatch 捕获 → success:false。
    if (file === null) {
      throw new Error(`memoryAppend: unsafe scope rejected: ${JSON.stringify(scope)}`);
    }
    await mkdir(path.dirname(file), { recursive: true });
    const block = `\n\n--- ${new Date().toISOString()} ---\n${content}\n`;
    await appendFile(file, block, 'utf8');
  }

  async memorySearch(folder: string, query: string): Promise<MemoryHit[]> {
    // folder 自洽校验：含 '..' / 绝对路径 → 逃出 memory 根 → 空结果（不依赖调用方先验）。#7
    if (this.folderEscapes(this.memoryDir, folder)) return [];
    const dir = path.join(this.memoryDir, folder);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const needle = query.toLowerCase();
    const hits: MemoryHit[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const full = path.join(dir, entry);
      let text: string;
      try {
        // lstat（非 stat）：识别并跳过符号链接，避免读出 memory 根之外的链接目标。#8
        const st = await lstat(full);
        if (!st.isFile()) continue; // 目录与 symlink 均被跳过
        text = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes(needle)) {
          hits.push({ path: entry, snippet: line.trim() });
          if (hits.length >= MAX_MEMORY_HITS) return hits;
        }
      }
    }
    return hits;
  }

  async memoryGet(folder: string, relPath: string): Promise<string | null> {
    // 防路径穿越：拒绝含 '..' 段或绝对路径的 relPath；以及逃出 memory 根的 folder。#7
    if (this.isUnsafePath(relPath)) return null;
    if (this.folderEscapes(this.memoryDir, folder)) return null;
    const base = path.resolve(this.memoryDir, folder);
    const full = path.resolve(this.memoryDir, folder, relPath);
    // 词法预检：明显越界直接拒。
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    try {
      // 物理校验：realpath 解析符号链接后，真实路径必须仍在 base 内，否则 folder 内的
      // symlink 可读出 memory 根之外的任意文件（纯词法 path.resolve 不跟随 symlink）。#8
      // base 自身也 realpath 一次，避免 memoryDir 上游含 symlink 时的前缀比较偏差。
      const realBase = await realpath(base).catch(() => base);
      const real = await realpath(full); // 不存在文件抛 ENOENT → 归并到 catch
      if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
      return await readFile(real, 'utf8');
    } catch {
      return null; // ENOENT / 越界 / 其它 → null
    }
  }

  // ───────────────────────── 内部工具 ─────────────────────────

  /** 取群组工作区目录；未绑定 → 抛错（send_image / send_file 无法解析文件路径）。 */
  private requireWorkspaceDir(tool: string): string {
    if (!this.workspaceGroupDir) {
      throw new Error(`${tool}: no workspace directory bound for this run`);
    }
    return this.workspaceGroupDir;
  }

  /** 取 Discord 路由 chatJid：未绑定或非 discord: 前缀 → 抛错（对齐上游工具的频道前置校验）。 */
  private requireDiscordChatJid(tool: string): string {
    const chatJid = this.requireChatJid(tool);
    if (!chatJid.startsWith('discord:')) {
      throw new Error(`${tool} only works in Discord channels. Current chat: ${chatJid}`);
    }
    return chatJid;
  }

  /** resolved 是否在 root 内（含 root 自身；path.sep 后缀防 /ws/g1 匹配 /ws/g10 的前缀绕过）。 */
  private isWithin(resolved: string, root: string): boolean {
    const normalizedRoot = path.resolve(root);
    if (resolved === normalizedRoot) return true;
    const safeRoot = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    return resolved.startsWith(safeRoot);
  }

  /**
   * A4：请求-响应协议（对齐上游 mcp-tools.ts pollIpcResult）。
   * 写一条请求到 tasks 通道 → 轮询 {resultFilePrefix}_{requestId}.json → 读后删除并返回解析结果。
   * 直接 readFile 并吞 ENOENT（修 TOCTOU，与上游一致）；超时抛 IpcPollTimeoutError。
   * 超时后**不删请求文件**（对齐上游：主进程可能只是慢，迟到执行仍有效）。
   */
  private async pollIpcResult(
    folder: string,
    payload: Record<string, unknown> & { requestId: string },
    resultFilePrefix: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const dir = this.channelDir(folder, 'tasks');
    const resultFilePath = path.join(dir, `${resultFilePrefix}_${payload.requestId}.json`);

    await this.writeIpc(folder, 'tasks', payload);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const raw = await readFile(resultFilePath, 'utf8');
        await unlink(resultFilePath).catch(() => {});
        return JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        // 结果未就绪——只吞 ENOENT，其余（解析失败 / 权限错）原样抛出。
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (Date.now() >= deadline) {
        throw new IpcPollTimeoutError(timeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  /** {ipcDir}/{folder}/{channel} 目录。folder 逃出 ipc 根 → 抛错（写类越界）。#7 */
  private channelDir(folder: string, channel: 'messages' | 'tasks'): string {
    if (this.folderEscapes(this.ipcDir, folder)) {
      throw new Error(`unsafe folder rejected: ${JSON.stringify(folder)}`);
    }
    return path.join(this.ipcDir, folder, channel);
  }

  /**
   * folder 是否逃出指定 root（'..' 段 / 绝对路径 / 空段）。逃出 → true。
   * 与 codex-home.ts 同构，使本组件自洽、不依赖调用方先验 folder 校验。#7
   */
  private folderEscapes(root: string, folder: string): boolean {
    const resolved = path.resolve(root, folder);
    const rel = path.relative(root, resolved);
    return rel === '' || rel.startsWith('..') || path.isAbsolute(rel);
  }

  /** 原子写一条 JSON 请求到 IPC channel：先写 `<target>.tmp` 再 rename 到 `<target>`。 */
  private async writeIpc(
    folder: string,
    channel: 'messages' | 'tasks',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const dir = this.channelDir(folder, channel);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, `${randomUUID()}.json`);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, target);
  }

  /** 写一条 pause/resume/cancel 请求（上游 flat 格式：type 即动作，taskId 为权威任务 id）。 */
  private async writeScheduleAction(
    folder: string,
    action: 'pause' | 'resume' | 'cancel',
    taskId: string,
  ): Promise<void> {
    await this.writeIpc(folder, 'tasks', {
      type: `${action}_task`,
      taskId,
      groupFolder: folder,
      timestamp: new Date().toISOString(),
      ts: Date.now(),
    });
  }

  /** memoryAppend 目标文件；scope 不安全（含路径分隔/穿越/控制字符）或 folder 越界 → null。 */
  private memoryFile(folder: string, scope?: string): string | null {
    const name = scope && scope.length > 0 ? scope : 'CLAUDE';
    if (this.isUnsafePath(name) || name.includes('/') || name.includes('\\')) return null;
    // folder 自洽校验：逃出 memory 根 → null（memoryAppend 据此抛 unsafe scope）。#7
    if (this.folderEscapes(this.memoryDir, folder)) return null;
    return path.join(this.memoryDir, folder, `${name}.md`);
  }

  /** 路径是否不安全：绝对路径、含 '..' 段，或含控制字符（含 NUL）。 */
  private isUnsafePath(p: string): boolean {
    // 控制字符（含 NUL）会让 fs 抛晦涩 TypeError；统一并入 unsafe 路径走清晰拒绝。#11
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(p)) return true;
    if (path.isAbsolute(p)) return true;
    const segments = p.split(/[\\/]/);
    return segments.includes('..');
  }
}

/**
 * 同毫秒 ts 平局时的动作优先级：终态（cancel）> 暂停（pause）> 排队（create/resume）。
 * 保证被 cancel 的任务在 ts 与 create 相同的极端情况下仍判 cancelled，绝不被盖回 queued。#10
 */
function actionRank(action: string): number {
  switch (action) {
    case 'cancel':
      return 3;
    case 'pause':
      return 2;
    case 'resume':
      return 1;
    case 'create':
    default:
      return 0;
  }
}
