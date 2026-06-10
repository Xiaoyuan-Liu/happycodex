/**
 * agent-capabilities（codex 版）单测 —— 改动点最小覆盖：
 *   - required 条目从 claude 换成 codex 二进制；claude 触点（含 resolveSdkBundledClaude）全消失；
 *   - checkHostCapabilities 进程级缓存 + resetHostCapabilitiesCache；
 *   - logCapabilityPreflight：required 缺失 → error，可选缺失 → warn，无缺失 → 不打。
 * 不对宿主机实际安装情况做断言（环境无关）。
 */
import { describe, expect, test, vi } from 'vitest';

const { errorMock, warnMock } = vi.hoisted(() => ({
  errorMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: errorMock,
  },
}));

const capabilities = await import('../src/agent-capabilities.js');
const {
  AGENT_CAPABILITIES,
  checkHostCapabilities,
  logCapabilityPreflight,
  resetHostCapabilitiesCache,
} = capabilities;

describe('AGENT_CAPABILITIES — codex 引擎条目', () => {
  test('required 条目是 codex 二进制（上游为 claude）', () => {
    const required = AGENT_CAPABILITIES.filter((c) => c.required);
    expect(required).toHaveLength(1);
    expect(required[0]?.binary).toBe('codex');
    expect(required[0]?.name).toBe('codex-cli');
    expect(required[0]?.installHint).toContain('@openai/codex');
  });

  test('claude 触点全消失：无 claude 条目、无 resolveSdkBundledClaude 导出', () => {
    expect(AGENT_CAPABILITIES.some((c) => c.binary === 'claude')).toBe(false);
    expect(
      AGENT_CAPABILITIES.some((c) => /claude/i.test(c.installHint)),
    ).toBe(false);
    expect('resolveSdkBundledClaude' in capabilities).toBe(false);
  });

  test('非引擎工具条目（feishu-cli / agent-browser / uv）原样保留', () => {
    const names = AGENT_CAPABILITIES.map((c) => c.name);
    expect(names).toContain('feishu-cli');
    expect(names).toContain('agent-browser');
    expect(names).toContain('uv');
  });
});

describe('checkHostCapabilities — 缓存语义', () => {
  test('两次调用返回同一 promise；reset 后重新探测；available+missing 覆盖全部条目', async () => {
    resetHostCapabilitiesCache();
    const p1 = checkHostCapabilities();
    const p2 = checkHostCapabilities();
    expect(p1).toBe(p2);

    const result = await p1;
    expect(result.available.length + result.missing.length).toBe(
      AGENT_CAPABILITIES.length,
    );

    resetHostCapabilitiesCache();
    const p3 = checkHostCapabilities();
    expect(p3).not.toBe(p1);
    await p3;
  });
});

describe('logCapabilityPreflight', () => {
  test('required 缺失 → logger.error；可选缺失 → logger.warn；无缺失 → 不打', () => {
    errorMock.mockClear();
    warnMock.mockClear();

    const codexCap = AGENT_CAPABILITIES.find((c) => c.binary === 'codex')!;
    const uvCap = AGENT_CAPABILITIES.find((c) => c.binary === 'uv')!;

    logCapabilityPreflight('g1', {
      available: [],
      missing: [codexCap, uvCap],
      envVars: {},
      resolvedPaths: {},
    });
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(errorMock.mock.calls[0]?.[1])).toContain('codex-cli');

    errorMock.mockClear();
    warnMock.mockClear();
    logCapabilityPreflight('g1', {
      available: [codexCap],
      missing: [],
      envVars: {},
      resolvedPaths: {},
    });
    expect(errorMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });
});
