/**
 * 最小 stub（A0 搬迁断开点，A1+ 用上游 web-context.ts 的忠实搬迁版替换）。
 *
 * 上游 src/web-context.ts 是 Web 共享状态模块（WebDeps 依赖注入 / WS 客户端管理），
 * 依赖 ws / group-queue / runtime-owner / whatsapp 等 A0 不搬的大模块。
 * 基建集里只有 schemas.ts 需要其中一个常量（MAX_GROUP_NAME_LEN），故先抽出该常量
 * 断开依赖，保持 schemas.ts 的 import 路径与上游逐字一致。
 *
 * 认证簇（A1）追加：session 缓存块 + Variables 类型（src/middleware/auth.ts 依赖），
 * 内容与上游 web-context.ts 对应段落逐字一致。WebDeps / WS 客户端 / 群组访问检查
 * （canAccessGroup 等）仍未搬迁——它们依赖 group-queue / runtime-owner 等大模块，
 * 由主进程线接上时替换本 stub。
 */

import type { AuthUser, UserSessionWithUser } from './types.js';
import { getSessionWithUser } from './db.js';

/** 与上游 web-context.ts 同值（群组名最大长度，schemas.ts 校验用）。 */
export const MAX_GROUP_NAME_LEN = 40;

export type Variables = {
  user: AuthUser;
  sessionId: string;
};

// lastActiveCache - 5 min debounce for session activity tracking
export const lastActiveCache = new Map<string, number>();
export const LAST_ACTIVE_DEBOUNCE_MS = 5 * 60 * 1000;
const LAST_ACTIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const lastActiveCleanupTimer = setInterval(
  () => {
    const cutoff = Date.now() - LAST_ACTIVE_CACHE_TTL_MS;
    for (const [sessionId, touchedAt] of lastActiveCache.entries()) {
      if (touchedAt < cutoff) lastActiveCache.delete(sessionId);
    }
  },
  60 * 60 * 1000,
);
lastActiveCleanupTimer.unref?.();

// Session data cache — 30s TTL, avoids DB query on every request
const SESSION_CACHE_TTL_MS = 30 * 1000;
const sessionCache = new Map<
  string,
  { data: UserSessionWithUser; expiry: number }
>();

export function getCachedSessionWithUser(
  sessionId: string,
): UserSessionWithUser | undefined {
  const cached = sessionCache.get(sessionId);
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }
  sessionCache.delete(sessionId);
  const data = getSessionWithUser(sessionId);
  if (data) {
    sessionCache.set(sessionId, {
      data,
      expiry: Date.now() + SESSION_CACHE_TTL_MS,
    });
  }
  return data;
}

export function invalidateSessionCache(sessionId: string): void {
  sessionCache.delete(sessionId);
  lastActiveCache.delete(sessionId);
}

export function invalidateUserSessions(userId: string): void {
  for (const [sid, entry] of sessionCache.entries()) {
    if (entry.data.user_id === userId) {
      sessionCache.delete(sid);
      lastActiveCache.delete(sid);
    }
  }
}

const sessionCacheCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [sid, entry] of sessionCache.entries()) {
      if (entry.expiry < now) sessionCache.delete(sid);
    }
  },
  5 * 60 * 1000,
);
sessionCacheCleanupTimer.unref?.();
