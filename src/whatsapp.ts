/**
 * WhatsApp 渠道 stub —— 按需后补。
 *
 * 上游 happyclaw 的 src/whatsapp.ts（@whiskeysockets/baileys WhatsApp Web 协议实现）未搬迁。
 * 本文件只保留 im-channel.ts / im-manager.ts 依赖的类型面（与上游逐字一致）、
 * 纯路径工具 getWhatsAppAuthDir（与上游实现一致），以及一个禁用态的工厂函数：
 * connect() 直接抛错，isConnected() 恒为 false。
 * 需要启用 WhatsApp 渠道时，按上游实现整体搬迁并替换本文件。
 */
import path from 'node:path';
import { logger } from './logger.js';

// ─── Types（与上游逐字一致）─────────────────────────────────────

export interface WhatsAppConnectionConfig {
  /** Account identifier — currently 固定 'default'，未来扩展 multi-account 用 */
  accountId?: string;
  /** Optional phone number hint for display purposes (E.164 format, e.g. +15551234567) */
  phoneNumber?: string;
  /** Auth state directory; required for production use to persist login between restarts */
  authDir: string;
}

export type WhatsAppConnectionStatus =
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

export interface WhatsAppConnectionState {
  status: WhatsAppConnectionStatus;
  /** Raw QR string (only when status='qr') */
  qr?: string;
  /** Pre-rendered PNG data URL of the QR (only when status='qr'), ready for <img src=> */
  qrDataUrl?: string;
  /** Human-readable error reason when status='disconnected' or 'logged_out' */
  error?: string;
  /** Self-bot WhatsApp JID once logged in (e.g. 15551234567@s.whatsapp.net) */
  meJid?: string;
  /** Display name of the logged-in account */
  meName?: string;
}

export interface WhatsAppConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Bot added to a new group */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot removed from a group / group dissolved */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** Group msg gate: bot not mentioned + this returns false → drop */
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** owner_mentioned mode: bot @mentioned but sender not group owner → drop */
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** Sender allowlist: false → drop before any further processing */
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  /** WhatsApp 专属：连接状态变化回调（QR 出现、connected、断线等） */
  onConnectionUpdate?: (state: WhatsAppConnectionState) => void;
}

export interface WhatsAppConnection {
  connect(opts: WhatsAppConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  /** Force log out and clear local auth state (user clicks "退出登录") */
  logout(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendFile(
    chatId: string,
    filePath: string,
    fileName: string,
  ): Promise<void>;
  sendTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  /** Current connection state snapshot (latest seen) */
  getState(): WhatsAppConnectionState;
}

// ─── 纯路径工具（与上游实现一致）────────────────────────────────

export function getWhatsAppAuthDir(
  dataDir: string,
  userId: string,
  accountId = 'default',
): string {
  return path.join(dataDir, 'config', 'user-im', userId, 'whatsapp-auth', accountId);
}

// ─── 禁用态工厂（stub）─────────────────────────────────────────

const STUB_MESSAGE =
  'WhatsApp 渠道未搬迁（stub）：上游 src/whatsapp.ts 依赖 @whiskeysockets/baileys/qrcode，按需后补';

export function createWhatsAppConnection(
  _config: WhatsAppConnectionConfig,
): WhatsAppConnection {
  const stubState: WhatsAppConnectionState = {
    status: 'disconnected',
    error: STUB_MESSAGE,
  };
  return {
    async connect(opts: WhatsAppConnectOpts): Promise<void> {
      logger.error(STUB_MESSAGE);
      // 推送带 STUB_MESSAGE 的 disconnected 状态（镜像上游 setState→onConnectionUpdate
      // 契约，upstream src/whatsapp.ts:215-222）：im-manager 缓存到 lastWhatsAppState，
      // GET/PUT /api/config/user-im/whatsapp 响应与 whatsapp_status WS 均携带 error，
      // 前端 WhatsAppChannelCard「断线原因」即可显示 stub 降级说明。
      try {
        opts.onConnectionUpdate?.(stubState);
      } catch {
        /* 回调异常不掩盖 stub 主错误 */
      }
      throw new Error(STUB_MESSAGE);
    },
    async disconnect(): Promise<void> {
      // no-op
    },
    async logout(): Promise<void> {
      // no-op
    },
    async sendMessage(): Promise<void> {
      throw new Error(STUB_MESSAGE);
    },
    async sendImage(): Promise<void> {
      throw new Error(STUB_MESSAGE);
    },
    async sendFile(): Promise<void> {
      throw new Error(STUB_MESSAGE);
    },
    async sendTyping(): Promise<void> {
      // no-op
    },
    isConnected(): boolean {
      return false;
    },
    getState(): WhatsAppConnectionState {
      return stubState;
    },
  };
}
