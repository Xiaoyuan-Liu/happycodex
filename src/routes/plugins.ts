/**
 * 【A5 stub / tombstone】plugin-* 全家不在本棒搬迁范围（用户决策：A5 再做）。
 *
 * 上游 src/routes/plugins.ts（537 行）是 Claude Code Plugins 管理路由
 * （catalog 扫描/启用/materialize/marketplace 删除/命令索引），依赖
 * plugin-catalog / plugin-importer / plugin-materializer / plugin-utils /
 * plugin-command-index / plugin-dependency-check 全家（均属 A5）。
 *
 * 本 stub 保持挂载点（web.ts 的 `app.route('/api/plugins', pluginsRoutes)`
 * 与上游逐字一致），提供最小可用面：
 *   - GET  /            → { marketplaces: [] }（前端 stores/plugins.ts 期望
 *     的空列表形状，插件页显示"无插件"而非报错）
 *   - 其余端点（scan/enabled/materialize/marketplaces 删除/commands/catalog）
 *     → 501 Not Implemented + 说明
 *
 * A5 搬迁 plugin 全家时以上游真版整体替换本文件。
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';

const pluginsRoutes = new Hono<{ Variables: Variables }>();

const NOT_IMPLEMENTED_MSG =
  'Plugin system is not available in this build (happycodex A5 pending)';

pluginsRoutes.get('/', authMiddleware, (c) => {
  // 空 catalog：与上游"用户无任何 plugin / catalog 为空"时的响应形状一致
  return c.json({ marketplaces: [] });
});

pluginsRoutes.get('/commands', authMiddleware, (c) => {
  return c.json({ commands: [], conflicts: [] });
});

pluginsRoutes.all('*', authMiddleware, (c) => {
  return c.json({ error: NOT_IMPLEMENTED_MSG }, 501);
});

export default pluginsRoutes;
