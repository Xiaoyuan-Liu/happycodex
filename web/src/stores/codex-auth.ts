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

/** codex 自定义 provider 的 wire_api。codex 0.137.0 仅 "responses" 可用，默认 responses。 */
export type CodexWireApi = 'responses' | 'chat';

/**
 * 脱敏后的自定义 codex provider（不含 apiKey 明文）。
 * 对应后端 PublicCodexCustomProvider（src/runtime-config.ts）。
 */
export interface CodexProviderPublic {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  wireApi: CodexWireApi;
  hasApiKey: boolean;
  apiKeyMask: string | null; // 形如 "••••1234"；无 key 时 null
  updatedAt: string | null;
}

/** 保存自定义 provider 的入参；apiKey 可选（未传则保留旧 key，不重置）。 */
export interface SaveCodexProviderInput {
  name: string;
  baseUrl: string;
  model: string;
  wireApi?: CodexWireApi;
  apiKey?: string;
}

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

  /** 当前用户的自定义 codex provider（脱敏）；null 表示未配置。 */
  provider: CodexProviderPublic | null;
  /** provider 加载/读取中（与认证 loading 分离，避免互相干扰）。 */
  providerLoading: boolean;

  loadStatus: () => Promise<void>;
  submitApiKey: (apiKey: string, force?: boolean) => Promise<void>;
  submitAccessToken: (accessToken: string) => Promise<void>;
  startDeviceAuth: () => Promise<void>;
  /** 标准浏览器登录（本机推荐）：POST /browser/start，URL 经同一 WS 事件推。 */
  startBrowserLogin: () => Promise<void>;
  logout: () => Promise<void>;
  /** 重置 device-auth 流程状态（重试前清场）。 */
  resetDevice: () => void;
  /** 订阅 codex_device_auth WS 事件，返回解订阅函数。 */
  subscribeDeviceAuth: () => () => void;

  /** 读取当前用户的自定义 provider（GET /api/config/codex/provider）。 */
  loadProvider: () => Promise<void>;
  /** 保存/更新自定义 provider（PUT）；apiKey 可选（未传保留旧 key）。 */
  saveProvider: (input: SaveCodexProviderInput) => Promise<void>;
  /** 删除自定义 provider（DELETE），回退 codex 默认模型。 */
  deleteProvider: () => Promise<void>;
}

const INITIAL_DEVICE: CodexDeviceAuthState = { phase: 'idle' };

export const useCodexAuthStore = create<CodexAuthState>((set, get) => ({
  status: null,
  loading: false,
  error: null,
  device: INITIAL_DEVICE,
  provider: null,
  providerLoading: false,

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

  startBrowserLogin: async () => {
    // 标准浏览器登录：codex 自动开浏览器，授权 URL 经同一 WS 事件推（无短码）作兜底。
    set({ device: { phase: 'pending' } });
    try {
      await api.post('/api/config/codex/auth/browser/start', {});
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

  loadProvider: async () => {
    set({ providerLoading: true });
    try {
      // 后端在未配置时返回 null（200）；脱敏视图绝不含 apiKey 明文。
      const data = await api.get<CodexProviderPublic | null>(
        '/api/config/codex/provider',
      );
      set({ provider: data, providerLoading: false });
    } catch (err) {
      set({ providerLoading: false });
      throw err;
    }
  },

  saveProvider: async (input) => {
    await api.put('/api/config/codex/provider', input);
    await get().loadProvider();
  },

  deleteProvider: async () => {
    await api.delete('/api/config/codex/provider');
    await get().loadProvider();
  },
}));
