/**
 * rollout-archive —— B1 上下文压缩的归档 + trim（对齐 HappyClaw PreCompact 的 archive/trim）。
 *
 * codex rollout 是 newline-delimited JSON（每行一个 entry）。本模块只做三件纯文件操作，
 * 全部 try/catch 吞错（不抛 —— 压缩副作用失败不应中断主流程）；path==null 时 no-op。
 *
 *   parseRollout(path)      —— 逐行 JSON.parse，跳坏行，返回 entries。
 *   archiveRollout(...)     —— 从 entries 取 message 渲染 markdown，写
 *                              {baseDir}/{folder}/conversations/{date}-{name}.md。
 *   trimRollout(path)       —— 保留首个 session_meta + 最后一个 'compacted' 边界行
 *                              （内嵌自包含 replacement_history）+ 边界后全部、删边界前；
 *                              原子写（tmp+rename）；少于阈值 / 无边界 → 跳过。
 *
 * rollout entry 形状（codex 0.137.0，已 PoC 实测）：
 *   - {type:'session_meta', payload:{id, cwd, cli_version, ...}}        —— 首行
 *   - {type:'response_item', payload:{type:'message', role, content:[{type, text}]}}
 *   - {type:'compacted', payload:{message, replacement_history:[...]}}  —— 压缩边界，自包含
 *   - {type:'event_msg' | 'turn_context' | ...}                        —— 其余忽略
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import * as path from 'node:path';

/** rollout 顶层 entry（只约束我们关心的字段）。 */
export interface RolloutEntry {
  type?: string;
  payload?: unknown;
  [k: string]: unknown;
}

/** 渲染用的一条消息（user / assistant / developer 等角色 + 拼接后的纯文本）。 */
export interface RolloutMessage {
  role: string;
  text: string;
}

/** trim 阈值：边界前条目数少于此值则跳过（不值当的 I/O；对齐 HappyClaw TRIM_MIN_ENTRIES=50）。 */
const TRIM_MIN_ENTRIES = 50;

/** archive markdown 单条消息正文截断长度（对齐 HappyClaw 的 2000）。 */
const MESSAGE_MAX_CHARS = 2000;

// ───────────────────────── parseRollout ─────────────────────────

/**
 * 逐行 JSON.parse，跳过空行 / 坏行，返回 entries。
 * path 为 null / 不存在 / 读失败 → 返回 []（不抛）。
 */
export function parseRollout(rolloutPath: string | null | undefined): RolloutEntry[] {
  if (!rolloutPath) return [];
  let raw: string;
  try {
    raw = readFileSync(rolloutPath, 'utf8');
  } catch {
    return [];
  }
  const out: RolloutEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RolloutEntry);
    } catch {
      // 跳坏行（rollout 可能在末尾有半写入行）。
    }
  }
  return out;
}

// ───────────────────────── archiveRollout ─────────────────────────

/**
 * 从 rollout 取 message 条目渲染 markdown，写
 *   {baseDir}/{folder}/conversations/{date}-{name}.md。
 * baseDir 为运行时数据根下的归档基目录（如 data/memory）；folder 越界（'..' / 绝对路径）→ no-op。
 * 无可归档消息 / path 缺失 → no-op。全程 try/catch 不抛。
 *
 * @returns 写出的文件绝对路径；未写出时返回 null。
 */
export function archiveRollout(
  rolloutPath: string | null | undefined,
  folder: string,
  baseDir: string,
): string | null {
  if (!rolloutPath) return null;
  try {
    const entries = parseRollout(rolloutPath);
    const messages = extractMessages(entries);
    if (messages.length === 0) return null;

    // folder 防穿越：与 ipc-bridge / codex-home 同构。
    const folderDir = path.resolve(baseDir, folder);
    const rel = path.relative(path.resolve(baseDir), folderDir);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;

    const conversationsDir = path.join(folderDir, 'conversations');
    mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const name = deriveArchiveName(rolloutPath);
    const filePath = path.join(conversationsDir, `${date}-${name}.md`);

    writeFileSync(filePath, renderMarkdown(messages), 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

/** 从 entries 取 response_item message 条目，拼接 content 文本。 */
export function extractMessages(entries: RolloutEntry[]): RolloutMessage[] {
  const out: RolloutMessage[] = [];
  for (const e of entries) {
    if (e.type !== 'response_item') continue;
    const payload = e.payload as
      | { type?: string; role?: string; content?: unknown }
      | undefined;
    if (!payload || payload.type !== 'message') continue;
    const role = typeof payload.role === 'string' ? payload.role : 'unknown';
    const text = joinContentText(payload.content);
    if (text.trim().length === 0) continue;
    out.push({ role, text });
  }
  return out;
}

/** 拼接 message.content 数组里各项的 text（input_text / output_text 等）。 */
function joinContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const t = (item as { text?: unknown } | null | undefined)?.text;
    if (typeof t === 'string') parts.push(t);
  }
  return parts.join('');
}

/** 渲染归档 markdown：标题 + 时间戳 + 逐条消息（角色加粗，正文截断）。 */
export function renderMarkdown(messages: RolloutMessage[]): string {
  const lines: string[] = [];
  lines.push('# Conversation');
  lines.push('');
  lines.push(`Archived: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const m of messages) {
    const sender = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
    const body =
      m.text.length > MESSAGE_MAX_CHARS ? m.text.slice(0, MESSAGE_MAX_CHARS) + '…' : m.text;
    lines.push(`**${sender}**: ${body}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 归档文件名（取 rollout basename，去扩展名 + 净化）；空则回退到时间戳。 */
function deriveArchiveName(rolloutPath: string): string {
  const base = path.basename(rolloutPath).replace(/\.jsonl$/i, '');
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.length > 0 ? safe : `conversation-${Date.now()}`;
}

// ───────────────────────── trimRollout ─────────────────────────

/**
 * 物理 trim rollout：保留首个 session_meta + 最后一个 'compacted' 边界行 + 边界后全部、删边界前。
 * 'compacted' 边界自包含 replacement_history（PoC 实测：trim 后 thread/resume 仍正确）。
 *
 * 跳过条件（任一）：path 缺失 / 文件不存在 / 无 compacted 边界 / 边界前条目数 < 阈值。
 * 原子写：先写 `<path>.tmp` 再 rename。全程 try/catch 不抛。
 *
 * @returns true=已 trim；false=跳过 / 失败。
 */
export function trimRollout(rolloutPath: string | null | undefined): boolean {
  if (!rolloutPath) return false;
  try {
    if (!existsSync(rolloutPath)) return false;
    const raw = readFileSync(rolloutPath, 'utf8');
    // 保留原始行文本（含 compacted 内嵌的 replacement_history），仅用解析定位边界。
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) return false;

    // 最后一个顶层 type==='compacted' 的边界（最新摘要，自包含）。从尾向头找。
    let boundaryIdx = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i];
      if (line === undefined) continue;
      try {
        const o = JSON.parse(line) as { type?: string };
        if (o.type === 'compacted') {
          boundaryIdx = i;
          break;
        }
      } catch {
        // 跳坏行。
      }
    }

    // 无边界 / 边界即首行后第一条 → 没有可删历史。
    if (boundaryIdx <= 1) return false;
    // 边界前需删除的条目数（line0 是 session_meta，保留；删 [1, boundaryIdx)）。
    const removedCount = boundaryIdx - 1;
    if (removedCount < TRIM_MIN_ENTRIES) return false;

    const head = lines[0];
    if (head === undefined) return false;
    const trimmed = [head, ...lines.slice(boundaryIdx)].join('\n') + '\n';

    const tmp = `${rolloutPath}.tmp`;
    writeFileSync(tmp, trimmed, 'utf8');
    renameSync(tmp, rolloutPath);
    return true;
  } catch {
    return false;
  }
}
