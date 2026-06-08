/**
 * tests/rollout-archive.test.ts —— B1 rollout 归档 + trim 单测。
 *
 * 用临时目录造 rollout 样本（含 session_meta + message 条目 + 一个 compacted 边界行），
 * 验证 parseRollout / extractMessages / renderMarkdown / archiveRollout / trimRollout。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRollout,
  extractMessages,
  renderMarkdown,
  archiveRollout,
  trimRollout,
} from '../src/runtime/rollout-archive.js';

// ───────────────────────── rollout 样本构造 ─────────────────────────

const META = JSON.stringify({ type: 'session_meta', payload: { id: 'sess_x', cwd: '/w' } });
function userMsg(text: string): string {
  return JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
}
function asstMsg(text: string): string {
  return JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
}
function compactedBoundary(): string {
  return JSON.stringify({
    type: 'compacted',
    payload: { message: '', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summary' }] }] },
  });
}
function eventMsg(t: string): string {
  return JSON.stringify({ type: 'event_msg', payload: { type: t } });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-rollout-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────── parseRollout ─────────────────────────

describe('parseRollout', () => {
  it('逐行 JSON.parse，跳坏行 / 空行', () => {
    const p = join(dir, 'r.jsonl');
    writeFileSync(p, [META, '', 'NOT JSON {', userMsg('hi'), '   '].join('\n') + '\n', 'utf8');
    const entries = parseRollout(p);
    expect(entries.length).toBe(2); // session_meta + 1 message（坏行/空行被跳）
    expect(entries[0]!.type).toBe('session_meta');
    expect(entries[1]!.type).toBe('response_item');
  });

  it('path 为 null / 不存在 → []（不抛）', () => {
    expect(parseRollout(null)).toEqual([]);
    expect(parseRollout(undefined)).toEqual([]);
    expect(parseRollout(join(dir, 'nope.jsonl'))).toEqual([]);
  });
});

// ───────────────────────── extractMessages / renderMarkdown ─────────────────────────

describe('extractMessages', () => {
  it('只取 response_item message，拼接 content text，丢弃空文本与非 message', () => {
    const entries = parseRollout(writeRollout([META, userMsg('hello'), asstMsg('world'), eventMsg('user_message'), userMsg('   ')]));
    const msgs = extractMessages(entries);
    expect(msgs).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'world' },
    ]);
  });
});

describe('renderMarkdown', () => {
  it('渲染标题 + 角色加粗正文', () => {
    const md = renderMarkdown([
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'a' },
      { role: 'developer', text: 'd' },
    ]);
    expect(md).toContain('# Conversation');
    expect(md).toContain('**User**: q');
    expect(md).toContain('**Assistant**: a');
    expect(md).toContain('**developer**: d');
  });
});

// ───────────────────────── archiveRollout ─────────────────────────

describe('archiveRollout', () => {
  it('写 {base}/{folder}/conversations/{date}-{name}.md，含消息正文', () => {
    const p = writeRollout([META, userMsg('user line'), asstMsg('assistant line')]);
    const out = archiveRollout(p, 'grp', dir);
    expect(out).not.toBeNull();
    expect(existsSync(out!)).toBe(true);
    const md = readFileSync(out!, 'utf8');
    expect(md).toContain('user line');
    expect(md).toContain('assistant line');
    // 路径位于 {dir}/grp/conversations/
    expect(out!.startsWith(join(dir, 'grp', 'conversations'))).toBe(true);
    // 文件名以 YYYY-MM-DD 开头。
    const fname = readdirSync(join(dir, 'grp', 'conversations'))[0]!;
    expect(fname).toMatch(/^\d{4}-\d{2}-\d{2}-.*\.md$/);
  });

  it('无可归档消息 → 不写、返回 null', () => {
    const p = writeRollout([META, eventMsg('user_message')]);
    expect(archiveRollout(p, 'grp', dir)).toBeNull();
    expect(existsSync(join(dir, 'grp'))).toBe(false);
  });

  it('path 为 null → no-op 返回 null', () => {
    expect(archiveRollout(null, 'grp', dir)).toBeNull();
  });

  it('folder 越界（..）→ no-op 返回 null', () => {
    const p = writeRollout([META, userMsg('x')]);
    expect(archiveRollout(p, '../escape', dir)).toBeNull();
  });
});

// ───────────────────────── trimRollout ─────────────────────────

describe('trimRollout', () => {
  it('保留 session_meta + 最后 compacted 边界 + 边界后全部、删边界前（≥阈值时）', () => {
    // 边界前造 60 条 user 消息（> 阈值 50），边界后留 3 条。
    const before = Array.from({ length: 60 }, (_, i) => userMsg(`before-${i}`));
    const after = [asstMsg('post-1'), userMsg('post-2'), asstMsg('post-3')];
    const p = writeRollout([META, ...before, compactedBoundary(), ...after]);

    const trimmed = trimRollout(p);
    expect(trimmed).toBe(true);

    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    // 保留：session_meta(1) + compacted(1) + after(3) = 5 行。
    expect(lines.length).toBe(5);
    expect((JSON.parse(lines[0]!) as { type: string }).type).toBe('session_meta');
    expect((JSON.parse(lines[1]!) as { type: string }).type).toBe('compacted');
    // 边界自包含 replacement_history 原样保留。
    expect(lines[1]!).toContain('replacement_history');
    expect(lines.some((l) => l.includes('before-0'))).toBe(false); // 边界前已删
    expect(lines.some((l) => l.includes('post-3'))).toBe(true); // 边界后保留
  });

  it('边界前条目数 < 阈值 → 跳过（不改文件）', () => {
    const before = Array.from({ length: 5 }, (_, i) => userMsg(`b-${i}`));
    const p = writeRollout([META, ...before, compactedBoundary(), asstMsg('post')]);
    const original = readFileSync(p, 'utf8');

    expect(trimRollout(p)).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe(original); // 未改
  });

  it('无 compacted 边界 → 跳过', () => {
    const before = Array.from({ length: 60 }, (_, i) => userMsg(`b-${i}`));
    const p = writeRollout([META, ...before]);
    const original = readFileSync(p, 'utf8');
    expect(trimRollout(p)).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe(original);
  });

  it('path 为 null / 不存在 → false（不抛）', () => {
    expect(trimRollout(null)).toBe(false);
    expect(trimRollout(join(dir, 'nope.jsonl'))).toBe(false);
  });

  it('多个 compacted 边界 → 保留最后一个（最新摘要）', () => {
    const seg1 = Array.from({ length: 55 }, (_, i) => userMsg(`s1-${i}`));
    const seg2 = Array.from({ length: 55 }, (_, i) => userMsg(`s2-${i}`));
    const p = writeRollout([META, ...seg1, compactedBoundary(), ...seg2, compactedBoundary(), asstMsg('tail')]);

    expect(trimRollout(p)).toBe(true);
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    // 保留 session_meta + 最后 compacted + tail = 3 行（seg1 的 compacted + seg2 全删）。
    expect(lines.length).toBe(3);
    expect(lines.some((l) => l.includes('s2-0'))).toBe(false);
    expect(lines.some((l) => l.includes('tail'))).toBe(true);
  });
});

// ───────────────────────── helper ─────────────────────────

function writeRollout(lines: string[]): string {
  const p = join(dir, `r-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}
