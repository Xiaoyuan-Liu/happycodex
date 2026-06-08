/**
 * IPC 输入侧单测（standalone agent-runner）—— 不依赖真实 codex。
 *
 * 用临时目录造 input/*.json + 三 sentinel，断言：
 *   - drainIpcInput 正确解析 {type:'message', text, images?, sourceJid?}、读后即删、毒丸不卡死
 *   - consumeSentinel 检测并 unlink
 *   - IpcInputLoop.tick 的检测顺序 + sentinel 映射（_close/_drain 停循环，_interrupt 不停）
 *   - input/ 目录与输出侧 messages/ 不混
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  drainIpcInput,
  consumeSentinel,
  ipcInputDir,
  IpcInputLoop,
  SENTINEL,
  type IpcInputMessage,
  type IpcInputLoopHandlers,
} from '../src/runtime/ipc-input.js';

const FOLDER = 'home-test';

let root: string;
let ipcDir: string;
let inputDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'happycodex-ipcinput-'));
  ipcDir = path.join(root, 'ipc');
  inputDir = ipcInputDir(ipcDir, FOLDER);
  await mkdir(inputDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 写一个 input message 文件。 */
async function writeMessage(name: string, payload: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(inputDir, name), JSON.stringify(payload), 'utf8');
}

/** 写一个 sentinel 文件。 */
async function writeSentinel(name: string): Promise<void> {
  await writeFile(path.join(inputDir, name), '', 'utf8');
}

/** 收集回调的简单 handlers + 计数。 */
function makeHandlers(): { handlers: IpcInputLoopHandlers; log: string[]; messages: IpcInputMessage[] } {
  const logArr: string[] = [];
  const messages: IpcInputMessage[] = [];
  const handlers: IpcInputLoopHandlers = {
    onMessage: (m) => {
      messages.push(m);
      logArr.push(`msg:${m.text}`);
    },
    onClose: () => logArr.push('close'),
    onInterrupt: () => logArr.push('interrupt'),
    onDrain: () => logArr.push('drain'),
  };
  return { handlers, log: logArr, messages };
}

describe('drainIpcInput', () => {
  it('解析 {type:message,text} 并读后即删', async () => {
    await writeMessage('a.json', { type: 'message', text: 'hello' });
    const msgs = drainIpcInput(inputDir);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toBe('hello');
    // 读后即删
    expect(await readdir(inputDir)).toHaveLength(0);
  });

  it('按文件名排序顺序 drain 多条', async () => {
    await writeMessage('2.json', { type: 'message', text: 'second' });
    await writeMessage('1.json', { type: 'message', text: 'first' });
    const msgs = drainIpcInput(inputDir);
    expect(msgs.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('解析 images 与 sourceJid 字段', async () => {
    await writeMessage('a.json', {
      type: 'message',
      text: 't',
      images: [{ data: 'AAA', mimeType: 'image/png' }],
      sourceJid: 'chat@x',
    });
    const msgs = drainIpcInput(inputDir);
    expect(msgs[0]?.images).toEqual([{ data: 'AAA', mimeType: 'image/png' }]);
    expect(msgs[0]?.sourceJid).toBe('chat@x');
  });

  it('忽略 type!=message / text 为空 / 缺 text 的文件（但仍删除）', async () => {
    await writeMessage('a.json', { type: 'ping' });
    await writeMessage('b.json', { type: 'message', text: '' });
    await writeMessage('c.json', { type: 'message' });
    const msgs = drainIpcInput(inputDir);
    expect(msgs).toHaveLength(0);
    expect(await readdir(inputDir)).toHaveLength(0);
  });

  it('毒丸（非法 JSON）被删除且不阻塞后续文件', async () => {
    await writeFile(path.join(inputDir, 'a.json'), '{not json', 'utf8');
    await writeMessage('b.json', { type: 'message', text: 'ok' });
    const msgs = drainIpcInput(inputDir);
    expect(msgs.map((m) => m.text)).toEqual(['ok']);
    expect(await readdir(inputDir)).toHaveLength(0);
  });

  it('忽略非 .json 文件', async () => {
    await writeFile(path.join(inputDir, 'note.txt'), 'x', 'utf8');
    await writeMessage('a.json', { type: 'message', text: 'kept' });
    const msgs = drainIpcInput(inputDir);
    expect(msgs.map((m) => m.text)).toEqual(['kept']);
    // 非 .json 不被删
    expect(await readdir(inputDir)).toContain('note.txt');
  });

  it('目录不存在 → 空数组（不抛）', () => {
    expect(drainIpcInput(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('consumeSentinel', () => {
  it('存在 → true 且删除', async () => {
    await writeSentinel(SENTINEL.close);
    expect(consumeSentinel(inputDir, SENTINEL.close)).toBe(true);
    expect(await readdir(inputDir)).not.toContain('_close');
  });

  it('不存在 → false', () => {
    expect(consumeSentinel(inputDir, SENTINEL.interrupt)).toBe(false);
  });
});

describe('IpcInputLoop.tick — sentinel 映射与检测顺序', () => {
  it('_close → onClose 且停循环', async () => {
    const { handlers, log } = makeHandlers();
    const loop = new IpcInputLoop(inputDir, handlers);
    await writeSentinel(SENTINEL.close);
    expect(loop.tick()).toBe(false);
    expect(log).toEqual(['close']);
  });

  it('_drain → onDrain 且停循环', async () => {
    const { handlers, log } = makeHandlers();
    const loop = new IpcInputLoop(inputDir, handlers);
    await writeSentinel(SENTINEL.drain);
    expect(loop.tick()).toBe(false);
    expect(log).toEqual(['drain']);
  });

  it('_interrupt → onInterrupt 但不停循环，且本批消息仍被 drain', async () => {
    const { handlers, log, messages } = makeHandlers();
    const loop = new IpcInputLoop(inputDir, handlers);
    await writeSentinel(SENTINEL.interrupt);
    await writeMessage('a.json', { type: 'message', text: 'after-interrupt' });
    expect(loop.tick()).toBe(true);
    expect(log).toEqual(['interrupt', 'msg:after-interrupt']);
    expect(messages).toHaveLength(1);
  });

  it('_close 优先于同批普通消息（消息不被先消费）', async () => {
    const { handlers, log } = makeHandlers();
    const loop = new IpcInputLoop(inputDir, handlers);
    await writeMessage('a.json', { type: 'message', text: 'should-not-process' });
    await writeSentinel(SENTINEL.close);
    expect(loop.tick()).toBe(false);
    expect(log).toEqual(['close']);
    // 消息文件未被消费（_close 提前返回）
    expect(await readdir(inputDir)).toContain('a.json');
  });

  it('普通消息 → onMessage 且循环继续', async () => {
    const { handlers, messages } = makeHandlers();
    const loop = new IpcInputLoop(inputDir, handlers);
    await writeMessage('a.json', { type: 'message', text: 'm1' });
    expect(loop.tick()).toBe(true);
    expect(messages.map((m) => m.text)).toEqual(['m1']);
  });

  it('stop() 后 tick 直接返回 false 且不触发回调', async () => {
    const { handlers, log } = makeHandlers();
    const loop = new IpcInputLoop(inputDir, handlers);
    loop.stop();
    await writeSentinel(SENTINEL.close);
    expect(loop.tick()).toBe(false);
    expect(log).toEqual([]);
  });
});

describe('目录隔离 — input/ 不是输出侧 messages/', () => {
  it('ipcInputDir 指向 {ipcDir}/{folder}/input', () => {
    expect(ipcInputDir(ipcDir, FOLDER)).toBe(path.join(ipcDir, FOLDER, 'input'));
    expect(ipcInputDir(ipcDir, FOLDER)).not.toContain(`${path.sep}messages`);
  });

  it('drain 只读 input/，不碰同 folder 下的 messages/', async () => {
    const messagesDir = path.join(ipcDir, FOLDER, 'messages');
    await mkdir(messagesDir, { recursive: true });
    await writeFile(path.join(messagesDir, 'out.json'), JSON.stringify({ type: 'send_message', text: 'x' }), 'utf8');
    await writeMessage('in.json', { type: 'message', text: 'in' });

    const msgs = drainIpcInput(inputDir);
    expect(msgs.map((m) => m.text)).toEqual(['in']);
    // 输出侧文件未被触碰
    expect(await readdir(messagesDir)).toContain('out.json');
  });
});
