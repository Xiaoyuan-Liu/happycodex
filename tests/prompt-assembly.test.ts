/**
 * prompt-assembly（系统提示词分片 + 场景化拼装）测试。
 *
 * 上游对应行为网：upstream agent-runner index.ts 的 promptPieces 拼装段
 * （选片条件 / 包裹标签 / 顺序 / 黄线剥除 / channel 扫描 / home-guest 记忆选片）。
 * 既用仓库自带分片（container/agent-runner/prompts/，验证 port 产物本身），
 * 也用临时目录分片（验证加载/缓存语义与目录注入）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  assemblePromptPieces,
  buildSystemPromptAppend,
  clearPromptShardCache,
  DEFAULT_PROMPTS_DIR,
  type PromptAssemblyArgs,
} from '../src/prompt-assembly.js';

function args(overrides: Partial<PromptAssemblyArgs> = {}): PromptAssemblyArgs {
  return {
    channel: 'web',
    isHome: true,
    disableMemoryLayer: false,
    ...overrides,
  };
}

afterEach(() => {
  clearPromptShardCache();
});

// ─── 仓库自带分片（port 产物） ────────────────────────────────────────

describe('assemblePromptPieces — 选片与顺序（仓库分片）', () => {
  test('默认场景（home + 记忆层开 + web 渠道 + 非子会话）：5 片，顺序与上游一致', () => {
    const pieces = assemblePromptPieces(args());
    expect(pieces.map((p) => p.name)).toEqual([
      'interaction.md',
      'skill-routing.md',
      'security-rules.md',
      'memory-system.home.md',
      'guidelines',
    ]);
  });

  test('包裹标签与上游一致：behavior/skill-routing/security/memory-system/guidelines', () => {
    const pieces = assemblePromptPieces(args());
    const byName = new Map(pieces.map((p) => [p.name, p.text]));
    expect(byName.get('interaction.md')).toMatch(/^<behavior>\n[\s\S]*\n<\/behavior>$/);
    expect(byName.get('skill-routing.md')).toMatch(/^<skill-routing>\n[\s\S]*\n<\/skill-routing>$/);
    expect(byName.get('security-rules.md')).toMatch(/^<security>\n[\s\S]*\n<\/security>$/);
    expect(byName.get('memory-system.home.md')).toMatch(/^<memory-system>\n[\s\S]*\n<\/memory-system>$/);
    // guidelines 块：output + web-fetch + background-tasks 三片合一（上游 GUIDELINES_BLOCK）
    const guidelines = byName.get('guidelines')!;
    expect(guidelines).toMatch(/^<guidelines>\n[\s\S]*\n<\/guidelines>$/);
    expect(guidelines).toContain('## 输出格式');
    expect(guidelines).toContain('## 网页访问策略');
    expect(guidelines).toContain('## 后台任务');
  });

  test('guest（非 home）：选 memory-system.guest.md', () => {
    const pieces = assemblePromptPieces(args({ isHome: false }));
    expect(pieces.map((p) => p.name)).toContain('memory-system.guest.md');
    expect(pieces.map((p) => p.name)).not.toContain('memory-system.home.md');
  });

  test('disableMemoryLayer：跳过 memory 分片 + security-rules 剥除「黄线操作」段', () => {
    const pieces = assemblePromptPieces(args({ disableMemoryLayer: true }));
    const names = pieces.map((p) => p.name);
    expect(names).not.toContain('memory-system.home.md');
    expect(names).not.toContain('memory-system.guest.md');
    const security = pieces.find((p) => p.name === 'security-rules.md')!.text;
    expect(security).not.toContain('### 黄线操作');
    expect(security).toContain('### 红线操作');
    expect(security).toContain('### Skill / MCP 安装审查'); // 后续段保留（上游正则同式）
  });

  test('记忆层开启时 security-rules 保留黄线段（对照）', () => {
    const security = assemblePromptPieces(args()).find((p) => p.name === 'security-rules.md')!.text;
    expect(security).toContain('### 黄线操作');
  });

  test('channel=feishu：注入 channels/feishu.md（<channel-format> 包裹）；web 无分片不注入', () => {
    const feishu = assemblePromptPieces(args({ channel: 'feishu' }));
    const piece = feishu.find((p) => p.name === 'channels/feishu.md');
    expect(piece).toBeDefined();
    expect(piece!.text).toMatch(/^<channel-format>\n## 飞书消息格式[\s\S]*\n<\/channel-format>$/);

    const web = assemblePromptPieces(args({ channel: 'web' }));
    expect(web.some((p) => p.name.startsWith('channels/'))).toBe(false);
  });

  test('四个渠道分片齐备：feishu / telegram / qq / dingtalk 均可选中', () => {
    for (const channel of ['feishu', 'telegram', 'qq', 'dingtalk']) {
      const pieces = assemblePromptPieces(args({ channel }));
      expect(pieces.map((p) => p.name)).toContain(`channels/${channel}.md`);
    }
  });

  test('agentId（子会话）：末位追加 agent-override.md（<agent-override> 包裹）', () => {
    const pieces = assemblePromptPieces(args({ agentId: 'agent-1', channel: 'feishu' }));
    const last = pieces[pieces.length - 1]!;
    expect(last.name).toBe('agent-override.md');
    expect(last.text).toMatch(/^<agent-override>\n[\s\S]*\n<\/agent-override>$/);
    expect(last.text).toContain('子会话行为规则');
  });

  test('buildSystemPromptAppend：分片以单个 \\n 连接（上游 systemPromptAppend 同式）', () => {
    const pieces = assemblePromptPieces(args());
    const append = buildSystemPromptAppend(args());
    expect(append).toBe(pieces.map((p) => p.text).join('\n'));
    expect(append.startsWith('<behavior>')).toBe(true);
  });

  test('codex 措辞适配落地：skill-routing 指向 .skills/ 物化目录而非 Skill 工具', () => {
    const routing = assemblePromptPieces(args()).find((p) => p.name === 'skill-routing.md')!.text;
    expect(routing).toContain('.skills/');
    expect(routing).not.toContain('Skill 工具');
    expect(routing).not.toContain('Claude Code');
  });

  test('workspaceGlobalDir：替换 memory 分片中的 /workspace/global 字面量（host 模式）', () => {
    const replaced = assemblePromptPieces(
      args({ workspaceGlobalDir: '/srv/data/groups/user-global/u1' }),
    ).find((p) => p.name === 'memory-system.home.md')!.text;
    expect(replaced).toContain('/srv/data/groups/user-global/u1/CLAUDE.md');
    expect(replaced).not.toContain('/workspace/global');

    // 不传 → 保持上游容器路径原文
    const original = assemblePromptPieces(args()).find(
      (p) => p.name === 'memory-system.home.md',
    )!.text;
    expect(original).toContain('/workspace/global/CLAUDE.md');
  });
});

// ─── 临时目录分片（加载 / 缓存语义） ─────────────────────────────────

describe('assemblePromptPieces — 分片加载与缓存（临时目录）', () => {
  let promptsDir: string;

  const SHARD_FILES: Record<string, string> = {
    'interaction.md': '## 交互A\n',
    'skill-routing.md': '## 路由A\n',
    'security-rules.md':
      '## 安全\n\n### 红线操作\n- A\n\n### 黄线操作（可执行）\n- B\n\n### Skill / MCP 安装审查\n- C\n',
    'output.md': '## 输出A\n',
    'web-fetch.md': '## 网页A\n',
    'background-tasks.md': '## 后台A\n',
    'agent-override.md': '## 覆盖A\n',
    'memory-system.home.md': '## 记忆home /workspace/global/CLAUDE.md\n',
    'memory-system.guest.md': '## 记忆guest\n',
    'channels/feishu.md': '## 飞书A\n',
  };

  beforeEach(() => {
    promptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happycodex-prompts-'));
    for (const [rel, content] of Object.entries(SHARD_FILES)) {
      const file = path.join(promptsDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    clearPromptShardCache();
  });

  afterEach(() => {
    fs.rmSync(promptsDir, { recursive: true, force: true });
  });

  test('按目录加载 + trimEnd（上游 loadPrompt 同式）', () => {
    const pieces = assemblePromptPieces(args({ channel: 'feishu' }), promptsDir);
    const byName = new Map(pieces.map((p) => [p.name, p.text]));
    expect(byName.get('interaction.md')).toBe('<behavior>\n## 交互A\n</behavior>');
    expect(byName.get('channels/feishu.md')).toBe('<channel-format>\n## 飞书A\n</channel-format>');
    expect(byName.get('guidelines')).toBe(
      '<guidelines>\n## 输出A\n## 网页A\n## 后台A\n</guidelines>',
    );
  });

  test('channels/ 扫描：文件名（去 .md）即 channel key；目录缺失渠道不注入', () => {
    const known = assemblePromptPieces(args({ channel: 'feishu' }), promptsDir);
    expect(known.map((p) => p.name)).toContain('channels/feishu.md');
    const unknown = assemblePromptPieces(args({ channel: 'telegram' }), promptsDir);
    expect(unknown.some((p) => p.name.startsWith('channels/'))).toBe(false);
  });

  test('缓存：同目录二次拼装不重读磁盘；clearPromptShardCache 后读到新内容', () => {
    const before = buildSystemPromptAppend(args(), promptsDir);
    fs.writeFileSync(path.join(promptsDir, 'interaction.md'), '## 交互B\n');
    expect(buildSystemPromptAppend(args(), promptsDir)).toBe(before); // 命中缓存
    clearPromptShardCache();
    expect(buildSystemPromptAppend(args(), promptsDir)).toContain('## 交互B');
  });

  test('黄线剥除正则与上游同式：保留红线与安装审查两段', () => {
    const security = assemblePromptPieces(
      args({ disableMemoryLayer: true }),
      promptsDir,
    ).find((p) => p.name === 'security-rules.md')!.text;
    expect(security).toContain('### 红线操作');
    expect(security).toContain('### Skill / MCP 安装审查');
    expect(security).not.toContain('黄线');
  });

  test('DEFAULT_PROMPTS_DIR 指向仓库 container/agent-runner/prompts（路径镜像上游）', () => {
    expect(DEFAULT_PROMPTS_DIR.endsWith(path.join('container', 'agent-runner', 'prompts'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(DEFAULT_PROMPTS_DIR, 'interaction.md'))).toBe(true);
    expect(fs.existsSync(path.join(DEFAULT_PROMPTS_DIR, 'channels', 'feishu.md'))).toBe(true);
  });
});
