/**
 * 【A5 stub / tombstone】plugin-* 全家不在本棒搬迁范围（用户决策：A5 再做）。
 *
 * 上游 src/plugin-expander-store.ts 把展开后的 prompt 哨兵持久化回消息行
 * （crash-safety：inline `!` 执行后、cursor 前必须落盘）。
 *
 * 本 stub 提供同签名 no-op：因为 plugin-expander-core 的 stub 永远返回
 * `{ kind: 'miss' }`（不会产生 expanded 结果），web.ts 中的调用点
 * （expansion.kind === 'expanded' 分支）实际不可达，no-op 不引入行为差异。
 * A5 搬迁 plugin 全家时以上游真版整体替换本文件。
 */

import type { PluginExpansionSentinel } from './plugin-expander-sentinel.js';

export function persistPluginExpansion(
  _msgId: string,
  _chatJid: string,
  _sentinel: PluginExpansionSentinel,
): void {
  // no-op stub：plugin 展开被禁用（core stub 恒 miss），此路径不可达
}
