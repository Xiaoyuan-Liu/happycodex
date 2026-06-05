/**
 * tests/jsonrpc-framing.test.ts —— JSON-RPC 行分帧纯逻辑测试。
 *
 * 不 spawn codex；只测从 src/appserver/client.ts 抽出的 {@link LineFramer} /
 * {@link parseInboundLine}。覆盖：
 *   ① 跨 chunk 半行拼接
 *   ② 一个 chunk 多行
 *   ③ 响应 / 通知 / server 请求三种 inbound 判别（含 error 响应）
 *   ④ 非法 JSON 行容错（不崩、产出 malformed、不影响后续行）
 */

import { describe, expect, it } from 'vitest';

import { AppServerClient, LineFramer, parseInboundLine, type ParsedInbound } from '../src/appserver/client.js';

describe('AppServerClient.onClose —— 返回取消订阅函数（回归 #6）', () => {
  it('onClose 返回 () => void，调用后移除该 handler（不 spawn 进程）', () => {
    const client = new AppServerClient();
    const off = client.onClose(() => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });
});

describe('parseInboundLine —— inbound 判别', () => {
  it('有 id + result → 响应（成功）', () => {
    const r = parseInboundLine(JSON.stringify({ id: 7, result: { userAgent: 'x' } }));
    expect(r.kind).toBe('response');
    if (r.kind === 'response') {
      expect(r.id).toBe(7);
      expect(r.result).toEqual({ userAgent: 'x' });
    }
  });

  it('有 id + error → 响应（失败），保留 code/message/data', () => {
    const r = parseInboundLine(
      JSON.stringify({ id: 'abc', error: { code: -32001, message: 'overloaded', data: { q: 1 } } }),
    );
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.id).toBe('abc');
      expect(r.error.code).toBe(-32001);
      expect(r.error.message).toBe('overloaded');
      expect(r.error.data).toEqual({ q: 1 });
    }
  });

  it('有 method + id → server→client 请求', () => {
    const r = parseInboundLine(
      JSON.stringify({
        id: 42,
        method: 'item/commandExecution/requestApproval',
        params: { foo: 'bar' },
      }),
    );
    expect(r.kind).toBe('serverRequest');
    if (r.kind === 'serverRequest') {
      expect(r.id).toBe(42);
      expect(r.method).toBe('item/commandExecution/requestApproval');
      expect(r.params).toEqual({ foo: 'bar' });
    }
  });

  it('有 method 无 id → 通知', () => {
    const r = parseInboundLine(
      JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'hi' } }),
    );
    expect(r.kind).toBe('notification');
    if (r.kind === 'notification') {
      expect(r.method).toBe('item/agentMessage/delta');
      expect(r.params).toEqual({ delta: 'hi' });
    }
  });

  it('通知可无 params（params=undefined）', () => {
    const r = parseInboundLine(JSON.stringify({ method: 'initialized' }));
    expect(r.kind).toBe('notification');
    if (r.kind === 'notification') {
      expect(r.method).toBe('initialized');
      expect(r.params).toBeUndefined();
    }
  });

  it('容忍线上格式无 jsonrpc 头（已是默认），也容忍带 jsonrpc 头', () => {
    const withHeader = parseInboundLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }),
    );
    expect(withHeader.kind).toBe('response');
    const noHeader = parseInboundLine(JSON.stringify({ id: 1, result: 'ok' }));
    expect(noHeader.kind).toBe('response');
  });

  it('string id 也算响应 / server 请求', () => {
    const resp = parseInboundLine(JSON.stringify({ id: 'req-1', result: null }));
    expect(resp.kind).toBe('response');
    const sreq = parseInboundLine(JSON.stringify({ id: 'req-2', method: 'm', params: 1 }));
    expect(sreq.kind).toBe('serverRequest');
  });

  it('非法 JSON → malformed（不抛）', () => {
    const r = parseInboundLine('{ not valid json');
    expect(r.kind).toBe('malformed');
    if (r.kind === 'malformed') {
      expect(r.raw).toBe('{ not valid json');
      expect(r.cause).toBeDefined();
    }
  });

  it('合法 JSON 但非对象（数组 / 标量）→ malformed', () => {
    expect(parseInboundLine('[1,2,3]').kind).toBe('malformed');
    expect(parseInboundLine('42').kind).toBe('malformed');
    expect(parseInboundLine('"hello"').kind).toBe('malformed');
    expect(parseInboundLine('null').kind).toBe('malformed');
  });

  it('既无 method 又无 result/error 的对象 → malformed', () => {
    expect(parseInboundLine(JSON.stringify({ id: 1 })).kind).toBe('malformed');
    expect(parseInboundLine(JSON.stringify({ foo: 'bar' })).kind).toBe('malformed');
  });
});

describe('LineFramer —— 分帧', () => {
  it('① 跨 chunk 半行拼接：一条 JSON 被切成两段，拼回后整体解析', () => {
    const framer = new LineFramer();
    const full = JSON.stringify({ id: 1, result: { ok: true } });
    const mid = Math.floor(full.length / 2);

    const part1 = framer.push(full.slice(0, mid));
    expect(part1).toHaveLength(0); // 半行无 \n，不产出
    expect(framer.pending.length).toBeGreaterThan(0);

    const part2 = framer.push(full.slice(mid) + '\n');
    expect(part2).toHaveLength(1);
    expect(part2[0]?.kind).toBe('response');
    expect(framer.pending).toBe(''); // \n 后无残留
  });

  it('① 跨多个 chunk 的半行（三段拼一行）', () => {
    const framer = new LineFramer();
    const full = JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'x' } });
    const a = full.slice(0, 10);
    const b = full.slice(10, 25);
    const c = full.slice(25);

    expect(framer.push(a)).toHaveLength(0);
    expect(framer.push(b)).toHaveLength(0);
    const out = framer.push(c + '\n');
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('notification');
  });

  it('② 一个 chunk 含多行：全部产出且顺序保持', () => {
    const framer = new LineFramer();
    const lines = [
      JSON.stringify({ id: 1, result: 'a' }),
      JSON.stringify({ method: 'n1', params: 1 }),
      JSON.stringify({ id: 2, method: 'sr', params: {} }),
    ];
    const out = framer.push(lines.join('\n') + '\n');
    expect(out).toHaveLength(3);
    expect(out.map((o) => o.kind)).toEqual(['response', 'notification', 'serverRequest']);
  });

  it('② 一个 chunk 多行且末行残缺：完整行产出，残缺行留 buffer', () => {
    const framer = new LineFramer();
    const complete = JSON.stringify({ id: 1, result: 'a' });
    const partial = '{"id":2,"resu';
    const out = framer.push(complete + '\n' + partial);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('response');
    expect(framer.pending).toBe(partial);

    // 续上残缺行
    const out2 = framer.push('lt":"b"}\n');
    expect(out2).toHaveLength(1);
    expect(out2[0]?.kind).toBe('response');
    if (out2[0]?.kind === 'response') {
      expect(out2[0].result).toBe('b');
    }
  });

  it('④ 非法 JSON 行容错：产出 malformed，不崩，且不影响同 chunk 的合法行', () => {
    const framer = new LineFramer();
    const out = framer.push('{ broken\n' + JSON.stringify({ id: 9, result: 'ok' }) + '\n');
    expect(out).toHaveLength(2);
    expect(out[0]?.kind).toBe('malformed');
    expect(out[1]?.kind).toBe('response');
  });

  it('④ 空行 / 纯空白行被跳过（不产出 malformed）', () => {
    const framer = new LineFramer();
    const out = framer.push('\n   \n' + JSON.stringify({ method: 'n' }) + '\n\n');
    // 仅一条有效通知，空行全部跳过
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('notification');
  });

  it('CRLF 行尾：trim 后仍能解析（\\r 不破坏 JSON 判别）', () => {
    const framer = new LineFramer();
    const out = framer.push(JSON.stringify({ id: 1, result: 'a' }) + '\r\n');
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('response');
  });

  it('reset() 清空残留 buffer', () => {
    const framer = new LineFramer();
    framer.push('{"id":1,"resu');
    expect(framer.pending.length).toBeGreaterThan(0);
    framer.reset();
    expect(framer.pending).toBe('');
  });

  it('混合长流：多次 push 累计产出顺序正确', () => {
    const framer = new LineFramer();
    const collected: ParsedInbound[] = [];
    collected.push(...framer.push('{"id":1,"result":'));
    collected.push(...framer.push('"x"}\n{"method":"a"}'));
    collected.push(...framer.push('\n{ bad json\n{"id":2,"method":"b","params":{}}\n'));

    expect(collected.map((c) => c.kind)).toEqual([
      'response',
      'notification',
      'malformed',
      'serverRequest',
    ]);
  });
});
