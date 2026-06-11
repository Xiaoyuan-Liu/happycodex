/**
 * Telegram 渠道 stub —— 按需后补。
 *
 * 上游 happyclaw 的 src/telegram.ts（grammy Bot API Long Polling 实现，1288 行）
 * 尚未整体搬迁（grammy/proxy-agent 依赖已在 package.json 中，仅实现本体未搬）。
 * 本文件只保留 im-channel.ts / im-manager.ts 依赖的类型面（与上游逐字一致）
 * 和一个禁用态的工厂函数：connect() 直接抛错，isConnected() 恒为 false。
 * 需要启用 Telegram 渠道时，按上游实现整体搬迁并替换本文件，
 * 同时移除 TELEGRAM_CHANNEL_STUBBED 及 routes/config.ts 中的对应 501 短路。
 */
import { logger } from './logger.js';

// ─── TelegramConnection Interface（与上游逐字一致）──────────────

export interface TelegramConnectionConfig {
  botToken: string;
  proxyUrl?: string;
}

export interface TelegramConnectOpts {
  onReady?: () => void;
  /** 收到消息后调用，让调用方自动注册未知的 Telegram 聊天 */
  onNewChat: (jid: string, name: string) => void;
  /** 检查聊天是否已注册（已在 registered_groups 中） */
  isChatAuthorized: (jid: string) => boolean;
  /** 配对尝试回调：验证码并注册聊天，返回是否成功 */
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  /** 斜杠指令回调（如 /clear），返回回复文本或 null。
   *  senderImId 是发送者的裸 Telegram 用户 ID（不含 `tg:` 前缀），
   *  与飞书/钉钉 onCommand 传裸 open_id / senderId 的格式一致，
   *  用于在主进程做 owner-only 命令检查（owner_im_id 比对）。 */
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  /** 热重连时设置：丢弃 date 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
  /** 根据 jid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (jid: string) => string | undefined;
  /** 将 IM chatJid 解析为绑定目标 JID（conversation agent 或工作区主对话） */
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  /** 当 IM 消息被路由到 conversation agent 后调用，触发 agent 处理 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Bot 被添加到群聊时调用（仅 group/supergroup） */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用 */
  onBotRemovedFromGroup?: (chatJid: string) => void;
}

export interface TelegramConnection {
  connect(opts: TelegramConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
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
  sendChatAction(chatId: string, action: 'typing'): Promise<void>;
  isConnected(): boolean;
}

// ─── 禁用态工厂（stub）─────────────────────────────────────────

/**
 * 渠道为 stub 的标记：routes/config.ts 据此对「测试连接」返回诚实的 501，
 * 并在 GET/PUT 配置响应中附加 lastError 解释「启用后为何永不连接」。
 * 整体搬迁上游实现时删除此导出（显式 boolean 注解避免字面量类型窄化）。
 */
export const TELEGRAM_CHANNEL_STUBBED: boolean = true;

export const STUB_MESSAGE =
  'Telegram 渠道未搬迁（stub）：上游 src/telegram.ts（grammy Long Polling 实现）尚未搬迁，渠道暂不可用，按需后补';

export function createTelegramConnection(
  _config: TelegramConnectionConfig,
): TelegramConnection {
  return {
    async connect(): Promise<void> {
      logger.error(STUB_MESSAGE);
      throw new Error(STUB_MESSAGE);
    },
    async disconnect(): Promise<void> {
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
    async sendChatAction(): Promise<void> {
      // no-op
    },
    isConnected(): boolean {
      return false;
    },
  };
}
