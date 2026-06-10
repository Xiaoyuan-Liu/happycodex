/**
 * 最小 stub（A0 搬迁断开点，A1+ 用上游 web-context.ts 的忠实搬迁版替换）。
 *
 * 上游 src/web-context.ts 是 Web 共享状态模块（WebDeps 依赖注入 / WS 客户端管理），
 * 依赖 ws / group-queue / runtime-owner / whatsapp 等 A0 不搬的大模块。
 * 基建集里只有 schemas.ts 需要其中一个常量（MAX_GROUP_NAME_LEN），故先抽出该常量
 * 断开依赖，保持 schemas.ts 的 import 路径与上游逐字一致。
 */

/** 与上游 web-context.ts 同值（群组名最大长度，schemas.ts 校验用）。 */
export const MAX_GROUP_NAME_LEN = 40;
