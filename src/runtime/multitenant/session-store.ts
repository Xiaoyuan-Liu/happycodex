/**
 * SessionStore —— folder → threadId 的 JSON 文件持久化（对应 HappyClaw sessions 表）。
 *
 * 设计取舍：
 * - 全同步 node:fs（readFileSync/writeFileSync/renameSync/mkdirSync）。store 操作很轻，
 *   同步实现避免异步交错带来的写-写竞态，调用方无需 await。
 * - 原子持久化：先写 `<filePath>.tmp` 再 renameSync 覆盖 filePath（rename 在同一文件系统上原子），
 *   崩溃时不会留下半写的 filePath。
 * - 构造时容错加载：文件缺失或 JSON 损坏都退化为空 Map，绝不抛——避免一条坏记录拖垮整个进程启动。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import type { ISessionStore } from './types.js';

export class SessionStore implements ISessionStore {
  private readonly filePath: string;
  private readonly map: Map<string, string>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.map = new Map();
    this.load();
  }

  getThreadId(folder: string): string | null {
    return this.map.get(folder) ?? null;
  }

  setThreadId(folder: string, threadId: string): void {
    this.map.set(folder, threadId);
    this.persist();
  }

  deleteThreadId(folder: string): void {
    this.map.delete(folder);
    this.persist();
  }

  all(): Record<string, string> {
    // 浅拷贝快照：调用方修改返回对象不影响内部状态。
    return Object.fromEntries(this.map);
  }

  /** 构造时从磁盘加载。文件不存在 / JSON 损坏 / 非对象 → 静默退化为空 Map，绝不抛。 */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      // 文件不存在或不可读 → 空 Map。
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 损坏的 JSON → 空 Map。
      return;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }

    for (const [folder, threadId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof threadId === 'string') {
        this.map.set(folder, threadId);
      }
    }
  }

  /** 原子持久化：mkdir -p 父目录 → 写 .tmp → renameSync 覆盖。 */
  private persist(): void {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    const json = JSON.stringify(Object.fromEntries(this.map), null, 2);
    writeFileSync(tmpPath, json, 'utf8');
    renameSync(tmpPath, this.filePath);
  }
}
