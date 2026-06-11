import { create } from 'zustand';
import { api } from '../api/client';
import { wsManager } from '../api/ws';

/**
 * Per-user codex 认证状态 store。
 *
 * 后端契约（src/routes/config.ts，作用域 c.get('user').id）：
 *   - GET    /api/config/codex/auth              → CodexAuthStatusPublic（脱敏，永不回 token）
 *   - POST   /api/config/codex/auth/api-key      → 写 per-user auth.json {OPENAI_API_KEY}
 *   - POST   /api/config/codex/auth/access-token → codex login --with-access-token（per-user）
 *   - POST   /api/config/codex/auth/device/start → 触发 device-auth；URL/码经 WS 异步推
 *   - DELETE  /api/config/codex/auth             → 删 per-user auth.json（登出，回退共享）
 *
 * WS 事件 codex_device_auth 的推送范式严格对标 whatsapp_status（per-user 定向推送）。
 */

export type CodexAuthMethod = 'chatgpt' | 'api_key' | 'unknown';

/** 脱敏后的认证状态（不含 token/key 明文）。对应后端 CodexAuthStatus 的安全子集。 */
export interface CodexAuthStatusPublic {
  loggedIn: boolean;
  method: CodexAuthMethod | null;
  lastRefresh: string | null;
  loginHint: string;
  /** per-user：该用户自己的 auth.json 是否存在（"用自己的"判定）。 */
  hasUserAuth?: boolean;
  /** per-user：本次状态是否回退自共享账号（per-user 缺失 + fallback 开启）。 */
  usingShared?: boolean;
}

/** device-auth 流程的各阶段状态（与后端 codex-device-auth.ts onUpdate payload 对齐）。 */
export type CodexDeviceAuthPhase =
  | 'idle'
  | 'pending'
  | 'authorized'
  | 'expired'
  | 'error';

/**
 * WS 事件 codex_device_auth 的前端类型副本（这不是冻结契约文件）。
 * 推送范式对标 whatsapp_status：服务端 per-user 定向推送。
 */
export interface CodexDeviceAuthEvent {
  type: 'codex_device_auth';
  status: 'pending' | 'authorized' | 'expired' | 'error';
  verificationUri?: string;
  userCode?: string;
  expiresInSec?: number;
  error?: string;
}

export interface CodexDeviceAuthState {
  phase: CodexDeviceAuthPhase;
  verificationUri?: string;
  userCode?: string;
  /** device-auth 启动时刻的有效期；用于前端展示倒计时。 */
  expiresInSec?: number;
  error?: string;
}

interface CodexAuthState {
  status: CodexAuthStatusPublic | null;
  loading: boolean;
  error: string | null;
  device: CodexDeviceAuthState;

  loadStatus: () => Promise<void>;
  submitApiKey: (apiKey: string, force?: boolean) => Promise<void>;
  submitAccessToken: (accessToken: string) => Promise<void>;
  startDeviceAuth: () => Promise<void>;
  logout: () => Promise<void>;
  /** 重置 device-auth 流程状态（重试前清场）。 */
  resetDevice: () => void;
  /** 订阅 codex_device_auth WS 事件，返回解订阅函数。 */
  subscribeDeviceAuth: () => () => void;
}

const INITIAL_DEVICE: CodexDeviceAuthState = { phase: 'idle' };

export const useCodexAuthStore = create<CodexAuthState>((set, get) => ({
  status: null,
  loading: false,
  error: null,
  device: INITIAL_DEVICE,

  loadStatus: async () => {
    set({ loading: true });
    try {
      const data = await api.get<CodexAuthStatusPublic>(
        '/api/config/codex/auth',
      );
      set({ status: data, loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  submitApiKey: async (apiKey, force) => {
    await api.post('/api/config/codex/auth/api-key', { apiKey, force });
    await get().loadStatus();
  },

  submitAccessToken: async (accessToken) => {
    await api.post('/api/config/codex/auth/access-token', { accessToken });
    await get().loadStatus();
  },

  startDeviceAuth: async () => {
    // 立即进入 pending（按钮 loading 态由调用方管理）；URL/码经 WS 异步推。
    set({ device: { phase: 'pending' } });
    try {
      await api.post('/api/config/codex/auth/device/start', {});
    } catch (err) {
      set({
        device: {
          phase: 'error',
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  },

  logout: async () => {
    await api.delete('/api/config/codex/auth');
    set({ device: INITIAL_DEVICE });
    await get().loadStatus();
  },

  resetDevice: () => set({ device: INITIAL_DEVICE }),

  subscribeDeviceAuth: () => {
    const unsubscribe = wsManager.on(
      'codex_device_auth',
      (data: CodexDeviceAuthEvent) => {
        set({
          device: {
            phase: data.status,
            verificationUri: data.verificationUri,
            userCode: data.userCode,
            expiresInSec: data.expiresInSec,
            error: data.error,
          },
        });
        // 授权成功 / 过期 / 失败时刷新卡片级状态（method/lastRefresh/usingShared）。
        if (data.status === 'authorized') {
          void get().loadStatus();
        }
      },
    );
    return unsubscribe;
  },
}));
