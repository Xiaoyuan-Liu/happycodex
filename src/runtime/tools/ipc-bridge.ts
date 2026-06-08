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
import { mkdir, rename, writeFile, readdir, readFile, appendFile, lstat, realpath } from 'node:fs/promises';
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
      ts: Date.now(), // 单调序：listTasks 据此让"最后动作"胜出（文件名是随机 UUID，无法据此定序）。
    });
    return { taskId };
  }

  async listTasks(folder: string): Promise<TaskSummary[]> {
    // Stage 4 接主进程：权威任务状态在主进程，这里返回 best-effort 排队快照。
    // 按 taskId 聚合同 folder 下所有 schedule 动作文件，用"最后一个动作"决定状态，
    // 保证被 cancel 的任务绝不再报 queued（占位实现曾恒报 queued，与现实相反）。#10
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
        action?: unknown;
        taskId?: unknown;
        task?: { name?: unknown };
        ts?: unknown;
      };
      if (rec.type !== 'schedule' || typeof rec.taskId !== 'string') continue;
      const action = typeof rec.action === 'string' ? rec.action : '';
      if (!['create', 'pause', 'resume', 'cancel'].includes(action)) continue;
      const id = rec.taskId;
      const ts = typeof rec.ts === 'number' ? rec.ts : fallbackSeq;
      fallbackSeq += 1;
      if (action === 'create') {
        meta.set(id, { name: typeof rec.task?.name === 'string' ? rec.task.name : id });
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

  /** 写一条 schedule pause/resume/cancel 请求。 */
  private async writeScheduleAction(
    folder: string,
    action: 'pause' | 'resume' | 'cancel',
    taskId: string,
  ): Promise<void> {
    await this.writeIpc(folder, 'tasks', { type: 'schedule', action, taskId, ts: Date.now() });
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
