/**
 * AppServerClient —— codex app-server 的 JSON-RPC over stdio 客户端。
 *
 * 职责（见 contracts.ts / IAppServerClient）：
 *   - spawn `codex app-server`（默认 stdio 传输）
 *   - newline-delimited JSON 双向通信（发送省略 jsonrpc 头，接收容忍有无）
 *   - 行分帧（抽成纯 {@link LineFramer} / {@link parseInboundLine}，便于单测，不依赖进程）
 *   - id 关联 pending Promise；-32001(ERR_SERVER_OVERLOADED) 指数退避 + jitter 重试
 *   - 通知 / server 请求分发；优雅关闭（SIGTERM → 宽限 → SIGKILL）
 *
 * 线上格式：发送 `{ id, method, params }`（**无** "jsonrpc" 字段）；
 *           接收 inbound 容忍有无 jsonrpc 字段，靠 id/method/result/error 判别。
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import type {
  AppServerClientOptions,
  IAppServerClient,
  IncomingServerRequest,
  ServerNotificationHandler,
  ServerRequestHandler,
} from '../contracts.js';
import {
  ClientNotif,
  ERR_SERVER_OVERLOADED,
  type InitializeParams,
  type InitializeResponse,
  type JsonRpcError,
  type JsonRpcInbound,
  Method,
  type RequestId,
} from './protocol.js';

// ───────────────────────── 纯分帧逻辑（可单测，无进程） ─────────────────────────

/** parseInboundLine 的判别结果。`malformed` 表示 JSON 解析失败或不符合任一形状。 */
export type ParsedInbound =
  | { kind: 'response'; id: RequestId; result: unknown }
  | { kind: 'error'; id: RequestId; error: JsonRpcError }
  | { kind: 'serverRequest'; id: RequestId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'malformed'; raw: string; cause?: unknown };

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 解析单行（已去除换行）为判别后的 inbound。
 *
 * 判别规则（对齐 codex app-server 线上格式，容忍有无 "jsonrpc" 头）：
 *   - 有 id 且有 result            → 响应（成功）
 *   - 有 id 且有 error             → 响应（失败）
 *   - 有 method 且有 id            → server→client 请求
 *   - 有 method 且无 id            → 通知
 *   - 其余 / 非法 JSON / 非对象    → malformed（容错，不抛）
 */
export function parseInboundLine(line: string): ParsedInbound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    return { kind: 'malformed', raw: line, cause };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', raw: line };
  }

  const obj = parsed as Record<string, unknown>;
  const hasId = hasOwn(obj, 'id') && (typeof obj.id === 'number' || typeof obj.id === 'string');
  const hasMethod = hasOwn(obj, 'method') && typeof obj.method === 'string';

  // server→client 请求：method + id 同时存在
  if (hasMethod && hasId) {
    return {
      kind: 'serverRequest',
      id: obj.id as RequestId,
      method: obj.method as string,
      params: hasOwn(obj, 'params') ? obj.params : undefined,
    };
  }

  // 通知：method 存在但无 id
  if (hasMethod) {
    return {
      kind: 'notification',
      method: obj.method as string,
      params: hasOwn(obj, 'params') ? obj.params : undefined,
    };
  }

  // 响应：id 存在 + result 或 error
  if (hasId) {
    if (hasOwn(obj, 'error') && typeof obj.error === 'object' && obj.error !== null) {
      return { kind: 'error', id: obj.id as RequestId, error: obj.error as JsonRpcError };
    }
    if (hasOwn(obj, 'result')) {
      return { kind: 'response', id: obj.id as RequestId, result: obj.result };
    }
  }

  return { kind: 'malformed', raw: line };
}

/**
 * 把 stdout 的 chunk 流按 `\n` 切成完整行并解析。
 *
 * 纯类，自带残留缓冲：跨 chunk 的半行会拼接，一个 chunk 含多行会全部产出。
 * 不做任何 I/O、不 spawn 进程，便于单测。
 */
export class LineFramer {
  private buffer = '';

  /**
   * 喂入一段文本（来自 stdout chunk），返回本次能完整解析出的所有 inbound。
   * 未遇到 `\n` 的尾部残留留在内部 buffer，等待后续 chunk 续接。
   * 空行（仅含空白）会被跳过（不产出 malformed）。
   */
  push(chunk: string): ParsedInbound[] {
    this.buffer += chunk;
    const out: ParsedInbound[] = [];

    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        out.push(parseInboundLine(trimmed));
      }
      newlineIdx = this.buffer.indexOf('\n');
    }

    return out;
  }

  /** 当前未消费的残留（用于诊断/测试断言）。 */
  get pending(): string {
    return this.buffer;
  }

  /** 重置内部缓冲。 */
  reset(): void {
    this.buffer = '';
  }
}

// ───────────────────────── 客户端实现 ─────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const RETRY_BASE_MS = 50;
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_MAX_DELAY_MS = 2000;
const CLOSE_GRACE_MS = 3000;
/** per-request 看门狗默认值；调用方仍可显式传 0 彻底关闭超时。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class AppServerClient implements IAppServerClient {
  private readonly options: AppServerClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly framer = new LineFramer();

  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();

  private readonly notificationHandlers = new Set<ServerNotificationHandler>();
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>();
  private readonly closeHandlers = new Set<
    (info: { code: number | null; signal: string | null; error?: Error }) => void
  >();

  private closed = false;
  private stderrBuffer = '';

  constructor(options: AppServerClientOptions = {}) {
    this.options = options;
  }

  // ── 生命周期 ──

  async start(): Promise<InitializeResponse> {
    if (this.child) {
      throw new Error('AppServerClient.start() called twice');
    }

    const bin = this.options.codexBin ?? 'codex';
    const args = ['app-server', ...(this.options.args ?? [])];
    const env = { ...process.env, ...this.options.env };

    this.log('info', `spawn ${bin} ${args.join(' ')}`);

    const child = spawn(bin, args, {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk));

    child.on('error', (error: Error) => this.onProcessError(error));
    child.on('exit', (code, signal) => this.onProcessExit(code, signal));

    // initialize 握手
    const initParams: InitializeParams = {
      clientInfo: { name: 'happycodex', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: null,
      },
    };

    const response = await this.request<InitializeResponse>(Method.initialize, initParams);

    // initialized 通知（无响应）
    this.notify(ClientNotif.initialized, {});

    return response;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const child = this.child;
    if (!child) {
      this.rejectAllPending(new Error('AppServerClient closed before start'));
      return;
    }

    // 已退出则直接清理
    if (child.exitCode !== null || child.signalCode !== null) {
      this.rejectAllPending(new Error('AppServerClient closed'));
      return;
    }

    // 在途请求立即失败，关停延迟与 OS 进程回收解耦：
    // 否则正等响应的 pending（如 turn/interrupt）会被 SIGTERM→SIGKILL 的 grace 阻塞最多 CLOSE_GRACE_MS。
    this.rejectAllPending(new Error('AppServerClient closing'));

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };

      child.once('exit', finish);

      // 先 SIGTERM，宽限后 SIGKILL
      try {
        child.kill('SIGTERM');
      } catch {
        // 进程可能已不存在
      }

      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, CLOSE_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    });

    this.rejectAllPending(new Error('AppServerClient closed'));
  }

  // ── 请求 / 通知 ──

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    let attempt = 0;
    // -32001 背压：指数退避 + jitter 重试
    for (;;) {
      try {
        return (await this.sendRequestOnce(method, params)) as T;
      } catch (err) {
        const code = errorCodeOf(err);
        if (code === ERR_SERVER_OVERLOADED && attempt < RETRY_MAX_ATTEMPTS && !this.closed) {
          const delay = backoffDelay(attempt);
          this.log('warn', `request ${method} overloaded (-32001), retry #${attempt + 1} in ${delay}ms`);
          attempt += 1;
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }
  }

  private sendRequestOnce(method: string, params?: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('AppServerClient is closed'));
        return;
      }
      const child = this.child;
      if (!child || !child.stdin.writable) {
        reject(new Error('AppServerClient stdin not writable (process not started or exited)'));
        return;
      }

      const id = this.nextId++;

      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }

      this.pending.set(id, { resolve, reject, timer });

      // 线上格式：省略 jsonrpc 头
      const payload: { id: RequestId; method: string; params?: unknown } = { id, method };
      if (params !== undefined) payload.params = params;

      this.writeLine(payload, (err) => {
        if (err) {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            if (entry.timer) clearTimeout(entry.timer);
          }
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) {
      this.log('warn', `notify ${method} dropped: client closed`);
      return;
    }
    const child = this.child;
    if (!child || !child.stdin.writable) {
      this.log('warn', `notify ${method} dropped: stdin not writable`);
      return;
    }
    const payload: { method: string; params?: unknown } = { method };
    if (params !== undefined) payload.params = params;
    this.writeLine(payload);
  }

  // ── 订阅 ──

  onNotification(handler: ServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => {
      this.serverRequestHandlers.delete(handler);
    };
  }

  onClose(
    handler: (info: { code: number | null; signal: string | null; error?: Error }) => void,
  ): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  // ── 内部：写出 ──

  private writeLine(payload: unknown, cb?: (err: Error | null | undefined) => void): void {
    const child = this.child;
    if (!child) {
      cb?.(new Error('no child process'));
      return;
    }
    const line = JSON.stringify(payload) + '\n';
    child.stdin.write(line, (err) => cb?.(err));
  }

  // ── 内部：读入分发 ──

  private onStdout(chunk: string): void {
    const inbounds = this.framer.push(chunk);
    for (const inbound of inbounds) {
      this.dispatch(inbound);
    }
  }

  private dispatch(inbound: ParsedInbound): void {
    switch (inbound.kind) {
      case 'response':
        this.resolvePending(inbound.id, inbound.result);
        break;
      case 'error':
        this.rejectPending(inbound.id, inbound.error);
        break;
      case 'serverRequest':
        this.dispatchServerRequest(inbound.id, inbound.method, inbound.params);
        break;
      case 'notification':
        this.dispatchNotification(inbound.method, inbound.params);
        break;
      case 'malformed':
        // 容错：记录但不崩
        this.log('warn', 'dropped malformed inbound line', {
          raw: inbound.raw.slice(0, 200),
        });
        break;
    }
  }

  private resolvePending(id: RequestId, result: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) {
      this.log('debug', `response for unknown id=${String(id)} ignored`);
      return;
    }
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(result);
  }

  private rejectPending(id: RequestId, error: JsonRpcError): void {
    const entry = this.pending.get(id);
    if (!entry) {
      this.log('debug', `error for unknown id=${String(id)} ignored`);
      return;
    }
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(new RpcError(error));
  }

  private dispatchNotification(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(method, params);
      } catch (err) {
        this.log('error', `notification handler threw for ${method}`, err);
      }
    }
  }

  private dispatchServerRequest(id: RequestId, method: string, params: unknown): void {
    const req: IncomingServerRequest = { id, method, params };
    let responded = false;
    const respond = (result: unknown): void => {
      if (responded) {
        this.log('warn', `respond() called twice for server request ${method} (id=${String(id)})`);
        return;
      }
      responded = true;
      // 回复：{ id, result }（无 jsonrpc 头）
      this.writeLine({ id, result });
    };

    if (this.serverRequestHandlers.size === 0) {
      this.log('warn', `no handler for server request ${method} (id=${String(id)})`);
      return;
    }

    for (const handler of this.serverRequestHandlers) {
      try {
        handler(req, respond);
      } catch (err) {
        this.log('error', `server request handler threw for ${method}`, err);
      }
    }
  }

  // ── 内部：进程事件 ──

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let idx = this.stderrBuffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.stderrBuffer.slice(0, idx);
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
      if (line.trim().length > 0) {
        this.log('debug', `[app-server stderr] ${line}`);
      }
      idx = this.stderrBuffer.indexOf('\n');
    }
  }

  private onProcessError(error: Error): void {
    this.log('error', `child process error: ${error.message}`, error);
    this.rejectAllPending(error);
    this.emitClose({ code: null, signal: null, error });
  }

  private onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.log('info', `child process exited code=${String(code)} signal=${String(signal)}`);
    this.rejectAllPending(
      new Error(`codex app-server exited (code=${String(code)} signal=${String(signal)})`),
    );
    this.emitClose({ code, signal });
  }

  private emitClose(info: { code: number | null; signal: string | null; error?: Error }): void {
    for (const handler of this.closeHandlers) {
      try {
        handler(info);
      } catch (err) {
        this.log('error', 'close handler threw', err);
      }
    }
  }

  private rejectAllPending(reason: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    meta?: unknown,
  ): void {
    this.options.logger?.(level, msg, meta);
  }
}

// ───────────────────────── 错误封装 / 工具 ─────────────────────────

/** 把 JSON-RPC error 包成 Error，保留 code/data 供上层（如 -32001 重试判定）。 */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = 'RpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

function errorCodeOf(err: unknown): number | undefined {
  if (err instanceof RpcError) return err.code;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'number'
  ) {
    return (err as { code: number }).code;
  }
  return undefined;
}

/** 第 attempt 次（0-based）重试的退避延迟：指数 + 全抖动，封顶。 */
function backoffDelay(attempt: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  // full jitter：[0, base) 上均匀抖动，避免惊群
  return Math.floor(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}
