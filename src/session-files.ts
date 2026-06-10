/**
 * Session file cleanup — shared between the Web UI reset-session route and the
 * IM `/clear` slash command.
 *
 * happycodex：骨架忠实于上游（per-entry try/catch、keep 集合、不存在即 no-op），
 * 实现替换为 codex 等价物。上游清的是 `data/sessions/{folder}/.claude/`（保留
 * settings.json）；这里改为两步：
 *   1) 删 SessionStore（data/sessions/index.json）的 folder→threadId 映射 ——
 *      下一次运行不再 resume 旧 thread；
 *   2) 清 per-folder CODEX_HOME（data/sessions/{folder}/.codex，agent 走
 *      agents/{agentId}/.codex）下的会话状态（sessions/ 下的 rollout、history.jsonl
 *      等），保留凭据与配置：auth.json / config.toml / agents/ / hooks.json。
 *
 * Errors on individual entries are logged and skipped so a single permission
 * problem (e.g. on a stale symlink) doesn't abort the whole reset.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { SessionStore } from './runtime/multitenant/session-store.js';

/** SessionStore 持久化文件（约定对齐 SessionManager 的默认值）。 */
const SESSION_INDEX_FILE = 'index.json';

/** CODEX_HOME 内需要保留的凭据/配置（对应上游保留 settings.json 的语义）。 */
const KEEP_ENTRIES = new Set(['auth.json', 'config.toml', 'agents', 'hooks.json']);

export function clearSessionFiles(folder: string, agentId?: string): void {
  // 1. 删 SessionStore 的 folder→threadId 映射。key 与 provisionCodexHome 的
  //    folder 约定一致（sub-agent 是 `{folder}/agents/{agentId}` 复合键）。
  //    仅在映射存在时才删（避免 no-op 清理也落盘创建 index.json）。
  const storeKey = agentId ? path.join(folder, 'agents', agentId) : folder;
  try {
    const store = new SessionStore(
      path.join(DATA_DIR, 'sessions', SESSION_INDEX_FILE),
    );
    if (store.getThreadId(storeKey) !== null) {
      store.deleteThreadId(storeKey);
    }
  } catch (err) {
    logger.warn(
      { folder, agentId, err },
      'Failed to delete thread mapping from session store, skipping',
    );
  }

  // 2. 清 per-folder CODEX_HOME 下的会话状态（rollout 等），保留凭据/配置。
  const codexDir = agentId
    ? path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, '.codex')
    : path.join(DATA_DIR, 'sessions', folder, '.codex');
  if (!fs.existsSync(codexDir)) return;

  for (const entry of fs.readdirSync(codexDir)) {
    if (KEEP_ENTRIES.has(entry)) continue;
    try {
      fs.rmSync(path.join(codexDir, entry), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      logger.warn(
        { entry, folder, agentId, err },
        'Failed to remove session file, skipping',
      );
    }
  }
}
