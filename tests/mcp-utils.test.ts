/**
 * mcp-utils 单测 —— loadUserMcpServers 的读取/过滤逻辑（与上游逐字一致的部分）。
 *
 * 覆盖：文件缺失/损坏容错、enabled 过滤、stdio 缺 command / http 缺 url 跳过、
 * env/headers 仅在非空对象时透传。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-mcp-'));

vi.mock('../src/config.js', () => ({
  DATA_DIR: tmpRoot,
}));

const { loadUserMcpServers } = await import('../src/mcp-utils.js');

const USER = 'u1';
const serversFile = path.join(tmpRoot, 'mcp-servers', USER, 'servers.json');

function writeServers(obj: unknown) {
  fs.mkdirSync(path.dirname(serversFile), { recursive: true });
  fs.writeFileSync(
    serversFile,
    typeof obj === 'string' ? obj : JSON.stringify(obj),
  );
}

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'mcp-servers'), {
    recursive: true,
    force: true,
  });
});

describe('loadUserMcpServers', () => {
  test('missing file → empty object', () => {
    expect(loadUserMcpServers(USER)).toEqual({});
  });

  test('malformed JSON → empty object', () => {
    writeServers('{not json');
    expect(loadUserMcpServers(USER)).toEqual({});
  });

  test('filters disabled servers', () => {
    writeServers({
      servers: {
        on: { enabled: true, command: 'mcp-on' },
        off: { enabled: false, command: 'mcp-off' },
      },
    });
    expect(loadUserMcpServers(USER)).toEqual({ on: { command: 'mcp-on' } });
  });

  test('stdio without command and http without url are skipped', () => {
    writeServers({
      servers: {
        noCmd: { enabled: true },
        noUrl: { enabled: true, type: 'http' },
      },
    });
    expect(loadUserMcpServers(USER)).toEqual({});
  });

  test('stdio passes args and non-empty env only', () => {
    writeServers({
      servers: {
        full: {
          enabled: true,
          command: 'npx',
          args: ['-y', 'pkg'],
          env: { K: 'v' },
        },
        emptyEnv: { enabled: true, command: 'npx', env: {} },
      },
    });
    expect(loadUserMcpServers(USER)).toEqual({
      full: { command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } },
      emptyEnv: { command: 'npx' },
    });
  });

  test('http/sse passes type+url and non-empty headers only', () => {
    writeServers({
      servers: {
        h: {
          enabled: true,
          type: 'http',
          url: 'https://a',
          headers: { Authorization: 'Bearer t' },
        },
        s: { enabled: true, type: 'sse', url: 'https://b', headers: {} },
      },
    });
    expect(loadUserMcpServers(USER)).toEqual({
      h: {
        type: 'http',
        url: 'https://a',
        headers: { Authorization: 'Bearer t' },
      },
      s: { type: 'sse', url: 'https://b' },
    });
  });
});
