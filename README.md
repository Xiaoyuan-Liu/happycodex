# happycodex

**Codex 版 HappyClaw 运行时**——把 [HappyClaw](../happyclaw) 的 Agent 执行层从
Claude Agent SDK 迁移到 **codex app-server**（JSON-RPC over stdio）的运行时实现。

当前仓库覆盖 **Stage 0-4**：协议契约 + app-server 客户端 + 流式事件映射 + thread/turn
注入循环 + 12 个工具（dynamicTools）+ 多租户编排（per-folder 隔离 / resume / 单写者）+
针对真实 codex 的 PoC 验证。基线 **codex-cli 0.137.0**。

> 完整迁移规划见 [`../happyclaw/docs/CODEX-PORT-PLAN.md`](../happyclaw/docs/CODEX-PORT-PLAN.md)。
> 本 README 覆盖 happycodex 仓库内的 Stage 0-4 范围（standalone；接 HappyClaw 主仓待做）。

---

## 项目定位

HappyClaw 用 `agent-runner` 在容器/宿主机进程里调用 Claude Agent SDK，把流式事件
经 `OUTPUT_MARKER` 包裹写 stdout，主进程解析后广播到 Web/IM。happycodex 把这条执行
管道的「引擎」换成 codex app-server：

- **协议层**：codex app-server 是一个长驻子进程，走 newline-delimited JSON-RPC（省略
  `"jsonrpc":"2.0"` 头）。thread = 会话，turn = 一轮对话，token 增量通过
  `item/agentMessage/delta` 等通知流式推送。
- **复用点**：codex 的流式通知映射到 HappyClaw 既有的 `StreamEvent` 形状（`shared/stream-event.ts`），
  再经同一套 `OUTPUT_MARKER` → WebSocket `stream_event` 管道吐给前端，**前端 chat store 无需改动**。

### 与 HappyClaw 的对应关系

| HappyClaw | happycodex | 说明 |
|-----------|-----------|------|
| `container/agent-runner/` | `src/runtime/codex-runner.ts` | 执行引擎：消费输入 + IPC 注入，驱动会话，吐 StreamEvent |
| Claude Agent SDK `query()` | `src/runtime/session.ts`（thread/turn） | 单会话生命周期 + 注入循环 |
| SDK 内部 spawn cli.js | `src/appserver/client.ts` | spawn `codex app-server`，JSON-RPC 分帧/关联/背压重试 |
| `shared/stream-event.ts` | `src/shared/stream-event.ts` | StreamEvent 类型（语义对齐，**冻结**） |
| `OUTPUT_START/END_MARKER` 流式管道 | 同名 marker（`shared/stream-event.ts`） | runner → stdout → 主进程解析，协议复用 |
| SDK 流式事件 → StreamEvent | `src/runtime/stream-mapper.ts` | 把 app-server 通知映射成 0..N 个 StreamEvent（纯函数） |

---

## 架构与模块

```
┌─────────────────────────────────────────────────────────────┐
│  codex app-server (子进程, JSON-RPC over stdio)              │
└───────────────▲───────────────────────────┬─────────────────┘
   请求/通知/审批 │                            │ 增量通知（delta / item / turn）
┌───────────────┴───────────────────────────▼─────────────────┐
│  src/appserver/client.ts   AppServerClient                   │
│   spawn + 行分帧 + id 关联 + -32001 背压重试 + 通知/请求分发     │
└───────────────▲───────────────────────────┬─────────────────┘
                │ request/notify             │ onNotification
┌───────────────┴───────────────────────────▼─────────────────┐
│  src/runtime/session.ts    ThreadSession                     │
│   thread/start|resume · turn/start|steer · activeTurnId 维护  │
│      │  通知 → StreamMapper → onStreamEvent                   │
│      ▼                                                        │
│  src/runtime/stream-mapper.ts  StreamMapper（纯映射）         │
│      app-server 通知 → StreamEvent[]                          │
└───────────────▲───────────────────────────┬─────────────────┘
                │ onStreamEvent              │
┌───────────────┴───────────────────────────▼─────────────────┐
│  src/runtime/codex-runner.ts  CodexRunner                    │
│   消费 CodexRunnerInput + IPC 注入，StreamEvent 经            │
│   OUTPUT_MARKER 包裹写 sink（默认 stdout）                     │
└──────────────────────────────────────────────────────────────┘
```

| 模块 | 职责 |
|------|------|
| `src/contracts.ts` | **冻结**：跨模块公共契约（接口 + 构造签名），各实现针对它编程 |
| `src/appserver/protocol.ts` | **冻结**：codex app-server JSON-RPC 协议子集（手工策展，对齐 generate-ts 产物） |
| `src/appserver/client.ts` | `AppServerClient`：spawn 进程、JSON-RPC 分帧/关联、背压重试、握手、通知/请求分发 |
| `src/runtime/stream-mapper.ts` | `StreamMapper`：单条 app-server 通知 → 0..N 个 StreamEvent（无副作用，可单测） |
| `src/runtime/session.ts` | `ThreadSession`：thread/turn 生命周期；`sendUserMessage` 自动判定 turn/start vs turn/steer |
| `src/runtime/codex-runner.ts` | `CodexRunner`：agent-runner 等价物，OUTPUT_MARKER 包裹写 stdout；可挂工具层 |
| `src/runtime/tools/types.ts` | **冻结**：工具层契约（ToolBridge / ToolDefinition / IToolRegistry / IToolDispatcher） |
| `src/runtime/tools/registry.ts` | `ToolRegistry`：聚合工具、产出 dynamicTools schema、按名分发（never throws） |
| `src/runtime/tools/builtin.ts` | `createBuiltinTools()`：HappyClaw 12 个工具的 dynamicTools 定义（schema + handler） |
| `src/runtime/tools/ipc-bridge.ts` | `IpcToolBridge`：工具副作用落成 HappyClaw 风格 IPC 文件 + 记忆文件操作 |
| `src/runtime/tools/dispatcher.ts` | `ToolDispatcher`：`item/tool/call` server 请求 → registry.dispatch → respond |
| `src/runtime/multitenant/types.ts` | **冻结**：多租户层契约（ISessionManager / ISessionStore / ICodexHomeProvisioner / ISerialQueue） |
| `src/runtime/multitenant/session-manager.ts` | `SessionManager`：编排 N 个 folder（per-folder app-server、resume、idle 回收、LRU 驱逐、可选工具） |
| `src/runtime/multitenant/session-store.ts` | `SessionStore`：folder→threadId JSON 持久化（映射 HappyClaw sessions 表，原子写） |
| `src/runtime/multitenant/codex-home.ts` | `FsCodexHomeProvisioner`：per-folder `CODEX_HOME` + 复制共享 auth（幂等、路径安全） |
| `src/runtime/multitenant/serial-queue.ts` | `SerialQueue`：per-key 单写者闸门（防 rollout 无锁并发损坏，对应 group-queue） |
| `src/shared/stream-event.ts` | **冻结**：StreamEvent 类型 + OUTPUT_MARKER 常量（对外流式协议单一真相源） |
| `src/poc/poc-stream.ts` | PoC R1：token 流式增量 |
| `src/poc/poc-steer.ts` | PoC R2：运行中注入（turn/steer） |
| `src/poc/poc-resume.ts` | PoC：跨进程 thread/resume 续接 |
| `src/poc/poc-tools.ts` | PoC R3：12 个工具走 dynamicTools，端到端往返 + 副作用落地 |
| `src/poc/poc-multitenant.ts` | PoC Stage 4：2 个 folder 并发，隔离 + 并发 + 跨进程 resume |
| `protocol/ts/`、`protocol/schema/` | codex 0.137.0 `generate-ts` / `generate-json-schema` 全量参考产物（不入编译） |

---

## 如何跑

### 前置条件

1. **安装 codex CLI**，版本对齐基线 `0.137.0`（可用 `codex --version` 确认）。
2. **codex 已登录**：app-server 复用本机 codex 的登录态（ChatGPT/API key）。
3. **`CODEX_HOME`**：指向有效的 codex 配置目录。PoC 默认用当前环境的 `CODEX_HOME`；
   `poc-resume` 的两次 client 必须共享同一 `CODEX_HOME`，否则第二个进程读不到第一个
   写入的 rollout，无法续接。
4. 安装依赖：`npm install`。

### 命令

```bash
# 类型检查（tsc --noEmit）
npm run typecheck        # 或：make typecheck

# 单测（vitest，纯逻辑模块：stream-mapper / client 分帧等）
npm run test             # 或：make test

# PoC（针对真实 codex app-server，需登录态 + CODEX_HOME）
npm run poc:stream       # 或：make poc-stream  —— R1 token 流式
npm run poc:steer        # 或：make poc-steer   —— R2 运行中注入 turn/steer
npm run poc:resume       # 或：make poc-resume  —— 跨进程 thread/resume 续接
npm run poc:tools        # 或：make poc-tools        —— R3 dynamicTools 工具端到端
npm run poc:multitenant  # 或：make poc-multitenant  —— Stage 4 多租户隔离/并发/resume
```

PoC 会话统一用 `{ approvalPolicy: 'never', sandbox: 'read-only' }`：不触发审批回环阻塞、
不写磁盘。每个脚本结尾打印 `OK / UNCERTAIN / FAIL` 结论并按结果 `process.exit`。

---

## Stage 0-4 范围 & 已知未做

### 本仓库已覆盖（Stage 0-4）

- 协议契约冻结（`contracts.ts` / `protocol.ts` / `stream-event.ts` / `tools/types.ts` / `multitenant/types.ts`）。
- `AppServerClient`：JSON-RPC over stdio、`-32001` 背压指数退避重试、握手、通知/请求分发。
- `StreamMapper`：app-server 通知 → StreamEvent 纯映射。
- `ThreadSession`：thread/turn 生命周期 + 运行中注入（turn/start vs turn/steer 自动判定）。
- `CodexRunner`：OUTPUT_MARKER 流式管道（对齐 HappyClaw agent-runner）+ 可挂工具层。
- **Stage 3 工具层**：12 个 HappyClaw 工具走 `dynamicTools`（注册 + `item/tool/call` 客户端代理执行）。
- **Stage 4 多租户**（standalone）：`SessionManager` 编排 N 个 folder——per-folder `CODEX_HOME`
  隔离（共享单账号，auth 复制进各 home，对齐 HappyClaw 全局凭据 + 配置目录隔离模型）、
  `SessionStore` 持久化 folder→threadId（resume 续接）、`SerialQueue` 单写者闸门、idle 回收 + LRU 驱逐。
- 五个 PoC 针对真实 codex app-server 验证 R1/R2/resume/tools/multitenant。

### 已知未做（明确不在本仓库 standalone 范围）

- **接 HappyClaw 主仓**：改 HappyClaw `container-runner` 用 `codex-runner`、`IpcToolBridge` 对接真实
  主进程 IPC/task-scheduler/memory（含 `listTasks` 真状态）、映射真实 `sessions` 表——是最终目标，
  跨两个仓库，留待后续。
- **共享单账号 token 刷新集中化**：standalone 下各 per-folder `CODEX_HOME` 独立 refresh 可能竞争；
  生产应集中一个 refresh owner（随"接主仓"一起做）。
- **provider failover（P0）**：HappyClaw 的多账号失效转移在 codex 架构下作废，不重做。
- **provider failover 作废（P0）**：HappyClaw 的 provider 限额切换/上下文恢复机制在 codex
  架构下**作废**——codex app-server 自管 provider，不在 happycodex 运行时重做。
- 容器化 / Docker 卷挂载、IM 通道、Web 前端：均属 HappyClaw 主仓既有能力，本仓库只替换执行引擎。

---

## 开发约束

- **ESM + NodeNext**：所有相对 import **必须带 `.js` 扩展名**（即使源文件是 `.ts`）。
- **严格 TS**：`strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`，避免 `any` 滥用。
- **冻结契约**：`src/contracts.ts`、`src/appserver/protocol.ts`、`src/shared/stream-event.ts`
  是冻结文件，修改 = 改公共 API，需同步所有实现方。
- 升级 codex 后：`npm run protocol:regen` 重新生成 `protocol/`，再对照 `protocol.ts` diff。
