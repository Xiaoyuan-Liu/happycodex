/**
 * container-runner × per-user 自定义 provider env 注入单测。
 *
 * buildAgentEnvLines 是私有函数 —— 经其唯一公开消费面 runHostAgent 端到端验证：
 * host 模式把 buildAgentEnvLines 产物直接合并进 spawn 的 hostEnv（fake runner 把
 * process.env dump 到文件供断言）。
 *   - owner 配了 provider（含 apiKey）→ 注入 CODEX_CUSTOM_API_KEY=<解密 key>；
 *   - owner 未配 provider / 无 created_by → 不注入；
 *   - owner 配了 provider 但 apiKey 为空 → 不注入（与 resolveModelProvider 同门控）。
 * 另：shellQuoteEnvLines（容器路径转义器，公开）对含特殊字符的 apiKey 单引号安全转义，
 * 且 normalizeSecret 已剥换行 —— 二者合证 apiKey 不破坏 env 文件。
 *
 * config.js 重定向 tmp：DATA_DIR/GROUPS_DIR 落 tmp，per-user provider.json 与加密 key
 * 也落同一 tmp DATA_DIR（runtime-config 与 container-runner 共享同一 config mock）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/config.js')>();
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pathm = await import('node:path');
  const tmpRoot = fsm.realpathSync(
    fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'hcx-codex-env-')),
  );
  return {
    ...orig,
    DATA_DIR: pathm.join(tmpRoot, 'data'),
    GROUPS_DIR: pathm.join(tmpRoot, 'data', 'groups'),
    MOUNT_ALLOWLIST_PATH: pathm.join(tmpRoot, 'config', 'mount-allowlist.json'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

import { DATA_DIR } from '../src/config.js';
import { runHostAgent, type ContainerInput, type ContainerOutput } from '../src/container-runner.js';
import { saveUserCodexProvider, shellQuoteEnvLines } from '../src/runtime-config.js';
import type { RegisteredGroup } from '../src/types.js';

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const FAKE_RUNNER = path.join(helpersDir, 'helpers', 'fake-agent-runner.mjs');

const ENV_KEYS = [
  'HAPPYCODEX_RUNNER_CMD',
  'HAPPYCODEX_TEST_DUMP',
  'HAPPYCODEX_TEST_MODE',
  'HAPPYCODEX_SHARED_CODEX_HOME',
  'CODEX_CUSTOM_API_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let sharedHome: string;

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
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
  // 外层环境若残留 CODEX_CUSTOM_API_KEY 会污染「不注入」断言 —— 清掉。
  delete process.env.CODEX_CUSTOM_API_KEY;
});

function makeGroup(folder: string, overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: `Group ${folder}`,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    is_home: true,
    created_by: 'owner-1',
    containerConfig: { timeout: 15_000 },
    ...overrides,
  };
}

function makeInput(folder: string, overrides: Partial<ContainerInput> = {}): ContainerInput {
  return {
    prompt: 'hi',
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

async function runHostWithDump(group: RegisteredGroup, input: ContainerInput): Promise<DumpShape> {
  const dumpPath = path.join(DATA_DIR, `dump-${group.folder}-${Date.now()}.json`);
  process.env.HAPPYCODEX_TEST_DUMP = dumpPath;
  const outputs: ContainerOutput[] = [];
  await runHostAgent(group, input, () => {}, async (out) => {
    outputs.push(out);
  });
  return JSON.parse(fs.readFileSync(dumpPath, 'utf8')) as DumpShape;
}

describe('buildAgentEnvLines（经 runHostAgent）— CODEX_CUSTOM_API_KEY 注入门控', () => {
  test('owner 配了含 apiKey 的 provider → 注入解密后的 CODEX_CUSTOM_API_KEY', async () => {
    const folder = 'env-has-provider';
    saveUserCodexProvider('owner-1', {
      name: 'GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.6',
      apiKey: 'sk-injected-secret-1234',
    });

    const dump = await runHostWithDump(makeGroup(folder), makeInput(folder));
    expect(dump.env.CODEX_CUSTOM_API_KEY).toBe('sk-injected-secret-1234');
  });

  test('owner 未配 provider → 不注入 CODEX_CUSTOM_API_KEY', async () => {
    const folder = 'env-no-provider';
    const dump = await runHostWithDump(
      makeGroup(folder, { created_by: 'owner-without-provider' }),
      makeInput(folder),
    );
    expect(dump.env.CODEX_CUSTOM_API_KEY).toBeUndefined();
  });

  test('group 无 created_by → 不注入（无 owner 可解析）', async () => {
    const folder = 'env-no-owner';
    const dump = await runHostWithDump(
      makeGroup(folder, { created_by: undefined }),
      makeInput(folder),
    );
    expect(dump.env.CODEX_CUSTOM_API_KEY).toBeUndefined();
  });

  test('owner 配了 provider 但 apiKey 为空 → 不注入（与 resolveModelProvider 同门控）', async () => {
    const folder = 'env-empty-key';
    saveUserCodexProvider('owner-emptykey', {
      name: 'p',
      baseUrl: 'https://api.example.com',
      model: 'm',
      apiKey: '',
    });
    const dump = await runHostWithDump(
      makeGroup(folder, { created_by: 'owner-emptykey' }),
      makeInput(folder),
    );
    expect(dump.env.CODEX_CUSTOM_API_KEY).toBeUndefined();
  });
});

describe('shell 安全：apiKey 特殊字符不破坏 env 文件', () => {
  test('shellQuoteEnvLines 单引号转义含特殊字符的 apiKey（容器路径转义器，可逆）', () => {
    // apiKey 经 normalizeSecret 剥空白/非 ASCII，但仍可能含 shell 元字符（$ ' " ` 等）。
    const apiKey = "sk-$weird'\"`;&|value";
    const lines = shellQuoteEnvLines([`CODEX_CUSTOM_API_KEY=${apiKey}`]);
    expect(lines).toHaveLength(1);
    const quoted = lines[0] as string;
    // 键名保留；值整体单引号包裹。
    expect(quoted.startsWith("CODEX_CUSTOM_API_KEY='")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // 内嵌单引号转义为 bash 安全序列（关闭引号 + 转义单引号 + 重开引号）。
    expect(quoted.includes("'\\''")).toBe(true);
    // 不含裸换行（env 文件按行解析）。
    expect(quoted).not.toMatch(/[\r\n]/);

    // bash 解析该单引号字面量应原样还原 apiKey（转义可逆）。
    const valuePart = quoted.slice(quoted.indexOf('=') + 1);
    expect(decodeShellSingleQuoted(valuePart)).toBe(apiKey);
  });

  test('saveUserCodexProvider 剥换行：解密 key 无空白，转义后注入值不含换行', () => {
    const pub = saveUserCodexProvider('owner-newline', {
      name: 'p',
      baseUrl: 'https://api.example.com',
      model: 'm',
      apiKey: 'sk-line1\nline2\r\n  spaced ',
    });
    expect(pub.hasApiKey).toBe(true);
    // normalizeSecret 剥 \s+：mask 末 4 位来自去空白后的尾部。
    expect(pub.apiKeyMask).toBe('••••aced');

    const quoted = shellQuoteEnvLines([`CODEX_CUSTOM_API_KEY=sk-line1line2spaced`])[0] as string;
    expect(quoted).not.toMatch(/[\r\n]/);
    expect(decodeShellSingleQuoted(quoted.slice(quoted.indexOf('=') + 1))).toBe(
      'sk-line1line2spaced',
    );
  });
});

/**
 * 还原 bash 单引号字面量为原始值，与 shellQuoteEnvLines 互逆。
 * 文法：值由若干单引号段与字面单引号段拼接（关闭引号 + 反斜杠转义单引号 + 重开引号）。
 * 逐字符扫描而非正则替换，避免占位符与真实空格冲突。
 */
function decodeShellSingleQuoted(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      i += 1; // 进入单引号段
      while (i < s.length && s[i] !== "'") {
        out += s[i];
        i += 1;
      }
      i += 1; // 跳过关闭单引号
    } else if (s[i] === '\\' && s[i + 1] === "'") {
      out += "'"; // 反斜杠转义的字面单引号
      i += 2;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}
