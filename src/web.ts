/**
 * Web 层最小 stub —— 断开点，主进程线会接。
 *
 * 上游 happyclaw 的 src/web.ts 是 Hono Web 服务（路由挂载 / WebSocket / 认证），
 * 不属于 IM 渠道层。各 IM 渠道（feishu/dingtalk/discord/qq/wechat）只依赖其中的
 * broadcastNewMessage() 一个函数（消息到达时向 Web 前端 WS 客户端广播）。
 *
 * 本 stub 提供同签名的 no-op，使渠道层可独立 typecheck/测试；
 * 主进程线搬迁 web.ts 时整体替换本文件，渠道层 import 无需改动。
 */
import type { NewMessage } from './types.js';

export function broadcastNewMessage(
  _chatJid: string,
  _msg: NewMessage & { is_from_me?: boolean },
  _agentId?: string,
  _source?: string,
): void {
  // no-op stub：尚无 Web/WS 层，消息广播由主进程线接入后生效
}
