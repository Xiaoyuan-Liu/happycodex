/**
 * mcp-toml 单测 —— JSON MCP server 配置 → codex config.toml [mcp_servers.*] 渲染器。
 *
 * 覆盖：stdio/http 两类形状、headers→http_headers 改名、type/enabled 不落盘、
 * TOML 标量先于子表、键/字符串转义、mergeMcpServersIntoToml 幂等合并。
 */
import { describe, expect, it } from 'vitest';

import {
  mcpServerSectionHeader,
  mergeMcpServersIntoToml,
  renderMcpServerSection,
  renderMcpServersToml,
  tomlString,
} from '../src/runtime/multitenant/mcp-toml.js';

describe('renderMcpServerSection — stdio 形状', () => {
  it('command/args 标量行在前，env 子表在后', () => {
    const out = renderMcpServerSection('files', {
      command: 'npx',
      args: ['-y', 'mcp-files'],
      env: { API_KEY: 'k1', DEBUG: 'true' },
    });
    expect(out).toBe(
      '[mcp_servers.files]\n' +
        'command = "npx"\n' +
        'args = ["-y", "mcp-files"]\n' +
        '\n' +
        '[mcp_servers.files.env]\n' +
        'API_KEY = "k1"\n' +
        'DEBUG = "true"\n',
    );
  });

  it('无 env 时只有标量段', () => {
    const out = renderMcpServerSection('solo', { command: 'mcp-solo' });
    expect(out).toBe('[mcp_servers.solo]\ncommand = "mcp-solo"\n');
  });
});

describe('renderMcpServerSection — http 形状', () => {
  it('type 不落盘、url 保留、headers 改名 http_headers 子表', () => {
    const out = renderMcpServerSection('remote', {
      type: 'http',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer x' },
    });
    expect(out).toContain('[mcp_servers.remote]\nurl = "https://mcp.example.com/sse"');
    expect(out).toContain('[mcp_servers.remote.http_headers]\nAuthorization = "Bearer x"');
    expect(out).not.toContain('type =');
  });
});

describe('转义与键引号', () => {
  it('名字含非 bare-key 字符时段头加引号', () => {
    expect(mcpServerSectionHeader('my server')).toBe('[mcp_servers."my server"]');
    expect(mcpServerSectionHeader('ok-name_1')).toBe('[mcp_servers.ok-name_1]');
  });

  it('字符串值转义反斜杠/双引号/换行', () => {
    expect(tomlString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    const out = renderMcpServerSection('esc', { command: 'C:\\bin\\mcp "x"' });
    expect(out).toContain('command = "C:\\\\bin\\\\mcp \\"x\\""');
  });
});

describe('renderMcpServersToml', () => {
  it('空集合返回空串', () => {
    expect(renderMcpServersToml({})).toBe('');
  });

  it('多 server 按名字排序、段间空行分隔', () => {
    const out = renderMcpServersToml({
      zeta: { command: 'z' },
      alpha: { command: 'a' },
    });
    const alphaIdx = out.indexOf('[mcp_servers.alpha]');
    const zetaIdx = out.indexOf('[mcp_servers.zeta]');
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(zetaIdx).toBeGreaterThan(alphaIdx);
  });
});

describe('mergeMcpServersIntoToml — 幂等合并', () => {
  const servers = { files: { command: 'npx', args: ['-y', 'mcp-files'] } };

  it('空内容 → 追加全部段', () => {
    const { content, appended } = mergeMcpServersIntoToml('', servers);
    expect(appended).toBe(1);
    expect(content).toContain('[mcp_servers.files]');
  });

  it('保留已有内容并在其后追加', () => {
    const base = 'model = "o3"\n\n[features]\nhooks = true\n';
    const { content, appended } = mergeMcpServersIntoToml(base, servers);
    expect(appended).toBe(1);
    expect(content.startsWith(base)).toBe(true);
    expect(content).toContain('[mcp_servers.files]');
  });

  it('段头已存在 → 跳过、appended=0、内容原样', () => {
    const first = mergeMcpServersIntoToml('', servers);
    const second = mergeMcpServersIntoToml(first.content, servers);
    expect(second.appended).toBe(0);
    expect(second.content).toBe(first.content);
  });

  it('部分存在 → 只追加缺失的 server', () => {
    const first = mergeMcpServersIntoToml('', servers);
    const { content, appended } = mergeMcpServersIntoToml(first.content, {
      ...servers,
      extra: { command: 'mcp-extra' },
    });
    expect(appended).toBe(1);
    expect(content.match(/\[mcp_servers\.files\]/g)).toHaveLength(1);
    expect(content).toContain('[mcp_servers.extra]');
  });
});
