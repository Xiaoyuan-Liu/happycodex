/**
 * src/codex-device-auth.ts 单测 —— per-user codex device-auth 子进程编排。
 *
 * 验证（契约第 7 条 device-auth 模块）：
 *   - stdout/stderr 解析出 verification URL + user code → 推 pending（含 expiresInSec=900）；
 *   - 子进程退出码 0 → authorized；非 0 → error；spawn error → error；
 *   - 15min 总超时 → kill 进程树 + expired；
 *   - 同一 userId 并发去重：再次 start 先 kill 旧进程（不残留僵尸）；
 *   - getDeviceAuthState 供 WS 重连恢复；cancel / shutdown 清理无泄漏；
 *   - 非法 userId 透传 userCodexHomeDir 抛错；
 *   - 安全：spawn 的 env.CODEX_HOME 指向 per-user 目录，且不向 onUpdate 回显原始输出。
 *
 * 注入方式：vi.mock('node:child_process') 提供可控 fake spawn（返回 EventEmitter 形态的
 * fake ChildProcess，带 stdout/stderr 子流），无需真实启动 codex。fake timers 驱动超时。
 * 全部 process.kill 被 spy 拦截（fake pid 不对应真实进程，避免误杀）。
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// ---- fake spawn 基础设施（hoisted，供 vi.mock 工厂闭包引用） ----
// hoisted 在所有 import 之前执行，不能依赖顶部 import。用最小内联 emitter（on/emit），
// 覆盖 device-auth 模块用到的 'data'/'close'/'error' 事件即可，避免在 hoist 期引 node:events。
const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class Emitter {
    private listeners = new Map<string, Listener[]>();
    on(event: string, cb: Listener): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      const arr = this.listeners.get(event);
      if (!arr || arr.length === 0) return false;
      for (const cb of [...arr]) cb(...args);
      return true;
    }
  }
  class FakeStream extends Emitter {
    push(chunk: string): void {
      this.emit('data', Buffer.from(chunk, 'utf8'));
    }
  }
  class FakeChild extends Emitter {
    stdout = new FakeStream();
    stderr = new FakeStream();
    pid = 4242;
    killed = false;
    constructor(
      public cmd: string,
      public args: string[],
      public options: { env?: Record<string, string | undefined> },
    ) {
      super();
    }
    kill(signal?: string): boolean {
      this.killed = true;
      this.emit('__killed', signal);
      return true;
    }
    /** 模拟进程退出（codex 进程结束）。 */
    exit(code: number | null): void {
      this.emit('close', code);
    }
  }
  const spawned: FakeChild[] = [];
  const spawn = (
    cmd: string,
    args: string[],
    options: { env?: Record<string, string | undefined> },
  ): FakeChild => {
    const child = new FakeChild(cmd, args, options);
    spawned.push(child);
    return child;
  };
  return { spawned, spawn, FakeChild };
});

// 只覆盖 spawn，其余（execFile 等，被 config.ts 经 codex-paths 链路用到）保留原样。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: h.spawn,
    default: { ...(actual as { default?: object }).default, spawn: h.spawn },
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

import fs from 'node:fs';
import {
  startDeviceAuth,
  getDeviceAuthState,
  cancelDeviceAuth,
  shutdownAllDeviceAuth,
  type CodexDeviceAuthState,
} from '../src/codex-device-auth.js';
import { userCodexHomeDir } from '../src/codex-paths.js';

let killSpy: import('vitest').MockInstance<(...args: never[]) => unknown>;
let existsSpy: import('vitest').MockInstance<(...args: never[]) => boolean>;
let mkdirSpy: import('vitest').MockInstance<(...args: never[]) => unknown>;

function lastChild(): InstanceType<typeof h.FakeChild> {
  const c = h.spawned[h.spawned.length - 1];
  if (!c) throw new Error('no child spawned');
  return c;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.spawned.length = 0;
  // process.kill 被 device-auth 的 killTree 调用（负 PID 杀进程组）。fake pid 不对应
  // 真实进程组——spy 拦截避免误杀真实进程，并让 killTree 退化路径可观测。
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  // authorized 现在以 auth.json 真落盘为准（exit 0 不够）。默认模拟"已写入"，
  // 个别测试覆写为 false 验证"exit 0 但无凭据 → error"。
  existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  // mkdir 真实会创建 per-user 目录——spy 成 no-op，避免测试在 data/ 下留垃圾。
  mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
});

afterEach(() => {
  shutdownAllDeviceAuth();
  killSpy.mockRestore();
  existsSpy.mockRestore();
  mkdirSpy.mockRestore();
  vi.useRealTimers();
});

describe('startDeviceAuth — spawn 参数与安全', () => {
  test('spawn `codex login --device-auth`，env.CODEX_HOME 指向 per-user 目录', () => {
    startDeviceAuth('alice', () => {});
    const child = lastChild();
    expect(child.cmd).toBe('codex');
    expect(child.args).toEqual(['login', '--device-auth']);
    expect(child.options.env?.CODEX_HOME).toBe(userCodexHomeDir('alice'));
  });

  test('codexBin 可配（opts.codexBin 覆盖默认 codex）', () => {
    startDeviceAuth('alice', () => {}, { codexBin: '/opt/codex/bin/codex' });
    expect(lastChild().cmd).toBe('/opt/codex/bin/codex');
  });

  test('detached 启动（便于超时杀进程树）', () => {
    startDeviceAuth('alice', () => {});
    expect((lastChild().options as { detached?: boolean }).detached).toBe(true);
  });

  test('spawn 前先创建 per-user CODEX_HOME（codex 对不存在目录会退出 1）', () => {
    startDeviceAuth('alice', () => {});
    expect(mkdirSpy).toHaveBeenCalledWith(userCodexHomeDir('alice'), {
      recursive: true,
    });
  });

  test('非法 userId → 透传 userCodexHomeDir 抛错（不 spawn）', () => {
    expect(() => startDeviceAuth('../evil', () => {})).toThrow(/Invalid userId/);
    expect(h.spawned).toHaveLength(0);
  });

});

describe('stdout/stderr 解析 → pending', () => {
  test('真实 ANSI 着色输出（codex 即便管道也带颜色码）→ 剥 ANSI 后 URL 干净、短码抓到', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    // 实测 codex 0.137.0 --device-auth 的真实输出形态（含 \x1b[94m...\x1b[0m）。
    lastChild().stdout.push(
      '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n' +
        '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n' +
        '   \x1b[94mGMF7-O8PIP\x1b[0m\n',
    );
    const pending = updates.find((u) => u.status === 'pending')!;
    expect(pending.verificationUri).toBe('https://auth.openai.com/codex/device');
    expect(pending.userCode).toBe('GMF7-O8PIP');
  });

  test('URL 与短码跨 chunk 到达 → 累积缓冲后整体解析出两者', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    const child = lastChild();
    // 第一个 chunk 只有 URL（无码）→ 暂不推（等码）。
    child.stdout.push('visit https://auth.openai.com/codex/device\n');
    expect(updates.filter((u) => u.status === 'pending')).toHaveLength(0);
    // 第二个 chunk 带来短码 → 累积后整体解析，推 pending 含两者。
    child.stdout.push('enter code WXYZ-9876\n');
    const pending = updates.find((u) => u.status === 'pending')!;
    expect(pending.verificationUri).toBe('https://auth.openai.com/codex/device');
    expect(pending.userCode).toBe('WXYZ-9876');
  });

  test('stdout 打印 URL + 短码 → onUpdate(pending) 含 verificationUri/userCode/expiresInSec=900', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    lastChild().stdout.push(
      'To authorize, visit https://auth.openai.com/codex/device and enter code ABCD-1234\n',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      status: 'pending',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      expiresInSec: 900,
    });
  });

  test('verification 也可来自 stderr（不同 codex 版本输出流不一）', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    lastChild().stderr.push('open https://example.com/device code WXYZ-9876\n');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.status).toBe('pending');
    expect(updates[0]?.verificationUri).toBe('https://example.com/device');
    expect(updates[0]?.userCode).toBe('WXYZ-9876');
  });

  test('重复输出不重复推 pending（只首个抓到的 verification 上报一次）', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    const child = lastChild();
    child.stdout.push('visit https://a.test/device code ABCD-1234\n');
    child.stdout.push('still waiting... https://a.test/device code ABCD-1234\n');
    expect(updates.filter((u) => u.status === 'pending')).toHaveLength(1);
  });

  test('安全：onUpdate 只收到 URL/短码，不回显原始 stdout（不泄露潜在 token）', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    lastChild().stdout.push(
      'secret-token=sk-LEAK https://a.test/device code ABCD-1234\n',
    );
    const pending = updates.find((u) => u.status === 'pending')!;
    expect(JSON.stringify(pending)).not.toContain('sk-LEAK');
    expect(JSON.stringify(pending)).not.toContain('secret-token');
  });

  test('安全：verificationUri 剥去 query/fragment（防 URL 内凭据被转发）', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    lastChild().stdout.push(
      'visit https://auth.openai.com/codex/device?access_token=sk-SECRET#frag code ABCD-1234\n',
    );
    const pending = updates.find((u) => u.status === 'pending')!;
    expect(pending.verificationUri).toBe('https://auth.openai.com/codex/device');
    expect(JSON.stringify(pending)).not.toContain('sk-SECRET');
  });
});

describe('进程退出 → 终态', () => {
  test('退出码 0 且 auth.json 已落盘 → authorized', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    const child = lastChild();
    child.stdout.push('https://a.test/device code ABCD-1234\n');
    child.exit(0); // existsSync 默认 true（beforeEach）→ 视为已写入
    expect(updates[updates.length - 1]).toEqual({ status: 'authorized' });
  });

  test('退出码 0 但 auth.json 未写入 → error（不误报 authorized）', () => {
    existsSpy.mockReturnValue(false); // 模拟 codex exit 0 却没落凭据
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    const child = lastChild();
    child.stdout.push('https://a.test/device code ABCD-1234\n');
    child.exit(0);
    expect(updates[updates.length - 1]?.status).toBe('error');
    expect(updates.some((u) => u.status === 'authorized')).toBe(false);
  });

  test('退出码非 0 → error', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    lastChild().exit(1);
    expect(updates[updates.length - 1]?.status).toBe('error');
  });

  test('spawn error 事件 → error', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    lastChild().emit('error', new Error('ENOENT'));
    expect(updates[updates.length - 1]?.status).toBe('error');
  });

  test('终态后再来 stdout/exit → 不再推（幂等终结）', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    const child = lastChild();
    child.exit(0);
    const afterFirstSettle = updates.length;
    child.stdout.push('https://a.test/device code ABCD-1234\n');
    child.exit(1);
    expect(updates.length).toBe(afterFirstSettle);
  });
});

describe('15min 总超时 → kill + expired', () => {
  test('超时触发 → kill 进程树（process.kill 负 PID）+ onUpdate(expired)', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    const child = lastChild();

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(updates[updates.length - 1]?.status).toBe('expired');
    // 杀的是进程组（负 pid），SIGKILL。
    expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  });

  test('未超时前（14:59）不触发 expired', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    vi.advanceTimersByTime(15 * 60 * 1000 - 1000);
    expect(updates.some((u) => u.status === 'expired')).toBe(false);
  });

  test('已 authorized 后定时器不再触发 expired（清理无悬挂回调）', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    lastChild().exit(0);
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(updates.filter((u) => u.status === 'expired')).toHaveLength(0);
    expect(updates[updates.length - 1]).toEqual({ status: 'authorized' });
  });
});

describe('同 userId 并发去重', () => {
  test('再次 start 同一 userId → kill 旧进程后重新 spawn（不残留僵尸）', () => {
    startDeviceAuth('alice', () => {});
    const first = lastChild();
    expect(h.spawned).toHaveLength(1);

    startDeviceAuth('alice', () => {});
    expect(h.spawned).toHaveLength(2);
    // 旧进程被 kill（killTree 负 PID SIGKILL）。
    expect(killSpy).toHaveBeenCalledWith(-first.pid, 'SIGKILL');
  });

  test('旧流程被抢占后，其 stdout/exit 不再推给旧 onUpdate', () => {
    const oldUpdates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => oldUpdates.push(s));
    const first = lastChild();

    startDeviceAuth('alice', () => {}); // 抢占
    // 旧进程晚到的事件不应触发旧 onUpdate。
    first.stdout.push('https://a.test/device code ABCD-1234\n');
    first.exit(0);
    expect(oldUpdates).toHaveLength(0);
  });

  test('不同 userId 各自独立 in-flight（互不干扰）', () => {
    const a: CodexDeviceAuthState[] = [];
    const b: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => a.push(s));
    const childA = lastChild();
    startDeviceAuth('bob', (s) => b.push(s));
    const childB = lastChild();

    childA.stdout.push('https://a.test/device code AAAA-1111\n');
    childB.stdout.push('https://b.test/device code BBBB-2222\n');

    expect(a[0]?.userCode).toBe('AAAA-1111');
    expect(b[0]?.userCode).toBe('BBBB-2222');
    expect(childA.options.env?.CODEX_HOME).toBe(userCodexHomeDir('alice'));
    expect(childB.options.env?.CODEX_HOME).toBe(userCodexHomeDir('bob'));
  });
});

describe('getDeviceAuthState — WS 重连恢复', () => {
  test('pending 后 getState 返回 pending（含 URL/码）', () => {
    startDeviceAuth('alice', () => {});
    lastChild().stdout.push('https://a.test/device code ABCD-1234\n');
    const state = getDeviceAuthState('alice');
    expect(state?.status).toBe('pending');
    expect(state?.verificationUri).toBe('https://a.test/device');
    expect(state?.userCode).toBe('ABCD-1234');
  });

  test('启动后未抓到 verification → getState 为初始 pending', () => {
    startDeviceAuth('alice', () => {});
    expect(getDeviceAuthState('alice')?.status).toBe('pending');
  });

  test('终结后从表移除 → getState undefined（无泄漏）', () => {
    startDeviceAuth('alice', () => {});
    lastChild().exit(0);
    expect(getDeviceAuthState('alice')).toBeUndefined();
  });

  test('无 in-flight 的 userId → undefined', () => {
    expect(getDeviceAuthState('nobody')).toBeUndefined();
  });
});

describe('cancel / shutdown — 清理无泄漏', () => {
  test('cancelDeviceAuth → kill 进程 + 移除（getState undefined），不推终态噪声', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    const child = lastChild();
    const before = updates.length;

    cancelDeviceAuth('alice');

    expect(killSpy).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(getDeviceAuthState('alice')).toBeUndefined();
    // cancel 不推 expired/error。
    expect(updates.length).toBe(before);
  });

  test('cancel 后定时器不再触发 expired（清理悬挂定时器）', () => {
    const updates: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => updates.push(s));
    cancelDeviceAuth('alice');
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(updates.some((u) => u.status === 'expired')).toBe(false);
  });

  test('cancel 无 in-flight → no-op（不抛错）', () => {
    expect(() => cancelDeviceAuth('nobody')).not.toThrow();
  });

  test('shutdownAll → 杀掉所有 in-flight 并清空（getState 全 undefined）', () => {
    startDeviceAuth('alice', () => {});
    const childA = lastChild();
    startDeviceAuth('bob', () => {});
    const childB = lastChild();

    shutdownAllDeviceAuth();

    expect(killSpy).toHaveBeenCalledWith(-childA.pid, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-childB.pid, 'SIGKILL');
    expect(getDeviceAuthState('alice')).toBeUndefined();
    expect(getDeviceAuthState('bob')).toBeUndefined();
  });

  test('shutdownAll 后定时器全部清除（推进时间不触发任何 expired）', () => {
    const a: CodexDeviceAuthState[] = [];
    startDeviceAuth('alice', (s) => a.push(s));
    shutdownAllDeviceAuth();
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(a.some((u) => u.status === 'expired')).toBe(false);
  });
});
