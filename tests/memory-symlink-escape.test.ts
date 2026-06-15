/**
 * tests/memory-symlink-escape.test.ts —— issue #2 P1：记忆 API 符号链接逃逸防护（端到端）。
 *
 * 词法路径校验不防 symlink；agent 在容器内 bind-mount 的工作区（data/groups/{folder}）植入
 * 符号链接，host 侧 memory API 的 read/write/rename/stat 跟随即逃逸。本测试直接 exercise 真实
 * sink（readMemoryFile / writeMemoryFile / listMemorySources），覆盖对抗 review 暴露的四类逃逸：
 *   1) host 逃逸：叶/祖先 symlink 指向允许 root 外 → 读写拒绝；
 *   2) 跨租户逃逸：folderA/link -> folderB（仍在 GROUPS_DIR 内）→ 归属判定基于真实 folder 而拒绝；
 *   3) .tmp 兄弟预放 symlink → 安全写不跟随，宿主目标不被改写；
 *   4) list 经 symlinked CLAUDE.md 泄露宿主/他人文件 size/mtime → lstat 跳过不泄露。
 * （helper-isolation 测试是假信心——会随 wiring 被删而仍绿；故这里走集成路径。）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// config.js：DATA_DIR/GROUPS_DIR 落到一个稳定 tmp 根（realpath 化，规避 macOS /tmp symlink）。
vi.mock('../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/config.js')>();
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const root = fsm.realpathSync(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'hcx-mem-')));
  return {
    ...orig,
    DATA_DIR: pathm.join(root, 'data'),
    STORE_DIR: pathm.join(root, 'data', 'db'),
    GROUPS_DIR: pathm.join(root, 'data', 'groups'),
  };
});

// db.js：bob 拥有 folder 'bob'，alice 拥有 'alice'（isUserOwnedFolder / listMemorySources 用）。
vi.mock('../src/db.js', () => ({
  getAllRegisteredGroups: () => ({
    g1: { folder: 'bob', created_by: 'bob', name: 'bob', added_at: '' },
    g2: { folder: 'alice', created_by: 'alice', name: 'alice', added_at: '' },
  }),
  getUserById: () => undefined,
}));

const { readMemoryFile, writeMemoryFile, listMemorySources, resolveRealMemoryPath, walkFiles } =
  await import('../src/routes/memory.js');
const { GROUPS_DIR, DATA_DIR } = await import('../src/config.js');

const ADMIN = { id: 'admin-1', role: 'admin' as const, username: 'a', display_name: 'A' } as never;
const BOB = { id: 'bob', role: 'member' as const, username: 'bob', display_name: 'Bob' } as never;

const ROOT = path.dirname(DATA_DIR); // chdir 目标：relativePath='data/...' 需相对此根解析
let prevCwd: string;
let outside: string;

beforeEach(() => {
  prevCwd = process.cwd();
  fs.mkdirSync(path.join(GROUPS_DIR, 'bob'), { recursive: true });
  fs.mkdirSync(path.join(GROUPS_DIR, 'alice'), { recursive: true });
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcx-host-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'HOST SECRET 0123456789');
  process.chdir(ROOT);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(GROUPS_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'memory'), { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('memory API 符号链接逃逸防护（issue #2 P1，端到端）', () => {
  test('正常读写 roundtrip（无 symlink）→ 成功', () => {
    writeMemoryFile('data/groups/bob/notes.md', 'hello', ADMIN);
    expect(readMemoryFile('data/groups/bob/notes.md', ADMIN).content).toBe('hello');
  });

  test('① host 逃逸：叶 symlink 指向 root 外 → 读拒绝', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(GROUPS_DIR, 'bob', 'evil.md'));
    expect(() => readMemoryFile('data/groups/bob/evil.md', ADMIN)).toThrow(/out of allowed scope/);
  });

  test('① host 逃逸：祖先 symlink 指向 root 外 → 读拒绝', () => {
    fs.symlinkSync(outside, path.join(GROUPS_DIR, 'bob', 'evildir'));
    fs.writeFileSync(path.join(outside, 'x.md'), 'leak');
    expect(() => readMemoryFile('data/groups/bob/evildir/x.md', ADMIN)).toThrow(/out of allowed scope/);
  });

  test('③ .tmp 兄弟预放 symlink → 安全写不跟随：宿主目标不被改写，内容落到真实文件', () => {
    const hostTarget = path.join(outside, 'secret.txt');
    // agent 预放：notes.md.tmp -> 宿主机文件（后缀确定，无需竞态）。
    fs.symlinkSync(hostTarget, path.join(GROUPS_DIR, 'bob', 'notes.md.tmp'));
    // O_NOFOLLOW 拒绝预放的 .tmp symlink → 清除后用全新 regular tmp 安全完成写入。
    writeMemoryFile('data/groups/bob/notes.md', 'MALICIOUS', ADMIN);
    expect(fs.readFileSync(hostTarget, 'utf-8')).toBe('HOST SECRET 0123456789'); // 宿主未被写穿
    expect(readMemoryFile('data/groups/bob/notes.md', ADMIN).content).toBe('MALICIOUS'); // 落到真实文件
    expect(fs.lstatSync(path.join(GROUPS_DIR, 'bob', 'notes.md')).isSymbolicLink()).toBe(false);
  });

  test('③b 残留普通 .tmp（上次写入崩溃遗留）→ 本次写入自愈成功（不再 EEXIST 失败）', () => {
    fs.writeFileSync(path.join(GROUPS_DIR, 'bob', 'note.md.tmp'), 'STALE'); // 残留普通文件
    writeMemoryFile('data/groups/bob/note.md', 'fresh', ADMIN);
    expect(readMemoryFile('data/groups/bob/note.md', ADMIN).content).toBe('fresh');
  });

  test('② 跨租户：bob 经 folderA/link -> alice 写 → 归属判定（真实 folder=alice）拒绝', () => {
    fs.symlinkSync(path.join(GROUPS_DIR, 'alice'), path.join(GROUPS_DIR, 'bob', 'link'));
    expect(() => writeMemoryFile('data/groups/bob/link/secret.md', 'x', BOB)).toThrow(/out of allowed scope/);
    expect(fs.existsSync(path.join(GROUPS_DIR, 'alice', 'secret.md'))).toBe(false); // 未写入他人 folder
  });

  test('② 跨租户：bob 经 folderA/link -> alice 读他人文件 → 拒绝', () => {
    fs.symlinkSync(path.join(GROUPS_DIR, 'alice'), path.join(GROUPS_DIR, 'bob', 'link'));
    fs.writeFileSync(path.join(GROUPS_DIR, 'alice', 'private.md'), 'ALICE PRIVATE');
    expect(() => readMemoryFile('data/groups/bob/link/private.md', BOB)).toThrow(/out of allowed scope/);
  });

  test('④ list：bob/CLAUDE.md 为 symlink 指向宿主文件 → /sources 不泄露其 size/mtime', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(GROUPS_DIR, 'bob', 'CLAUDE.md'));
    const leakedSize = fs.statSync(path.join(outside, 'secret.txt')).size; // 跟随后的真实大小
    const sources = listMemorySources(BOB);
    const claude = sources.find((s) => s.path === 'data/groups/bob/CLAUDE.md');
    // 符号链接条目被丢弃（既不暴露 exists，也不暴露宿主 size）。
    if (claude) {
      expect(claude.exists).toBe(false);
      expect(claude.size).not.toBe(leakedSize);
    } else {
      expect(claude).toBeUndefined();
    }
    // 无论如何，结果里不得出现泄露的宿主文件大小。
    expect(sources.some((s) => s.size === leakedSize && leakedSize > 0)).toBe(false);
  });
});

describe('resolveRealMemoryPath / walkFiles 单元（issue #2）', () => {
  let root: string;
  let out: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcx-rr-')));
    out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcx-rr-out-')));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('叶 symlink → 解析到真实目标（落 root 外，供调用方据此拒绝）', () => {
    fs.writeFileSync(path.join(out, 'secret'), 's');
    fs.symlinkSync(path.join(out, 'secret'), path.join(root, 'evil'));
    expect(resolveRealMemoryPath(path.join(root, 'evil'))).toBe(path.join(out, 'secret'));
  });

  test('祖先 symlink + 不存在末级 → 真实祖先 + 拼回后缀', () => {
    fs.symlinkSync(out, path.join(root, 'evildir'));
    expect(resolveRealMemoryPath(path.join(root, 'evildir', 'new.md'))).toBe(path.join(out, 'new.md'));
  });

  test('合法已存在路径 → 恒等', () => {
    fs.writeFileSync(path.join(root, 'real.md'), 'a');
    expect(resolveRealMemoryPath(path.join(root, 'real.md'))).toBe(path.join(root, 'real.md'));
  });

  test('walkFiles 跳过 symlink 文件与 symlink 目录', () => {
    fs.writeFileSync(path.join(root, 'real.md'), 'a');
    fs.symlinkSync(path.join(out, 'x'), path.join(root, 'evil.md'));
    fs.symlinkSync(out, path.join(root, 'evildir'));
    const acc: string[] = [];
    walkFiles(root, 4, 500, acc);
    expect(acc.map((p) => path.basename(p))).toEqual(['real.md']);
  });
});
