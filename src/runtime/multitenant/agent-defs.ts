/**
 * 预定义子代理（subagent）定义 —— 移植自 HappyClaw 的 PREDEFINED_AGENTS
 * （happyclaw/container/agent-runner/src/agent-definitions.ts:15-37），人设对齐。
 *
 * codex 不经 SDK `agents` 选项注册子代理，而是读 `{CODEX_HOME}/agents/<name>.toml`
 * （PoC 实测字段：name + description + developer_instructions 三引号多行）。模型对
 * "spawn the predefined agent named X" 会发 spawnAgent（multi_agent 已 stable）。
 *
 * 工具集差异：HappyClaw 的 tools / model / maxTurns 是 SDK Task 概念，codex agent TOML
 * 无对应字段（子代理工具由 codex sandbox/审批策略统一约束）；故只移植 name/description/人设。
 * web-researcher 的网页搜索能力改由 thread/start.config.web_search='live' 提供
 * （见 ThreadSessionConfig.webSearch），不在 agent TOML 里声明。
 */

/** 一个预定义子代理的最小定义（→ 渲染成 codex agent TOML）。 */
export interface AgentDef {
  /** agent 名（= TOML 文件名 <name>.toml，也是 spawnAgent 引用名）。 */
  name: string;
  /** 一句话描述（模型据此决定何时派生该子代理）。 */
  description: string;
  /** 人设 / 指令（→ developer_instructions，三引号多行）。 */
  developerInstructions: string;
}

/** 预定义子代理列表（与 HappyClaw PREDEFINED_AGENTS 一一对应）。 */
export const PREDEFINED_AGENTS: AgentDef[] = [
  {
    name: 'code-reviewer',
    description:
      'Code review agent that analyzes code quality, best practices, and potential issues',
    developerInstructions:
      'You are a strict code reviewer. Focus on correctness, security, performance, and maintainability. ' +
      'Point out specific issues with file:line references. Be concise and actionable.',
  },
  {
    name: 'web-researcher',
    description: 'Web research agent that searches and extracts information from web pages',
    developerInstructions:
      'You are an efficient web researcher. Search for information, extract key facts, and summarize findings. ' +
      'Always cite sources with URLs. Prefer authoritative sources.',
  },
];

/**
 * 把一个 AgentDef 渲染成 codex agent TOML 内容。
 *
 * developer_instructions 用三引号字面字符串（toml multiline literal），避免对换行/引号转义。
 * 三引号字面里唯一不能出现的是连续三个双引号 `"""`；人设文本不含，仍做防御性替换以防注入破坏。
 */
export function renderAgentToml(def: AgentDef): string {
  const instr = sanitizeTripleQuote(def.developerInstructions);
  return [
    `name = ${tomlBasicString(def.name)}`,
    `description = ${tomlBasicString(def.description)}`,
    `developer_instructions = """`,
    instr,
    `"""`,
    '',
  ].join('\n');
}

/** TOML 基本字符串（双引号）转义：反斜杠与双引号。键值简单，无需处理控制字符。 */
function tomlBasicString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 防御：三引号字面里不能出现 `"""`，把它降级为 `""\"`（语义等价、不破坏字面闭合）。 */
function sanitizeTripleQuote(s: string): string {
  return s.replace(/"""/g, '""\\"');
}
