/**
 * FsCodexHomeProvisioner × modelProvider 接线点单测（调和式，非只追加）——
 *   - provider 提供：happycodex 拥有顶层 model/model_provider + [model_providers.<id>] 段
 *     （env_key 固定 CODEX_CUSTOM_API_KEY，wire_api 默认 responses），覆盖既有同名/同 id；
 *   - provider 缺失（删除/无 key）：剥离 happycodex 管理的 provider 配置 → 自愈回退默认；
 *   - 改名/改 model：旧 id 段剥离、新值写入；幂等：二次 provision 结果稳定。
 * apiKey 绝不落 config.toml（只引用 env_key）。
 * 与 ensureProjectDocSettings 的顶层键插入共存不冲突（都插在首个表头前）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { FsCodexHomeProvisioner } from '../src/runtime/multitenant/codex-home.js';

const FOLDER = 'home-model-provider';
const AUTH_CONTENT = '{"tokens":{"access":"t"}}';
const PROVIDER = {
  id: 'glm',
  name: 'GLM Provider',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4.6',
} as const;

let sharedCodexHome: string;
let dataDir: string;

beforeEach(async () => {
  sharedCodexHome = await mkdtemp(path.join(os.tmpdir(), 'happycodex-shared-'));
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'happycodex-data-'));
  await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
});

afterEach(async () => {
  await rm(sharedCodexHome, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('FsCodexHomeProvisioner — modelProvider 接线点', () => {
  it('写顶层 model + model_provider + [model_providers.<id>] 段（env_key 固定，wire_api 默认 responses）', async () => {
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      modelProvider: { ...PROVIDER },
    });

    const codexHome = await prov.provision(FOLDER);
    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');

    // 顶层选用键。
    expect(content).toContain('model = "glm-4.6"');
    expect(content).toContain('model_provider = "glm"');
    // provider 段。
    expect(content).toContain('[model_providers.glm]');
    expect(content).toContain('name = "GLM Provider"');
    expect(content).toContain('base_url = "https://open.bigmodel.cn/api/paas/v4"');
    expect(content).toContain('env_key = "CODEX_CUSTOM_API_KEY"');
    // wire_api 默认 responses（apiKey 绝不落盘）。
    expect(content).toContain('wire_api = "responses"');
    expect(content).not.toContain('api_key');

    // 顶层键须在第一个表头之前。
    const headerIdx = content.search(/^\s*\[/m);
    const modelIdx = content.indexOf('model = "glm-4.6"');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeLessThan(headerIdx);
  });

  it('wireApi 显式 chat → 段内写 wire_api = "chat"', async () => {
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      modelProvider: { ...PROVIDER, wireApi: 'chat' },
    });

    const codexHome = await prov.provision(FOLDER);
    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content).toContain('wire_api = "chat"');
    expect(content).not.toContain('wire_api = "responses"');
  });

  it('二次 provision 幂等：顶层键与 provider 段均不重复', async () => {
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      modelProvider: { ...PROVIDER },
    });

    await prov.provision(FOLDER);
    const codexHome = await prov.provision(FOLDER);
    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');

    expect(content.match(/^\s*model\s*=/gm)?.filter((m) => !m.includes('model_provider'))).toHaveLength(1);
    expect(content.match(/^model_provider\s*=/gm)).toHaveLength(1);
    expect(content.match(/\[model_providers\.glm\]/g)).toHaveLength(1);
  });

  it('调和：配 provider 时顶层 model 由 provider 决定（覆盖既有 model，无重复键）', async () => {
    // 既有一个本地 model pin（无 model_provider/无 provider 段）。
    const prov1 = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });
    const codexHome = await prov1.provision(FOLDER);
    await writeFile(
      path.join(codexHome, 'config.toml'),
      'model = "local-pinned"\n',
      'utf8',
    );

    const prov2 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      modelProvider: { ...PROVIDER },
    });
    await prov2.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    // provider 的 model 胜出，旧 pin 被覆盖；model 键只出现一次（无重复非法 TOML）。
    expect(content).toContain('model = "glm-4.6"');
    expect(content).not.toContain('model = "local-pinned"');
    expect(content.match(/^model\s*=/gm)).toHaveLength(1);
    expect(content).toContain('model_provider = "glm"');
    expect(content).toContain('[model_providers.glm]');
  });

  it('调和：同 id 段被 happycodex 接管重写（段头只一次，内容为 happycodex 的）', async () => {
    const prov1 = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });
    const codexHome = await prov1.provision(FOLDER);
    await writeFile(
      path.join(codexHome, 'config.toml'),
      '[model_providers.glm]\nname = "local-custom-name"\nbase_url = "https://local.example.com"\n',
      'utf8',
    );

    const prov2 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      modelProvider: { ...PROVIDER },
    });
    await prov2.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    // happycodex 拥有该 id：段头只一次，内容是 happycodex 的（旧 user-authored 同 id 段被覆盖）。
    expect(content.match(/\[model_providers\.glm\]/g)).toHaveLength(1);
    expect(content).toContain('name = "GLM Provider"');
    expect(content).toContain('env_key = "CODEX_CUSTOM_API_KEY"');
    expect(content).not.toContain('name = "local-custom-name"');
  });

  it('调和：删除 provider（不传 modelProvider）→ 剥离残留 model/model_provider/段，自愈', async () => {
    // 1) 先配 provider。
    const prov1 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      modelProvider: { ...PROVIDER },
    });
    const codexHome = await prov1.provision(FOLDER);
    let content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content).toContain('model_provider = "glm"');
    expect(content).toContain('[model_providers.glm]');

    // 2) 删除（不传 modelProvider）→ 应剥离 happycodex 管理的 provider 配置。
    const prov2 = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });
    await prov2.provision(FOLDER);
    content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(content).not.toContain('model_provider = "glm"');
    expect(content).not.toContain('[model_providers.glm]');
    expect(content).not.toContain('model = "glm-4.6"');
  });

  it('调和：改名/改 model → 旧 id 段剥离、新值写入（不残留旧 provider）', async () => {
    const prov1 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      modelProvider: { ...PROVIDER }, // id glm, model glm-4.6
    });
    const codexHome = await prov1.provision(FOLDER);

    const prov2 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      modelProvider: { id: 'glm-v2', name: 'GLM v2', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-4.6-air' },
    });
    await prov2.provision(FOLDER);

    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    // 旧 id/model 全部清除，新值生效。
    expect(content).not.toContain('[model_providers.glm]');
    expect(content).not.toContain('model = "glm-4.6"\n');
    expect(content).toContain('model = "glm-4.6-air"');
    expect(content).toContain('model_provider = "glm-v2"');
    expect(content).toContain('[model_providers.glm-v2]');
    expect(content.match(/^model_provider\s*=/gm)).toHaveLength(1);
  });

  it('不提供 modelProvider → 不创建 / 不写 model 相关键', async () => {
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });
    const codexHome = await prov.provision(FOLDER);

    // 共享端无 config.toml，没有 modelProvider 不应凭空创建。
    let content = '';
    try {
      content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    } catch {
      content = '';
    }
    expect(content).not.toContain('model_provider');
    expect(content).not.toContain('[model_providers.');
  });
});

describe('FsCodexHomeProvisioner — modelProvider × project_doc 顶层键共存', () => {
  it('modelProvider + projectDoc 同时提供：四个顶层键全在首个表头之前，互不冲突', async () => {
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      projectDocFallbackFilenames: ['CLAUDE.md'],
      projectDocMaxBytes: 64 * 1024,
      modelProvider: { ...PROVIDER },
    });

    const codexHome = await prov.provision(FOLDER);
    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');

    // 四个顶层键都存在。
    expect(content).toContain('project_doc_fallback_filenames = ["CLAUDE.md"]');
    expect(content).toContain('project_doc_max_bytes = 65536');
    expect(content).toContain('model = "glm-4.6"');
    expect(content).toContain('model_provider = "glm"');
    // provider 段也存在。
    expect(content).toContain('[model_providers.glm]');

    // 全部顶层键都落在第一个表头（[model_providers.glm]）之前。
    const headerIdx = content.search(/^\s*\[/m);
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    for (const key of [
      'project_doc_fallback_filenames',
      'project_doc_max_bytes',
      'model = "glm-4.6"',
      'model_provider',
    ]) {
      const idx = content.indexOf(key);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(headerIdx);
    }
  });

  it('存量 config 已有 projectDoc 顶层键 + 已 provision 过 → 再加 modelProvider 只补 model 相关键，不重复 projectDoc 键', async () => {
    // 第一轮：只写 projectDoc。
    const prov1 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      projectDocFallbackFilenames: ['CLAUDE.md'],
      projectDocMaxBytes: 64 * 1024,
    });
    await prov1.provision(FOLDER);

    // 第二轮：projectDoc + modelProvider 都给。
    const prov2 = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      projectDocFallbackFilenames: ['CLAUDE.md'],
      projectDocMaxBytes: 64 * 1024,
      modelProvider: { ...PROVIDER },
    });
    const codexHome = await prov2.provision(FOLDER);
    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8');

    // projectDoc 键不重复。
    expect(content.match(/project_doc_fallback_filenames\s*=/g)).toHaveLength(1);
    expect(content.match(/project_doc_max_bytes\s*=/g)).toHaveLength(1);
    // model 相关键补上了。
    expect(content).toContain('model = "glm-4.6"');
    expect(content).toContain('model_provider = "glm"');
    expect(content).toContain('[model_providers.glm]');
  });
});
