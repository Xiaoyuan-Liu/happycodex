/**
 * agent-runner 工作区路径解析 + per-folder 工具桥适配测试。
 *
 * 覆盖本阶段引擎侧小改（A1 container-runner 搬迁的引擎适配）：
 *   - resolveWorkspacePaths：HAPPYCLAW_WORKSPACE_IPC/MEMORY（上游名，per-folder 路径）
 *     存在时不再拼 {folder} 层（含 agents/{aid}、tasks-run/{rid} 子空间）；
 *     HAPPYCODEX_*（旧名，root 语义）双读兼容；都缺省时退回 data/ 根。
 *   - FixedFolderToolBridge：把工具调用钉到 env 解析出的 (root, folder)，
 *     ipc 与 memory 各自独立（非 home 群组 memoryFolder=ownerHomeFolder 的上游语义可表达）。
 */
import path from 'path';

import { describe, expect, test } from 'vitest';

import { FixedFolderToolBridge, parseRunnerInput, resolveWorkspacePaths } from '../src/agent-runner.js';
import { FakeToolBridge } from './helpers/fake-tool-bridge.js';

const DATA = '/data-root';

describe('resolveWorkspacePaths', () => {
  test('HAPPYCLAW_WORKSPACE_IPC（per-folder）：input 直挂其下，不再拼 {folder}', () => {
    const ws = resolveWorkspacePaths(
      { HAPPYCLAW_WORKSPACE_IPC: '/d/ipc/home-u1' },
      'home-u1',
      DATA,
    );
    expect(ws.inputDir).toBe('/d/ipc/home-u1/input');
    // bridge (root, folder) 还原出同一 per-folder 目录
    expect(path.join(ws.bridgeIpcRoot, ws.bridgeIpcFolder)).toBe('/d/ipc/home-u1');
    expect(ws.bridgeIpcFolder).toBe('home-u1');
  });

  test('agents/{aid} 子空间：basename 即最终 namespace（≠ groupFolder）', () => {
    const ws = resolveWorkspacePaths(
      { HAPPYCLAW_WORKSPACE_IPC: '/d/ipc/home-u1/agents/a1' },
      'home-u1',
      DATA,
    );
    expect(ws.inputDir).toBe('/d/ipc/home-u1/agents/a1/input');
    expect(ws.bridgeIpcRoot).toBe('/d/ipc/home-u1/agents');
    expect(ws.bridgeIpcFolder).toBe('a1');
  });

  test('容器固定挂载点 /workspace/ipc 同样成立', () => {
    const ws = resolveWorkspacePaths(
      { HAPPYCLAW_WORKSPACE_IPC: '/workspace/ipc', HAPPYCLAW_WORKSPACE_MEMORY: '/workspace/memory' },
      'home-u1',
      DATA,
    );
    expect(ws.inputDir).toBe('/workspace/ipc/input');
    expect(path.join(ws.bridgeIpcRoot, ws.bridgeIpcFolder)).toBe('/workspace/ipc');
    expect(path.join(ws.bridgeMemoryRoot, ws.bridgeMemoryFolder)).toBe('/workspace/memory');
  });

  test('HAPPYCLAW_WORKSPACE_MEMORY（per-folder）：memoryFolder 可 ≠ groupFolder（owner home 共享）', () => {
    const ws = resolveWorkspacePaths(
      { HAPPYCLAW_WORKSPACE_MEMORY: '/d/memory/home-owner' },
      'sub-group',
      DATA,
    );
    expect(ws.bridgeMemoryRoot).toBe('/d/memory');
    expect(ws.bridgeMemoryFolder).toBe('home-owner');
  });

  test('HAPPYCODEX_*（旧名）双读兼容：root 语义，folder 由 groupFolder 拼接', () => {
    const ws = resolveWorkspacePaths(
      { HAPPYCODEX_WORKSPACE_IPC: '/legacy/ipc', HAPPYCODEX_WORKSPACE_MEMORY: '/legacy/mem' },
      'f1',
      DATA,
    );
    expect(ws.inputDir).toBe('/legacy/ipc/f1/input');
    expect(ws.bridgeIpcRoot).toBe('/legacy/ipc');
    expect(ws.bridgeIpcFolder).toBe('f1');
    expect(ws.bridgeMemoryRoot).toBe('/legacy/mem');
    expect(ws.bridgeMemoryFolder).toBe('f1');
  });

  test('上游名优先于旧名（两者并存时按 per-folder 语义）', () => {
    const ws = resolveWorkspacePaths(
      {
        HAPPYCLAW_WORKSPACE_IPC: '/d/ipc/f1',
        HAPPYCODEX_WORKSPACE_IPC: '/legacy/ipc',
      },
      'f1',
      DATA,
    );
    expect(ws.inputDir).toBe('/d/ipc/f1/input');
    expect(ws.bridgeIpcRoot).toBe('/d/ipc');
  });

  test('全部缺省：退回 {dataDir}/ipc、{dataDir}/memory 根语义', () => {
    const ws = resolveWorkspacePaths({}, 'f2', DATA);
    expect(ws.inputDir).toBe(path.join(DATA, 'ipc', 'f2', 'input'));
    expect(ws.bridgeIpcRoot).toBe(path.join(DATA, 'ipc'));
    expect(ws.bridgeIpcFolder).toBe('f2');
    expect(ws.bridgeMemoryRoot).toBe(path.join(DATA, 'memory'));
    expect(ws.bridgeMemoryFolder).toBe('f2');
  });

  test('A4 workspaceGroupDir：HAPPYCLAW_WORKSPACE_GROUP（per-folder）直用；root 语义/缺省回退', () => {
    // 上游名（per-folder）：直接使用，不拼 {folder}。
    const a = resolveWorkspacePaths({ HAPPYCLAW_WORKSPACE_GROUP: '/workspace/group' }, 'f1', DATA);
    expect(a.workspaceGroupDir).toBe('/workspace/group');
    // 旧名（root 语义）：拼 {folder}。
    const b = resolveWorkspacePaths({ HAPPYCODEX_WORKSPACE_GROUP: '/legacy/groups' }, 'f1', DATA);
    expect(b.workspaceGroupDir).toBe(path.join('/legacy/groups', 'f1'));
    // 全缺省：{dataDir}/groups/{folder}（对齐主进程 GROUPS_DIR 布局）。
    const c = resolveWorkspacePaths({}, 'f1', DATA);
    expect(c.workspaceGroupDir).toBe(path.join(DATA, 'groups', 'f1'));
  });
});

describe('FixedFolderToolBridge', () => {
  test('ipc 类调用钉到 ipcFolder（忽略调用方 folder）', async () => {
    const fake = new FakeToolBridge();
    const bridge = new FixedFolderToolBridge(fake, 'pinned-ipc', 'pinned-mem');

    await bridge.sendMessage('caller-folder', 'hello');
    await bridge.scheduleTask('caller-folder', {
      name: 'n',
      prompt: 'p',
      schedule: { kind: 'once', at: 'now' },
    });
    await bridge.pauseTask('caller-folder', 't1');
    await bridge.registerGroup('caller-folder', 'jid@x', 'Name');

    for (const call of fake.calls) {
      expect(call.args[0]).toBe('pinned-ipc');
    }
    expect(fake.opNames()).toEqual([
      'sendMessage',
      'scheduleTask',
      'pauseTask',
      'registerGroup',
    ]);
    // 业务参数原样透传
    expect(fake.calls[0]?.args[1]).toBe('hello');
    expect(fake.calls[3]?.args.slice(1)).toEqual(['jid@x', 'Name']);
  });

  test('A4 新工具调用钉到 ipcFolder（send_image/send_file/discord_*）', async () => {
    const fake = new FakeToolBridge();
    const bridge = new FixedFolderToolBridge(fake, 'pinned-ipc', 'pinned-mem');

    await bridge.sendImage('caller-folder', 'chart.png', 'cap');
    await bridge.sendFile('caller-folder', 'a.pdf', 'a.pdf');
    await bridge.discordGetHistory('caller-folder', { limit: 10 });
    await bridge.discordGetChannelInfo('caller-folder');
    await bridge.discordGetServerInfo('caller-folder');

    for (const call of fake.calls) {
      expect(call.args[0]).toBe('pinned-ipc');
    }
    expect(fake.opNames()).toEqual([
      'sendImage',
      'sendFile',
      'discordGetHistory',
      'discordGetChannelInfo',
      'discordGetServerInfo',
    ]);
    // 业务参数原样透传
    expect(fake.calls[0]?.args.slice(1)).toEqual(['chart.png', 'cap']);
    expect(fake.calls[2]?.args[1]).toEqual({ limit: 10 });
  });

  test('memory 类调用钉到 memoryFolder（与 ipcFolder 独立）', async () => {
    const fake = new FakeToolBridge();
    const bridge = new FixedFolderToolBridge(fake, 'pinned-ipc', 'pinned-mem');

    await bridge.memoryAppend('caller-folder', 'content', 'scope1');
    await bridge.memorySearch('caller-folder', 'query');
    await bridge.memoryGet('caller-folder', 'notes.md');

    for (const call of fake.calls) {
      expect(call.args[0]).toBe('pinned-mem');
    }
    expect(fake.opNames()).toEqual(['memoryAppend', 'memorySearch', 'memoryGet']);
  });

  test('canned 返回值原样穿透', async () => {
    const fake = new FakeToolBridge();
    fake.memoryValue = 'the-memo';
    const bridge = new FixedFolderToolBridge(fake, 'i', 'm');
    expect(await bridge.memoryGet('x', 'a.md')).toBe('the-memo');
    const { taskId } = await bridge.scheduleTask('x', {
      name: 'n',
      prompt: 'p',
      schedule: { kind: 'once', at: 'now' },
    });
    expect(taskId).toBe(fake.nextTaskId);
  });
});

describe('parseRunnerInput — IPC 工具路由上下文（ContainerInput.chatJid 等）', () => {
  test('chatJid / isScheduledTask / messageTaskId 透传（IpcToolBridge 路由来源）', () => {
    const input = parseRunnerInput(
      JSON.stringify({
        prompt: 'hi',
        groupFolder: 'g1',
        chatJid: 'web:g1',
        isScheduledTask: true,
        messageTaskId: 'task-9',
      }),
    );
    expect(input.chatJid).toBe('web:g1');
    expect(input.isScheduledTask).toBe(true);
    expect(input.messageTaskId).toBe('task-9');
  });

  test('缺省/非法时不产字段（空串 chatJid 视为缺失；isScheduledTask 仅接受 true）', () => {
    const input = parseRunnerInput(
      JSON.stringify({ prompt: 'hi', groupFolder: 'g1', chatJid: '', isScheduledTask: 'yes' }),
    );
    expect(input.chatJid).toBeUndefined();
    expect(input.isScheduledTask).toBeUndefined();
    expect(input.messageTaskId).toBeUndefined();
  });

  test('A4：currentSourceJid / isAdminHome 透传（per-channel 工具与 list_tasks stamp 来源）', () => {
    const input = parseRunnerInput(
      JSON.stringify({
        prompt: 'hi',
        groupFolder: 'main',
        chatJid: 'web:main',
        currentSourceJid: 'discord:123456789012345678',
        isAdminHome: true,
      }),
    );
    expect(input.currentSourceJid).toBe('discord:123456789012345678');
    expect(input.isAdminHome).toBe(true);
    // 非法值不产字段
    const bad = parseRunnerInput(
      JSON.stringify({ prompt: 'hi', groupFolder: 'g', currentSourceJid: '', isAdminHome: 'yes' }),
    );
    expect(bad.currentSourceJid).toBeUndefined();
    expect(bad.isAdminHome).toBeUndefined();
  });

  test('A4：images 宽松解析（仅收 data 非空字符串的条目；mimeType 非串丢弃）', () => {
    const input = parseRunnerInput(
      JSON.stringify({
        prompt: 'look',
        groupFolder: 'g1',
        images: [
          { data: 'b64-a', mimeType: 'image/png' },
          { data: 'b64-b', mimeType: 123 },
          { data: '' },
          { mimeType: 'image/png' },
          'garbage',
          null,
        ],
      }),
    );
    expect(input.images).toEqual([{ data: 'b64-a', mimeType: 'image/png' }, { data: 'b64-b' }]);
    // images 非数组 / 全部非法 → 不产字段
    const none = parseRunnerInput(
      JSON.stringify({ prompt: 'x', groupFolder: 'g1', images: [{ data: '' }] }),
    );
    expect(none.images).toBeUndefined();
    const notArr = parseRunnerInput(
      JSON.stringify({ prompt: 'x', groupFolder: 'g1', images: 'nope' }),
    );
    expect(notArr.images).toBeUndefined();
  });
});
