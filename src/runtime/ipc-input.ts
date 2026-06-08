/**
 * IPC 输入侧（happycodex standalone agent-runner）。
 *
 * happycodex 此前完全缺失 IPC 输入侧（IpcToolBridge 只写 messages/tasks，不读 input/）。
 * 本模块补齐输入侧：监听 `{ipcDir}/{folder}/input/*.json`，把后续用户消息桥接到 runner.inject()，
 * 并识别三个 sentinel（_close / _interrupt / _drain）。
 *
 * 路径 / 字段 / sentinel 名严格对齐主仓 HappyClaw
 * （container/agent-runner/src/index.ts 的 drainIpcInput / createIpcWatcher /
 *  waitForIpcMessage / shouldClose / shouldInterrupt / shouldDrain）：
 *   - 目录：input/（输入侧；与 IpcToolBridge 的输出侧 messages/、tasks/ 区分，别搞反）
 *   - 文件：{type:'message', text, images?, sourceJid?}.json — 读后原子 drain（unlink）
 *   - sentinel：input/_close、input/_interrupt、input/_drain（存在即触发，触发后 unlink）
 *
 * 实现照搬主仓语义：
 *   - fs.watch 事件驱动 + setInterval 后备轮询（防 inotify 丢事件 / Docker bind mount 行为差异）
 *   - 50ms debounce 合并抖动
 *   - 文件按文件名排序后顺序 drain，单条解析失败也删除避免毒丸卡死
 *   - sentinel 检测优先于普通消息 drain
 *
 * 与主仓的差异（standalone）：
 *   - 主仓是 inotify→pipe 进 SDK MessageStream；这里是 inotify→runner.inject()。
 *   - 主仓 IPC_INPUT_DIR 由 env+默认容器路径解析；这里 dir 显式由调用方按 {ipcDir}/{folder}/input 传入，
 *     便于多租户与单测（临时目录）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 后备轮询间隔（毫秒）——对齐主仓 IPC_FALLBACK_POLL_MS=5000。仅防 inotify 事件丢失。 */
export const IPC_FALLBACK_POLL_MS = 5000;
/** fs.watch 抖动合并窗口（毫秒）——对齐主仓 createIpcWatcher 的 50ms debounce。 */
const WATCH_DEBOUNCE_MS = 50;

/** 一条 drain 出来的输入消息（字段对齐主仓 IpcDrainResult.messages[]）。 */
export interface IpcInputMessage {
  text: string;
  images?: Array<{ data: string; mimeType?: string }>;
  sourceJid?: string;
}

/** sentinel 文件名（严格对齐主仓 _close / _interrupt / _drain）。 */
export const SENTINEL = {
  close: '_close',
  interrupt: '_interrupt',
  drain: '_drain',
} as const;

export type SentinelKind = (typeof SENTINEL)[keyof typeof SENTINEL];

/** input 目录路径：{ipcDir}/{folder}/input（与 IpcToolBridge 的 messages/tasks 输出侧分开）。 */
export function ipcInputDir(ipcDir: string, folder: string): string {
  return path.join(ipcDir, folder, 'input');
}

/**
 * drain 所有待处理的 *.json 输入消息。
 * 照搬主仓 drainIpcInput：按文件名排序 → 逐个读 + 解析 + unlink（读后即删）。
 * 仅接受 {type:'message', text:<非空字符串>}；解析失败的文件也删除（毒丸防护，避免反复失败）。
 * 目录不存在 / readdir 失败 → 返回空数组（不抛）。
 */
export function drainIpcInput(dir: string): IpcInputMessage[] {
  const messages: IpcInputMessage[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return messages;
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      // 先删后用：原子 drain，避免重复消费（与主仓一致）。
      fs.unlinkSync(filePath);
      if (data.type === 'message' && typeof data.text === 'string' && data.text.length > 0) {
        const msg: IpcInputMessage = { text: data.text };
        if (Array.isArray(data.images)) {
          msg.images = data.images as Array<{ data: string; mimeType?: string }>;
        }
        if (typeof data.sourceJid === 'string') {
          msg.sourceJid = data.sourceJid;
        }
        messages.push(msg);
      }
    } catch {
      // 解析/读取失败：删掉毒丸文件，继续处理其余（与主仓一致）。
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }
  }
  return messages;
}

/**
 * 检测并消费一个 sentinel：存在即 unlink 并返回 true（与主仓 shouldClose/shouldInterrupt/shouldDrain 一致）。
 */
export function consumeSentinel(dir: string, name: SentinelKind): boolean {
  const sentinelPath = path.join(dir, name);
  if (fs.existsSync(sentinelPath)) {
    try {
      fs.unlinkSync(sentinelPath);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/** createIpcWatcher 的返回句柄。 */
export interface IpcWatcherHandle {
  close(): void;
}

/**
 * fs.watch 事件驱动 + setInterval 后备轮询的目录监听器（照搬主仓 createIpcWatcher）。
 * fs.watch 失败（平台不支持 / 目录问题）时降级为纯后备轮询。后备定时器 unref()，不阻止进程自然退出。
 */
export function createIpcWatcher(
  dir: string,
  onChange: () => void,
  opts: { fallbackPollMs?: number; debounceMs?: number } = {},
): IpcWatcherHandle {
  const fallbackPollMs = opts.fallbackPollMs ?? IPC_FALLBACK_POLL_MS;
  const debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS;

  let watcher: fs.FSWatcher | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const debounced = (): void => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onChange();
    }, debounceMs);
  };

  // 确保 input 目录存在（与主仓一致：监听前 mkdir -p）。
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }

  try {
    // 监听全部事件类型：'rename' 覆盖原子写（Linux），Docker bind mount（macOS virtiofs）可能只发 'change'。
    watcher = fs.watch(dir, () => debounced());
    watcher.on('error', () => {
      // 降级为后备轮询。
      watcher?.close();
      watcher = null;
    });
  } catch {
    /* fall through to fallback polling */
  }

  fallbackTimer = setInterval(() => {
    if (!closed) onChange();
  }, fallbackPollMs);
  fallbackTimer.unref();

  return {
    close(): void {
      closed = true;
      watcher?.close();
      watcher = null;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    },
  };
}

/** IpcInputLoop 的回调集合（不依赖真实 codex / runner，便于单测）。 */
export interface IpcInputLoopHandlers {
  /** 收到普通用户消息（已 drain + 解析），桥接到 runner.inject()。 */
  onMessage(msg: IpcInputMessage): void;
  /** _close sentinel：runner.shutdown()。触发后循环停止。 */
  onClose(): void;
  /** _interrupt sentinel：session.interrupt()（经 runner 暴露的 interrupt 路径）。循环继续。 */
  onInterrupt(): void;
  /** _drain sentinel：收尾语义（完成当前后退出）。触发后循环停止。 */
  onDrain(): void;
}

/**
 * IPC 输入循环：watch + 后备轮询 + 原子 drain + 三 sentinel 识别。
 *
 * tick() 的检测顺序（对齐主仓 waitForIpcMessage.tryDrain）：
 *   1) _close   → onClose()，停循环（终态）
 *   2) _drain   → onDrain()，停循环（收尾）
 *   3) _interrupt → onInterrupt()，**不停循环**（中断当前 turn 但会话保持 warm，可继续收消息）
 *   4) drain *.json → 每条 onMessage()
 *
 * 先消费 sentinel 再 drain 消息：保证 _close/_drain 不被同批 *.json 抢先消费。
 * _interrupt 优先于消息 drain，避免中断信号被本批新消息挤后。
 */
export class IpcInputLoop {
  private readonly dir: string;
  private readonly handlers: IpcInputLoopHandlers;
  private readonly watcherOpts: { fallbackPollMs?: number; debounceMs?: number };
  private watcher: IpcWatcherHandle | null = null;
  private stopped = false;

  constructor(
    dir: string,
    handlers: IpcInputLoopHandlers,
    watcherOpts: { fallbackPollMs?: number; debounceMs?: number } = {},
  ) {
    this.dir = dir;
    this.handlers = handlers;
    this.watcherOpts = watcherOpts;
  }

  /** 启动监听 + 立即 tick 一次（处理已存在的文件 / sentinel）。 */
  start(): void {
    if (this.watcher) return;
    this.watcher = createIpcWatcher(this.dir, () => this.tick(), this.watcherOpts);
    this.tick();
  }

  /** 停止监听（幂等）。 */
  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * 单次检测：sentinel 优先 → drain 消息。导出供单测直接驱动（无需等定时器）。
   * 返回是否仍在运行（false = 已因 _close/_drain 停止）。
   */
  tick(): boolean {
    if (this.stopped) return false;

    if (consumeSentinel(this.dir, SENTINEL.close)) {
      this.stop();
      this.handlers.onClose();
      return false;
    }
    if (consumeSentinel(this.dir, SENTINEL.drain)) {
      this.stop();
      this.handlers.onDrain();
      return false;
    }
    if (consumeSentinel(this.dir, SENTINEL.interrupt)) {
      // 中断当前 turn 但保持会话 warm：不停循环，继续收后续消息。
      this.handlers.onInterrupt();
    }

    const messages = drainIpcInput(this.dir);
    for (const msg of messages) {
      this.handlers.onMessage(msg);
    }
    return !this.stopped;
  }
}
