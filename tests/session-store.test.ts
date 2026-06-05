/**
 * SessionStore 单测 —— 用 os.tmpdir() 下唯一临时目录验证：
 *   - set 后 get 命中
 *   - 持久化：新建 SessionStore 指向同文件能读回
 *   - delete 后 get null 且持久化生效
 *   - all() 返回快照，不被后续 set 影响（拷贝）
 *   - 损坏 JSON → 构造不抛且当空 Map
 *   - 文件不存在 → 空 Map
 *   - 原子写：set 后无 .tmp 残留
 *
 * 每个用例独立临时目录，afterEach 清理，互不干扰。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionStore } from '../src/runtime/multitenant/session-store.js';

let root: string;
let filePath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'happycodex-sessionstore-'));
  filePath = path.join(root, 'sub', 'sessions.json');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('set 后 get 命中', () => {
    const store = new SessionStore(filePath);
    expect(store.getThreadId('home-1')).toBeNull();

    store.setThreadId('home-1', 'thread-abc');
    expect(store.getThreadId('home-1')).toBe('thread-abc');
  });

  it('未命中返回 null', () => {
    const store = new SessionStore(filePath);
    expect(store.getThreadId('does-not-exist')).toBeNull();
  });

  it('持久化：新建 SessionStore 指向同文件能读回', () => {
    const a = new SessionStore(filePath);
    a.setThreadId('home-1', 'thread-abc');
    a.setThreadId('home-2', 'thread-def');

    const b = new SessionStore(filePath);
    expect(b.getThreadId('home-1')).toBe('thread-abc');
    expect(b.getThreadId('home-2')).toBe('thread-def');
    expect(b.all()).toEqual({ 'home-1': 'thread-abc', 'home-2': 'thread-def' });
  });

  it('set 覆盖同一 folder 的旧 threadId', () => {
    const store = new SessionStore(filePath);
    store.setThreadId('home-1', 'old');
    store.setThreadId('home-1', 'new');
    expect(store.getThreadId('home-1')).toBe('new');

    const reopened = new SessionStore(filePath);
    expect(reopened.getThreadId('home-1')).toBe('new');
  });

  it('delete 后 get null 且持久化', () => {
    const a = new SessionStore(filePath);
    a.setThreadId('home-1', 'thread-abc');
    a.setThreadId('home-2', 'thread-def');

    a.deleteThreadId('home-1');
    expect(a.getThreadId('home-1')).toBeNull();
    expect(a.getThreadId('home-2')).toBe('thread-def');

    // 持久化验证：重新打开后 home-1 仍然消失。
    const b = new SessionStore(filePath);
    expect(b.getThreadId('home-1')).toBeNull();
    expect(b.getThreadId('home-2')).toBe('thread-def');
  });

  it('delete 不存在的 folder 不抛', () => {
    const store = new SessionStore(filePath);
    expect(() => store.deleteThreadId('ghost')).not.toThrow();
  });

  it('all() 返回快照，不被后续 set 影响（拷贝）', () => {
    const store = new SessionStore(filePath);
    store.setThreadId('home-1', 'thread-abc');

    const snapshot = store.all();
    expect(snapshot).toEqual({ 'home-1': 'thread-abc' });

    // 后续 set 不应改变已取出的快照。
    store.setThreadId('home-2', 'thread-def');
    expect(snapshot).toEqual({ 'home-1': 'thread-abc' });

    // 修改快照不应回写内部状态。
    snapshot['home-1'] = 'mutated';
    expect(store.getThreadId('home-1')).toBe('thread-abc');
  });

  it('损坏 JSON 文件 → 构造不抛且当空 Map', () => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{ this is not valid json ::::', 'utf8');

    let store!: SessionStore;
    expect(() => {
      store = new SessionStore(filePath);
    }).not.toThrow();
    expect(store.all()).toEqual({});
    expect(store.getThreadId('home-1')).toBeNull();

    // 损坏后仍可正常 set / 持久化覆盖。
    store.setThreadId('home-1', 'recovered');
    const reopened = new SessionStore(filePath);
    expect(reopened.getThreadId('home-1')).toBe('recovered');
  });

  it('非对象 JSON（数组/标量）→ 当空 Map', () => {
    mkdirSync(path.dirname(filePath), { recursive: true });

    writeFileSync(filePath, '["a","b"]', 'utf8');
    expect(new SessionStore(filePath).all()).toEqual({});

    writeFileSync(filePath, '42', 'utf8');
    expect(new SessionStore(filePath).all()).toEqual({});

    writeFileSync(filePath, 'null', 'utf8');
    expect(new SessionStore(filePath).all()).toEqual({});
  });

  it('文件不存在 → 空 Map', () => {
    const store = new SessionStore(filePath);
    expect(existsSync(filePath)).toBe(false);
    expect(store.all()).toEqual({});
    expect(store.getThreadId('anything')).toBeNull();
  });

  it('原子写：set 后无 .tmp 残留', () => {
    const store = new SessionStore(filePath);
    store.setThreadId('home-1', 'thread-abc');
    store.setThreadId('home-2', 'thread-def');
    store.deleteThreadId('home-1');

    const dir = path.dirname(filePath);
    const entries = readdirSync(dir);
    const leftovers = entries.filter((e) => e.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    // 真实文件应存在。
    expect(existsSync(filePath)).toBe(true);
  });

  it('persist 自动创建缺失的父目录', () => {
    // filePath 在 root/sub/ 下，sub 尚不存在。
    expect(existsSync(path.dirname(filePath))).toBe(false);
    const store = new SessionStore(filePath);
    store.setThreadId('home-1', 'thread-abc');
    expect(existsSync(filePath)).toBe(true);
  });
});
