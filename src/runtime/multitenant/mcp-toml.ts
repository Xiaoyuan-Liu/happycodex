/**
 * mcp-toml —— JSON MCP server 配置 → codex config.toml `[mcp_servers.*]` TOML 段渲染。
 *
 * 上游 HappyClaw 把 loadUserMcpServers() 的结果注入 Claude settings.json 的 mcpServers；
 * codex 改为渲染进 per-folder CODEX_HOME 的 config.toml（codex 读 `[mcp_servers.<name>]`）。
 * 本模块是纯文本工具（无 fs / 无 config 依赖，保持 engine 侧零应用层耦合）：
 *   - renderMcpServersToml：整组 servers → TOML 文本；
 *   - mergeMcpServersIntoToml：把缺失的 server 段幂等合并进已有 config.toml 内容
 *     （段头已存在则跳过 —— 与 hooks-config.writeTrustedHashes 同款合并策略，
 *      不解析整份 TOML，只做段头 marker 检测 + 追加）。
 *
 * 渲染规则（覆盖 loadUserMcpServers 产出的两类形状）：
 *   stdio: { command, args?, env? }   → command/args 标量行 + [mcp_servers.<name>.env] 子表
 *   http : { type, url, headers? }    → url 等标量行 + [mcp_servers.<name>.http_headers] 子表
 *     （codex 的 streamable HTTP server 用 url + http_headers；上游 JSON 的 headers
 *      键在此改名为 http_headers，type 仅作来源标注不落盘——codex 由 url 的存在判型。）
 *   TOML 约束：标量/数组键必须出现在子表段头之前，渲染时先标量后子表。
 */

/** TOML 基本字符串（双引号）转义：反斜杠、双引号与控制字符。 */
export function tomlString(s: string): string {
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/** TOML 键：bare key 字符集直接用，否则加引号。 */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

/** 渲染单个标量/数组值；不支持的类型返回 null（调用方跳过该键）。 */
function tomlValue(v: unknown): string | null {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) {
      const rendered = tomlValue(item);
      if (rendered === null) return null; // 数组含不可渲染成员 → 整键跳过
      parts.push(rendered);
    }
    return `[${parts.join(', ')}]`;
  }
  return null;
}

/** `[mcp_servers.<name>]` 段头（导出供幂等检测复用）。 */
export function mcpServerSectionHeader(name: string): string {
  return `[mcp_servers.${tomlKey(name)}]`;
}

/**
 * 渲染单个 server 为一段 TOML（含段头，末尾带换行）。
 * 标量键在前、子表（env/http_headers 等嵌套对象）在后；
 * 上游 JSON 的 `headers` 键改名 `http_headers`，`type`/`enabled` 不落盘。
 */
export function renderMcpServerSection(
  name: string,
  server: Record<string, unknown>,
): string {
  const scalars: string[] = [];
  const subTables: string[] = [];

  for (const [key, value] of Object.entries(server)) {
    if (value === null || value === undefined) continue;
    if (key === 'type' || key === 'enabled') continue; // 来源标注，codex 不识别
    const tomlName = key === 'headers' ? 'http_headers' : key;

    if (typeof value === 'object' && !Array.isArray(value)) {
      // 嵌套对象 → 子表（只取 string/number/boolean 成员）。
      const lines: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const rendered = tomlValue(v);
        if (rendered === null || Array.isArray(v)) continue;
        lines.push(`${tomlKey(k)} = ${rendered}`);
      }
      if (lines.length > 0) {
        subTables.push(
          `[mcp_servers.${tomlKey(name)}.${tomlKey(tomlName)}]\n${lines.join('\n')}`,
        );
      }
      continue;
    }

    const rendered = tomlValue(value);
    if (rendered === null) continue;
    scalars.push(`${tomlKey(tomlName)} = ${rendered}`);
  }

  const body = [mcpServerSectionHeader(name), ...scalars].join('\n');
  return [body, ...subTables].join('\n\n') + '\n';
}

/** 渲染整组 servers（按名字稳定排序，段间空行分隔）。空集合 → 空串。 */
export function renderMcpServersToml(
  servers: Record<string, Record<string, unknown>>,
): string {
  const names = Object.keys(servers).sort();
  if (names.length === 0) return '';
  return names
    .map((name) => renderMcpServerSection(name, servers[name] ?? {}))
    .join('\n');
}

/**
 * 把缺失的 server 段幂等合并进已有 config.toml 内容。
 * - 段头 `[mcp_servers.<name>]` 已存在 → 跳过该 server（不覆盖、不重复追加）。
 * - 全部已存在 → 原样返回（appended=0，调用方可免写盘）。
 */
export function mergeMcpServersIntoToml(
  content: string,
  servers: Record<string, Record<string, unknown>>,
): { content: string; appended: number } {
  let appended = 0;
  let extra = '';
  for (const name of Object.keys(servers).sort()) {
    const header = mcpServerSectionHeader(name);
    if (content.includes(header)) continue; // 幂等：该 server 已配置
    extra += `\n${renderMcpServerSection(name, servers[name] ?? {})}`;
    appended += 1;
  }
  if (appended === 0) return { content, appended: 0 };
  const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  return { content: `${content}${sep}${extra}`, appended };
}
