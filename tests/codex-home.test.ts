/**
 * FsCodexHomeProvisioner 单测 —— 用临时目录验证隔离 CODEX_HOME 准备 + 共享 auth 复制 + 幂等 + 路径逃逸防护。
 *
 * 每个用例用 os.tmpdir() 下两个唯一子目录（假的 sharedCodexHome + dataDir），afterEach 清理，互不干扰。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FsCodexHomeProvisioner } from '../src/runtime/multitenant/codex-home.js';

const FOLDER = 'home-test';
const AUTH_CONTENT = '{"tokens":{"access":"shared-account-token"}}';
const CONFIG_CONTENT = 'model = "o3"\n';

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
});

afterEach(async () => {
  await rm(sharedCodexHome, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('FsCodexHomeProvisioner — provision 正常路径', () => {
  it('codexHome 存在且含 auth.json，内容等于源；返回路径形如 .../sessions/{folder}/.codex', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);

    expect(path.isAbsolute(codexHome)).toBe(true);
    expect(codexHome).toBe(path.join(dataDir, 'sessions', FOLDER, '.codex'));
    expect(await exists(codexHome)).toBe(true);

    const copied = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
    expect(copied).toBe(AUTH_CONTENT);
  });

  it('config.toml 存在则复制', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    await writeFile(path.join(sharedCodexHome, 'config.toml'), CONFIG_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);

    const copied = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(copied).toBe(CONFIG_CONTENT);
  });

  it('config.toml 不存在则跳过、不报错', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);

    expect(await exists(path.join(codexHome, 'config.toml'))).toBe(false);
    // auth.json 仍然到位。
    expect(await exists(path.join(codexHome, 'auth.json'))).toBe(true);
  });
});

describe('FsCodexHomeProvisioner — 幂等', () => {
  it('provision 两次不覆盖已有 auth.json（保留 per-folder 自己刷新的 token）', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);

    // 模拟 per-folder 自己刷新了 token，写入了不同内容。
    const refreshed = '{"tokens":{"access":"per-folder-refreshed"}}';
    await writeFile(path.join(codexHome, 'auth.json'), refreshed, 'utf8');

    // 再次 provision —— 不应被源覆盖。
    const codexHome2 = await prov.provision(FOLDER);
    expect(codexHome2).toBe(codexHome);

    const after = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
    expect(after).toBe(refreshed);
    expect(after).not.toBe(AUTH_CONTENT);
  });

  it('config.toml 同样幂等：已有不被源覆盖', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    await writeFile(path.join(sharedCodexHome, 'config.toml'), CONFIG_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);

    const local = 'model = "local-override"\n';
    await writeFile(path.join(codexHome, 'config.toml'), local, 'utf8');

    await prov.provision(FOLDER);

    const after = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(after).toBe(local);
  });
});

describe('FsCodexHomeProvisioner — 错误路径', () => {
  it('sharedCodexHome 缺 auth.json → 抛错（说明未登录）', async () => {
    // 不写 auth.json。
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    await expect(prov.provision(FOLDER)).rejects.toThrow(/auth\.json/);
  });

  it("folder='../evil' → 抛错（逃出 sessions 目录）", async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    await expect(prov.provision('../evil')).rejects.toThrow();
  });

  it('folder 含中间 .. 段逃逸 → 抛错', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    await expect(prov.provision('a/../../evil')).rejects.toThrow();
  });

  it('绝对路径 folder → 抛错', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    await expect(prov.provision('/etc')).rejects.toThrow();
  });
});

describe('FsCodexHomeProvisioner — 合法嵌套 folder', () => {
  it('允许包含分隔符的合法子路径 folder（如 home-123）', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const folder = 'home-123';
    const codexHome = await prov.provision(folder);
    expect(codexHome).toBe(path.join(dataDir, 'sessions', folder, '.codex'));
    expect(await exists(path.join(codexHome, 'auth.json'))).toBe(true);
  });
});
