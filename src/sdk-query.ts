/**
 * 【codex 触点替换】轻量 text-in → text-out 一次性问答。
 *
 * 上游 src/sdk-query.ts 是 Claude Agent SDK 的封装（`query()` + maxTurns:1，
 * 给 /recall 摘要、任务自然语言解析、bug 上报摘要、自动标题等"一次性小问答"用）。
 * happycodex 没有 Claude SDK —— 等价实现为 `codex exec` 非交互一次性调用：
 *
 *   codex exec --ephemeral --skip-git-repo-check -s read-only \
 *     --output-last-message <tmpfile> --color never [-m model] -
 *
 *   - prompt 走 stdin（`-`），避免 argv 长度限制；
 *   - --ephemeral：不持久化 session 文件（一次性问答无需 resume）；
 *   - -s read-only：摘要/解析类任务无需写盘，最小权限；
 *   - --output-last-message：最终 agent 消息落临时文件，避免解析混杂 stdout；
 *   - CODEX_HOME 取共享认证（HAPPYCODEX_SHARED_CODEX_HOME > CODEX_HOME > ~/.codex，
 *     与 container-runner.sharedCodexHomeDir 同序）。
 *
 * 失败/超时恒返回 null —— 上游所有调用方（/recall、routes/tasks.ts 的 NL 任务
 * 解析、routes/bug-report.ts 的 AI 摘要、LLM 标题）本就把 null 当作"AI 不可用"
 * 处理（fallback 到人工填写/原文），不会抛错。
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/** 共享 codex home（与 container-runner.sharedCodexHomeDir 的解析顺序一致）。 */
function sharedCodexHomeDir(): string {
  return (
    process.env.HAPPYCODEX_SHARED_CODEX_HOME ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), '.codex')
  );
}

export async function sdkQuery(
  prompt: string,
  opts?: { model?: string; timeout?: number },
): Promise<string | null> {
  const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
  const outFile = path.join(
    os.tmpdir(),
    `happycodex-sdk-query-${crypto.randomUUID()}.txt`,
  );

  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '--output-last-message',
    outFile,
    '--color',
    'never',
  ];
  if (opts?.model) args.push('-m', opts.model);
  args.push('-'); // prompt from stdin

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      resolve(value);
    };

    let child;
    try {
      child = spawn('codex', args, {
        cwd: os.tmpdir(),
        env: { ...process.env, CODEX_HOME: sharedCodexHomeDir() },
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (err) {
      logger.warn({ err }, 'sdkQuery: failed to spawn codex exec');
      finish(null);
      return;
    }

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-500);
    });

    const timer = setTimeout(() => {
      logger.warn({ timeoutMs }, 'sdkQuery: codex exec timed out, killing');
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead
      }
      finish(null);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn(
        { err: err.message },
        'sdkQuery: codex exec spawn error (codex CLI not available?)',
      );
      finish(null);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn(
          { code, stderrTail: stderrTail.slice(-200) },
          'sdkQuery: codex exec exited non-zero',
        );
        finish(null);
        return;
      }
      try {
        const text = fs.readFileSync(outFile, 'utf-8').trim();
        finish(text || null);
      } catch (err) {
        logger.warn({ err }, 'sdkQuery: failed to read codex exec output');
        finish(null);
      }
    });

    child.stdin?.on('error', () => {
      // EPIPE when codex dies early — close handler resolves
    });
    child.stdin?.end(prompt);
  });
}
