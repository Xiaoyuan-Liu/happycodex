// Memory management routes and utilities

import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  MemoryFileSchema,
  MemoryGlobalSchema,
  type MemorySource,
  type MemoryFilePayload,
  type MemorySearchHit,
} from '../schemas.js';
import { getAllRegisteredGroups, getUserById } from '../db.js';
import { logger } from '../logger.js';
import { GROUPS_DIR, DATA_DIR } from '../config.js';
import { writeFileAtomicNoFollow } from '../utils.js';
import type { AuthUser } from '../types.js';

const memoryRoutes = new Hono<{ Variables: Variables }>();

// --- Constants ---

const USER_GLOBAL_DIR = path.join(GROUPS_DIR, 'user-global');
const MAIN_MEMORY_DIR = path.join(GROUPS_DIR, 'main');
const MAIN_MEMORY_FILE = path.join(MAIN_MEMORY_DIR, 'CLAUDE.md');
const MEMORY_DATA_DIR = path.join(DATA_DIR, 'memory');
const MAX_GLOBAL_MEMORY_LENGTH = 200_000;
const MAX_MEMORY_FILE_LENGTH = 500_000;
const MEMORY_LIST_LIMIT = 500;
const MEMORY_SEARCH_LIMIT = 120;
const MEMORY_SOURCE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
]);

// --- Utility Functions ---

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * 符号链接逃逸防护（issue #2 P1）：词法 isWithinRoot 只比较字符串路径，不防 symlink。
 * 把一个绝对路径解析成 fs 实际会触达的**真实落点**：沿路径向上找到最近的已存在祖先、
 * 对其 realpathSync（展开其中所有 symlink），再把不存在的剩余后缀原样拼回。
 *
 * 调用方据此真实落点做"容器内"与"归属"两类判定，从而同时拦截：
 *   - host 逃逸：末级或某祖先是 symlink 指向允许 root 外（realpath 落到 root 外）；
 *   - 跨租户逃逸：symlink 指向另一租户 folder（realpath 落到他人 folder → 归属判定基于
 *     真实 folder 而非词法 folder，故能识破）。
 * 对齐 file-manager.ts validateAndResolvePath 的祖先 realpath 思路。导出供单测。
 */
export function resolveRealMemoryPath(absolutePath: string): string {
  let existing = absolutePath;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolutePath; // 触顶仍不存在（cwd 必存在，正常不至此）
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const base = fs.realpathSync(existing);
  return tail.length > 0 ? path.join(base, ...tail) : base;
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('path must be a string');
  }
  const normalized = input.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Invalid memory path');
  }
  const parts = normalized.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    throw new Error('Invalid memory path');
  }
  return normalized;
}

function resolveMemoryPath(
  relativePath: string,
  user: AuthUser,
): {
  absolutePath: string;
  writable: boolean;
} {
  // 符号链接逃逸防护（issue #2 P1）：先把词法绝对路径解析成 fs 真实落点（展开 symlink），
  // 后续"容器内/归属"判定与实际 fs 读写都基于这个真实路径——否则一个落在 root 内的 symlink
  // 会让词法判定通过、fs 却写到 root 外（host 逃逸）或他人 folder（跨租户逃逸）。
  //
  // 已闭合：所有在校验时点已存在的 symlink（叶或祖先；指向 root 外或他人 folder）——resolveRealMemoryPath
  // 展开后由下方容器内/归属校验拒绝；写入侧的 `.tmp` 预放 symlink 由 writeFileAtomicNoFollow 的
  // O_NOFOLLOW 拦截。
  // 已知残留（与全代码库一致，见 src/routes/files.ts 同款注释）：校验之后、fs 操作之前，并发的
  // agent 进程把某个**中间目录**换成 symlink 的 TOCTOU 竞态——O_NOFOLLOW 只护叶子、不护中间段，
  // 彻底闭合需 openat 逐段遍历（Node 原生不支持，且本仓 files.ts/file-manager.ts 均未做）。窗口为
  // 同步调用间的亚毫秒间隙，仅可被独立容器进程以紧致循环概率性命中，非确定性原语；超出本 issue
  // 范围，若威胁模型需要应作为独立的 openat 加固项跟踪。
  const absolute = path.resolve(process.cwd(), relativePath);
  const real = resolveRealMemoryPath(absolute);
  // 允许 root 也按同法解析（DATA_DIR 可能位于 symlink 下，如 macOS /tmp；fresh install 时
  // 目录尚不存在亦能解析其已存在祖先），保证与 real 同一坐标系比较。
  const groupsRoot = resolveRealMemoryPath(GROUPS_DIR);
  const memoryRoot = resolveRealMemoryPath(MEMORY_DATA_DIR);
  const userGlobalRoot = resolveRealMemoryPath(USER_GLOBAL_DIR);

  const inGroups = isWithinRoot(real, groupsRoot);
  const inMemoryData = isWithinRoot(real, memoryRoot);
  const writable = inGroups || inMemoryData;

  if (!writable) {
    // 真实落点不在任何允许 root 内 → host 逃逸 / 越界。
    throw new Error('Memory path out of allowed scope');
  }

  // User ownership check for non-admin —— 基于真实落点的 folder，而非词法 folder
  // （否则 folderA/link -> folderB 会用词法 folderA 通过归属、真实写入 folderB）。
  if (user.role !== 'admin') {
    // user-global/{userId}/... — member can only access their own
    if (isWithinRoot(real, userGlobalRoot)) {
      const ownerUserId = path.relative(userGlobalRoot, real).split(path.sep)[0];
      if (ownerUserId !== user.id) {
        throw new Error('Memory path out of allowed scope');
      }
    }
    // data/groups/{folder}/... — check group ownership
    else if (inGroups) {
      const folder = path.relative(groupsRoot, real).split(path.sep)[0] ?? '';
      if (!isUserOwnedFolder(user, folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
    // data/memory/{folder}/... — check group ownership
    else if (inMemoryData) {
      const folder = path.relative(memoryRoot, real).split(path.sep)[0] ?? '';
      if (!isUserOwnedFolder(user, folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
  }

  return { absolutePath: real, writable };
}

/** Check if a folder belongs to the user (via registered_groups). */
function isUserOwnedFolder(
  user: { id: string; role: string },
  folder: string,
): boolean {
  if (user.role === 'admin') return true;
  if (!folder) return false;
  const groups = getAllRegisteredGroups();
  for (const group of Object.values(groups)) {
    if (group.folder === folder && group.created_by === user.id) {
      return true;
    }
  }
  return false;
}

function classifyMemorySource(
  relativePath: string,
): Pick<MemorySource, 'type' | 'label' | 'ownerName' | 'folder'> {
  const parts = relativePath.split('/');

  // data/groups/user-global/{userId}/...
  if (
    parts[0] === 'data' &&
    parts[1] === 'groups' &&
    parts[2] === 'user-global'
  ) {
    const userId = parts[3] || 'unknown';
    const name = parts.slice(4).join('/') || 'CLAUDE.md';
    const owner = getUserById(userId);
    const ownerLabel = owner ? owner.display_name || owner.username : userId;

    return {
      type: 'global',
      label: `${ownerLabel} / 全局记忆 / ${name}`,
      ownerName: ownerLabel,
    };
  }

  // data/memory/{folder}/...
  if (parts[0] === 'data' && parts[1] === 'memory') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3).join('/') || 'memory';
    return {
      type: 'date',
      label: `${folder} / 日期记忆 / ${name}`,
      folder,
    };
  }

  // data/groups/{folder}/conversations/...
  if (
    parts[0] === 'data' &&
    parts[1] === 'groups' &&
    parts.length >= 4 &&
    parts[3] === 'conversations'
  ) {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(4).join('/');
    return {
      type: 'conversation',
      label: `${folder} / 对话归档 / ${name}`,
      folder,
    };
  }

  // data/groups/{folder}/... (session memory)
  if (parts[0] === 'data' && parts[1] === 'groups') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3).join('/');
    return {
      type: 'session',
      label: `${folder} / ${name}`,
      folder,
    };
  }

  // Fallback
  return {
    type: 'session',
    label: parts.slice(2).join('/'),
    folder: parts[2] || undefined,
  };
}

export function readMemoryFile(
  relativePath: string,
  user: AuthUser,
): MemoryFilePayload {
  const normalized = normalizeRelativePath(relativePath);
  const { absolutePath, writable } = resolveMemoryPath(normalized, user);
  if (!fs.existsSync(absolutePath)) {
    if (!writable) {
      throw new Error('Memory file not found');
    }
    return {
      path: normalized,
      content: '',
      updatedAt: null,
      size: 0,
      writable,
    };
  }
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const stat = fs.statSync(absolutePath);
  return {
    path: normalized,
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

// 记忆路径中禁止写入的系统子目录（CLAUDE.md 除外，它是记忆文件）
const MEMORY_BLOCKED_DIRS = ['logs', '.claude', 'conversations'];

// 符号链接逃逸防护（issue #2 P1）：系统子目录写禁令必须基于**真实落点**判断，而非词法路径。
// 若校验 normalizedPath，同租户 symlink（如 bob/link -> bob/logs）写 bob/link/x.md 会被看成
// 系统目录段为 'link' 而放行，真实却落进 logs/，绕过禁令。这里用已展开 symlink 的真实绝对路径，
// 取其相对 GROUPS_DIR 的第一段系统目录（{folder}/{subDir}/...）判定。
function isBlockedMemoryWritePath(realAbsolutePath: string): boolean {
  const groupsRoot = resolveRealMemoryPath(GROUPS_DIR);
  if (!isWithinRoot(realAbsolutePath, groupsRoot)) return false;
  const subDir = path.relative(groupsRoot, realAbsolutePath).split(path.sep)[1] ?? '';
  return MEMORY_BLOCKED_DIRS.includes(subDir);
}

export function writeMemoryFile(
  relativePath: string,
  content: string,
  user: AuthUser,
): MemoryFilePayload {
  const normalized = normalizeRelativePath(relativePath);
  const { absolutePath, writable } = resolveMemoryPath(normalized, user);
  if (!writable) {
    throw new Error('Memory file is read-only');
  }
  // absolutePath 已是 resolveMemoryPath 展开 symlink 后的真实落点 → 基于它判系统目录写禁令。
  if (isBlockedMemoryWritePath(absolutePath)) {
    throw new Error('Cannot write to system path');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_FILE_LENGTH) {
    throw new Error('Memory file is too large');
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  // 符号链接逃逸防护（issue #2 P1）：absolutePath 已是真实落点，但其 `.tmp` 兄弟（后缀确定）
  // 可能被预放成 symlink——普通 writeFileSync(tmp) 会跟随它把内容写到 root 外/他人文件。
  // writeFileAtomicNoFollow 拒绝 symlink 目标、并以 O_NOFOLLOW|O_EXCL 创建 tmp 杜绝预放。
  writeFileAtomicNoFollow(absolutePath, content);

  const stat = fs.statSync(absolutePath);
  return {
    path: normalized,
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

// Directories to skip when scanning group workspaces for memory files
const WALK_SKIP_DIRS = new Set(['logs', '.claude', 'conversations', 'downloads', 'node_modules']);

export function walkFiles(
  baseDir: string,
  maxDepth: number,
  limit: number,
  out: string[],
  currentDepth = 0,
): void {
  if (out.length >= limit || currentDepth > maxDepth || !fs.existsSync(baseDir))
    return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    // 符号链接逃逸防护（issue #2 P1）：不跟随符号链接——symlink-to-dir 会被
    // isDirectory() 判否而当作"文件"push、symlink-to-file 直接 push，二者经 search
    // 的 readMemoryFile 跟随即读到 root 外宿主机文件（且会污染 list 结果）。整体跳过。
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      walkFiles(fullPath, maxDepth, limit, out, currentDepth + 1);
      continue;
    }
    out.push(fullPath);
  }
}

function isMemoryCandidateFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEMORY_SOURCE_EXTENSIONS.has(ext);
}

export function listMemorySources(user: AuthUser): MemorySource[] {
  const files = new Set<string>();
  const isAdmin = user.role === 'admin';
  const groups = getAllRegisteredGroups();
  const accessibleFolders = new Set<string>();

  if (isAdmin) {
    for (const group of Object.values(groups)) {
      accessibleFolders.add(group.folder);
    }
  } else {
    for (const group of Object.values(groups)) {
      if (group.created_by === user.id) {
        accessibleFolders.add(group.folder);
      }
    }
  }

  // 1. User-global memory
  files.add(path.join(USER_GLOBAL_DIR, user.id, 'CLAUDE.md'));

  // 2. Group CLAUDE.md files
  for (const folder of accessibleFolders) {
    files.add(path.join(GROUPS_DIR, folder, 'CLAUDE.md'));
  }

  // 3. Scan group workspace directories (skips system dirs via WALK_SKIP_DIRS)
  for (const folder of accessibleFolders) {
    const folderDir = path.join(GROUPS_DIR, folder);
    const scanned: string[] = [];
    walkFiles(folderDir, 4, MEMORY_LIST_LIMIT, scanned);
    for (const f of scanned) {
      if (isMemoryCandidateFile(f)) files.add(f);
    }
  }

  // 4. Scan data/memory/ (date memory files)
  if (fs.existsSync(MEMORY_DATA_DIR)) {
    const memFolders = fs.readdirSync(MEMORY_DATA_DIR, { withFileTypes: true });
    for (const d of memFolders) {
      if (d.isDirectory() && (isAdmin || accessibleFolders.has(d.name))) {
        const scanned: string[] = [];
        walkFiles(
          path.join(MEMORY_DATA_DIR, d.name),
          4,
          MEMORY_LIST_LIMIT,
          scanned,
        );
        for (const f of scanned) {
          if (isMemoryCandidateFile(f)) files.add(f);
        }
      }
    }
  }

  // 5. Scan conversations/ directories (read-only archives)
  for (const folder of accessibleFolders) {
    const convDir = path.join(GROUPS_DIR, folder, 'conversations');
    // 符号链接逃逸防护（issue #2 P1）：conversations/ 本身被换成 symlink 指向 root 外时，
    // readdir 会跟随它枚举宿主目录、把外部文件名带进列表；下方 per-entry lstat 只看叶子、
    // 看不出中间目录是 symlink。故扫描前先 lstat 该目录，是 symlink 或非目录直接跳过。
    let convStat: fs.Stats;
    try {
      convStat = fs.lstatSync(convDir);
    } catch {
      continue; // 不存在或不可读
    }
    if (convStat.isSymbolicLink() || !convStat.isDirectory()) continue;
    try {
      const entries = fs.readdirSync(convDir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.size >= MEMORY_LIST_LIMIT) break;
        if (!entry.isFile()) continue;
        const fullPath = path.join(convDir, entry.name);
        if (isMemoryCandidateFile(fullPath)) files.add(fullPath);
      }
    } catch { /* skip unreadable */ }
  }

  const sources: MemorySource[] = [];
  const realGroupsRoot = resolveRealMemoryPath(GROUPS_DIR);
  const realMemoryRoot = resolveRealMemoryPath(MEMORY_DATA_DIR);
  for (const absolutePath of files) {
    const inGroups = isWithinRoot(absolutePath, GROUPS_DIR);
    const inMemoryData = isWithinRoot(absolutePath, MEMORY_DATA_DIR);
    if (!inGroups && !inMemoryData) continue;

    // 符号链接逃逸防护（issue #2 P1）：词法 isWithinRoot + 叶子 lstat 仍漏一种——某个**中间
    // 目录**（如 conversations/）是 symlink 时，候选词法在 root 内、叶子又是真实文件，会把 root
    // 外文件的 name/size/mtime 泄露进 /sources。把真实落点解析出来，要求其仍在允许 root 内（与
    // read/write 侧 resolveRealMemoryPath 同一坐标系），否则丢弃。
    const real = resolveRealMemoryPath(absolutePath);
    if (!isWithinRoot(real, realGroupsRoot) && !isWithinRoot(real, realMemoryRoot)) {
      continue;
    }

    const relativePath = path
      .relative(process.cwd(), absolutePath)
      .replace(/\\/g, '/');
    // 符号链接逃逸防护（issue #2 P1）：用 lstat 而非 stat——statSync 跟随 symlink 会把
    // 宿主机/他人文件的 size/mtime 泄露进 /sources 列表。步骤 1-2 直接 add 的 CLAUDE.md
    // 不经 walkFiles 的 symlink 过滤，故此处兜底：条目本身是 symlink 直接丢弃。
    let updatedAt: string | null = null;
    let size = 0;
    let exists = false;
    try {
      const lst = fs.lstatSync(absolutePath);
      if (lst.isSymbolicLink()) continue; // 不把 symlink 目标的元数据暴露给调用方
      exists = true;
      updatedAt = lst.mtime.toISOString();
      size = lst.size;
    } catch {
      // ENOENT：尚未创建的源仍列出（exists:false），沿用原行为。
    }

    const classified = classifyMemorySource(relativePath);
    const writable = classified.type !== 'conversation';
    sources.push({
      path: relativePath,
      writable,
      exists,
      updatedAt,
      size,
      ...classified,
    });
  }

  const typeRank: Record<MemorySource['type'], number> = {
    global: 0,
    session: 1,
    date: 2,
    conversation: 3,
  };

  sources.sort((a, b) => {
    if (typeRank[a.type] !== typeRank[b.type])
      return typeRank[a.type] - typeRank[b.type];
    if (a.folder !== b.folder)
      return (a.folder || '').localeCompare(b.folder || '', 'zh-CN');
    return a.path.localeCompare(b.path, 'zh-CN');
  });

  return sources.slice(0, MEMORY_LIST_LIMIT);
}

function buildSearchSnippet(
  content: string,
  index: number,
  keywordLength: number,
): string {
  const start = Math.max(0, index - 36);
  const end = Math.min(content.length, index + keywordLength + 36);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function searchMemorySources(
  keyword: string,
  user: AuthUser,
  limit = MEMORY_SEARCH_LIMIT,
): MemorySearchHit[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return [];

  const maxResults = Number.isFinite(limit)
    ? Math.max(1, Math.min(MEMORY_SEARCH_LIMIT, Math.trunc(limit)))
    : MEMORY_SEARCH_LIMIT;

  const hits: MemorySearchHit[] = [];
  const sources = listMemorySources(user);

  for (const source of sources) {
    if (hits.length >= maxResults) break;
    if (!source.exists || source.size === 0) continue;
    if (source.size > MAX_MEMORY_FILE_LENGTH) continue;

    try {
      const payload = readMemoryFile(source.path, user);
      const lower = payload.content.toLowerCase();
      const firstIndex = lower.indexOf(normalizedKeyword);
      if (firstIndex === -1) continue;

      let count = 0;
      let from = 0;
      while (from < lower.length) {
        const idx = lower.indexOf(normalizedKeyword, from);
        if (idx === -1) break;
        count += 1;
        from = idx + normalizedKeyword.length;
      }

      hits.push({
        ...source,
        hits: count,
        snippet: buildSearchSnippet(
          payload.content,
          firstIndex,
          normalizedKeyword.length,
        ),
      });
    } catch {
      continue;
    }
  }

  return hits;
}

// --- Routes ---
// All memory routes require authentication (member + admin).
// User-level filtering is handled inside each function.

memoryRoutes.get('/sources', authMiddleware, (c) => {
  try {
    const user = c.get('user') as AuthUser;
    return c.json({ sources: listMemorySources(user) });
  } catch (err) {
    logger.error({ err }, 'Failed to list memory sources');
    return c.json({ error: 'Failed to list memory sources' }, 500);
  }
});

memoryRoutes.get('/search', authMiddleware, (c) => {
  const query = c.req.query('q');
  if (!query || !query.trim()) {
    return c.json({ error: 'Missing q' }, 400);
  }
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) ? limitRaw : MEMORY_SEARCH_LIMIT;
  try {
    const user = c.get('user') as AuthUser;
    return c.json({ hits: searchMemorySources(query, user, limit) });
  } catch (err) {
    logger.error({ err }, 'Failed to search memory sources');
    return c.json({ error: 'Failed to search memory sources' }, 500);
  }
});

memoryRoutes.get('/file', authMiddleware, (c) => {
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'Missing path' }, 400);
  try {
    const user = c.get('user') as AuthUser;
    return c.json(readMemoryFile(filePath, user));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to read memory file';
    const status = message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

memoryRoutes.put('/file', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MemoryFileSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  try {
    const user = c.get('user') as AuthUser;
    return c.json(
      writeMemoryFile(validation.data.path, validation.data.content, user),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write memory file';
    return c.json({ error: message }, 400);
  }
});

// Legacy /global API — now operates on the current user's user-global memory.
memoryRoutes.get('/global', authMiddleware, (c) => {
  try {
    const user = c.get('user') as AuthUser;
    const userGlobalPath = `data/groups/user-global/${user.id}/CLAUDE.md`;
    return c.json(readMemoryFile(userGlobalPath, user));
  } catch (err) {
    logger.error({ err }, 'Failed to read user global memory');
    return c.json({ error: 'Failed to read global memory' }, 500);
  }
});

memoryRoutes.put('/global', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MemoryGlobalSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  if (
    Buffer.byteLength(validation.data.content, 'utf-8') >
    MAX_GLOBAL_MEMORY_LENGTH
  ) {
    return c.json({ error: 'Global memory is too large' }, 400);
  }

  try {
    const user = c.get('user') as AuthUser;
    const userGlobalPath = `data/groups/user-global/${user.id}/CLAUDE.md`;
    return c.json(
      writeMemoryFile(userGlobalPath, validation.data.content, user),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write global memory';
    logger.error({ err }, 'Failed to write user global memory');
    return c.json({ error: message }, 400);
  }
});

export default memoryRoutes;
