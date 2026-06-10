/**
 * 【A5 stub / tombstone】plugin-* 全家不在本棒搬迁范围（用户决策：A5 再做）。
 *
 * 上游 src/plugin-expander-context.ts 是 plugin 斜杠命令展开的 ExpandContext
 * 纯类型/纯函数模块（零内部依赖）。web.ts 的 buildWebExpandContext 依赖
 * makeExpandContext + ExpandContext 类型。
 *
 * 本 stub 保持与上游完全相同的类型与 makeExpandContext 签名/语义（该模块本身
 * 是纯函数、无 plugin 运行时依赖，逐字保留成本为零且让 web.ts 的调用路径
 * 行为与上游一致）；plugin 展开的"核心"逻辑（plugin-expander-core）才是
 * 真正被 stub 掉的部分——见 plugin-expander-core.ts 的 tombstone。
 */

import path from 'path';

export type ExecutionMode = 'host' | 'container';

export interface ExpandContext {
  userId: string;
  groupJid: string;
  groupFolder: string;
  /** host: absolute path; container: '/workspace/group'. */
  cwd: string;
  executionMode: ExecutionMode;
  /** Active container name (docker mode only). null when no runner is up. */
  containerName: string | null;
}

/** 与上游逐字一致的纯函数（见上方 tombstone 说明）。 */
export function makeExpandContext(args: {
  chatJid: string;
  groupFolder: string;
  ownerId: string | null | undefined;
  executionMode: 'host' | 'container' | string | null | undefined;
  customCwd?: string | null;
  groupsDir: string;
  containerName: string | null;
}): ExpandContext | null {
  if (!args.ownerId) return null;
  const executionMode: ExecutionMode =
    (args.executionMode || 'container') === 'host' ? 'host' : 'container';
  let cwd: string;
  if (executionMode === 'host') {
    cwd = args.customCwd
      ? path.resolve(args.customCwd)
      : path.resolve(args.groupsDir, args.groupFolder);
  } else {
    cwd = '/workspace/group';
  }
  return {
    userId: args.ownerId,
    groupJid: args.chatJid,
    groupFolder: args.groupFolder,
    cwd,
    executionMode,
    containerName: args.containerName,
  };
}
