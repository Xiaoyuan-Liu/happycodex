/**
 * 【A5 stub / tombstone】plugin-* 全家不在本棒搬迁范围（用户决策：A5 再做）。
 *
 * 上游 src/plugin-expander-sentinel.ts 定义 plugin 展开的 attachments 哨兵
 * 类型与读写纯函数。web.ts 只消费 PLUGIN_EXPANSION_ATTACHMENT_TYPE 常量 +
 * PluginExpansionSentinel 类型（persistPluginExpansion 的入参）。
 *
 * 本 stub 保留常量与类型（与上游逐字一致）；attachments 读写函数
 * （readPluginExpansionFromAttachments / writePluginExpansionToAttachments）
 * 未搬——A5 搬 plugin-expander 全家时以上游真版整体替换本文件。
 */

export const PLUGIN_EXPANSION_ATTACHMENT_TYPE = 'plugin_expansion';

export interface PluginExpansionSentinel {
  type: typeof PLUGIN_EXPANSION_ATTACHMENT_TYPE;
  expanded: true;
  prompt: string;
  expandedAt: string;
}

/** 上游同名类型（plugin-expander-core 的 persistExpansion 注入点签名）。 */
export type PersistExpansionFn = (
  msgId: string,
  chatJid: string,
  expansion: PluginExpansionSentinel,
) => void;
