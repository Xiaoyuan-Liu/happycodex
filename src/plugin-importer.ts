/**
 * 【A5 stub / tombstone】plugin-* 全家不在本棒搬迁范围（用户决策：A5 再做）。
 *
 * 上游 src/plugin-importer.ts（~660 行）扫描宿主机 marketplace 目录
 * （~/.claude/plugins/marketplaces 等），把 host 上已安装的 Claude Code
 * plugin marketplace 导入 HappyClaw 的 plugin catalog（DB + 物化目录）。
 *
 * index.ts 只消费 scanHostMarketplaces()（启动时 + 每日定时的 fire-and-forget
 * 扫描，错误本就被 .catch 吞掉）。本 stub 为 no-op：无 plugin 运行时可导入，
 * 扫描结果恒为空 —— 与上游"宿主机无 marketplace 目录"路径的行为一致，
 * 不影响主流程。
 *
 * A5 搬迁 plugin 全家时以上游真版整体替换本文件。
 */

import { logger } from './logger.js';

export async function scanHostMarketplaces(): Promise<void> {
  logger.debug(
    'plugin-importer stub: plugin marketplace scan skipped (A5 未搬迁)',
  );
}
