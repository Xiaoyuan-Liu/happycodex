/**
 * Agent Capability Preflight — shared capability declarations for host mode.
 *
 * Container mode gets these tools via Dockerfile; host mode relies on the
 * host OS having them installed.  This module detects what's available and
 * returns environment variables + log messages so `runHostAgent()` can act
 * on the results.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// happycodex：上游此处的 PROJECT_ROOT 锚点仅服务 resolveSdkBundledClaude（SDK 内置
// claude 二进制定位），随 Claude 触点一并删除 —— codex 引擎只认 PATH 上的 codex 二进制。

export interface AgentCapability {
  /** Human-readable name */
  name: string;
  /** Binary to look up in $PATH */
  binary: string;
  /** Extra env vars to inject when the tool is present */
  envVars?: Record<string, string>;
  /** Platform-specific overrides for envVars (merged on top) */
  platformEnvVars?: Partial<Record<NodeJS.Platform, Record<string, string>>>;
  /** If true the preflight logs an error; otherwise a warning */
  required: boolean;
  /** One-liner install command shown in the log */
  installHint: string;
}

export const AGENT_CAPABILITIES: AgentCapability[] = [
  // happycodex：上游 required 的 claude-code/claude 条目换成 codex 二进制检测。
  {
    name: 'codex-cli',
    binary: 'codex',
    required: true,
    installHint:
      'npm install -g @openai/codex (then authenticate via: codex login)',
  },
  {
    name: 'feishu-cli',
    binary: 'feishu-cli',
    required: false,
    installHint:
      'See scripts/install-host-tools.sh or: curl -fsSL https://github.com/riba2534/feishu-cli/releases/latest/download/install.sh | sh',
  },
  {
    name: 'agent-browser',
    binary: 'agent-browser',
    platformEnvVars: {
      darwin: {
        AGENT_BROWSER_EXECUTABLE_PATH:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      linux: {
        AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium',
      },
    },
    required: false,
    installHint: 'npm install -g agent-browser',
  },
  {
    name: 'uv',
    binary: 'uv',
    required: false,
    installHint: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
  },
];

async function isBinaryAvailable(binary: string): Promise<boolean> {
  // happycodex：上游对 claude 的 resolveSdkBundledClaude 短路特判已删除
  // （SDK 内置二进制是 Claude Agent SDK 专属机制，codex 无对应物）。
  try {
    await execFileAsync('which', [binary], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// happycodex：上游 resolveSdkBundledClaude() 整段删除 —— 它定位
// `container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk-<plat>-<arch>/claude`，
// 用于规避 PATH 上的 claude wrapper 劫持；codex 引擎无 SDK 内置二进制概念。

/**
 * Resolve the actual path of a binary.
 *
 * Uses `which` because `node_modules/.bin/` may contain stubs that shadow the
 * actual working binary.
 */
async function resolveBinaryPath(binary: string): Promise<string | null> {
  // happycodex：上游对 claude 的 SDK-bundled 优先分支已删除。
  try {
    const { stdout } = await execFileAsync('which', [binary], {
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface CapabilityCheckResult {
  available: AgentCapability[];
  missing: AgentCapability[];
  /** Env vars to inject into the host process (only for available tools) */
  envVars: Record<string, string>;
  /** Resolved paths for specific binaries (keyed by binary name) */
  resolvedPaths: Record<string, string>;
}

let cachedCheck: Promise<CapabilityCheckResult> | null = null;

/** Test-only: drop the cached result so the next call re-probes the host. */
export function resetHostCapabilitiesCache(): void {
  cachedCheck = null;
}

/** Detect which agent capabilities are present on the host. Result is cached
 * for the process lifetime — host tools don't appear/disappear at runtime. */
export function checkHostCapabilities(): Promise<CapabilityCheckResult> {
  if (!cachedCheck) {
    cachedCheck = doCheckHostCapabilities().catch((err) => {
      cachedCheck = null;
      throw err;
    });
  }
  return cachedCheck;
}

async function doCheckHostCapabilities(): Promise<CapabilityCheckResult> {
  const results = await Promise.all(
    AGENT_CAPABILITIES.map(async (cap) => ({
      cap,
      available: await isBinaryAvailable(cap.binary),
    })),
  );

  const available: AgentCapability[] = [];
  const missing: AgentCapability[] = [];
  const envVars: Record<string, string> = {};
  const resolvedPaths: Record<string, string> = {};

  for (const { cap, available: ok } of results) {
    if (ok) {
      available.push(cap);
      if (cap.envVars) Object.assign(envVars, cap.envVars);
      const platformVars = cap.platformEnvVars?.[os.platform()];
      if (platformVars) Object.assign(envVars, platformVars);

      // happycodex：上游只为 claude 解析绝对路径；这里改为 codex（引擎二进制，
      // runHostAgent 可据此做 PATH 前置 / 直接调用）。
      if (cap.binary === 'codex') {
        const resolvedPath = await resolveBinaryPath(cap.binary);
        if (resolvedPath) {
          resolvedPaths[cap.binary] = resolvedPath;
        }
      }
    } else {
      missing.push(cap);
    }
  }

  return { available, missing, envVars, resolvedPaths };
}

/** Log preflight results — warnings for missing, nothing for available. */
export function logCapabilityPreflight(
  groupName: string,
  result: CapabilityCheckResult,
): void {
  if (result.missing.length === 0) return;

  for (const cap of result.missing) {
    const logFn = cap.required
      ? logger.error.bind(logger)
      : logger.warn.bind(logger);
    logFn(
      { group: groupName, tool: cap.name },
      `Host preflight: ${cap.name} not found — some agent capabilities will be unavailable. Install: ${cap.installHint}`,
    );
  }
}
