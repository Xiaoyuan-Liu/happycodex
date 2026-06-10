# Upstream 同步台账（happyclaw → happycodex）

happycodex 是 **codex-only 的 happyclaw 衍生项目**：执行引擎用 codex（app-server）替代
Claude Agent SDK，其余能力对齐 happyclaw。**不做自动 merge**——不定时人工查看 happyclaw
新增内容，在 happycodex 上迁移/实现 codex 等价物。

## 上游引用

- 基于 **happyclaw 原项目**：`upstream` remote → `https://github.com/riba2534/happyclaw.git`
  （**只读引用，永不 merge；push 已禁用**）。
- **不基于本机的 fork**：本地 `/Users/bytedance/Workspace/code_agnet/happyclaw` 是用户自己的 fork
  开发目录（有额外分支/改动），仅在调研期被只读参考过，**不作为追踪源、其文件不被本项目改动**。
- 追踪分支：`upstream/main`。
- **当前基线水位线**：`2599989`（riba2534/happyclaw main，2026-06-08 fetch）。
- 可浏览源码快照：`upstream-happyclaw/`（gitignored，486 文件 ~27M，纯源码，
  不含 data/dist/node_modules/备份）。

## 刷新 & 看「happyclaw 新增了什么」

```bash
git fetch upstream                                       # 更新上游引用（riba2534 原项目）
git log <上次水位线>..upstream/main --oneline            # 自上次以来 happyclaw 新增的 commit
git diff <上次水位线> upstream/main -- <路径>             # 看具体改动
# 刷新可浏览快照：
rm -rf upstream-happyclaw && mkdir upstream-happyclaw && \
  git archive upstream/main | tar -x -C upstream-happyclaw
```

看完 → 在 happycodex 实现 codex 等价物 → 更新下方「迁移水位线」。

## 引擎接缝映射（迁移时对照 happyclaw → happycodex）

| happyclaw | happycodex | 说明 |
|---|---|---|
| `container/agent-runner/`（Claude SDK 引擎） | `src/runtime/*`（codex 运行时） | 执行引擎本体，自有，按功能手工 port |
| `src/container-runner.ts`（spawn 编排 + Claude env/provider） | A 阶段：spawn 指向 codex 引擎 + env 旁路 | provider-pool/failover 作废 |
| `src/stream-event.types.ts`（eventType/agentScope/statusText） | `src/shared/stream-event.ts`（type/scope/status） | StreamEvent；接主仓时对齐字段/marker |
| 主进程 IPC 消费（`index.ts` handleIpcTask 等） | `src/runtime/tools/ipc-bridge.ts` | 12 工具协议，需逐一对齐 |
| sessions 表 / `db.ts` | A 阶段映射 thread_id→session_id | `provider_id` 列作废 |
| `src/claude-context-resolver.ts`（CLAUDE.md/rules/skills symlink+挂载计划） | `src/claude-context-resolver.ts`（同名 codex 版） | 三通道替换：用户/全局→CODEX_HOME/AGENTS.md 物化；项目→config.toml project_doc_fallback_filenames=["CLAUDE.md"] 零拷贝直读；会话动态→ContainerInput.developerInstructions。CLAUDE.md 只读数据源不回写 |
| `src/index.ts`（主进程 10k 行编排） | `src/index.ts`（忠实裁剪搬迁） | Claude 触点替换：`.claude` 会话清理→session-files.clearSessionFiles（SessionStore+CODEX_HOME）；summarizeWithClaude→summarizeWithCodex（sdkQuery=codex exec 真实现）；feedStreamEventToCard/usage/Task 持久化对齐冻结 StreamEvent 契约（parentToolUseId→agentScope、sessionId→threadId、Task 工具→collabAgentToolCall、usage 经 readStreamUsage 窄化取 tokenUsage.last 增量）；provider-switch 分支与 registerProcess.selectedProviderId 随 failover 作废删除；plugin-importer→A5 stub |
| `src/sdk-query.ts`（Claude SDK 一次性问答） | `src/sdk-query.ts`（codex exec --ephemeral 真版） | --output-last-message + stdin prompt + 共享 CODEX_HOME；失败/超时恒 null（调用方降级语义不变） |
| `src/task-routing.ts` / `config/*.json|*.md` | 逐字 port | task-routing 纯函数 + default-groups/mount-allowlist/global-claude-md.template（用户维度数据源） |

## 迁移水位线 / 台账

- **基线**：riba2534/happyclaw main @ `2599989`（2026-06-08）= 当前已对照基线。
- **已 port**：R1 流式 / R2 运行中注入 / R3 工具+多租户 / R4 审批 + Stage5（compact /
  sub-agent / hooks）= happycodex Stage 0–5（standalone 引擎本体，未接主仓）。
- **待办**：A 接主仓（引擎 swap + 真实 IPC/sessions/memory + 旁路 Claude env/provider）。
- **下次**：`git fetch upstream` 后评估 `2599989..新HEAD` 的 happyclaw 新功能逐条是否需 port，
  并更新本基线水位线。
