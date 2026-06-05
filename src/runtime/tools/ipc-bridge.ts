/**
 * IpcToolBridge —— ToolBridge 的 HappyClaw IPC 实现。
 *
 * 动作类工具（send / schedule / pause / resume / cancel / register / install / uninstall）
 * 落成 HappyClaw 风格的 IPC 请求文件（原子写：先写 `<target>.tmp` 再 rename 到 `<target>`），
 * 由主进程消费。记忆类工具（memoryAppend / memorySearch / memoryGet）直接对
 * `{memoryDir}/{folder}/` 下的 .md 文件做读写。
 *
 * IPC 布局（对齐 HappyClaw `data/ipc/{folder}/`）：
 *   {ipcDir}/{folder}/messages/{uuid}.json   —— send_message / register / skill 控制请求
 *   {ipcDir}/{folder}/tasks/{uuid}.json      —— schedule 任务请求（create / pause / resume / cancel）
 *
 * Stage 4 注：listTasks 当前只返回本进程已排队的请求摘要；真实任务列表在主进程，
 * 接主进程后改为查询主进程状态。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, readdir, readFile, appendFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ToolBridge,
  ScheduleTaskInput,
  TaskSummary,
  MemoryHit,
} from './types.js';

/** memorySearch 返回的最大命中条数。 */
const MAX_MEMORY_HITS = 50;

export interface IpcToolBridgeOptions {
  /** IPC 根目录（对齐 HappyClaw `data/ipc/`）。 */
  ipcDir: string;
  /** 记忆根目录（对齐 HappyClaw `data/groups/`，per-folder 下挂 .md）。 */
  memoryDir: string;
}

export class IpcToolBridge implements ToolBridge {
  private readonly ipcDir: string;
  private readonly memoryDir: string;

  constructor(opts: IpcToolBridgeOptions) {
    this.ipcDir = opts.ipcDir;
    this.memoryDir = opts.memoryDir;
  }

  // ───────────────────────── IPC 动作类 ─────────────────────────

  async sendMessage(folder: string, message: string): Promise<void> {
    await this.writeIpc(folder, 'messages', {
      type: 'send_message',
      text: message,
      ts: Date.now(),
    });
  }

  async scheduleTask(folder: string, input: ScheduleTaskInput): Promise<{ taskId: string }> {
    const taskId = `task_${randomUUID().slice(0, 8)}`;
    await this.writeIpc(folder, 'tasks', {
      type: 'schedule',
      action: 'create',
      task: input,
      taskId,
    });
    return { taskId };
  }

  async listTasks(folder: string): Promise<TaskSummary[]> {
    // Stage 4 接主进程：真实任务列表在主进程，这里 best-effort 返回已排队的 create 请求摘要。
    const dir = this.channelDir(folder, 'tasks');
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: TaskSummary[] = [];
    for (const entry of entries) {
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
        action?: unknown;
        taskId?: unknown;
        task?: { name?: unknown };
      };
      if (rec.type !== 'schedule' || rec.action !== 'create') continue;
      const id = typeof rec.taskId === 'string' ? rec.taskId : entry;
      const name = typeof rec.task?.name === 'string' ? rec.task.name : id;
      out.push({ id, name, status: 'queued' });
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

  async registerGroup(folder: string, jid: string, name?: string): Promise<void> {
    await this.writeIpc(folder, 'messages', {
      type: 'register_group',
      jid,
      name: name ?? null,
      ts: Date.now(),
    });
  }

  async installSkill(folder: string, name: string): Promise<void> {
    await this.writeIpc(folder, 'messages', {
      type: 'install_skill',
      name,
      ts: Date.now(),
    });
  }

  async uninstallSkill(folder: string, name: string): Promise<void> {
    await this.writeIpc(folder, 'messages', {
      type: 'uninstall_skill',
      name,
      ts: Date.now(),
    });
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
        const st = await stat(full);
        if (!st.isFile()) continue;
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
    // 防路径穿越：拒绝含 '..' 段或绝对路径。
    if (this.isUnsafePath(relPath)) return null;
    const full = path.join(this.memoryDir, folder, relPath);
    // 二次校验：解析后的路径必须仍在 {memoryDir}/{folder}/ 下。
    const base = path.resolve(this.memoryDir, folder);
    const resolved = path.resolve(full);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    try {
      return await readFile(resolved, 'utf8');
    } catch {
      return null;
    }
  }

  // ───────────────────────── 内部工具 ─────────────────────────

  /** {ipcDir}/{folder}/{channel} 目录。 */
  private channelDir(folder: string, channel: 'messages' | 'tasks'): string {
    return path.join(this.ipcDir, folder, channel);
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

  /** 写一条 schedule pause/resume/cancel 请求。 */
  private async writeScheduleAction(
    folder: string,
    action: 'pause' | 'resume' | 'cancel',
    taskId: string,
  ): Promise<void> {
    await this.writeIpc(folder, 'tasks', { type: 'schedule', action, taskId });
  }

  /** memoryAppend 目标文件；scope 不安全（含路径分隔/穿越）→ null。 */
  private memoryFile(folder: string, scope?: string): string | null {
    const name = scope && scope.length > 0 ? scope : 'CLAUDE';
    if (this.isUnsafePath(name) || name.includes('/') || name.includes('\\')) return null;
    return path.join(this.memoryDir, folder, `${name}.md`);
  }

  /** 路径是否不安全：绝对路径或含 '..' 段。 */
  private isUnsafePath(p: string): boolean {
    if (path.isAbsolute(p)) return true;
    const segments = p.split(/[\\/]/);
    return segments.includes('..');
  }
}
