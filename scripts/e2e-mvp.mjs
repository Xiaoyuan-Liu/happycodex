#!/usr/bin/env node
/**
 * E2E MVP 验收脚本（docs/MIGRATION-ROADMAP.md「MVP 定义」口径，真实 codex）。
 *
 * 跑什么：
 *   S1 初始化      — 隔离环境（临时 approot/data）启动主进程，DB 迁移 + Web 服务起，/api/health 200
 *   S2 setup       — POST /api/auth/setup 注册管理员 → session cookie → POST /api/groups 建 host 群组
 *   S3 首条消息    — POST /api/messages → 入库 → group-queue 调度 → codex 真执行 →
 *                    StreamEvent WS 推送 + 最终回复文本（含 marker）+ sessions 表 threadId 落库
 *   S4 多轮上下文  — 第二条消息引用第一条内容（同 thread 续轮）
 *   S5 工具冒烟    — 模型调 schedule_task + memory_append → IPC→DB 副作用（scheduled_tasks 行）
 *                    + 文件副作用（data/memory/** marker）
 *   S6 重启 resume — SIGTERM → 重启进程 → 同群组发消息召回 S3 marker，且 sessions.session_id 不变
 *   S7 Docker      — 镜像存在（happycodex-agent:latest）且 docker daemon 可用时：
 *                    建 container 群组重跑场景 4（发消息 → 容器内 codex 执行 → 回复）
 *
 * 前置：
 *   - npm run build（dist/index.js + dist/agent-runner.js）
 *   - codex CLI 已登录（~/.codex/auth.json，provisioner 复制链的共享凭据源）
 *   - S7 需先 docker build -f container/Dockerfile -t happycodex-agent:latest .
 *
 * 用法：
 *   node scripts/e2e-mvp.mjs              # 全量（Docker 场景按 daemon/镜像可用性自动降级为 SKIP）
 *   node scripts/e2e-mvp.mjs --no-docker  # 跳过 Docker 场景
 *   node scripts/e2e-mvp.mjs --keep       # 结束后保留临时环境（排障用）
 *
 * 退出码：0 = 全部非 SKIP 场景通过；1 = 有失败。
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import Database from 'better-sqlite3';

// ─── 常量 / 环境 ─────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// realpath：macOS /tmp → /private/tmp（Docker Desktop 默认共享 /private，容器挂载需要真实路径）
const E2E_ROOT = fs.realpathSync.native
  ? prepareRoot(process.env.E2E_ROOT || '/tmp/happycodex-e2e-mvp')
  : prepareRoot('/tmp/happycodex-e2e-mvp');
const APP_ROOT = path.join(E2E_ROOT, 'approot');
const PORT = parseInt(process.env.E2E_PORT || '43117', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes('--keep');
const NO_DOCKER = process.argv.includes('--no-docker');

const ADMIN_USER = 'e2eadmin';
const ADMIN_PASS = 'e2e-Passw0rd!';
const MARKER_1 = 'E2E-ALPHA-7391';
const FRUIT = 'dragonfruit';
const MEMORY_MARKER = 'E2E-MEMORY-MARKER-55AA';
const TASK_PROMPT_MARKER = 'E2E-TASK-PROBE-9d2f';
const REPLY_TIMEOUT_MS = 300_000; // codex 单轮上限（含首轮冷启动 provision）
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'HappyClaw';

function prepareRoot(p) {
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync(p);
}

// ─── 结果记录 ────────────────────────────────────────────────────────────────

const results = []; // {id, title, status: 'PASS'|'FAIL'|'SKIP', evidence: [], error?}
function record(id, title, status, evidence, error) {
  results.push({ id, title, status, evidence, ...(error ? { error: String(error) } : {}) });
  const tag = status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️ ' : '❌';
  console.log(`\n${tag} [${id}] ${title} — ${status}`);
  for (const e of evidence) console.log(`     · ${e}`);
  if (error) console.log(`     ! ${error}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 服务器进程管理 ──────────────────────────────────────────────────────────

let serverProc = null;
let serverLogPath = null;
let serverGen = 0;

async function startServer() {
  serverGen += 1;
  serverLogPath = path.join(E2E_ROOT, `server-${serverGen}.log`);
  const logFd = fs.openSync(serverLogPath, 'a');
  serverProc = spawn(process.execPath, [path.join(PROJECT_ROOT, 'dist', 'index.js')], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      WEB_PORT: String(PORT),
      ASSISTANT_NAME,
      // 隔离 cwd 下 data/ 即数据根；codex 共享凭据源走默认 ~/.codex（provisioner 复制链）
    },
    stdio: ['ignore', logFd, logFd],
    detached: false,
  });
  serverProc.on('exit', (code, signal) => {
    serverProc._exited = { code, signal, at: Date.now() };
  });
  // 等待 /api/health 200
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (serverProc._exited) {
      throw new Error(`主进程提前退出: ${JSON.stringify(serverProc._exited)}（日志 ${serverLogPath}）`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* 未就绪 */
    }
    await sleep(500);
  }
  throw new Error(`主进程 60s 内未就绪（日志 ${serverLogPath}）`);
}

async function stopServer(signal = 'SIGTERM', timeoutMs = 15_000) {
  if (!serverProc || serverProc._exited) return serverProc?._exited ?? null;
  const proc = serverProc;
  proc.kill(signal);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc._exited) return proc._exited;
    await sleep(200);
  }
  proc.kill('SIGKILL');
  await sleep(500);
  return proc._exited ?? { code: null, signal: 'SIGKILL(forced)' };
}

// ─── HTTP / WS 辅助 ──────────────────────────────────────────────────────────

let sessionCookie = '';

async function api(method, apiPath, body) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/(?:__Host-)?happyclaw_session=([^;]+)/);
    if (m) sessionCookie = `happyclaw_session=${m[1]}`;
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json };
}

/** WS 事件收集器（按 chatJid 聚合 stream_event / new_message）。 */
function connectWs() {
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { Cookie: sessionCookie },
  });
  ws.on('message', (data) => {
    try {
      events.push(JSON.parse(data.toString()));
    } catch {
      /* ignore */
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS 连接超时')), 10_000);
  });
  return { ws, events, opened };
}

/** 发消息并轮询直至 assistant 回复匹配 matcher。返回 {sent, reply}。 */
async function sendAndWaitReply(chatJid, content, matcher, timeoutMs = REPLY_TIMEOUT_MS) {
  const sentAt = new Date().toISOString();
  const post = await api('POST', '/api/messages', { chatJid, content });
  assert(post.status === 200 && post.json?.success, `POST /api/messages 失败: ${post.status} ${JSON.stringify(post.json)}`);
  const sent = { messageId: post.json.messageId, timestamp: post.json.timestamp };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const res = await api('GET', `/api/groups/${encodeURIComponent(chatJid)}/messages?limit=50`);
    assert(res.status === 200, `GET messages 失败: ${res.status}`);
    const msgs = res.json?.messages || [];
    const reply = msgs.find(
      (m) =>
        m.is_from_me &&
        m.sender_name === ASSISTANT_NAME &&
        m.timestamp >= sentAt &&
        typeof m.content === 'string' &&
        matcher(m.content),
    );
    if (reply) return { sent, reply };
    // 错误兜底：agent 失败时会落系统错误消息，提前失败而非干等超时
    const sysErr = msgs.find(
      (m) =>
        m.is_from_me &&
        m.timestamp >= sentAt &&
        typeof m.content === 'string' &&
        /(失败|错误|error|Error)/.test(m.content) &&
        m.sender_name !== ASSISTANT_NAME,
    );
    if (sysErr) throw new Error(`收到系统错误消息: ${sysErr.content.slice(0, 200)}`);
  }
  throw new Error(`等待回复超时（${timeoutMs / 1000}s）: ${content.slice(0, 60)}…`);
}

// ─── DB 直读断言 ─────────────────────────────────────────────────────────────

function openDb() {
  return new Database(path.join(APP_ROOT, 'data', 'db', 'messages.db'), { readonly: true });
}

function dbGet(sql, ...params) {
  const db = openDb();
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

function dbAll(sql, ...params) {
  const db = openDb();
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** 递归找文件内容包含 needle 的文件。 */
function grepDir(dir, needle) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = grepDir(p, needle);
      if (hit) return hit;
    } else if (entry.isFile()) {
      try {
        if (fs.readFileSync(p, 'utf8').includes(needle)) return p;
      } catch {
        /* 二进制等忽略 */
      }
    }
  }
  return null;
}

function grepServerLog(needle) {
  try {
    return fs
      .readFileSync(serverLogPath, 'utf8')
      .split('\n')
      .filter((l) => l.includes(needle));
  } catch {
    return [];
  }
}

// ─── 环境准备 / 清理 ─────────────────────────────────────────────────────────

function prepareEnv() {
  fs.rmSync(APP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(APP_ROOT, { recursive: true });
  // config/（default-groups / mount-allowlist / global-claude-md 模板）按 cwd 解析 → 复制
  fs.cpSync(path.join(PROJECT_ROOT, 'config'), path.join(APP_ROOT, 'config'), { recursive: true });
  // dist / web 按 cwd 解析（host preflight 校验 cwd/dist/agent-runner.js；serveStatic ./web/dist）→ 符号链接
  fs.symlinkSync(path.join(PROJECT_ROOT, 'dist'), path.join(APP_ROOT, 'dist'));
  fs.symlinkSync(path.join(PROJECT_ROOT, 'web'), path.join(APP_ROOT, 'web'));

  // 前置校验
  assert(fs.existsSync(path.join(PROJECT_ROOT, 'dist', 'index.js')), '缺 dist/index.js，先 npm run build');
  assert(fs.existsSync(path.join(PROJECT_ROOT, 'dist', 'agent-runner.js')), '缺 dist/agent-runner.js，先 npm run build');
  const sharedCodexHome =
    process.env.HAPPYCODEX_SHARED_CODEX_HOME ||
    process.env.CODEX_HOME ||
    path.join(process.env.HOME || '', '.codex');
  assert(
    fs.existsSync(path.join(sharedCodexHome, 'auth.json')),
    `共享 codex home 未登录（缺 ${sharedCodexHome}/auth.json），先 codex login`,
  );
}

function dockerStatus() {
  if (NO_DOCKER) return { ok: false, reason: '--no-docker 指定跳过' };
  try {
    execFileSync('docker', ['info'], { timeout: 10_000, stdio: 'pipe' });
  } catch {
    return { ok: false, reason: 'docker daemon 不可用' };
  }
  try {
    const out = execFileSync('docker', ['images', '-q', 'happycodex-agent:latest'], {
      timeout: 10_000,
    })
      .toString()
      .trim();
    if (!out) return { ok: false, reason: '镜像 happycodex-agent:latest 不存在（先 docker build）' };
    return { ok: true, imageId: out };
  } catch (e) {
    return { ok: false, reason: `docker images 查询失败: ${e}` };
  }
}

// ─── 场景 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`E2E root: ${E2E_ROOT}\nApp root: ${APP_ROOT}\nPort: ${PORT}`);
  prepareEnv();

  let wsConn = null;
  let hostJid = null;
  let hostFolder = null;
  let threadId1 = null;

  // S1 初始化
  try {
    await startServer();
    const health = await fetch(`${BASE}/api/health`);
    const root = await fetch(`${BASE}/`);
    const migrated = grepServerLog('migration').length + grepServerLog('Migrat').length;
    record('S1', '隔离环境启动主进程（DB 迁移 + Web 服务）', 'PASS', [
      `GET /api/health → ${health.status}`,
      `GET / → ${root.status}（前端静态资源）`,
      `server log: ${serverLogPath}（migration 相关行 ${migrated} 条）`,
    ]);
  } catch (err) {
    record('S1', '隔离环境启动主进程（DB 迁移 + Web 服务）', 'FAIL', [], err);
    throw err; // 后续全部依赖
  }

  // S2 setup：注册管理员 + 登录态 + 建群组
  try {
    const setup = await api('POST', '/api/auth/setup', { username: ADMIN_USER, password: ADMIN_PASS });
    assert(setup.status === 201 && setup.json?.success, `setup 失败: ${setup.status} ${JSON.stringify(setup.json)}`);
    assert(sessionCookie, '未拿到 session cookie');
    const me = await api('GET', '/api/auth/me');
    assert(me.status === 200, `GET /api/auth/me 失败: ${me.status}`);
    const create = await api('POST', '/api/groups', { name: 'e2e-host', execution_mode: 'host' });
    assert(create.status === 200 && create.json?.success, `建群组失败: ${create.status} ${JSON.stringify(create.json)}`);
    hostJid = create.json.jid;
    hostFolder = create.json.group.folder;
    const row = dbGet('SELECT jid, folder FROM registered_groups WHERE jid = ?', hostJid);
    assert(row && row.folder === hostFolder, 'registered_groups 未落库');
    record('S2', 'Web API setup（管理员注册→登录→建 host 群组）', 'PASS', [
      `POST /api/auth/setup → 201（admin=${ADMIN_USER}，cookie 已取得）`,
      `POST /api/groups → jid=${hostJid} folder=${hostFolder} mode=host`,
      `DB registered_groups 落库: ${JSON.stringify(row)}`,
    ]);
  } catch (err) {
    record('S2', 'Web API setup（管理员注册→登录→建 host 群组）', 'FAIL', [], err);
    throw err;
  }

  // WS 订阅（S3 用）
  wsConn = connectWs();
  await wsConn.opened;

  // S3 首条消息：完整管线
  try {
    const content = `Please reply with exactly this code: ${MARKER_1} . Also remember for later: my favorite fruit is ${FRUIT}. No tools needed.`;
    const { sent, reply } = await sendAndWaitReply(hostJid, content, (t) => t.includes(MARKER_1));
    // 入库（用户消息 + 回复）
    const userRow = dbGet('SELECT id, content FROM messages WHERE id = ?', sent.messageId);
    assert(userRow, '用户消息未入库');
    const replyRow = dbGet('SELECT id, sender_name, content FROM messages WHERE id = ?', reply.id);
    assert(replyRow && replyRow.content.includes(MARKER_1), '回复未入库或缺 marker');
    // group-queue 调度 + codex 真执行（主进程日志）
    const spawnLines = grepServerLog('Spawning host agent');
    const codexLines = grepServerLog('codex binary resolved');
    assert(spawnLines.length >= 1, '日志无 Spawning host agent（group-queue 未调度）');
    // sessions 表 threadId 落库
    const sess = dbGet("SELECT group_folder, session_id FROM sessions WHERE group_folder = ? AND agent_id = ''", hostFolder);
    assert(sess?.session_id, 'sessions 表无 threadId');
    threadId1 = sess.session_id;
    // per-folder CODEX_HOME 落盘（provisioner 复制链）
    const folderCodexHome = path.join(APP_ROOT, 'data', 'sessions', hostFolder, '.codex');
    assert(fs.existsSync(path.join(folderCodexHome, 'auth.json')), 'per-folder CODEX_HOME auth.json 缺失');
    // WS 流式推送
    const streamEvts = wsConn.events.filter((e) => e.type === 'stream_event' && e.chatJid === hostJid);
    const evtTypes = [...new Set(streamEvts.map((e) => e.event?.eventType))];
    const newMsgEvts = wsConn.events.filter(
      (e) => e.type === 'new_message' && e.chatJid === hostJid && e.message?.id === reply.id,
    );
    assert(streamEvts.length > 0, 'WS 无 stream_event 推送');
    assert(newMsgEvts.length === 1, 'WS 无回复 new_message 推送');
    record('S3', '首条消息全管线（入库→调度→codex 执行→WS 流式→回复）', 'PASS', [
      `用户消息入库 id=${sent.messageId}`,
      `回复入库 id=${reply.id}，含 marker ${MARKER_1}：${replyRow.content.slice(0, 120).replace(/\n/g, ' ')}`,
      `group-queue 调度证据: 'Spawning host agent' ×${spawnLines.length}，'codex binary resolved' ×${codexLines.length}`,
      `sessions 表 threadId=${threadId1}（folder=${hostFolder}）`,
      `per-folder CODEX_HOME provision: ${folderCodexHome}/auth.json 存在`,
      `WS stream_event ×${streamEvts.length}（eventType: ${evtTypes.join(', ')}），new_message 回复推送 ×${newMsgEvts.length}`,
    ]);
  } catch (err) {
    record('S3', '首条消息全管线（入库→调度→codex 执行→WS 流式→回复）', 'FAIL', [], err);
  }

  // S4 多轮上下文
  try {
    const { reply } = await sendAndWaitReply(
      hostJid,
      'What is my favorite fruit (the one I told you earlier)? Answer in one short sentence.',
      (t) => t.toLowerCase().includes(FRUIT),
    );
    const sess = dbGet("SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ''", hostFolder);
    assert(sess?.session_id === threadId1, `多轮后 threadId 变了: ${sess?.session_id} ≠ ${threadId1}`);
    record('S4', '第二条消息多轮上下文（召回第一条内容）', 'PASS', [
      `回复含 "${FRUIT}"：${reply.content.slice(0, 120).replace(/\n/g, ' ')}`,
      `threadId 未变（同 thread 续轮）: ${threadId1}`,
    ]);
  } catch (err) {
    record('S4', '第二条消息多轮上下文（召回第一条内容）', 'FAIL', [], err);
  }

  // S5 工具冒烟：schedule_task（IPC→DB）+ memory_append（文件副作用）
  try {
    const content =
      `Do two tool calls now: ` +
      `1) call schedule_task with name "e2e-probe", prompt "${TASK_PROMPT_MARKER}", schedule {kind:"once", at:"2099-01-01T00:00:00"}; ` +
      `2) call memory_append with content "${MEMORY_MARKER}". ` +
      `Then reply exactly: DONE-TOOL`;
    const { reply } = await sendAndWaitReply(hostJid, content, (t) => t.includes('DONE-TOOL'));
    // DB 副作用（IPC tasks/*.json → 主进程 watcher → scheduled_tasks）；watcher 轮询给 30s 余量
    let taskRow = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !taskRow) {
      taskRow = dbGet('SELECT id, group_folder, prompt, schedule_type, schedule_value, status FROM scheduled_tasks WHERE prompt LIKE ?', `%${TASK_PROMPT_MARKER}%`);
      if (!taskRow) await sleep(2_000);
    }
    assert(taskRow, 'scheduled_tasks 无任务行（IPC schedule_task 链路未落地）');
    assert(taskRow.group_folder === hostFolder, `任务 folder 不符: ${taskRow.group_folder}`);
    // 文件副作用（memory_append）
    const memHit = grepDir(path.join(APP_ROOT, 'data', 'memory'), MEMORY_MARKER);
    assert(memHit, 'data/memory 下未找到 memory_append 内容');
    // IPC 目录结构存在（input/messages/tasks 三通道）
    const ipcDir = path.join(APP_ROOT, 'data', 'ipc', hostFolder);
    const ipcChannels = fs.existsSync(ipcDir) ? fs.readdirSync(ipcDir).sort().join(',') : '(missing)';
    record('S5', '工具冒烟（schedule_task IPC→DB + memory_append 文件副作用）', 'PASS', [
      `回复: ${reply.content.slice(0, 80).replace(/\n/g, ' ')}`,
      `scheduled_tasks 行: ${JSON.stringify(taskRow)}`,
      `memory 文件命中: ${memHit}`,
      `IPC 目录 ${ipcDir} 通道: ${ipcChannels}`,
    ]);
  } catch (err) {
    record('S5', '工具冒烟（schedule_task IPC→DB + memory_append 文件副作用）', 'FAIL', [], err);
  }

  // S6 重启 resume
  try {
    const exited = await stopServer('SIGTERM');
    assert(exited && exited.code === 0, `SIGTERM 退出异常: ${JSON.stringify(exited)}`);
    try {
      wsConn?.ws.close();
    } catch { /* already closed by server */ }
    await startServer();
    const sessBefore = dbGet("SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ''", hostFolder);
    const { reply } = await sendAndWaitReply(
      hostJid,
      'Earlier in this conversation I gave you a code starting with E2E-ALPHA. Reply with just that exact code.',
      (t) => t.includes(MARKER_1),
    );
    const sessAfter = dbGet("SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ''", hostFolder);
    assert(sessAfter?.session_id === threadId1, `重启后 threadId 变了: ${sessAfter?.session_id} ≠ ${threadId1}（resume 失败，新开了 thread）`);
    record('S6', '重启验收（SIGTERM→重启→同会话 codex thread resume）', 'PASS', [
      `SIGTERM 优雅退出 code=0`,
      `重启后回复召回 marker：${reply.content.slice(0, 120).replace(/\n/g, ' ')}`,
      `threadId 跨重启不变: before=${sessBefore?.session_id} after=${sessAfter?.session_id}（resume 而非新 thread）`,
    ]);
  } catch (err) {
    record('S6', '重启验收（SIGTERM→重启→同会话 codex thread resume）', 'FAIL', [], err);
  }

  // S7 Docker 容器模式
  const dk = dockerStatus();
  if (!dk.ok) {
    record('S7', 'Docker 容器模式（建 container 群组→容器内 codex 执行→回复）', 'SKIP', [dk.reason]);
  } else {
    try {
      const create = await api('POST', '/api/groups', { name: 'e2e-docker', execution_mode: 'container' });
      assert(create.status === 200 && create.json?.success, `建 container 群组失败: ${create.status} ${JSON.stringify(create.json)}`);
      const dockerJid = create.json.jid;
      const dockerFolder = create.json.group.folder;
      const marker = 'E2E-DOCKER-BRAVO-42';
      const { reply } = await sendAndWaitReply(
        dockerJid,
        `Reply with exactly this code: ${marker} . Also run a shell command to read /etc/os-release and tell me the distro ID in the same reply. No other tools.`,
        (t) => t.includes(marker),
        420_000, // 容器冷启动（镜像加载 + codex 首轮）更慢
      );
      const sess = dbGet("SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ''", dockerFolder);
      const dockerLogLines = grepServerLog('docker');
      record('S7', 'Docker 容器模式（建 container 群组→容器内 codex 执行→回复）', 'PASS', [
        `镜像 happycodex-agent:latest (${dk.imageId})`,
        `jid=${dockerJid} folder=${dockerFolder} mode=container`,
        `回复含 marker：${reply.content.slice(0, 160).replace(/\n/g, ' ')}`,
        `sessions threadId=${sess?.session_id}`,
        `主进程日志 docker 相关行 ×${dockerLogLines.length}`,
      ]);
    } catch (err) {
      record('S7', 'Docker 容器模式（建 container 群组→容器内 codex 执行→回复）', 'FAIL', [], err);
    }
  }

  // ─── 收尾 ───
  try {
    wsConn?.ws.close();
  } catch { /* noop */ }
  const exited = await stopServer('SIGTERM');
  console.log(`\n服务器收口: ${JSON.stringify(exited)}`);

  const failed = results.filter((r) => r.status === 'FAIL');
  console.log('\n══════════ E2E MVP 验收汇总 ══════════');
  for (const r of results) console.log(`${r.status.padEnd(4)} [${r.id}] ${r.title}`);
  console.log(JSON.stringify({ results }, null, 2));

  if (!KEEP) {
    fs.rmSync(APP_ROOT, { recursive: true, force: true });
    console.log(`已清理 ${APP_ROOT}（日志保留在 ${E2E_ROOT}/server-*.log）`);
  } else {
    console.log(`--keep：保留 ${APP_ROOT}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\n💥 E2E 致命错误:', err);
  await stopServer('SIGTERM').catch(() => {});
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(JSON.stringify({ results, fatal: String(err) }, null, 2));
  process.exit(1);
});
