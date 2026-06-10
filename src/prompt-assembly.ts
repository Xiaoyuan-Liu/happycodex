/**
 * prompt-assembly —— 系统提示词分片加载 + 场景化拼装（codex 版）。
 *
 * 上游对应：upstream-happyclaw/container/agent-runner/src/index.ts 的
 * loadPrompt / GUIDELINES_BLOCK / CONVERSATION_AGENT_BLOCK / buildSecurityRulesPrompt /
 * CHANNEL_GUIDELINES / buildMemoryRecallPrompt / promptPieces 拼装段（index.ts:112-135 /
 * 171-177 / 278-291 / 1034-1037 / 1271-1297）。分片文件路径镜像上游：
 * container/agent-runner/prompts/{*.md, channels/*.md}。
 *
 * 引擎面差异（codex 无 Claude 的 systemPrompt preset append 通道）：
 *   - 上游产物注入 query options 的 systemPrompt.append（claude_code preset 之上）；
 *     codex 版产物经 ContainerInput.developerInstructions 透传到
 *     thread/start.developerInstructions（PoC 结论 ③：与 AGENTS.md 叠加、冲突时胜出）。
 *     接线点：container-runner.deriveInputWithSessionContext（两处 spawn 共用）。
 *   - 上游在容器内 agent-runner 启动期 readFileSync 缓存；codex 版拼装发生在宿主侧
 *     spawn 前（host 进程常驻），改为惰性加载 + 按 promptsDir 缓存（测试可注入临时目录）。
 *
 * Claude 专属措辞的最小适配（分片文件内容，相对上游逐条记录）：
 *   - skill-routing.md：上游「使用 Claude Code 已发现的 skills…调用 Skill 工具」——codex
 *     无 SKILL.md 发现/Skill 工具机制，改为「.skills/ 物化目录 + AGENTS.md 索引 + 按需
 *     cat 入口文件」（对齐 skills-materializer 布局）。
 *   - background-tasks.md：上游「使用 Task 工具并设置 run_in_background: true」——codex
 *     无 Task 工具，改为 shell 后台（nohup + 日志文件）+ 按日志汇报；「任务通知处理」段
 *     原样保留（schedule_task 通知链路不变）。
 *   - memory-system.home.md：上游「用 Read 工具读取…再用 Edit 工具原地更新」——去工具名
 *     改为「先读取再原地最小编辑」；品牌词 HappyClaw → HappyCodex。
 *   - memory-system.guest.md：上游「Claude 会自动维护你的会话记忆」→「会话上下文会自动
 *     持久化」（codex thread resume 语义）；品牌词同上。
 *   - security-rules.md：审查条目 `$ANTHROPIC_API_KEY` → `$OPENAI_API_KEY`、
 *     「HappyClaw 核心配置（data/config/、.claude/）」→「HappyCodex（data/config/、.codex/）」。
 *     章节标题原样保留（黄线剥除正则依赖标题文本，与上游同式）。
 *   - web-fetch.md：「切换到已加载的合适技能」→「切换到 .skills/ 中合适的技能」。
 *   - channels/feishu.md、channels/telegram.md：删去「可使用 send_image 和 send_file 工具」
 *     一句——happycodex 内置 12 工具无 send_image/send_file。
 *   - interaction.md / output.md / agent-override.md / channels/{qq,dingtalk}.md：原样。
 *
 * 此外提供 workspaceGlobalDir 替换点：上游 memory 分片硬编码容器路径
 * `/workspace/global`（host 模式下并不存在，上游即有的 wart）。codex 拼装在宿主侧、
 * 实际路径已知，host 模式传入真实 user-global 目录做字面替换；容器模式不传（保持原文）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** 默认分片目录：{projectRoot}/container/agent-runner/prompts（路径镜像上游）。
 *  src/ 与 dist/ 均位于 projectRoot 一级子目录，'..' 同样解析到 projectRoot。 */
export const DEFAULT_PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'container',
  'agent-runner',
  'prompts',
);

/** 与上游同名同形：单个分片的拼装产物（name 供审计/测试，text 为带包裹标签的正文）。 */
export interface PromptPiece {
  name: string;
  text: string;
}

/** 场景输入（上游取值点：normalizeHomeFlags / HAPPYCLAW_DISABLE_MEMORY_LAYER /
 *  getChannelFromJid(chatJid) / containerInput.agentId）。 */
export interface PromptAssemblyArgs {
  /** 渠道 key（feishu / telegram / qq / dingtalk / web / ...），channels/{key}.md 存在才注入。 */
  channel: string;
  /** 主容器（is_home）→ memory-system.home.md；否则 guest 版。 */
  isHome: boolean;
  /** 禁用记忆层：跳过 memory 分片 + 剥除 security-rules 的「黄线操作」段（上游同语义）。 */
  disableMemoryLayer: boolean;
  /** 子会话（conversation agent）→ 追加 agent-override.md。 */
  agentId?: string | undefined;
  /** host 模式的真实 user-global 目录；提供时替换 memory 分片中的 /workspace/global 字面量。 */
  workspaceGlobalDir?: string | undefined;
}

/** 一个 prompts 目录加载出的全部分片（trimEnd 后缓存，对齐上游 loadPrompt）。 */
interface LoadedShards {
  interaction: string;
  skillRouting: string;
  securityRules: string;
  output: string;
  webFetch: string;
  backgroundTasks: string;
  agentOverride: string;
  memoryHome: string;
  memoryGuest: string;
  /** channels/*.md：文件名（去 .md）= channel key（上游启动期扫描同语义）。 */
  channels: Record<string, string>;
}

const shardCache = new Map<string, LoadedShards>();

function loadShard(promptsDir: string, ...segments: string[]): string {
  return fs.readFileSync(path.join(promptsDir, ...segments), 'utf-8').trimEnd();
}

function loadShards(promptsDir: string): LoadedShards {
  const cached = shardCache.get(promptsDir);
  if (cached) return cached;

  const channels: Record<string, string> = {};
  const channelsDir = path.join(promptsDir, 'channels');
  if (fs.existsSync(channelsDir)) {
    for (const file of fs.readdirSync(channelsDir)) {
      if (!file.endsWith('.md')) continue;
      channels[file.slice(0, -'.md'.length)] = loadShard(promptsDir, 'channels', file);
    }
  }

  const shards: LoadedShards = {
    interaction: loadShard(promptsDir, 'interaction.md'),
    skillRouting: loadShard(promptsDir, 'skill-routing.md'),
    securityRules: loadShard(promptsDir, 'security-rules.md'),
    output: loadShard(promptsDir, 'output.md'),
    webFetch: loadShard(promptsDir, 'web-fetch.md'),
    backgroundTasks: loadShard(promptsDir, 'background-tasks.md'),
    agentOverride: loadShard(promptsDir, 'agent-override.md'),
    memoryHome: loadShard(promptsDir, 'memory-system.home.md'),
    memoryGuest: loadShard(promptsDir, 'memory-system.guest.md'),
    channels,
  };
  shardCache.set(promptsDir, shards);
  return shards;
}

/** 测试用：清空分片缓存（分片文件在用例间变化时）。 */
export function clearPromptShardCache(): void {
  shardCache.clear();
}

/** 上游 buildSecurityRulesPrompt 同式：禁用记忆层时剥除「黄线操作」段（无日期记忆可记）。 */
function buildSecurityRulesPrompt(securityRules: string, disableMemoryLayer: boolean): string {
  if (!disableMemoryLayer) return securityRules;
  return securityRules.replace(
    /\n### 黄线操作[\s\S]*?(?=\n### Skill \/ MCP 安装审查)/,
    '',
  );
}

/** 上游 buildMemoryRecallPrompt 同式：禁用记忆层 → ''（跳过分片）；否则按 home/guest 选片。 */
function buildMemoryRecallPrompt(shards: LoadedShards, args: PromptAssemblyArgs): string {
  if (args.disableMemoryLayer) return '';
  const text = args.isHome ? shards.memoryHome : shards.memoryGuest;
  // host 模式注入真实 user-global 路径（容器路径 /workspace/global 在宿主机不存在）。
  if (args.workspaceGlobalDir) {
    return text.split('/workspace/global').join(args.workspaceGlobalDir);
  }
  return text;
}

/**
 * 场景化选片拼装（上游 promptPieces 段逐条对齐，顺序/包裹标签一致）：
 *   1. interaction.md         → <behavior>
 *   2. skill-routing.md       → <skill-routing>
 *   3. security-rules.md      → <security>（disableMemoryLayer 时剥黄线段）
 *   4. memory-system.{home|guest}.md → <memory-system>（disableMemoryLayer 时整段跳过）
 *   5. guidelines（output + web-fetch + background-tasks）→ <guidelines>
 *   6. channels/{channel}.md  → <channel-format>（该渠道分片存在才注入）
 *   7. agent-override.md      → <agent-override>（agentId 存在才注入）
 */
export function assemblePromptPieces(
  args: PromptAssemblyArgs,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): PromptPiece[] {
  const shards = loadShards(promptsDir);

  const guidelinesBlock = `<guidelines>\n${shards.output}\n${shards.webFetch}\n${shards.backgroundTasks}\n</guidelines>`;
  const agentOverrideBlock = `<agent-override>\n${shards.agentOverride}\n</agent-override>`;
  const channelGuidelines = shards.channels[args.channel] ?? '';
  const memoryRecall = buildMemoryRecallPrompt(shards, args);
  const memoryPromptName = !args.disableMemoryLayer
    ? args.isHome
      ? 'memory-system.home.md'
      : 'memory-system.guest.md'
    : null;

  return [
    { name: 'interaction.md', text: `<behavior>\n${shards.interaction}\n</behavior>` },
    { name: 'skill-routing.md', text: `<skill-routing>\n${shards.skillRouting}\n</skill-routing>` },
    {
      name: 'security-rules.md',
      text: `<security>\n${buildSecurityRulesPrompt(shards.securityRules, args.disableMemoryLayer)}\n</security>`,
    },
    ...(memoryRecall && memoryPromptName
      ? [{ name: memoryPromptName, text: `<memory-system>\n${memoryRecall}\n</memory-system>` }]
      : []),
    { name: 'guidelines', text: guidelinesBlock },
    ...(channelGuidelines
      ? [{ name: `channels/${args.channel}.md`, text: `<channel-format>\n${channelGuidelines}\n</channel-format>` }]
      : []),
    ...(args.agentId ? [{ name: 'agent-override.md', text: agentOverrideBlock }] : []),
  ];
}

/** 上游 systemPromptAppend 同式：分片正文以 '\n' 连接。 */
export function buildSystemPromptAppend(
  args: PromptAssemblyArgs,
  promptsDir: string = DEFAULT_PROMPTS_DIR,
): string {
  return assemblePromptPieces(args, promptsDir)
    .map((piece) => piece.text)
    .join('\n');
}
