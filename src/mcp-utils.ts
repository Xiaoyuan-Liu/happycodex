/**
 * Shared MCP server loading utilities.
 * Used by container-runner (Docker + Host modes) and routes/mcp-servers.
 *
 * happycodex：读取/过滤逻辑与上游逐字一致；下游注入从「写 Claude settings.json」
 * 改为「渲染 codex config.toml 的 [mcp_servers.*] TOML 段」——渲染器在
 * src/runtime/multitenant/mcp-toml.ts（codex-home 旁），FsCodexHomeProvisioner
 * 的 provision 流程留有可选接线点（options.mcpServers）。
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

/**
 * Load enabled MCP server configs from a servers.json file.
 * Returns only enabled servers with fields needed for settings.json.
 * Supports both stdio (command/args/env) and http/sse (type/url/headers) server types.
 */
function loadMcpServersFromFile(
  serversFile: string,
): Record<string, Record<string, unknown>> {
  try {
    if (!fs.existsSync(serversFile)) return {};
    const file = JSON.parse(fs.readFileSync(serversFile, 'utf8')) as {
      servers?: Record<string, Record<string, unknown>>;
    };
    const raw = file.servers || {};
    const result: Record<string, Record<string, unknown>> = {};
    for (const [name, server] of Object.entries(raw)) {
      if (!server.enabled) continue;

      const isHttpType = server.type === 'http' || server.type === 'sse';

      if (isHttpType) {
        if (!server.url) continue;
        const entry: Record<string, unknown> = {
          type: server.type,
          url: server.url,
        };
        if (
          server.headers &&
          typeof server.headers === 'object' &&
          Object.keys(server.headers as object).length > 0
        ) {
          entry.headers = server.headers;
        }
        result[name] = entry;
      } else {
        if (!server.command) continue;
        const entry: Record<string, unknown> = { command: server.command };
        if (server.args) entry.args = server.args;
        if (
          server.env &&
          typeof server.env === 'object' &&
          Object.keys(server.env as object).length > 0
        ) {
          entry.env = server.env;
        }
        result[name] = entry;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load enabled MCP server configs for a user.
 * Reads data/mcp-servers/{userId}/servers.json.
 * All workspaces owned by this user share the same MCP server set.
 */
export function loadUserMcpServers(
  userId: string,
): Record<string, Record<string, unknown>> {
  const serversFile = path.join(DATA_DIR, 'mcp-servers', userId, 'servers.json');
  return loadMcpServersFromFile(serversFile);
}
