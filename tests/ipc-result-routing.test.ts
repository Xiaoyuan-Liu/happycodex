/**
 * 修复轮 2（CR#1 / CR#2 / CR#8）回归测试 —— IPC 消费端路径安全 helpers（src/ipc-paths.ts）。
 *
 * src/index.ts 在模块加载时执行 main()，无法被测试 import；消费端语义抽到 ipc-paths.ts
 * 纯函数后在此钉死（同 task-routing.ts 的「helper 测试锁语义」范式）：
 *
 * - CR#1 resolveIpcResultPath：请求-响应回执必须锚定**请求所在** tasks 目录
 *   （agents/{aid}/、tasks-run/{id}/ 子空间），不得回落主 namespace；防穿越校验保留。
 * - CR#8 resolveSendFileAnchor：send_file 相对路径锚点 host+customCwd 时为 customCwd
 *   （与 container-runner 注入 HAPPYCLAW_WORKSPACE_GROUP 同源）；downloads 兜底恒锚默认组目录。
 * - CR#2 isRealPathWithinRoots：realpath 物理校验，symlink 越界必须拒绝（词法校验跟随
 *   symlink 后失效的最后防线）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveIpcResultPath,
  resolveSendFileAnchor,
  isRealPathWithinRoots,
} from '../src/ipc-paths.js';

describe('resolveIpcResultPath (CR#1 回执命名空间)', () => {
  const dataDir = path.join(os.tmpdir(), 'hc-data');
  const mainTasksDir = path.join(dataDir, 'ipc', 'my-group', 'tasks');
  const agentTasksDir = path.join(
    dataDir,
    'ipc',
    'my-group',
    'agents',
    'agent-1',
    'tasks',
  );
  const taskRunTasksDir = path.join(
    dataDir,
    'ipc',
    'my-group',
    'tasks-run',
    'run-42',
    'tasks',
  );

  it('主 namespace 请求：回执锚定主 tasks 目录', () => {
    const p = resolveIpcResultPath(mainTasksDir, 'list_tasks_result_abc.json');
    expect(p).toBe(path.join(mainTasksDir, 'list_tasks_result_abc.json'));
  });

  it('agents/{aid}/ 子空间请求：回执必须写回子空间，不得回落主 namespace（CR#1 核心回归）', () => {
    const p = resolveIpcResultPath(
      agentTasksDir,
      'install_skill_result_req1.json',
    );
    expect(p).toBe(path.join(agentTasksDir, 'install_skill_result_req1.json'));
    // 回退到硬编码主 namespace（修复前行为）必须导致本断言失败
    expect(p!.startsWith(`${agentTasksDir}${path.sep}`)).toBe(true);
    expect(p).not.toBe(path.join(mainTasksDir, 'install_skill_result_req1.json'));
  });

  it('tasks-run/{id}/ 子空间请求：回执锚定 tasks-run 子空间', () => {
    const p = resolveIpcResultPath(
      taskRunTasksDir,
      'discord_get_history_result_r9.json',
    );
    expect(p).toBe(
      path.join(taskRunTasksDir, 'discord_get_history_result_r9.json'),
    );
  });

  it('防穿越校验保留：文件名逃逸 tasks 目录返回 null', () => {
    expect(
      resolveIpcResultPath(agentTasksDir, '../../../evil_result.json'),
    ).toBeNull();
    expect(resolveIpcResultPath(mainTasksDir, '..')).toBeNull();
    // 同前缀兄弟目录（tasks-evil）不得通过 startsWith 前缀绕过
    expect(
      resolveIpcResultPath(mainTasksDir, '../tasks-evil/r.json'),
    ).toBeNull();
  });
});

describe('resolveSendFileAnchor (CR#8 customCwd 锚点)', () => {
  const groupsDir = path.join(os.tmpdir(), 'hc-groups');
  const customCwd = path.join(os.tmpdir(), 'hc-custom-project');

  it('container 模式（默认）：锚定默认组目录，单一允许根', () => {
    const a = resolveSendFileAnchor({ groupsDir, sourceGroup: 'g1' });
    expect(a.workspaceBase).toBe(path.join(groupsDir, 'g1'));
    expect(a.defaultGroupBase).toBe(path.join(groupsDir, 'g1'));
    expect(a.allowedRoots).toEqual([path.join(groupsDir, 'g1')]);
  });

  it('host + customCwd：锚定 customCwd，允许根含 customCwd 与默认组目录（downloads 兜底）', () => {
    const a = resolveSendFileAnchor({
      groupsDir,
      sourceGroup: 'g1',
      executionMode: 'host',
      customCwd,
    });
    expect(a.workspaceBase).toBe(customCwd);
    expect(a.defaultGroupBase).toBe(path.join(groupsDir, 'g1'));
    expect(a.allowedRoots).toEqual([customCwd, path.join(groupsDir, 'g1')]);
  });

  it('host 无 customCwd：锚定默认组目录（与 container-runner groupDir 推导一致）', () => {
    const a = resolveSendFileAnchor({
      groupsDir,
      sourceGroup: 'g1',
      executionMode: 'host',
    });
    expect(a.workspaceBase).toBe(path.join(groupsDir, 'g1'));
    expect(a.allowedRoots).toEqual([path.join(groupsDir, 'g1')]);
  });

  it('container 模式带 customCwd：customCwd 不生效（仅 host 模式消费该字段）', () => {
    const a = resolveSendFileAnchor({
      groupsDir,
      sourceGroup: 'g1',
      executionMode: 'container',
      customCwd,
    });
    expect(a.workspaceBase).toBe(path.join(groupsDir, 'g1'));
    expect(a.allowedRoots).toEqual([path.join(groupsDir, 'g1')]);
  });
});

describe('isRealPathWithinRoots (CR#2 symlink 物理校验)', () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-ipc-paths-'));
    workspace = path.join(root, 'workspace');
    outside = path.join(root, 'outside');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('工作区内常规文件：通过', () => {
    const f = path.join(workspace, 'report.pdf');
    fs.writeFileSync(f, 'data');
    expect(isRealPathWithinRoots(f, [workspace])).toBe(true);
  });

  it('工作区内 symlink 指向外部文件：拒绝（CR#2 核心回归）', () => {
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'top-secret');
    const link = path.join(workspace, 'evil.txt');
    fs.symlinkSync(secret, link);
    // 词法校验会放行（link 路径在 workspace 内），物理校验必须拒绝
    expect(link.startsWith(workspace + path.sep)).toBe(true);
    expect(isRealPathWithinRoots(link, [workspace])).toBe(false);
  });

  it('工作区内 symlink 目录穿透到外部：拒绝', () => {
    const linkDir = path.join(workspace, 'sub');
    fs.symlinkSync(outside, linkDir);
    const secret = path.join(outside, 'leak.txt');
    fs.writeFileSync(secret, 'leak');
    expect(
      isRealPathWithinRoots(path.join(linkDir, 'leak.txt'), [workspace]),
    ).toBe(false);
  });

  it('工作区内相对 symlink 指向工作区内文件：通过（合法用法不误杀）', () => {
    const real = path.join(workspace, 'real.txt');
    fs.writeFileSync(real, 'ok');
    const link = path.join(workspace, 'alias.txt');
    fs.symlinkSync('real.txt', link);
    expect(isRealPathWithinRoots(link, [workspace])).toBe(true);
  });

  it('根路径自身含 symlink（如 macOS /var → /private/var）：先 realpath 根再比较，不误拒', () => {
    const linkedRoot = path.join(root, 'workspace-link');
    fs.symlinkSync(workspace, linkedRoot);
    const f = path.join(workspace, 'file.txt');
    fs.writeFileSync(f, 'x');
    // 用 symlink 形式的根校验真实文件
    expect(isRealPathWithinRoots(f, [linkedRoot])).toBe(true);
  });

  it('多根（host+customCwd 双根）：downloads 兜底命中默认组目录也通过', () => {
    const custom = path.join(root, 'custom-cwd');
    fs.mkdirSync(custom, { recursive: true });
    const dl = path.join(workspace, 'downloads', 'feishu');
    fs.mkdirSync(dl, { recursive: true });
    const f = path.join(dl, 'doc.docx');
    fs.writeFileSync(f, 'x');
    expect(isRealPathWithinRoots(f, [custom, workspace])).toBe(true);
    // 但两根之外仍拒绝
    const out = path.join(outside, 'o.txt');
    fs.writeFileSync(out, 'x');
    expect(isRealPathWithinRoots(out, [custom, workspace])).toBe(false);
  });

  it('目标不存在 / 悬空 symlink：拒绝', () => {
    expect(
      isRealPathWithinRoots(path.join(workspace, 'missing.txt'), [workspace]),
    ).toBe(false);
    const dangling = path.join(workspace, 'dangling');
    fs.symlinkSync(path.join(outside, 'gone.txt'), dangling);
    expect(isRealPathWithinRoots(dangling, [workspace])).toBe(false);
  });

  it('某个允许根不存在：跳过该根而非误放行/抛错', () => {
    const ghost = path.join(root, 'ghost-root');
    const f = path.join(workspace, 'f.txt');
    fs.writeFileSync(f, 'x');
    expect(isRealPathWithinRoots(f, [ghost, workspace])).toBe(true);
    expect(isRealPathWithinRoots(f, [ghost])).toBe(false);
  });
});
