/**
 * clearSessionFiles（codex 版）单测 —— 骨架移植自上游 tests/session-files.test.ts，
 * 断言面换成 codex 等价物：
 *   - 上游清 `.claude/` 保留 settings.json → 这里清 `.codex/` 保留
 *     auth.json / config.toml / agents/ / hooks.json；
 *   - 新增：删 SessionStore（data/sessions/index.json）的 folder→threadId 映射
 *     （sub-agent 用 `{folder}/agents/{agentId}` 复合键，不误伤主会话映射）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-session-'));

vi.mock('../src/config.js', () => ({
  DATA_DIR: tmpRoot,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER the mocks are registered so session-files picks up the mocked
// DATA_DIR at evaluation time.
const { clearSessionFiles } = await import('../src/session-files.js');

const INDEX_FILE = path.join(tmpRoot, 'sessions', 'index.json');

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'sessions'), { recursive: true, force: true });
});

afterEach(() => {
  // no-op; tmpRoot kept for whole suite, subdirs scrubbed per-test
});

function touch(filePath: string, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeIndex(map: Record<string, string>) {
  touch(INDEX_FILE, JSON.stringify(map));
}

function readIndex(): Record<string, string> {
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
}

describe('clearSessionFiles', () => {
  test('removes everything under .codex/ except auth.json/config.toml/agents/hooks.json', () => {
    const folder = 'main';
    const codexDir = path.join(tmpRoot, 'sessions', folder, '.codex');
    touch(path.join(codexDir, 'auth.json'), '{"keep":true}');
    touch(path.join(codexDir, 'config.toml'), 'model = "o3"');
    touch(path.join(codexDir, 'agents', 'code-reviewer.toml'), 'kept');
    touch(path.join(codexDir, 'hooks.json'), '{}');
    touch(
      path.join(codexDir, 'sessions', '2026', '06', '10', 'rollout-x.jsonl'),
      'line',
    );
    touch(path.join(codexDir, 'history.jsonl'), 'h');
    touch(path.join(codexDir, 'log', 'codex.log'), 'debug');

    clearSessionFiles(folder);

    expect(fs.existsSync(path.join(codexDir, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(codexDir, 'config.toml'))).toBe(true);
    expect(
      fs.existsSync(path.join(codexDir, 'agents', 'code-reviewer.toml')),
    ).toBe(true);
    expect(fs.existsSync(path.join(codexDir, 'hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(codexDir, 'sessions'))).toBe(false);
    expect(fs.existsSync(path.join(codexDir, 'history.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(codexDir, 'log'))).toBe(false);
  });

  test('agent-scoped clear only affects the given agent subdir', () => {
    const folder = 'main';
    const agentId = 'agent-xyz';
    const mainDir = path.join(tmpRoot, 'sessions', folder, '.codex');
    const agentDir = path.join(
      tmpRoot,
      'sessions',
      folder,
      'agents',
      agentId,
      '.codex',
    );
    touch(path.join(mainDir, 'sessions', '2026', 'rollout-p.jsonl'));
    touch(path.join(agentDir, 'sessions', '2026', 'rollout-a.jsonl'));
    touch(path.join(agentDir, 'auth.json'), '{}');

    clearSessionFiles(folder, agentId);

    expect(
      fs.existsSync(path.join(mainDir, 'sessions', '2026', 'rollout-p.jsonl')),
    ).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'sessions'))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, 'auth.json'))).toBe(true);
  });

  test('no-op when .codex dir does not exist (and does not create index.json)', () => {
    expect(() => clearSessionFiles('never-created')).not.toThrow();
    // 映射不存在时不应顺手把 index.json 写出来。
    expect(fs.existsSync(INDEX_FILE)).toBe(false);
  });

  test('survives a broken symlink inside .codex/', () => {
    const folder = 'main';
    const codexDir = path.join(tmpRoot, 'sessions', folder, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    touch(path.join(codexDir, 'auth.json'));
    fs.symlinkSync(
      '/nonexistent/path/to/nowhere',
      path.join(codexDir, 'stale-link'),
    );

    // Core guarantee: the per-entry try/catch means a problematic symlink
    // does NOT abort the whole reset — auth.json must survive regardless
    // of whether the symlink itself is cleanable on the current platform.
    expect(() => clearSessionFiles(folder)).not.toThrow();
    expect(fs.existsSync(path.join(codexDir, 'auth.json'))).toBe(true);
  });

  test('deletes the folder→threadId mapping from the session store', () => {
    writeIndex({ main: 'thread-1', other: 'thread-2' });

    clearSessionFiles('main');

    expect(readIndex()).toEqual({ other: 'thread-2' });
  });

  test('agent-scoped clear deletes only the composite agent key', () => {
    writeIndex({
      main: 'thread-main',
      [path.join('main', 'agents', 'agent-xyz')]: 'thread-agent',
    });

    clearSessionFiles('main', 'agent-xyz');

    expect(readIndex()).toEqual({ main: 'thread-main' });
  });
});
