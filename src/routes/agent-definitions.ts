// Agent definitions routes（codex 版：只读展示 PREDEFINED_AGENTS）
//
// tombstone（happycodex）：上游本路由对宿主机 ~/.claude/agents/*.md 做活体 CRUD
// （getAgentsDir/discoverAgents/getAgentDetail/parseFrontmatter/extractTools 等
// frontmatter 解析与 fs 读写全套，Claude Code 全局子代理定义）。codex 引擎不读
// ~/.claude——预定义子代理的单一真相源是 src/runtime/multitenant/agent-defs.ts 的
// PREDEFINED_AGENTS，由 FsCodexHomeProvisioner.provisionAgents（src/runtime/
// multitenant/codex-home.ts）渲染成 {CODEX_HOME}/agents/<name>.toml。GET 改为如实
// 展示 PREDEFINED_AGENTS（页面呈现 codex 实际运行的子代理）；写操作（PUT/POST/
// DELETE）返回 501——自定义子代理定义的持久化（DB 或 {dataDir}/agent-defs）与
// provision 合并留待后续接线，任何路径都绝不写 ~/.claude。

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { PREDEFINED_AGENTS } from '../runtime/multitenant/agent-defs.js';

const agentDefinitionsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
  updatedAt: string;
}

interface AgentDefinitionDetail extends AgentDefinition {
  content: string;
}

const EDIT_NOT_SUPPORTED =
  'Agent definition editing is not supported on the codex engine; ' +
  'predefined agents are provisioned from PREDEFINED_AGENTS into {CODEX_HOME}/agents/*.toml';

/**
 * PREDEFINED_AGENTS → 路由 wire 形状。
 * tools 恒空：codex agent TOML 无 tools 字段（子代理工具由 sandbox/审批策略统一
 * 约束，见 agent-defs.ts 头注）；updatedAt 恒空：编译期常量定义，无文件 mtime。
 */
function listPredefinedAgents(): AgentDefinition[] {
  return PREDEFINED_AGENTS.map((def) => ({
    id: def.name,
    name: def.name,
    description: def.description,
    tools: [],
    updatedAt: '',
  }));
}

// --- Routes ---

// List all agent definitions（codex 实际运行的预定义子代理）
agentDefinitionsRoutes.get('/', authMiddleware, (c) => {
  return c.json({ agents: listPredefinedAgents() });
});

// Get single agent detail（content = developer_instructions 人设全文）
agentDefinitionsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const def = PREDEFINED_AGENTS.find((a) => a.name === id);
  if (!def) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  const agent: AgentDefinitionDetail = {
    id: def.name,
    name: def.name,
    description: def.description,
    tools: [],
    updatedAt: '',
    content: def.developerInstructions,
  };
  return c.json({ agent });
});

// Update agent content — codex 引擎不支持（见文件头 tombstone）
agentDefinitionsRoutes.put('/:id', authMiddleware, systemConfigMiddleware, (c) => {
  return c.json({ error: EDIT_NOT_SUPPORTED }, 501);
});

// Create new agent — codex 引擎不支持（见文件头 tombstone）
agentDefinitionsRoutes.post('/', authMiddleware, systemConfigMiddleware, (c) => {
  return c.json({ error: EDIT_NOT_SUPPORTED }, 501);
});

// Delete agent — codex 引擎不支持（见文件头 tombstone）
agentDefinitionsRoutes.delete('/:id', authMiddleware, systemConfigMiddleware, (c) => {
  return c.json({ error: EDIT_NOT_SUPPORTED }, 501);
});

export default agentDefinitionsRoutes;
