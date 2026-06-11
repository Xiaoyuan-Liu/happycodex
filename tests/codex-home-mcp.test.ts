/**
 * FsCodexHomeProvisioner × mcpServers 接线点单测 ——
 * 可选 options.mcpServers 提供时，provision 把 [mcp_servers.*] 段幂等合并进
 * per-folder config.toml；不提供时完全不触碰 mcp_servers 配置。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FsCodexHomeProvisioner } from '../src/runtime/multitenant/codex-home.js';

const FOLDER = 'home-mcp';
const AUTH_CONTENT = '{"tokens":{"access":"t"}}';
const MCP_SERVERS = {
  files: { command: 'npx', args: ['-y', 'mcp-files'], env: { K: 'v' } },
};

let sharedCodexHome: string;
let dataDir: string;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  sharedCodexHome = await mkdtemp(path.join(os.tmpdir(), 'happycodex-shared-'));
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'happycodex-data-'));
  await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
});

afterEach(async () => {
  await rm(sharedCodexHome, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('FsCodexHomeProvisioner — mcpServers 接线点', () => {
  it('提供 mcpServers 时渲染 [mcp_servers.*] 进 per-folder config.toml（共享无 config.toml 也能新建）', async () => {
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      mcpServers: MCP_SERVERS,
    });

    const codexHome = await prov.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content).toContain('[mcp_servers.files]');
    expect(content).toContain('command = "npx"');
    expect(content).toContain('[mcp_servers.files.env]');
  });

  it('保留共享 config.toml 复制内容，在其后追加 mcp_servers 段', async () => {
    await writeFile(
      path.join(sharedCodexHome, 'config.toml'),
      'model = "o3"\n',
      'utf8',
    );
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      mcpServers: MCP_SERVERS,
    });

    const codexHome = await prov.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content.startsWith('model = "o3"\n')).toBe(true);
    expect(content).toContain('[mcp_servers.files]');
  });

  it('二次 provision 幂等：不重复追加段', async () => {
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      mcpServers: MCP_SERVERS,
    });

    await prov.provision(FOLDER);
    const codexHome = await prov.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content.match(/\[mcp_servers\.files\]/g)).toHaveLength(1);
  });

  it('per-folder 已有同名段（本地修改）→ 不覆盖', async () => {
    const prov1 = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });
    const codexHome = await prov1.provision(FOLDER);
    await writeFile(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.files]\ncommand = "local-custom"\n',
      'utf8',
    );

    const prov2 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      mcpServers: MCP_SERVERS,
    });
    await prov2.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content).toContain('command = "local-custom"');
    expect(content).not.toContain('command = "npx"');
  });

  it('不提供 mcpServers（或空对象）→ 不创建/不改 config.toml', async () => {
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      mcpServers: {},
    });

    const codexHome = await prov.provision(FOLDER);

    // 共享端没有 config.toml，空 mcpServers 不应凭空创建。
    expect(await exists(path.join(codexHome, 'config.toml'))).toBe(false);
  });
});

describe('FsCodexHomeProvisioner — project_doc 设置（fallback_filenames + max_bytes）', () => {
  it('写入 project_doc_fallback_filenames 与 project_doc_max_bytes（顶层）', async () => {
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      projectDocFallbackFilenames: ['CLAUDE.md'],
      projectDocMaxBytes: 64 * 1024,
    });

    const codexHome = await prov.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content).toContain('project_doc_fallback_filenames = ["CLAUDE.md"]');
    expect(content).toContain('project_doc_max_bytes = 65536');
    // 顶层键须在任意表头之前。
    const headerIdx = content.search(/^\s*\[/m);
    const maxIdx = content.indexOf('project_doc_max_bytes');
    expect(maxIdx).toBeGreaterThanOrEqual(0);
    if (headerIdx !== -1) expect(maxIdx).toBeLessThan(headerIdx);
  });

  it('二次 provision 幂等：两个键都不重复', async () => {
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      projectDocFallbackFilenames: ['CLAUDE.md'],
      projectDocMaxBytes: 64 * 1024,
    });

    await prov.provision(FOLDER);
    const codexHome = await prov.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content.match(/project_doc_fallback_filenames\s*=/g)).toHaveLength(1);
    expect(content.match(/project_doc_max_bytes\s*=/g)).toHaveLength(1);
  });

  it('已有 fallback 键、缺 max_bytes（存量 config）→ 只补 max_bytes，不动既有键', async () => {
    // 模拟旧版只写了 fallback 的 per-folder config.toml。
    const prov1 = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });
    const codexHome = await prov1.provision(FOLDER);
    await writeFile(
      path.join(codexHome, 'config.toml'),
      'project_doc_fallback_filenames = ["CLAUDE.md"]\n',
      'utf8',
    );

    const prov2 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      projectDocFallbackFilenames: ['CLAUDE.md'],
      projectDocMaxBytes: 64 * 1024,
    });
    await prov2.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content.match(/project_doc_fallback_filenames\s*=/g)).toHaveLength(1);
    expect(content).toContain('project_doc_max_bytes = 65536');
  });

  it('per-folder 已自定义 max_bytes（本地修改）→ 不覆盖', async () => {
    const prov1 = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });
    const codexHome = await prov1.provision(FOLDER);
    await writeFile(
      path.join(codexHome, 'config.toml'),
      'project_doc_fallback_filenames = ["CLAUDE.md"]\nproject_doc_max_bytes = 131072\n',
      'utf8',
    );

    const prov2 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      projectDocFallbackFilenames: ['CLAUDE.md'],
      projectDocMaxBytes: 64 * 1024,
    });
    await prov2.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content).toContain('project_doc_max_bytes = 131072');
    expect(content).not.toContain('project_doc_max_bytes = 65536');
  });
});
