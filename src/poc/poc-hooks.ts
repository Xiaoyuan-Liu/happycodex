/**
 * PoC（Stage 5/B3）：hooks 端到端 + trusted_hash 信任机制调研 —— 对真实 codex 0.137.0。
 *
 * B3 唯一未验的环节是 hooks 的「信任校验」：codex 是否要求把 hook 标记 trusted 才会执行？
 * 算法/输入是什么？能否在 standalone provision 时纯程序化复算并写入（→ recommendation='config'），
 * 还是必须走 managed_dir / is_managed 绕过（→ recommendation='managed_dir'）。
 *
 * 真实格式（探明自 ~/.codex）：
 *   - config.toml: [features] hooks = true 开启特性
 *   - hooks.json（CODEX_HOME 根）: { "hooks": { "SessionStart":[{ "hooks":[{type,command,timeout}] }], "Stop":[...] } }
 *   - 信任态: config.toml 里 [hooks.state."<sourcePath>:<event_snake>:<group_idx>:<handler_idx>"] trusted_hash="sha256:..."
 *     例：[hooks.state."/Users/.../hooks.json:session_start:0:0"] trusted_hash = "sha256:f4cf…"
 *
 * 核心方法（关键技巧，避免逆向 hash 算法）：
 *   codex 暴露 JSON-RPC 方法 `hooks/list`（ClientRequest.ts 确认），返回每个 hook 的
 *   HookMetadata { key, currentHash, trustStatus, isManaged, ... }。
 *   → 我们让 codex **自己算出** currentHash，读回来，再原样写进 config.toml 的 trusted_hash。
 *   这就是「程序化复算」：不需要我们实现 hash，只要复用 codex 给的 currentHash 即可。
 *   若写回后 trustStatus 翻成 'trusted' 且 hook 真触发 → recommendation='config'。
 *
 * 四个阶段：
 *   A. 写 features+hooks.json（不带任何 trusted_hash）→ hooks/list 读 key/currentHash/trustStatus（基线：应 untrusted）。
 *   B. 未信任就跑一轮 + 关会话 → 看 SessionStart/Stop 是否触发（hook/started|completed 通知 + echo 落文件）。预期：不触发。
 *   C. 把 A 读到的 currentHash 写成 [hooks.state.<key>] trusted_hash → 新进程 hooks/list 复核 trustStatus=trusted，
 *      再跑一轮 + 关会话 → 看 hook 是否真触发。成功 → 程序化 config 路可行。
 *   D. 兜底：若 C 不通，测 managed_dir / isManaged 是否能绕信任（写 config managed_dir 指向 hooks 所在目录）。
 *
 * 约束：临时 CODEX_HOME + 拷 auth.json 复用登录态；{approvalPolicy:'never', sandbox:'read-only'}；结束清理。
 * 结尾打印 OK / UNCERTAIN / FAIL，并以 JSON 落一行到 stdout 供 orchestration 抓取。
 * 跑：npm run poc:hooks
 */

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  copyFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { AppServerClient } from '../appserver/client.js';
import {
  Method,
  ServerNotif,
  textInput,
  type ThreadStartParams,
  type ThreadStartResponse,
  type TurnStartParams,
  type TurnStartResponse,
  type TurnCompletedNotification,
  type HookStartedNotification,
  type HookCompletedNotification,
} from '../appserver/protocol.js';
// Phase E：用生产模块（非内联 POC 代码）证明端到端可行。
import {
  writeHooksJson,
  ensureHooksFeature,
  trustManagedHooks,
  CONFIG_TOML_FILE,
} from '../runtime/multitenant/hooks-config.js';

// hooks/list 不在 protocol.ts 的 Method 常量里（MVP 未消费），用裸字符串。
const M_HOOKS_LIST = 'hooks/list';

// ───────────────────────── HookMetadata（对齐 protocol/ts/v2/HookMetadata.ts，仅取本 PoC 关心字段） ─────────────────────────
interface HookMetadata {
  key: string;
  eventName: string;
  handlerType: string;
  matcher: string | null;
  command: string | null;
  source: string;
  sourcePath: string;
  isManaged: boolean;
  enabled: boolean;
  currentHash: string;
  trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified';
}
interface HooksListEntry {
  cwd: string;
  hooks: HookMetadata[];
  warnings: string[];
  errors: Array<{ path: string; message: string }>;
}
interface HooksListResponse {
  data: HooksListEntry[];
}

// ───────────────────────── 通知抓取（hook/started|completed） ─────────────────────────
interface HookNotif {
  phase: 'started' | 'completed';
  eventName: string;
  status?: string;
  statusMessage?: string | null;
}

class HookWatcher {
  notifs: HookNotif[] = [];
  attach(client: AppServerClient): () => void {
    return client.onNotification((method, params) => {
      if (method === ServerNotif.hookStarted) {
        const p = params as HookStartedNotification;
        this.notifs.push({ phase: 'started', eventName: p?.run?.eventName ?? '(?)' });
      } else if (method === ServerNotif.hookCompleted) {
        const p = params as HookCompletedNotification;
        this.notifs.push({
          phase: 'completed',
          eventName: p?.run?.eventName ?? '(?)',
          status: p?.run?.status,
          statusMessage: p?.run?.statusMessage,
        });
      }
    });
  }
  byEvent(name: string): HookNotif[] {
    return this.notifs.filter((n) => n.eventName === name);
  }
  reset(): void {
    this.notifs = [];
  }
}

// ───────────────────────── CODEX_HOME 装配 ─────────────────────────

interface HomeLayout {
  home: string;
  configToml: string;
  hooksJson: string;
  sessionStartMarker: string; // SessionStart echo 落点
  stopMarker: string; // Stop echo 落点
}

/** 创建临时 CODEX_HOME：拷 auth.json、写 features、写 hooks.json（SessionStart + Stop，echo 到 marker 文件）。 */
function provisionHome(withTrust: { key: string; hash: string }[] | null, managedDir: string | null): HomeLayout {
  const home = mkdtempSync(join(tmpdir(), 'happycodex-hooks-'));
  const configToml = join(home, 'config.toml');
  const hooksJson = join(home, 'hooks.json');
  const sessionStartMarker = join(home, 'fired-session-start.txt');
  const stopMarker = join(home, 'fired-stop.txt');

  // 复用真实登录态
  const realAuth = join(homedir(), '.codex', 'auth.json');
  if (existsSync(realAuth)) copyFileSync(realAuth, join(home, 'auth.json'));

  // 无副作用 echo 命令：把一行 append 到 marker 文件（hook 触发的可观测痕迹）。
  const ssCmd = `printf 'SS\\n' >> ${JSON.stringify(sessionStartMarker)}`;
  const stopCmd = `printf 'STOP\\n' >> ${JSON.stringify(stopMarker)}`;

  const hooks = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: ssCmd, timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: stopCmd, timeout: 10 }] }],
    },
  };
  writeFileSync(hooksJson, JSON.stringify(hooks, null, 2), 'utf8');

  // config.toml：开启 hooks 特性。沙箱/审批在 thread/start 传，这里只放静态特性 + 可选信任态/managed_dir。
  let cfg = '[features]\nhooks = true\n';
  if (managedDir) {
    // 探针 D：managed hooks 目录（is_managed 绕信任）。真实字段名取自 ManagedHooksRequirements.managedDir + binary "managed_dir="。
    cfg += `\n[hooks]\nmanaged_dir = ${JSON.stringify(managedDir)}\n`;
  }
  if (withTrust) {
    for (const t of withTrust) {
      cfg += `\n[hooks.state.${JSON.stringify(t.key)}]\ntrusted_hash = ${JSON.stringify(t.hash)}\n`;
    }
  }
  writeFileSync(configToml, cfg, 'utf8');

  return { home, configToml, hooksJson, sessionStartMarker, stopMarker };
}

/** 把已读到的 trusted_hash 追加进现有 home 的 config.toml（用于 A→C 同一 home 演进，避免重新 provision 影响 hash）。 */
function appendTrust(layout: HomeLayout, entries: { key: string; hash: string }[]): void {
  let extra = '';
  for (const t of entries) {
    extra += `\n[hooks.state.${JSON.stringify(t.key)}]\ntrusted_hash = ${JSON.stringify(t.hash)}\n`;
  }
  appendFileSync(layout.configToml, extra, 'utf8');
}

// ───────────────────────── 协议 helper ─────────────────────────

async function startClient(home: string): Promise<AppServerClient> {
  const client = new AppServerClient({
    requestTimeoutMs: 120_000,
    env: { CODEX_HOME: home },
  });
  await client.start();
  return client;
}

async function hooksList(client: AppServerClient, cwd: string): Promise<HookMetadata[]> {
  const resp = await client.request<HooksListResponse>(M_HOOKS_LIST, { cwds: [cwd] });
  const entry = resp?.data?.[0];
  return entry?.hooks ?? [];
}

async function startThread(client: AppServerClient): Promise<ThreadStartResponse> {
  const params: ThreadStartParams = { approvalPolicy: 'never', sandbox: 'read-only' };
  return client.request<ThreadStartResponse>(Method.threadStart, params);
}

async function runTurn(client: AppServerClient, threadId: string, text: string): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const off = client.onNotification((method, params) => {
      if (method === ServerNotif.turnCompleted) {
        const p = params as TurnCompletedNotification;
        if (p?.threadId === threadId) {
          off();
          resolve();
        }
      }
    });
  });
  const params: TurnStartParams = { threadId, input: [textInput(text)] };
  await client.request<TurnStartResponse>(Method.turnStart, params);
  await done;
}

/**
 * 给 hook（可能 async）一点时间把 echo 落盘 + 推 hook/completed。
 * 注意：此处**不** unref —— 关闭 client 后 child 已死、其它 timer 也 unref，
 * 若这里也 unref，事件循环会空转退出导致 await 永不 resolve（进程静默 exit 0）。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

function markerLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0).length;
}

// ───────────────────────── 一次「跑一轮 + 关会话」观测 ─────────────────────────

interface FireResult {
  sessionStartNotif: boolean;
  stopNotif: boolean;
  sessionStartMarker: number;
  stopMarker: number;
  hookNotifDump: string;
}

/**
 * 在给定 home 上：start client → hooks/list（返回 metadata）→ thread/start → 跑一轮 →
 * 等 hook → 关 client（触发 Stop）→ 再等 → 统计触发证据。
 */
async function exerciseHome(
  layout: HomeLayout,
  label: string,
): Promise<{ metas: HookMetadata[]; fire: FireResult }> {
  const client = await startClient(layout.home);
  const watcher = new HookWatcher();
  const off = watcher.attach(client);
  let metas: HookMetadata[] = [];
  try {
    // hooks/list：读 codex 自算的 key/currentHash/trustStatus
    const threadEarly = await startThread(client);
    const cwd = process.cwd();
    metas = await hooksList(client, cwd);
    console.error(`[poc-hooks][${label}] hooks/list → ${metas.length} hook(s)`);
    for (const m of metas) {
      console.error(
        `[poc-hooks][${label}]   key=${m.key} event=${m.eventName} trust=${m.trustStatus} managed=${m.isManaged} hash=${m.currentHash}`,
      );
    }

    // SessionStart 在 thread 建立时触发；给它时间落盘
    console.error(`[poc-hooks][${label}] thread=${threadEarly.thread.id}; sleeping for SessionStart…`);
    await sleep(1500);

    // 跑一轮（轻量），让 Stop 有机会在 turn 结束触发（部分实现 Stop=turn 完成；也可能仅在会话关闭时）
    console.error(`[poc-hooks][${label}] running turn…`);
    await runTurn(client, threadEarly.thread.id, 'Reply with exactly the single word: PING');
    console.error(`[poc-hooks][${label}] turn done; sleeping…`);
    await sleep(1500);
  } finally {
    off();
    // 关 client → app-server 退出 → 触发会话级 Stop（若实现如此）
    await client.close();
  }
  // 关后再等一拍，给 Stop 的 detached echo 落盘
  await sleep(1500);

  const fire: FireResult = {
    sessionStartNotif: watcher.byEvent('sessionStart').length > 0,
    stopNotif: watcher.byEvent('stop').length > 0,
    sessionStartMarker: markerLines(layout.sessionStartMarker),
    stopMarker: markerLines(layout.stopMarker),
    hookNotifDump: JSON.stringify(watcher.notifs),
  };
  console.error(
    `[poc-hooks][${label}] fire: SS_notif=${fire.sessionStartNotif} STOP_notif=${fire.stopNotif} SS_marker=${fire.sessionStartMarker} STOP_marker=${fire.stopMarker}`,
  );
  return { metas, fire };
}

// ───────────────────────── 主流程 ─────────────────────────

interface Findings {
  ranAgainstRealCodex: boolean;
  sessionStartFires: string;
  stopFires: string;
  trustedHashMechanism: string;
  programmaticSetupWorks: boolean;
  recommendation: 'config' | 'managed_dir';
  verdict: 'OK' | 'UNCERTAIN' | 'FAIL';
  evidence: string[];
}

async function main(): Promise<number> {
  const f: Findings = {
    ranAgainstRealCodex: false,
    sessionStartFires: 'UNKNOWN',
    stopFires: 'UNKNOWN',
    trustedHashMechanism: 'UNKNOWN',
    programmaticSetupWorks: false,
    recommendation: 'managed_dir',
    verdict: 'UNCERTAIN',
    evidence: [],
  };

  const homesToClean: string[] = [];

  try {
    // ── 阶段 A+B：未信任基线（无 trusted_hash） ──
    console.error('[poc-hooks] ── 阶段 A+B：未信任基线（无 trusted_hash）──');
    const layoutA = provisionHome(null, null);
    homesToClean.push(layoutA.home);
    f.ranAgainstRealCodex = true;
    f.evidence.push(`[A] CODEX_HOME=${layoutA.home}`);
    const { metas: metasA, fire: fireA } = await exerciseHome(layoutA, 'A:untrusted');

    if (metasA.length === 0) {
      f.evidence.push('[A] hooks/list returned 0 hooks — hooks.json 未被识别（特性/格式问题）');
    }
    // 记录未信任时各 hook 的 trustStatus + currentHash（这是程序化复算的关键输入）
    const ssMeta = metasA.find((m) => m.eventName === 'sessionStart');
    const stopMeta = metasA.find((m) => m.eventName === 'stop');
    f.evidence.push(
      `[A] sessionStart meta: ${ssMeta ? `trust=${ssMeta.trustStatus} hash=${ssMeta.currentHash} key=${ssMeta.key}` : 'MISSING'}`,
    );
    f.evidence.push(
      `[A] stop meta: ${stopMeta ? `trust=${stopMeta.trustStatus} hash=${stopMeta.currentHash} key=${stopMeta.key}` : 'MISSING'}`,
    );
    f.evidence.push(
      `[B] untrusted fire: SS_notif=${fireA.sessionStartNotif} STOP_notif=${fireA.stopNotif} SS_marker=${fireA.sessionStartMarker} STOP_marker=${fireA.stopMarker}`,
    );
    f.evidence.push(`[B] untrusted hook notif dump: ${fireA.hookNotifDump.slice(0, 300)}`);

    const firedWhenUntrusted =
      fireA.sessionStartNotif || fireA.stopNotif || fireA.sessionStartMarker > 0 || fireA.stopMarker > 0;

    // 推断信任机制基线
    if (metasA.length > 0 && (ssMeta?.trustStatus === 'untrusted' || stopMeta?.trustStatus === 'untrusted')) {
      f.trustedHashMechanism =
        'REQUIRED — hooks/list 显示新写入的 hook trustStatus="untrusted"，codex 暴露 currentHash（sha256:...）。' +
        '未信任时 hook ' +
        (firedWhenUntrusted ? '仍触发(意外，需复核)' : '不触发') +
        '。';
    }

    // ── 阶段 C：写回 currentHash 作 trusted_hash，复核 trustStatus + 再跑 ──
    let trustWorked = false;
    if (ssMeta && stopMeta && ssMeta.currentHash && stopMeta.currentHash) {
      console.error('[poc-hooks] ── 阶段 C：写 trusted_hash=currentHash 后复核 + 触发 ──');
      // 关键：直接复用 codex 给的 currentHash → 程序化复算（无需自己实现 hash 算法）。
      appendTrust(layoutA, [
        { key: ssMeta.key, hash: ssMeta.currentHash },
        { key: stopMeta.key, hash: stopMeta.currentHash },
      ]);
      f.evidence.push(
        `[C] wrote [hooks.state."${ssMeta.key}"].trusted_hash=${ssMeta.currentHash} (+stop) into config.toml`,
      );

      const { metas: metasC, fire: fireC } = await exerciseHome(layoutA, 'C:trusted');
      const ssC = metasC.find((m) => m.eventName === 'sessionStart');
      const stopC = metasC.find((m) => m.eventName === 'stop');
      f.evidence.push(
        `[C] after-write trust: sessionStart=${ssC?.trustStatus ?? '?'} stop=${stopC?.trustStatus ?? '?'}`,
      );
      f.evidence.push(
        `[C] trusted fire: SS_notif=${fireC.sessionStartNotif} STOP_notif=${fireC.stopNotif} SS_marker=${fireC.sessionStartMarker} STOP_marker=${fireC.stopMarker}`,
      );
      f.evidence.push(`[C] trusted hook notif dump: ${fireC.hookNotifDump.slice(0, 300)}`);

      const becameTrusted = ssC?.trustStatus === 'trusted' || stopC?.trustStatus === 'trusted';
      const firedWhenTrusted =
        fireC.sessionStartNotif || fireC.stopNotif || fireC.sessionStartMarker > 0 || fireC.stopMarker > 0;

      f.sessionStartFires = fireC.sessionStartNotif
        ? 'YES — hook/started|completed(sessionStart) 通知收到（trusted 后）'
        : fireC.sessionStartMarker > 0
          ? 'YES(marker) — SessionStart echo 落盘但无通知'
          : 'NO — trusted 后仍未观测到 SessionStart 触发';
      f.stopFires = fireC.stopNotif
        ? 'YES — hook/started|completed(stop) 通知收到（trusted 后）'
        : fireC.stopMarker > 0
          ? 'YES(marker) — Stop echo 落盘但无通知'
          : 'NO — trusted 后未观测到 Stop 触发（可能 Stop 仅在会话关闭/特定边界）';

      if (becameTrusted) {
        f.trustedHashMechanism =
          'sha256(codex 自算)，可程序化复算：写空配置后调 hooks/list 读 HookMetadata.currentHash（"sha256:<hex>"），' +
          '原样写入 config.toml 的 [hooks.state."<sourcePath>:<event_snake>:<group_idx>:<handler_idx>"].trusted_hash → ' +
          'trustStatus 翻成 "trusted"。' +
          (ssMeta.currentHash === ssC?.currentHash ? ' currentHash 在写前后稳定。' : ' 注意 currentHash 写前后变化。');
      }

      trustWorked = becameTrusted && firedWhenTrusted;
      if (trustWorked) {
        f.programmaticSetupWorks = true;
        f.recommendation = 'config';
      }
    } else {
      f.evidence.push('[C] 跳过：阶段 A 未拿到 sessionStart/stop 的 currentHash');
    }

    // ── 阶段 D：兜底 managed_dir / isManaged 绕信任（仅当 C 未通） ──
    if (!trustWorked) {
      console.error('[poc-hooks] ── 阶段 D：兜底 managed_dir（is_managed 绕信任）──');
      // hooks 放到独立 managed 目录，config 指 managed_dir 到那里。
      const layoutD = provisionHome(null, null);
      homesToClean.push(layoutD.home);
      // 用 home 自身作为 managed_dir（hooks.json 就在 home 根；若 codex 期望 managed_dir 下有 hooks.json，这满足）。
      const managedHooksDir = layoutD.home;
      // 重写 config 带 managed_dir
      writeFileSync(
        layoutD.configToml,
        `[features]\nhooks = true\n\n[hooks]\nmanaged_dir = ${JSON.stringify(managedHooksDir)}\n`,
        'utf8',
      );
      f.evidence.push(`[D] managed_dir=${managedHooksDir}`);
      const { metas: metasD, fire: fireD } = await exerciseHome(layoutD, 'D:managed');
      const anyManaged = metasD.some((m) => m.isManaged || m.trustStatus === 'managed');
      const firedManaged =
        fireD.sessionStartNotif || fireD.stopNotif || fireD.sessionStartMarker > 0 || fireD.stopMarker > 0;
      f.evidence.push(
        `[D] managed: anyManaged=${anyManaged} fire(SS_notif=${fireD.sessionStartNotif} STOP_notif=${fireD.stopNotif} SS_marker=${fireD.sessionStartMarker} STOP_marker=${fireD.stopMarker})`,
      );
      f.evidence.push(`[D] managed metas: ${JSON.stringify(metasD.map((m) => ({ e: m.eventName, t: m.trustStatus, m: m.isManaged })))}`);

      if (anyManaged && firedManaged) {
        f.programmaticSetupWorks = true;
        f.recommendation = 'managed_dir';
        f.trustedHashMechanism =
          (f.trustedHashMechanism === 'UNKNOWN' ? '' : f.trustedHashMechanism + ' ') +
          'managed_dir 路径：hooks 标为 isManaged/trustStatus="managed"，绕过 trusted_hash 校验直接执行。';
        // 若 SS/Stop 触发数据此前是 NO，用 managed 结果覆盖
        if (f.sessionStartFires.startsWith('NO') || f.sessionStartFires === 'UNKNOWN') {
          f.sessionStartFires = fireD.sessionStartNotif || fireD.sessionStartMarker > 0
            ? 'YES(managed) — SessionStart 在 managed_dir 下触发'
            : f.sessionStartFires;
        }
        if (f.stopFires.startsWith('NO') || f.stopFires === 'UNKNOWN') {
          f.stopFires = fireD.stopNotif || fireD.stopMarker > 0
            ? 'YES(managed) — Stop 在 managed_dir 下触发'
            : f.stopFires;
        }
      } else {
        f.evidence.push('[D] managed_dir 未生效（字段名/布局可能不符；以 config 路为准）');
      }
    }

    // ── 阶段 E：用生产模块 hooks-config.ts 端到端复证（配置注入后 hook 真触发） ──
    // 不用内联 POC 代码，而是走 writeHooksJson + ensureHooksFeature + trustManagedHooks，
    // 证明 SessionManager 实际调用的那套函数能让 SessionStart/Stop 在真实 codex 触发。
    try {
      console.error('[poc-hooks] ── 阶段 E：生产模块 hooks-config.ts 端到端复证 ──');
      const eHome = mkdtempSync(join(tmpdir(), 'happycodex-hooks-E-'));
      homesToClean.push(eHome);
      const realAuth = join(homedir(), '.codex', 'auth.json');
      if (existsSync(realAuth)) copyFileSync(realAuth, join(eHome, 'auth.json'));

      const ssMarker = join(eHome, 'fired-session-start.txt');
      const stopMarker = join(eHome, 'fired-stop.txt');
      // 生产函数：写 hooks.json + [features] hooks=true。
      const hooksPath = await writeHooksJson(eHome, {
        sessionStartCommand: `printf 'SS\\n' >> ${JSON.stringify(ssMarker)}`,
        stopCommand: `printf 'STOP\\n' >> ${JSON.stringify(stopMarker)}`,
      });
      await ensureHooksFeature(join(eHome, CONFIG_TOML_FILE));
      f.evidence.push(`[E] provisioned via hooks-config.ts; hooks.json=${hooksPath}`);

      // 起 client → 生产函数 trustManagedHooks（list→选→写 trusted_hash）。
      const c1 = await startClient(eHome);
      // 建个 thread 让 hooks/list 能按 cwd 命中（与生产路径一致）。
      await startThread(c1);
      const wrote = await trustManagedHooks(c1, eHome, hooksPath);
      f.evidence.push(`[E] trustManagedHooks wrote ${wrote} trusted_hash entrie(s)`);
      await c1.close();

      // 重启 → trusted_hash 生效 → 跑一轮 + 关会话观测触发。
      const layoutE: HomeLayout = {
        home: eHome,
        configToml: join(eHome, CONFIG_TOML_FILE),
        hooksJson: hooksPath,
        sessionStartMarker: ssMarker,
        stopMarker,
      };
      const { fire: fireE } = await exerciseHome(layoutE, 'E:prod-module');
      const eFired =
        fireE.sessionStartNotif || fireE.stopNotif || fireE.sessionStartMarker > 0 || fireE.stopMarker > 0;
      f.evidence.push(
        `[E] prod-module fire: SS_notif=${fireE.sessionStartNotif} STOP_notif=${fireE.stopNotif} SS_marker=${fireE.sessionStartMarker} STOP_marker=${fireE.stopMarker}`,
      );
      if (wrote > 0 && eFired) {
        f.evidence.push('[E] PASS — 生产模块注入的配置使 hook 在真实 codex 触发（端到端打通）。');
      } else {
        f.evidence.push('[E] NOTE — 生产模块端到端未观测到触发（见上 fire 数据）。');
      }
    } catch (eErr) {
      f.evidence.push(`[E] error: ${(eErr as Error).message}`);
    }

    // ── 裁决 ──
    if (f.programmaticSetupWorks && (f.sessionStartFires.startsWith('YES') || f.stopFires.startsWith('YES'))) {
      f.verdict = 'OK';
    } else if (f.ranAgainstRealCodex && metasA.length > 0) {
      // 跑到了真实 codex 且识别了 hook，但触发/信任未完全打通
      f.verdict = 'UNCERTAIN';
    } else {
      f.verdict = 'FAIL';
    }
  } catch (err) {
    f.evidence.push(`fatal: ${(err as Error).message}`);
    f.verdict = f.ranAgainstRealCodex ? 'UNCERTAIN' : 'FAIL';
  } finally {
    for (const h of homesToClean) rmSync(h, { recursive: true, force: true });
  }

  // ── 报告 ──
  console.error('\n' + '═'.repeat(60));
  console.error('[poc-hooks] FINDINGS');
  console.error('─'.repeat(60));
  console.error(`ranAgainstRealCodex   : ${f.ranAgainstRealCodex}`);
  console.error(`sessionStartFires     : ${f.sessionStartFires}`);
  console.error(`stopFires             : ${f.stopFires}`);
  console.error(`trustedHashMechanism  : ${f.trustedHashMechanism}`);
  console.error(`programmaticSetupWorks: ${f.programmaticSetupWorks}`);
  console.error(`recommendation        : ${f.recommendation}`);
  console.error('─'.repeat(60));
  console.error('EVIDENCE:');
  for (const e of f.evidence) console.error(`  • ${e}`);
  console.error('═'.repeat(60));
  console.error(`[poc-hooks] RESULT: ${f.verdict}`);

  process.stdout.write(JSON.stringify({ poc: 'hooks', ...f }) + '\n');
  return f.verdict === 'FAIL' ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[poc-hooks] fatal:', err);
    process.exit(1);
  });
