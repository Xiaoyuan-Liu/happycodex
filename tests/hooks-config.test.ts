/**
 * tests/hooks-config.test.ts —— B3 hooks 配置生成 + 信任注入单测。
 *
 * 覆盖：
 *  - buildHooksJson / renderHooksJson：SessionStart + Stop 的真实落盘形状（PascalCase 键、command handler）。
 *  - hookStateKey：config.toml 信任态键的 snake_case 格式。
 *  - writeHooksJson / ensureHooksFeature / writeTrustedHashes：落盘幂等 + 合并不破坏既有内容。
 *  - selectManagedTrustEntries / trustManagedHooks：从 hooks/list 元数据挑本 home 的 SessionStart/Stop 信任。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  HOOKS_JSON_FILE,
  CONFIG_TOML_FILE,
  MANAGED_HOOK_EVENTS,
  buildHooksJson,
  renderHooksJson,
  hookStateKey,
  ensureHooksFeature,
  writeHooksJson,
  writeTrustedHashes,
  selectManagedTrustEntries,
  trustManagedHooks,
  listHooks,
  type HookListMetadata,
  type HooksListClient,
} from '../src/runtime/multitenant/hooks-config.js';

const BUILD = { sessionStartCommand: 'echo SS', stopCommand: 'echo STOP' };

let home: string;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'happycodex-hooks-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('buildHooksJson / renderHooksJson', () => {
  it('生成 SessionStart + Stop（PascalCase 键 + command handler + 默认 timeout=10）', () => {
    const j = buildHooksJson(BUILD);
    expect(Object.keys(j.hooks)).toEqual(['SessionStart', 'Stop']);
    expect(j.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo SS', timeout: 10 }] },
    ]);
    expect(j.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'echo STOP', timeout: 10 }] }]);
  });

  it('timeoutSec 可覆盖', () => {
    const j = buildHooksJson({ ...BUILD, timeoutSec: 3 });
    expect(j.hooks.SessionStart[0]!.hooks[0]!.timeout).toBe(3);
  });

  it('renderHooksJson 是合法 JSON，roundtrip 等价，末尾带换行', () => {
    const txt = renderHooksJson(buildHooksJson(BUILD));
    expect(txt.endsWith('\n')).toBe(true);
    expect(JSON.parse(txt)).toEqual(buildHooksJson(BUILD));
  });
});

describe('hookStateKey — config.toml 信任态键 snake_case 格式', () => {
  it('<hooks.json绝对路径>:<event_snake>:<group>:<handler>，默认 0:0', () => {
    expect(hookStateKey('/data/.codex/hooks.json', 'session_start')).toBe(
      '/data/.codex/hooks.json:session_start:0:0',
    );
    expect(hookStateKey('/data/.codex/hooks.json', 'stop', 1, 2)).toBe(
      '/data/.codex/hooks.json:stop:1:2',
    );
  });

  it('MANAGED_HOOK_EVENTS 三套命名对照正确（camelCase / PascalCase / snake_case）', () => {
    expect(MANAGED_HOOK_EVENTS).toEqual([
      { protocol: 'sessionStart', jsonKey: 'SessionStart', snake: 'session_start' },
      { protocol: 'stop', jsonKey: 'Stop', snake: 'stop' },
    ]);
  });
});

describe('writeHooksJson — 幂等', () => {
  it('首次写 hooks.json，返回绝对路径，内容为 SessionStart + Stop', async () => {
    const p = await writeHooksJson(home, BUILD);
    expect(p).toBe(path.join(home, HOOKS_JSON_FILE));
    const parsed = JSON.parse(await readFile(p, 'utf8'));
    expect(Object.keys(parsed.hooks)).toEqual(['SessionStart', 'Stop']);
  });

  it('已存在则不覆盖（保留 per-folder 本地修改）', async () => {
    const p = path.join(home, HOOKS_JSON_FILE);
    await writeFile(p, '{"hooks":{"local":true}}', 'utf8');
    await writeHooksJson(home, BUILD);
    expect(await readFile(p, 'utf8')).toBe('{"hooks":{"local":true}}');
  });
});

describe('ensureHooksFeature — [features] hooks=true 幂等合并', () => {
  it('config.toml 不存在 → 新建并写 [features] hooks=true', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    await ensureHooksFeature(cfg);
    const txt = await readFile(cfg, 'utf8');
    expect(txt).toContain('[features]');
    expect(txt).toMatch(/^hooks = true$/m);
  });

  it('已有 hooks=true → 不动（幂等，内容不变）', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    const original = 'model = "o3"\n\n[features]\nhooks = true\nother = false\n';
    await writeFile(cfg, original, 'utf8');
    await ensureHooksFeature(cfg);
    expect(await readFile(cfg, 'utf8')).toBe(original);
  });

  it('有 [features] 段但缺 hooks → 在段头后插入 hooks=true（保留既有键）', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    await writeFile(cfg, '[features]\nmemories = true\n', 'utf8');
    await ensureHooksFeature(cfg);
    const txt = await readFile(cfg, 'utf8');
    expect(txt).toMatch(/^hooks = true$/m);
    expect(txt).toContain('memories = true'); // 既有键保留
  });

  it('无 [features] 段（已有其它配置）→ 追加 [features] 段，不破坏既有', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    await writeFile(cfg, 'model = "o3"\n', 'utf8');
    await ensureHooksFeature(cfg);
    const txt = await readFile(cfg, 'utf8');
    expect(txt).toContain('model = "o3"');
    expect(txt).toContain('[features]');
    expect(txt).toMatch(/^hooks = true$/m);
  });

  it('两次调用幂等：第二次不重复追加', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    await ensureHooksFeature(cfg);
    const after1 = await readFile(cfg, 'utf8');
    await ensureHooksFeature(cfg);
    expect(await readFile(cfg, 'utf8')).toBe(after1);
    expect(after1.match(/hooks = true/g)).toHaveLength(1);
  });
});

describe('writeTrustedHashes — [hooks.state] trusted_hash 幂等合并', () => {
  const key = '/data/.codex/hooks.json:session_start:0:0';
  const hash = 'sha256:deadbeef';

  it('首次写入：追加 [hooks.state."<key>"] trusted_hash，返回写入条数', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    await writeFile(cfg, '[features]\nhooks = true\n', 'utf8');
    const n = await writeTrustedHashes(cfg, [{ key, hash }]);
    expect(n).toBe(1);
    const txt = await readFile(cfg, 'utf8');
    expect(txt).toContain(`[hooks.state."${key}"]`);
    expect(txt).toContain(`trusted_hash = "${hash}"`);
    expect(txt).toContain('[features]'); // 既有不破坏
  });

  it('已存在同名段 → 跳过、返回 0、不重复', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    await writeFile(cfg, '[features]\nhooks = true\n', 'utf8');
    await writeTrustedHashes(cfg, [{ key, hash }]);
    const n2 = await writeTrustedHashes(cfg, [{ key, hash }]);
    expect(n2).toBe(0);
    const txt = await readFile(cfg, 'utf8');
    expect(txt.match(new RegExp(`\\[hooks\\.state\\.`, 'g'))).toHaveLength(1);
  });

  it('多条混合：仅写缺失的，返回新写入数', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    await writeFile(cfg, '[features]\nhooks = true\n', 'utf8');
    const stopKey = '/data/.codex/hooks.json:stop:0:0';
    await writeTrustedHashes(cfg, [{ key, hash }]); // 先写 session_start
    const n = await writeTrustedHashes(cfg, [
      { key, hash }, // 已存在 → 跳过
      { key: stopKey, hash: 'sha256:cafef00d' }, // 新 → 写
    ]);
    expect(n).toBe(1);
    const txt = await readFile(cfg, 'utf8');
    expect(txt).toContain(`[hooks.state."${stopKey}"]`);
  });
});

describe('selectManagedTrustEntries — 从 hooks/list 元数据挑本 home 的 SessionStart/Stop', () => {
  const hooksPath = '/data/.codex/hooks.json';
  const meta = (over: Partial<HookListMetadata>): HookListMetadata => ({
    key: 'k',
    eventName: 'sessionStart',
    currentHash: 'sha256:aaa',
    trustStatus: 'untrusted',
    sourcePath: hooksPath,
    ...over,
  });

  it('只挑 sessionStart / stop（camelCase 匹配），组装 {key,hash}', () => {
    const metas = [
      meta({ key: 'k-ss', eventName: 'sessionStart', currentHash: 'sha256:1' }),
      meta({ key: 'k-stop', eventName: 'stop', currentHash: 'sha256:2' }),
      meta({ key: 'k-ptu', eventName: 'preToolUse', currentHash: 'sha256:3' }), // 忽略
    ];
    expect(selectManagedTrustEntries(metas, hooksPath)).toEqual([
      { key: 'k-ss', hash: 'sha256:1' },
      { key: 'k-stop', hash: 'sha256:2' },
    ]);
  });

  it('sourcePath 不匹配本 hooks.json → 排除（防误信任其它来源 hook）', () => {
    const metas = [meta({ sourcePath: '/other/hooks.json' })];
    expect(selectManagedTrustEntries(metas, hooksPath)).toEqual([]);
  });

  it('sourcePath 缺省 → 放宽接受（部分实现不回填）', () => {
    const metas = [meta({ sourcePath: undefined, key: 'k-ss', currentHash: 'sha256:9' })];
    expect(selectManagedTrustEntries(metas, hooksPath)).toEqual([{ key: 'k-ss', hash: 'sha256:9' }]);
  });

  it('多路径变体（symlink + realpath，macOS /var→/private/var）：任一匹配即接受', () => {
    // codex 回 realpath，我们写盘用 symlink 路径 → 须都接受，否则信任注入静默写 0 条、hook 永不触发。
    const realp = '/private/data/.codex/hooks.json';
    const metas = [meta({ sourcePath: realp, key: 'k-ss', currentHash: 'sha256:7' })];
    expect(selectManagedTrustEntries(metas, [hooksPath, realp])).toEqual([
      { key: 'k-ss', hash: 'sha256:7' },
    ]);
    // 仅传 symlink 路径（不含 realpath）→ 不匹配，被排除。
    expect(selectManagedTrustEntries(metas, hooksPath)).toEqual([]);
  });

  it('currentHash / key 空 → 跳过', () => {
    const metas = [meta({ currentHash: '' }), meta({ key: '' })];
    expect(selectManagedTrustEntries(metas, hooksPath)).toEqual([]);
  });
});

describe('listHooks / trustManagedHooks — 端到端（注入 fake client）', () => {
  class FakeClient implements HooksListClient {
    constructor(private readonly metas: HookListMetadata[], private readonly cwds: string[] = []) {}
    requested: Array<{ method: string; params: unknown }> = [];
    async request<T>(method: string, params?: unknown): Promise<T> {
      this.requested.push({ method, params });
      return { data: [{ cwd: this.cwds[0] ?? '', hooks: this.metas }] } as T;
    }
  }

  it('listHooks 调 hooks/list、传 cwds、解析 data[0].hooks', async () => {
    const c = new FakeClient([{ key: 'k', eventName: 'stop', currentHash: 'sha256:x', trustStatus: 'untrusted' }]);
    const metas = await listHooks(c, '/cwd');
    expect(c.requested[0]).toEqual({ method: 'hooks/list', params: { cwds: ['/cwd'] } });
    expect(metas).toHaveLength(1);
  });

  it('listHooks 容错：响应缺 data → 空数组', async () => {
    const c: HooksListClient = { request: async () => ({}) as never };
    expect(await listHooks(c, '/cwd')).toEqual([]);
  });

  it('trustManagedHooks：list → 选 → 写 trusted_hash，返回新写入数', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    await writeFile(cfg, '[features]\nhooks = true\n', 'utf8');
    const hooksPath = path.join(home, HOOKS_JSON_FILE);
    const c = new FakeClient([
      { key: `${hooksPath}:session_start:0:0`, eventName: 'sessionStart', currentHash: 'sha256:ss', trustStatus: 'untrusted', sourcePath: hooksPath },
      { key: `${hooksPath}:stop:0:0`, eventName: 'stop', currentHash: 'sha256:st', trustStatus: 'untrusted', sourcePath: hooksPath },
    ]);
    const n = await trustManagedHooks(c, home, hooksPath);
    expect(n).toBe(2);
    const txt = await readFile(cfg, 'utf8');
    expect(txt).toContain(`[hooks.state."${hooksPath}:session_start:0:0"]`);
    expect(txt).toContain('trusted_hash = "sha256:ss"');
    expect(txt).toContain(`[hooks.state."${hooksPath}:stop:0:0"]`);
  });

  it('trustManagedHooks 幂等：二次调用返回 0（已信任）', async () => {
    const cfg = path.join(home, CONFIG_TOML_FILE);
    await writeFile(cfg, '[features]\nhooks = true\n', 'utf8');
    const hooksPath = path.join(home, HOOKS_JSON_FILE);
    const c = new FakeClient([
      { key: `${hooksPath}:stop:0:0`, eventName: 'stop', currentHash: 'sha256:st', trustStatus: 'untrusted', sourcePath: hooksPath },
    ]);
    expect(await trustManagedHooks(c, home, hooksPath)).toBe(1);
    expect(await trustManagedHooks(c, home, hooksPath)).toBe(0);
  });

  it('trustManagedHooks：无可信任的 hook（list 返回空）→ 不建 config、返回 0', async () => {
    const hooksPath = path.join(home, HOOKS_JSON_FILE);
    const c = new FakeClient([]);
    expect(await trustManagedHooks(c, home, hooksPath)).toBe(0);
    expect(await exists(path.join(home, CONFIG_TOML_FILE))).toBe(false);
  });
});
