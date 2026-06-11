/**
 * writeFileAtomic（src/utils.ts，修复轮 2 CR#15 下沉的原子写 helper）测试。
 *
 * 行为网：tmp+rename 原子写；stale-tmp 防御（Node 的 mode 仅 on-create 生效，
 * 残留 tmp 不得让本次写入复用旧 mode）；mode 指定时 rename 后补 chmod。
 * codex-home.provisionAgentsMd 的 AGENTS.md 原子写已改走此 helper
 * （tests/claude-context-resolver.test.ts 的「原子写不残留 .tmp」用例联动覆盖）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { writeFileAtomic } from '../src/utils.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-utils-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  test('写入内容正确且不残留 .tmp 中间文件', () => {
    const target = path.join(tmp, 'out.txt');
    writeFileAtomic(target, 'hello\n');

    expect(fs.readFileSync(target, 'utf8')).toBe('hello\n');
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });

  test('覆盖已有文件：rename 原子替换', () => {
    const target = path.join(tmp, 'out.txt');
    fs.writeFileSync(target, 'old');
    writeFileAtomic(target, 'new');

    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });

  test('stale-tmp 防御：残留宽权限 tmp 不污染本次写入的 mode（指定 mode=0o600）', () => {
    const target = path.join(tmp, 'secret.json');
    // 模拟上次崩溃残留的 0o644 tmp：若直接复用，本次 secret 会落到 0o644
    fs.writeFileSync(`${target}.tmp`, 'stale', { mode: 0o644 });

    writeFileAtomic(target, '{"k":"v"}\n', { mode: 0o600 });

    expect(fs.readFileSync(target, 'utf8')).toBe('{"k":"v"}\n');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });

  test('支持 Buffer 数据', () => {
    const target = path.join(tmp, 'bin.dat');
    const data = Buffer.from([0x00, 0xff, 0x10]);
    writeFileAtomic(target, data);

    expect(fs.readFileSync(target).equals(data)).toBe(true);
  });
});
