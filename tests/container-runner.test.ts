/**
 * container-runner（codex 版）测试。
 *
 * 上游 tests/ 对 container-runner 的直接覆盖均绑在已删除的引擎面上（provider-switch-* 绑
 * provider pool、container-runner-plugin-mount 绑 Claude plugins），不搬（tombstone）。
 * 本文件为 happycodex 新增的最小行为网：
 *   - runHostAgent：经 HAPPYCODEX_RUNNER_CMD 指向 fake runner，断言 spawn 参数构造
 *     （env 含 CODEX_HOME + HAPPYCLAW_WORKSPACE_*（per-folder）、不含 ANTHROPIC_* 注入）、
 *     ContainerInput stdin 写入形状、信封流消费、超时 kill 路径、非零退出路径、预检错误。
 *   - buildVolumeMounts：codex home 挂载替换 .claude 挂载、Claude 时代挂载点全部消失、
 *     customEnv → env 文件（零 ANTHROPIC_* 行）、admin/project 挂载、agents/ IPC 子空间。
 *   - writeTasksSnapshot / writeGroupsSnapshot：admin/member 可见性过滤（纯 port 行为）。
 *
 * Docker 分支（runContainerAgent spawn docker）不在本文件起真实容器——编译期保证 +
 * buildVolumeMounts 单测覆盖挂载构造；端到端留 A1-2（TODO）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// config.js 重定向到临时目录：DATA_DIR/GROUPS_DIR/MOUNT_ALLOWLIST_PATH 全部落 tmp，
// 避免测试写进仓库 data/。tmpRoot 先 realpath（macOS /var → /private/var symlink），
// 使 runHostAgent 内 realpathSync 后的路径与字面拼接一致。
vi.mock('../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/config.js')>();
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const tmpRoot = fsm.realpathSync(
    fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'hcx-container-runner-')),
  );
  return {
    ...orig,
    DATA_DIR: pathm.join(tmpRoot, 'data'),
    GROUPS_DIR: pathm.join(tmpRoot, 'data', 'groups'),
    MOUNT_ALLOWLIST_PATH: pathm.join(tmpRoot, 'config', 'mount-allowlist.json'),
  };
});

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import {
  buildVolumeMounts,
  provisionCodexHome,
  runHostAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  type ContainerInput,
  type ContainerOutput,
} from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = path.join(helpersDir, 'helpers', 'fake-agent-runner.mjs');

// ─── 环境隔离 ────────────────────────────────────────────────────────

const ENV_KEYS = [
  'HAPPYCODEX_RUNNER_CMD',
  'HAPPYCODEX_TEST_DUMP',
  'HAPPYCODEX_TEST_MODE',
  'HAPPYCODEX_SHARED_CODEX_HOME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'DEBUG_CLAUDE_AGENT_SDK',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let sharedHome: string;

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // 共享 codex home（已"登录"）：auth.json 存在即可被 provision 复制。
  sharedHome = path.join(DATA_DIR, 'shared-codex-home');
  fs.mkdirSync(sharedHome, { recursive: true });
  fs.writeFileSync(path.join(sharedHome, 'auth.json'), '{"fake":"auth"}\n');
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  process.env.HAPPYCODEX_RUNNER_CMD = `${process.execPath} ${FAKE_RUNNER}`;
  process.env.HAPPYCODEX_SHARED_CODEX_HOME = sharedHome;
  delete process.env.HAPPYCODEX_TEST_DUMP;
  delete process.env.HAPPYCODEX_TEST_MODE;
  // 确保 Claude 时代 env 不从外层环境泄入断言。
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.DEBUG_CLAUDE_AGENT_SDK;
});

function makeGroup(folder: string, overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: `Group ${folder}`,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    is_home: true,
    created_by: 'u1',
    containerConfig: { timeout: 15_000 },
    ...overrides,
  };
}

function makeInput(folder: string, overrides: Partial<ContainerInput> = {}): ContainerInput {
  return {
    prompt: 'hi there',
    groupFolder: folder,
    chatJid: `web:${folder}`,
    isMain: true,
    ...overrides,
  };
}

interface DumpShape {
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: Record<string, unknown> | null;
}

async function runHostWithDump(
  group: RegisteredGroup,
  input: ContainerInput,
): Promise<{ result: ContainerOutput; dump: DumpShape; outputs: ContainerOutput[]; processIds: string[]; providerIds: Array<string | null> }> {
  const dumpPath = path.join(DATA_DIR, `dump-${group.folder}-${Date.now()}.json`);
  process.env.HAPPYCODEX_TEST_DUMP = dumpPath;
  const outputs: ContainerOutput[] = [];
  const processIds: string[] = [];
  const providerIds: Array<string | null> = [];
  const result = await runHostAgent(
    group,
    input,
    (_proc, id, providerId) => {
      processIds.push(id);
      providerIds.push(providerId);
    },
    async (out) => {
      outputs.push(out);
    },
  );
  const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8')) as DumpShape;
  return { result, dump, outputs, processIds, providerIds };
}

// ─── runHostAgent ────────────────────────────────────────────────────

describe('runHostAgent（host 模式 spawn，fake runner）', () => {
  test('成功路径：success 终态 + newSessionId + 信封顺序', async () => {
    const folder = 'hg-success';
    const { result, outputs } = await runHostWithDump(makeGroup(folder), makeInput(folder));

    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('thr_fake');
    // 流式模式：最终 resolve 的 result 为 null，正文经 onOutput 信封到达。
    expect(result.result).toBeNull();

    expect(outputs.map((o) => o.status)).toEqual(['stream', 'success']);
    expect(outputs[1]?.result).toBe('hello');
    expect(outputs[1]?.newSessionId).toBe('thr_fake');
  });

  test('env 注入：CODEX_HOME 指向 per-folder home 且 auth.json 已复制', async () => {
    const folder = 'hg-codexhome';
    const { dump } = await runHostWithDump(makeGroup(folder), makeInput(folder));

    const expectedHome = path.join(DATA_DIR, 'sessions', folder, '.codex');
    expect(dump.env.CODEX_HOME).toBe(expectedHome);
    expect(fs.existsSync(path.join(expectedHome, 'auth.json'))).toBe(true);
  });

  test('env 注入：HAPPYCLAW_WORKSPACE_* 为上游名 + per-folder 路径', async () => {
    const folder = 'hg-wsenv';
    const { dump } = await runHostWithDump(makeGroup(folder), makeInput(folder));

    expect(dump.env.HAPPYCLAW_WORKSPACE_GROUP).toBe(path.join(GROUPS_DIR, folder));
    expect(dump.env.HAPPYCLAW_WORKSPACE_IPC).toBe(path.join(DATA_DIR, 'ipc', folder));
    expect(dump.env.HAPPYCLAW_WORKSPACE_MEMORY).toBe(path.join(DATA_DIR, 'memory', folder));
    expect(dump.env.HAPPYCLAW_WORKSPACE_GLOBAL).toBe(
      path.join(GROUPS_DIR, 'user-global', 'u1'),
    );
    // cwd = group 工作目录
    expect(dump.cwd).toBe(path.join(GROUPS_DIR, folder));
  });

  test('env 注入：不含任何 ANTHROPIC_* / CLAUDE_CONFIG_DIR（Claude 引擎面已删）', async () => {
    const folder = 'hg-noclaude';
    const { dump } = await runHostWithDump(makeGroup(folder), makeInput(folder));

    const keys = Object.keys(dump.env);
    expect(keys.filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
    expect(keys).not.toContain('CLAUDE_CONFIG_DIR');
    expect(keys).not.toContain('DEBUG_CLAUDE_AGENT_SDK');
  });

  test('stdin 写入：ContainerInput JSON 原样到达 runner', async () => {
    const folder = 'hg-stdin';
    const input = makeInput(folder, { sessionId: 'thr_resume', isScheduledTask: true });
    const { dump } = await runHostWithDump(makeGroup(folder), input);

    expect(dump.stdin).toMatchObject({
      prompt: 'hi there',
      groupFolder: folder,
      chatJid: `web:${folder}`,
      isMain: true,
      sessionId: 'thr_resume',
      isScheduledTask: true,
    });
  });

  test('onProcess：host-{folder}- 标识 + providerId 恒为 null（pool 已删）', async () => {
    const folder = 'hg-onproc';
    const { processIds, providerIds } = await runHostWithDump(
      makeGroup(folder),
      makeInput(folder),
    );
    expect(processIds).toHaveLength(1);
    expect(processIds[0]).toMatch(new RegExp(`^host-${folder}-\\d+$`));
    expect(providerIds).toEqual([null]);
  });

  test('IPC 目录结构：messages/tasks/input/agents 四个子目录创建', async () => {
    const folder = 'hg-ipcdirs';
    await runHostWithDump(makeGroup(folder), makeInput(folder));
    for (const sub of ['messages', 'tasks', 'input', 'agents']) {
      expect(fs.statSync(path.join(DATA_DIR, 'ipc', folder, sub)).isDirectory()).toBe(true);
    }
  });

  test('超时路径：无输出的 runner 被 kill，error 终态带 timed out', async () => {
    const folder = 'hg-timeout';
    process.env.HAPPYCODEX_TEST_MODE = 'hang';
    const group = makeGroup(folder, { containerConfig: { timeout: 500 } });
    const { result } = await runHostWithDump(group, makeInput(folder));

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/timed out after 500ms/);
  }, 15_000);

  test('非零退出路径：exit 3 → error 终态带退出码与 stderr 尾巴', async () => {
    const folder = 'hg-errexit';
    process.env.HAPPYCODEX_TEST_MODE = 'error-exit';
    const { result } = await runHostWithDump(makeGroup(folder), makeInput(folder));

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Host agent exited with code 3/);
    expect(result.error).toMatch(/simulated failure/);
  });

  test('预检：customCwd 不存在 → 宿主机模式启动失败', async () => {
    const folder = 'hg-badcwd';
    const group = makeGroup(folder, {
      customCwd: path.join(DATA_DIR, 'definitely-missing-dir'),
    });
    const result = await runHostAgent(group, makeInput(folder), () => {});
    expect(result.status).toBe('error');
    expect(result.result).toMatch(/工作目录不存在或无法解析/);
  });

  test('预检：共享 codex home 未登录（缺 auth.json）→ CODEX_HOME 准备失败', async () => {
    const folder = 'hg-noauth';
    const emptyShared = path.join(DATA_DIR, 'empty-shared-home');
    fs.mkdirSync(emptyShared, { recursive: true });
    process.env.HAPPYCODEX_SHARED_CODEX_HOME = emptyShared;
    const result = await runHostAgent(makeGroup(folder), makeInput(folder), () => {});
    expect(result.status).toBe('error');
    expect(result.result).toMatch(/CODEX_HOME 准备失败/);
    expect(result.error).toMatch(/auth\.json/);
  });
});

// ─── context-resolver 接线（host spawn 路径） ────────────────────────

describe('context-resolver 接线（runHostAgent）', () => {
  test('AGENTS.md 物化 + config.toml fallback 键 + developerInstructions 注入', async () => {
    const folder = 'hg-ctx';
    // user-global 记忆源（makeGroup created_by=u1, is_home=true → 注入 AGENTS.md）
    const userGlobalMd = path.join(GROUPS_DIR, 'user-global', 'u1', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(userGlobalMd), { recursive: true });
    fs.writeFileSync(userGlobalMd, '# u1 全局记忆\n偏好X\n');

    const { dump } = await runHostWithDump(makeGroup(folder), makeInput(folder));

    // ③ 会话动态上下文经 ContainerInput.developerInstructions 透传链到达 runner stdin
    const devIns = dump.stdin?.developerInstructions;
    expect(typeof devIns).toBe('string');
    expect(devIns).toContain('<happycodex-session-context>');
    expect(devIns).toContain(`folder: ${folder}`);

    // ① 用户/全局维度 → per-folder CODEX_HOME/AGENTS.md（marker + 内容）
    const codexHome = path.join(DATA_DIR, 'sessions', folder, '.codex');
    const agentsMd = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain('happycodex:generated');
    expect(agentsMd).toContain('# u1 全局记忆');

    // ② 项目维度 → config.toml 顶层 project_doc_fallback_filenames=["CLAUDE.md"]
    const configToml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    expect(configToml).toMatch(/^project_doc_fallback_filenames = \["CLAUDE\.md"\]/m);

    // 红线：群组工作区 CLAUDE.md 本体不被生成/改写（源文件原样）
    expect(fs.readFileSync(userGlobalMd, 'utf8')).toBe('# u1 全局记忆\n偏好X\n');
    expect(fs.existsSync(path.join(GROUPS_DIR, folder, 'CLAUDE.md'))).toBe(false);
  });

  test('调用方预置 developerInstructions：保留并前置，动态会话段追加在后', async () => {
    const folder = 'hg-ctx-preset';
    const input = makeInput(folder, { developerInstructions: '调用方预置段' });
    const { dump } = await runHostWithDump(makeGroup(folder), input);

    const devIns = dump.stdin?.developerInstructions as string;
    expect(devIns.startsWith('调用方预置段')).toBe(true);
    const presetIdx = devIns.indexOf('调用方预置段');
    const dynamicIdx = devIns.indexOf('<happycodex-session-context>');
    expect(dynamicIdx).toBeGreaterThan(presetIdx);
  });

  test('mcpServers 接线点：loadUserMcpServers(ownerId) → per-folder config.toml [mcp_servers.*]', async () => {
    const folder = 'hg-ctx-mcp';
    const serversFile = path.join(DATA_DIR, 'mcp-servers', 'u1', 'servers.json');
    fs.mkdirSync(path.dirname(serversFile), { recursive: true });
    fs.writeFileSync(
      serversFile,
      JSON.stringify({
        servers: {
          echo: { enabled: true, command: 'echo', args: ['hi'] },
          off: { enabled: false, command: 'never' },
        },
      }),
    );

    await runHostWithDump(makeGroup(folder), makeInput(folder));

    const configToml = fs.readFileSync(
      path.join(DATA_DIR, 'sessions', folder, '.codex', 'config.toml'),
      'utf8',
    );
    expect(configToml).toContain('[mcp_servers.echo]');
    expect(configToml).not.toContain('[mcp_servers.off]');
  });
});

// ─── provisionCodexHome ──────────────────────────────────────────────

describe('provisionCodexHome', () => {
  test('主 agent：sessions/{folder}/.codex；sub-agent：sessions/{folder}/agents/{aid}/.codex', async () => {
    const main = await provisionCodexHome('pv-main');
    expect(main).toBe(path.join(DATA_DIR, 'sessions', 'pv-main', '.codex'));
    expect(fs.existsSync(path.join(main, 'auth.json'))).toBe(true);

    const sub = await provisionCodexHome('pv-main', 'agent-1');
    expect(sub).toBe(
      path.join(DATA_DIR, 'sessions', 'pv-main', 'agents', 'agent-1', '.codex'),
    );
    expect(fs.existsSync(path.join(sub, 'auth.json'))).toBe(true);
  });
});

// ─── buildVolumeMounts ───────────────────────────────────────────────

describe('buildVolumeMounts（Docker 挂载构造）', () => {
  test('核心挂载：codex home 读写挂到 /home/node/.codex（替换 .claude）+ 基础工作区', async () => {
    const folder = 'bm-core';
    const codexHome = await provisionCodexHome(folder);
    const mounts = buildVolumeMounts(makeGroup(folder), false, codexHome);

    const byTarget = new Map(mounts.map((m) => [m.containerPath, m]));
    expect(byTarget.get('/home/node/.codex')).toMatchObject({
      hostPath: codexHome,
      readonly: false,
    });
    expect(byTarget.get('/workspace/group')?.hostPath).toBe(path.join(GROUPS_DIR, folder));
    expect(byTarget.get('/workspace/ipc')?.hostPath).toBe(path.join(DATA_DIR, 'ipc', folder));
    expect(byTarget.get('/workspace/memory')?.hostPath).toBe(
      path.join(DATA_DIR, 'memory', folder),
    );
    expect(byTarget.get('/workspace/global')?.hostPath).toBe(
      path.join(GROUPS_DIR, 'user-global', 'u1'),
    );
    expect(byTarget.has('/workspace/extra')).toBe(true);
    expect(byTarget.get('/home/node/.feishu-cli')?.readonly).toBe(false);
  });

  test('Claude 时代挂载点全部消失（.claude/.claude.json/skills/plugins/src 热挂载/CLAUDE.md）', async () => {
    const folder = 'bm-noclaude';
    const codexHome = await provisionCodexHome(folder);
    const mounts = buildVolumeMounts(makeGroup(folder), true, codexHome);
    const targets = mounts.map((m) => m.containerPath);

    for (const gone of [
      '/home/node/.claude',
      '/home/node/.claude.json',
      '/workspace/project-skills',
      '/workspace/user-skills',
      '/workspace/external-skills',
      '/workspace/plugins',
      '/app/src',
      '/workspace/CLAUDE.md',
      '/workspace/.claude/rules',
    ]) {
      expect(targets).not.toContain(gone);
    }
  });

  test('admin home：项目根读写挂载 /workspace/project；非 admin 无', async () => {
    const folder = 'bm-admin';
    const codexHome = await provisionCodexHome(folder);
    const adminMounts = buildVolumeMounts(makeGroup(folder), true, codexHome);
    expect(
      adminMounts.find((m) => m.containerPath === '/workspace/project'),
    ).toMatchObject({ readonly: false });

    const memberMounts = buildVolumeMounts(makeGroup(folder), false, codexHome);
    expect(memberMounts.map((m) => m.containerPath)).not.toContain('/workspace/project');
  });

  test('sub-agent：IPC 挂载落 agents/{agentId} 子空间', async () => {
    const folder = 'bm-agent';
    const codexHome = await provisionCodexHome(folder, 'a1');
    const mounts = buildVolumeMounts(makeGroup(folder), false, codexHome, 'a1');
    expect(mounts.find((m) => m.containerPath === '/workspace/ipc')?.hostPath).toBe(
      path.join(DATA_DIR, 'ipc', folder, 'agents', 'a1'),
    );
  });

  test('env 文件：仅 customEnv 进入（零 ANTHROPIC_* 行，override 残留 provider 字段被忽略）', async () => {
    const folder = 'bm-env';
    // 写群组级 container-env 配置：customEnv + 残留的 anthropic 字段（必须被忽略）。
    const envCfgDir = path.join(DATA_DIR, 'config', 'container-env');
    fs.mkdirSync(envCfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(envCfgDir, `${folder}.json`),
      JSON.stringify({
        anthropicApiKey: 'sk-should-never-appear',
        anthropicBaseUrl: 'https://should.never.appear',
        customEnv: { FOO_BAR: 'baz' },
      }),
    );

    const codexHome = await provisionCodexHome(folder);
    const mounts = buildVolumeMounts(makeGroup(folder), false, codexHome);
    const envMount = mounts.find((m) => m.containerPath === '/workspace/env-dir');
    expect(envMount).toMatchObject({ readonly: true });

    const envFile = path.join(DATA_DIR, 'env', folder, 'env');
    const content = fs.readFileSync(envFile, 'utf8');
    expect(content).toContain('FOO_BAR');
    expect(content).not.toMatch(/ANTHROPIC_/);
    expect(content).not.toContain('should-never-appear');
  });

  test('无 customEnv 配置时不产生 env-dir 挂载', async () => {
    const folder = 'bm-noenv';
    const codexHome = await provisionCodexHome(folder);
    const mounts = buildVolumeMounts(makeGroup(folder), false, codexHome);
    expect(mounts.map((m) => m.containerPath)).not.toContain('/workspace/env-dir');
  });
});

// ─── 快照写入（纯 port 行为） ─────────────────────────────────────────

describe('writeTasksSnapshot / writeGroupsSnapshot', () => {
  const task = (id: string, groupFolder: string) => ({
    id,
    groupFolder,
    prompt: 'p',
    schedule_type: 'cron',
    schedule_value: '* * * * *',
    status: 'active',
    next_run: null,
  });

  test('writeTasksSnapshot：admin 看全部，member 只看自己', () => {
    const tasks = [task('t1', 'snap-a'), task('t2', 'snap-b')];

    writeTasksSnapshot('snap-a', false, tasks);
    const memberSeen = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'ipc', 'snap-a', 'current_tasks.json'), 'utf8'),
    ) as Array<{ id: string }>;
    expect(memberSeen.map((t) => t.id)).toEqual(['t1']);

    writeTasksSnapshot('snap-admin', true, tasks);
    const adminSeen = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'ipc', 'snap-admin', 'current_tasks.json'), 'utf8'),
    ) as Array<{ id: string }>;
    expect(adminSeen.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  test('writeGroupsSnapshot：admin 可见全部群组，member 为空', () => {
    const groups = [
      { jid: 'g1@x', name: 'G1', lastActivity: 'now', isRegistered: false },
    ];

    writeGroupsSnapshot('snap-gm', false, groups, new Set());
    const memberSeen = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'ipc', 'snap-gm', 'available_groups.json'), 'utf8'),
    ) as { groups: unknown[] };
    expect(memberSeen.groups).toEqual([]);

    writeGroupsSnapshot('snap-ga', true, groups, new Set());
    const adminSeen = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'ipc', 'snap-ga', 'available_groups.json'), 'utf8'),
    ) as { groups: Array<{ jid: string }> };
    expect(adminSeen.groups.map((g) => g.jid)).toEqual(['g1@x']);
  });
});
