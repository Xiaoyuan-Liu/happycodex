/**
 * Regression test for riba2534/happyclaw#559 ("notify 失效").
 *
 * Group-mode scheduled tasks inject their prompt into the source workspace as a
 * normal message. When a runner is ALREADY active, delivery goes through
 * GroupQueue.sendMessage() (the IPC-injection path), not the cold-start
 * runContainerAgent() path. That IPC payload must carry `taskId` — otherwise the
 * agent-runner can't attribute the resulting send_message output to the task, so
 * the host's resolveTaskRoutingDecision() returns `none` and the configured
 * notify_channels broadcast (Feishu etc.) is silently skipped.
 *
 * These tests pin the contract at the filesystem boundary: the written IPC input
 * JSON carries `taskId` when (and only when) one is supplied.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { drainIpcInput } from '../src/runtime/ipc-input.js';

const TEST_DATA_DIR = '/tmp/happycodex-queue-taskid-test';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: TEST_DATA_DIR };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/container-runner.js', () => ({ killProcessTree: () => {} }));

vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 1,
    maxConcurrentHostProcesses: 1,
  }),
}));

vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');

const tick = () => new Promise((r) => setImmediate(r));
const JID = 'web:taskid-inject';
const FOLDER = 'taskid-inject';

let queue: InstanceType<typeof GroupQueue>;
let resolveGate: (() => void) | null;

function readInjectedPayloads(): Array<Record<string, unknown>> {
  const dir = path.join(TEST_DATA_DIR, 'ipc', FOLDER, 'input');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
}

beforeEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  queue = new GroupQueue();
  resolveGate = null;
  // Keep the run gate-blocked so the runner stays active while we inject.
  queue.setProcessMessagesFn(async () => {
    await new Promise<void>((r) => {
      resolveGate = r;
    });
    return true;
  });
});

afterEach(async () => {
  resolveGate?.();
  await tick();
  await tick();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function startActiveRunner(): Promise<void> {
  queue.enqueueMessageCheck(JID); // run goes active, blocks on the gate
  await tick();
  // registerProcess sets groupFolder so resolveActiveState() accepts the state
  // and resolveIpcInputDir() can locate data/ipc/{folder}/input.
  queue.registerProcess(JID, { kill: () => {}, killed: false } as never, {
    containerName: null,
    groupFolder: FOLDER,
  });
}

describe('GroupQueue.sendMessage taskId propagation (#559)', () => {
  test('stamps taskId into the IPC payload when provided', async () => {
    await startActiveRunner();

    const result = queue.sendMessage(
      JID,
      'task output',
      undefined,
      undefined,
      undefined,
      'task-abc',
    );

    expect(result).toBe('sent');
    const payloads = readInjectedPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;
    expect(p.type).toBe('message');
    expect(p.text).toBe('task output');
    expect(p.taskId).toBe('task-abc');
  });

  test('omits taskId for regular user messages', async () => {
    await startActiveRunner();

    const result = queue.sendMessage(
      JID,
      'hi',
      undefined,
      undefined,
      'feishu:u1',
    );

    expect(result).toBe('sent');
    const payloads = readInjectedPayloads();
    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;
    expect(p.taskId).toBeUndefined();
    expect(p.sourceJid).toBe('feishu:u1');
  });
});

// 消费者侧端到端（修复 review #F1/#F6：上游 7e49a65 此前只 port 了生产者，drainIpcInput
// 丢弃 taskId → warm-runner 注入路径 notify 失效）。这里把生产者写出的真实 IPC 文件喂给
// 消费者 drainIpcInput，钉死「生产者 stamp → 消费者解析」同名字段的线格式契约。
describe('drainIpcInput 消费侧 taskId 透传（#559 端到端）', () => {
  function inputDir(): string {
    return path.join(TEST_DATA_DIR, 'ipc', FOLDER, 'input');
  }

  test('drainIpcInput 解析出注入消息携带的 taskId', async () => {
    await startActiveRunner();
    queue.sendMessage(JID, 'task output', undefined, undefined, undefined, 'task-abc');
    const msgs = drainIpcInput(inputDir());
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('task output');
    expect(msgs[0]!.taskId).toBe('task-abc');
  });

  test('普通用户消息：drainIpcInput 的 taskId 为 undefined（不串台）', async () => {
    await startActiveRunner();
    queue.sendMessage(JID, 'hi', undefined, undefined, 'feishu:u1');
    const msgs = drainIpcInput(inputDir());
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.taskId).toBeUndefined();
    expect(msgs[0]!.sourceJid).toBe('feishu:u1');
  });
});
