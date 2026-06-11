/**
 * ensureAgentDirectories 回归测试 —— 修复轮 finding #10。
 *
 * 上游每次子代理 spawn 预建 data/sessions/{folder}/agents/{agentId}/.claude/
 * （Claude 会话目录）；codex 侧 per-agent 会话目录是 .codex，由 provisionCodexHome
 * 在 spawn 时创建。本函数只负责 IPC 目录——绝不预建任何 .claude / .codex 目录
 * （后者预建会掩盖 provision 失败）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, test, vi } from 'vitest';

const TMP_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happycodex-ensure-agent-dirs-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: TMP_DATA_DIR };
});

const { ensureAgentDirectories } = await import('../src/utils.js');

describe('ensureAgentDirectories', () => {
  test('创建 IPC input/messages/tasks 三目录并返回 agentIpcDir', () => {
    const agentIpcDir = ensureAgentDirectories('g1', 'agent-1');
    expect(agentIpcDir).toBe(
      path.join(TMP_DATA_DIR, 'ipc', 'g1', 'agents', 'agent-1'),
    );
    for (const sub of ['input', 'messages', 'tasks']) {
      expect(fs.statSync(path.join(agentIpcDir, sub)).isDirectory()).toBe(true);
    }
  });

  test('不再预建 sessions/{folder}/agents/{agentId}/.claude（死目录）', () => {
    ensureAgentDirectories('g2', 'agent-2');
    expect(
      fs.existsSync(
        path.join(TMP_DATA_DIR, 'sessions', 'g2', 'agents', 'agent-2', '.claude'),
      ),
    ).toBe(false);
    // sessions 子树整个不该被本函数触碰（.codex 由 provisionCodexHome 负责）
    expect(fs.existsSync(path.join(TMP_DATA_DIR, 'sessions', 'g2'))).toBe(false);
  });
});
