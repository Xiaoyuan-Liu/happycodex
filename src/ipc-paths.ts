/**
 * IPC 消费端路径安全 helpers（src/index.ts processTaskIpc / handleDiscordIpcRequest 专用）。
 *
 * 修复轮 2（CR#1 / CR#2 / CR#8）抽成纯函数模块：src/index.ts 在模块加载时执行 main()，
 * 无法被测试 import，语义由 tests/ipc-result-routing.test.ts 直接钉死（同 task-routing.ts
 * 的抽取范式）。
 *
 * - CR#1 resolveIpcResultPath：请求-响应类 IPC（list_tasks / install_skill /
 *   uninstall_skill / discord_*）的结果文件必须写回**请求所在**的 tasks 目录——请求可能
 *   来自 agents/{aid}/ 或 tasks-run/{id}/ 子空间（index.ts 的 per-ipcRoot 循环），硬编码
 *   data/ipc/{folder}/tasks 会让子空间内的轮询方永远收不到回执。上游 happyclaw 1:1 同
 *   缺陷，主动修复，偏离记录见 docs/UPSTREAM-SYNC.md。
 * - CR#8 resolveSendFileAnchor：send_file 相对路径的还原锚点必须与 agent 进程实际 cwd
 *   同源——host 模式 container-runner 注入 HAPPYCLAW_WORKSPACE_GROUP = customCwd ||
 *   GROUPS_DIR/{folder}（container-runner.ts runHostAgent），producer（ipc-bridge
 *   sendFile）按该目录产出相对路径；消费端若恒锚 GROUPS_DIR/{folder}，host+customCwd
 *   群组发文件永远 not found。downloads 兜底恒锚定默认组目录（im-downloader 不随
 *   customCwd 走，见 im-downloader.ts:74）。
 * - CR#2 isRealPathWithinRoots：词法 startsWith 校验在跟随 symlink 后失效（工作区内一个
 *   `evil -> /etc/passwd` 链接即可外读任意文件）。producer 侧（ipc-bridge
 *   resolveWorkspaceFile）本轮已同步加 realpath 物理校验；消费端仍独立校验作为最后
 *   防线——producer 可能被 prompt 注入驱动，两侧防御不互相依赖。
 */
import fs from 'fs';
import path from 'path';

/**
 * CR#1：把结果文件名锚定到请求所在 tasks 目录，并做防穿越校验。
 * 返回校验通过的绝对路径；文件名逃逸 tasksDir（如含 `../`）时返回 null。
 */
export function resolveIpcResultPath(
  tasksDir: string,
  resultFileName: string,
): string | null {
  const tasksDirResolved = path.resolve(tasksDir);
  const resultFilePath = path.resolve(tasksDir, resultFileName);
  if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
    return null;
  }
  return resultFilePath;
}

export interface SendFileAnchor {
  /** 相对路径还原锚点（= agent 进程 cwd 同源目录）。 */
  workspaceBase: string;
  /** 默认组目录（downloads 兜底恒锚于此）。 */
  defaultGroupBase: string;
  /** realpath 物理校验允许的根集合（host+customCwd 时含两个根）。 */
  allowedRoots: string[];
}

/**
 * CR#8：按 RegisteredGroup 的 executionMode/customCwd 推导 send_file 消费端锚点。
 * 与 container-runner.ts runHostAgent 的 `groupDir = customCwd || GROUPS_DIR/{folder}`
 * 同源；container 模式（默认）恒为默认组目录，customCwd 不生效。
 *
 * host+customCwd 分支对 customCwd 做 fs.realpathSync 归一，与 container-runner.ts
 * runHostAgent（:934 `groupDir = fs.realpathSync(groupDir)` 后注入 HAPPYCLAW_WORKSPACE_GROUP）
 * 逐字符同源——消除「消费端用原始 customCwd、生产端用 realpath(customCwd)」的锚点分叉
 * （customCwd 含 symlink 段如 macOS /tmp→/private/tmp 时分叉，未来对两锚做词法 path
 * 运算会错配）。归一失败（路径不存在）回退 path.resolve，不抛错。
 */
export function resolveSendFileAnchor(opts: {
  groupsDir: string;
  sourceGroup: string;
  executionMode?: string;
  customCwd?: string;
}): SendFileAnchor {
  const defaultGroupBase = path.join(opts.groupsDir, opts.sourceGroup);
  let workspaceBase: string;
  if ((opts.executionMode || 'container') === 'host' && opts.customCwd) {
    try {
      workspaceBase = fs.realpathSync(opts.customCwd);
    } catch {
      workspaceBase = path.resolve(opts.customCwd);
    }
  } else {
    workspaceBase = defaultGroupBase;
  }
  const allowedRoots =
    workspaceBase === defaultGroupBase
      ? [defaultGroupBase]
      : [workspaceBase, defaultGroupBase];
  return { workspaceBase, defaultGroupBase, allowedRoots };
}

/**
 * CR#2：realpath 物理校验——targetPath 解析 symlink 后的真实位置必须仍在任一允许根内。
 * 根自身也 realpath（参照 ipc-bridge.ts memoryGet 范式），避免根路径上游含 symlink
 * （如 macOS /var → /private/var）时前缀比较偏差。某个根不存在则跳过该根（根都不存在
 * 时其内不可能有合法文件）。
 *
 * 返回校验通过的**真实路径**（realpath 后），调用方应拿它去 read/send——而非把原 targetPath
 * 再交给下游（下游 readFile 会二次跟随 symlink，与本次校验解析出的 inode 不必是同一个，
 * 留下 TOCTOU 窗口：校验通过后换链即可外发）。targetPath 不存在/不可解析、或越界 → null。
 */
export function isRealPathWithinRoots(
  targetPath: string,
  roots: string[],
): string | null {
  let real: string;
  try {
    real = fs.realpathSync(targetPath);
  } catch {
    return null;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) {
      return real;
    }
  }
  return null;
}
