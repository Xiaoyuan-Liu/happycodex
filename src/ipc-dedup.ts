// IPC send_message 跨重试去重（从 index.ts 抽出以便单测——index.ts main() 加载即执行、不可被测试
// import；沿用 src/ipc-paths.ts / src/task-routing.ts 的「helper 测试锁语义」范式）。
//
// 错误退避重试会把整个 prompt 从头重跑，agent 在失败前已执行的 send_message 会被原样再执行一遍，
// 经 IPC watcher 即时送达用户（重复刷消息）。
//
// 关键：抑制必须严格限定在「重试重放」窗口，否则会误杀合法的重复内容（周期定时任务每次报告相同
// 文案、用户明确要求重发同一句话）。因此始终记录每条 send 的指纹，但仅当该源 group 当前正处于
// 失败重试轮次（retryCount>0）时，命中已记录的指纹才抑制——正常首轮永不抑制。
import crypto from 'crypto';

export const IPC_SEND_DEDUP_TTL_MS = 10 * 60_000;
export const IPC_SEND_DEDUP_MAX = 500;

export interface IpcSendDedupDeps {
  /** sourceGroup 是 folder → 反查该 folder 的全部真实 chatJid（web:<uuid> / feishu:oc_xxx）。 */
  getJidsByFolder: (folder: string) => string[];
  /** 按真实 chatJid 取重试计数（GroupQueue.getRetryCount）。 */
  getRetryCount: (jid: string) => number;
  /** 时钟注入（默认 Date.now），供测试控制 TTL。 */
  now?: () => number;
}

export type IsRetryDuplicateIpcSend = (
  sourceGroup: string,
  chatJid: string,
  text: string,
) => boolean;

/**
 * 构造一个带独立指纹表的去重判定器。每个进程一个实例（index.ts 持有单例）。
 * 返回 true 表示「当前处于重试重放窗口、且这条 send 的指纹已见过」→ 应抑制。
 */
export function createIpcSendDedup(deps: IpcSendDedupDeps): IsRetryDuplicateIpcSend {
  const now = deps.now ?? Date.now;
  const recentIpcSends = new Map<string, number>(); // key → expireAt
  return function isRetryDuplicateIpcSend(sourceGroup, chatJid, text) {
    const key = `${sourceGroup}|${chatJid}|${crypto
      .createHash('md5')
      .update(text)
      .digest('hex')}`;
    const t = now();
    const exp = recentIpcSends.get(key);
    // 仅在该 group 处于重试重放时，已见过的指纹才视为重复并抑制。
    // sourceGroup 是 folder，而 retryCount 以**真实 chatJid** 记账：旧实现用 `web:${folder}` / `folder`
    // 猜键，仅 admin home（folder=jid=web:main）碰巧命中，普通群（web:<uuid>）/ IM 群（feishu:oc_xxx）
    // 恒 false → 去重对绝大多数群是 no-op（#F5）。改为取该 folder 全部真实 JID，任一处于重试重放即视
    // 为窗口内。对齐上游 happyclaw 修复（getJidsByFolder）。
    const inRetry = deps.getJidsByFolder(sourceGroup).some(
      (jid) => deps.getRetryCount(jid) > 0,
    );
    const isDup = !!(exp && exp > t) && inRetry;
    recentIpcSends.set(key, t + IPC_SEND_DEDUP_TTL_MS);
    // 容量控制：Map 迭代为插入序，先进先出淘汰
    for (const k of recentIpcSends.keys()) {
      if (recentIpcSends.size <= IPC_SEND_DEDUP_MAX) break;
      recentIpcSends.delete(k);
    }
    return isDup;
  };
}
