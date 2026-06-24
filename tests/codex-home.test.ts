/**
 * FsCodexHomeProvisioner 单测 —— 用临时目录验证隔离 CODEX_HOME 准备 + 共享 auth 复制 + 幂等 + 路径逃逸防护。
 *
 * 每个用例用 os.tmpdir() 下两个唯一子目录（假的 sharedCodexHome + dataDir），afterEach 清理，互不干扰。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access, utimes } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FsCodexHomeProvisioner } from '../src/runtime/multitenant/codex-home.js';
import { PREDEFINED_AGENTS, renderAgentToml } from '../src/runtime/multitenant/agent-defs.js';

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
  it('provision 两次不覆盖更新的目标 auth.json（保留 per-folder 自己刷新的 token）', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);

    // 模拟 per-folder 自己刷新了 token，写入了不同内容。
    const refreshed = '{"tokens":{"access":"per-folder-refreshed"}}';
    await writeFile(path.join(codexHome, 'auth.json'), refreshed, 'utf8');
    await utimes(path.join(sharedCodexHome, 'auth.json'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(path.join(codexHome, 'auth.json'), new Date('2026-01-01T00:00:10Z'), new Date('2026-01-01T00:00:10Z'));

    // 再次 provision —— 不应被源覆盖。
    const codexHome2 = await prov.provision(FOLDER);
    expect(codexHome2).toBe(codexHome);

    const after = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
    expect(after).toBe(refreshed);
    expect(after).not.toBe(AUTH_CONTENT);
  });

  it('源 auth.json 更新后会覆盖旧目标 auth.json（设备码重登传播到旧会话）', async () => {
    const original = '{"tokens":{"access":"old-source"}}';
    const renewed = '{"tokens":{"access":"renewed-source"}}';
    await writeFile(path.join(sharedCodexHome, 'auth.json'), original, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);
    expect(await readFile(path.join(codexHome, 'auth.json'), 'utf8')).toBe(original);

    await writeFile(path.join(sharedCodexHome, 'auth.json'), renewed, 'utf8');
    await utimes(path.join(codexHome, 'auth.json'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(path.join(sharedCodexHome, 'auth.json'), new Date('2026-01-01T00:00:10Z'), new Date('2026-01-01T00:00:10Z'));

    await prov.provision(FOLDER);

    expect(await readFile(path.join(codexHome, 'auth.json'), 'utf8')).toBe(renewed);
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

describe('FsCodexHomeProvisioner — B2 预定义子代理 TOML', () => {
  it('provision 写出 agents/<name>.toml（含 name/description/developer_instructions）', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);

    for (const def of PREDEFINED_AGENTS) {
      const tomlPath = path.join(codexHome, 'agents', `${def.name}.toml`);
      expect(await exists(tomlPath)).toBe(true);
      const content = await readFile(tomlPath, 'utf8');
      expect(content).toContain(`name = "${def.name}"`);
      expect(content).toContain('developer_instructions = """');
      expect(content).toContain(def.description);
    }
  });

  it('幂等：再次 provision 不覆盖已被本地修改的 agent TOML', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);
    const target = path.join(codexHome, 'agents', `${PREDEFINED_AGENTS[0]!.name}.toml`);

    const local = 'name = "code-reviewer"\ndescription = "local override"\n';
    await writeFile(target, local, 'utf8');

    await prov.provision(FOLDER); // 再次 provision

    const after = await readFile(target, 'utf8');
    expect(after).toBe(local); // 未被覆盖
  });
});

describe('renderAgentToml', () => {
  it('渲染 name/description/三引号 developer_instructions', () => {
    const toml = renderAgentToml({
      name: 'x',
      description: 'desc',
      developerInstructions: 'line1\nline2',
    });
    expect(toml).toContain('name = "x"');
    expect(toml).toContain('description = "desc"');
    expect(toml).toContain('developer_instructions = """\nline1\nline2\n"""');
  });

  it('转义 name/description 中的双引号与反斜杠', () => {
    const toml = renderAgentToml({
      name: 'a"b',
      description: 'c\\d',
      developerInstructions: 'x',
    });
    expect(toml).toContain('name = "a\\"b"');
    expect(toml).toContain('description = "c\\\\d"');
  });

  it('防御：developer_instructions 内的连续三引号被降级，不破坏字面闭合', () => {
    const toml = renderAgentToml({
      name: 'n',
      description: 'd',
      developerInstructions: 'before """ after',
    });
    expect(toml).not.toContain('before """ after');
    expect(toml).toContain('before ""\\" after');
  });
});

describe('FsCodexHomeProvisioner — B3 hooks 配置注入', () => {
  it('enableHooks=false（默认）→ 不写 hooks.json、不动 config.toml 的 [features]', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);

    expect(await exists(path.join(codexHome, 'hooks.json'))).toBe(false);
  });

  it('enableHooks=true → 写 hooks.json（SessionStart + Stop）+ config.toml [features] hooks=true', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome, enableHooks: true });

    const codexHome = await prov.provision(FOLDER);

    const hooksTxt = await readFile(path.join(codexHome, 'hooks.json'), 'utf8');
    const parsed = JSON.parse(hooksTxt);
    expect(Object.keys(parsed.hooks)).toEqual(['SessionStart', 'Stop']);
    expect(parsed.hooks.SessionStart[0].hooks[0].type).toBe('command');

    const cfg = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(cfg).toContain('[features]');
    expect(cfg).toMatch(/^hooks = true$/m);
  });

  it('enableHooks=true 且 shared config.toml 已有内容 → 合并 [features]，不破坏既有键', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    await writeFile(path.join(sharedCodexHome, 'config.toml'), 'model = "o3"\n', 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome, enableHooks: true });

    const codexHome = await prov.provision(FOLDER);

    const cfg = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(cfg).toContain('model = "o3"'); // 既有键保留
    expect(cfg).toMatch(/^hooks = true$/m);
  });

  it('hookCommands 可注入自定义命令', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      enableHooks: true,
      hookCommands: { sessionStartCommand: 'echo CUSTOM_SS', stopCommand: 'echo CUSTOM_STOP', timeoutSec: 7 },
    });

    const codexHome = await prov.provision(FOLDER);

    const parsed = JSON.parse(await readFile(path.join(codexHome, 'hooks.json'), 'utf8'));
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('echo CUSTOM_SS');
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('echo CUSTOM_STOP');
    expect(parsed.hooks.SessionStart[0].hooks[0].timeout).toBe(7);
  });

  it('幂等：再次 provision 不覆盖已被本地修改的 hooks.json，且不重复写 [features]', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome, enableHooks: true });

    const codexHome = await prov.provision(FOLDER);
    const hooksPath = path.join(codexHome, 'hooks.json');
    const local = '{"hooks":{"SessionStart":[],"Stop":[]}}';
    await writeFile(hooksPath, local, 'utf8');

    await prov.provision(FOLDER); // 再次

    expect(await readFile(hooksPath, 'utf8')).toBe(local); // 未覆盖
    const cfg = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(cfg.match(/hooks = true/g)).toHaveLength(1); // 不重复
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

describe('FsCodexHomeProvisioner — per-user authSourceDir（契约：auth 源切到 per-user）', () => {
  const USER_AUTH_CONTENT = '{"tokens":{"access":"per-user-token"}}';

  let userAuthDir: string;

  beforeEach(async () => {
    userAuthDir = await mkdtemp(path.join(os.tmpdir(), 'happycodex-userauth-'));
  });

  afterEach(async () => {
    await rm(userAuthDir, { recursive: true, force: true });
  });

  it('authSourceDir 存在 auth.json → per-user 优先：复制的是 per-user 凭据（非 shared）', async () => {
    // shared 与 per-user 都有 auth.json，但内容不同——验证复制的是 per-user。
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    await writeFile(path.join(userAuthDir, 'auth.json'), USER_AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      authSourceDir: userAuthDir,
    });

    const codexHome = await prov.provision(FOLDER);

    const copied = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
    expect(copied).toBe(USER_AUTH_CONTENT);
    expect(copied).not.toBe(AUTH_CONTENT);
  });

  it('config.toml 仍取 sharedCodexHome（authSourceDir 只覆盖 auth.json）', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    await writeFile(path.join(sharedCodexHome, 'config.toml'), CONFIG_CONTENT, 'utf8');
    await writeFile(path.join(userAuthDir, 'auth.json'), USER_AUTH_CONTENT, 'utf8');
    // per-user 目录里放一个不同的 config.toml——不应被使用（config 源恒为 shared）。
    await writeFile(path.join(userAuthDir, 'config.toml'), 'model = "user-only"\n', 'utf8');
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      authSourceDir: userAuthDir,
    });

    const codexHome = await prov.provision(FOLDER);

    expect(await readFile(path.join(codexHome, 'auth.json'), 'utf8')).toBe(USER_AUTH_CONTENT);
    // config 来自 shared，而非 per-user。
    expect(await readFile(path.join(codexHome, 'config.toml'), 'utf8')).toBe(CONFIG_CONTENT);
  });

  it('缺省 authSourceDir（不传）→ 回退共享：复制的是 shared 凭据', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    // 不传 authSourceDir —— 等价于 fallback 开启 + per-user 缺失，调用方传 shared 作源。
    const prov = new FsCodexHomeProvisioner({ dataDir, sharedCodexHome });

    const codexHome = await prov.provision(FOLDER);

    expect(await readFile(path.join(codexHome, 'auth.json'), 'utf8')).toBe(AUTH_CONTENT);
  });

  it('authSourceDir 缺 auth.json（fallback 关闭场景：指向不含 auth 的 per-user 目录）→ 抛"未登录"错', async () => {
    // 模拟 container-runner 在 fallback 关闭 + per-user 未登录时，故意把 authSourceDir
    // 指向不含 auth.json 的 per-user 目录 → provision 抛错（呈现为"请先登录"）。
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    // userAuthDir 故意不写 auth.json。
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      authSourceDir: userAuthDir,
    });

    await expect(prov.provision(FOLDER)).rejects.toThrow(/auth\.json/);
  });

  it('authSourceDir 显式等于 sharedCodexHome（fallback 回退共享）→ 复制 shared 凭据成功', async () => {
    await writeFile(path.join(sharedCodexHome, 'auth.json'), AUTH_CONTENT, 'utf8');
    const prov = new FsCodexHomeProvisioner({
      dataDir,
      sharedCodexHome,
      authSourceDir: sharedCodexHome,
    });

    const codexHome = await prov.provision(FOLDER);

    expect(await readFile(path.join(codexHome, 'auth.json'), 'utf8')).toBe(AUTH_CONTENT);
  });
});
