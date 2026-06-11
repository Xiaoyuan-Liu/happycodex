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
| `container/agent-runner/prompts/`（9+4 分片）+ agent-runner 启动期 loadPrompt/promptPieces 拼装 → `systemPrompt.append` | `container/agent-runner/prompts/`（路径镜像 port）+ `src/prompt-assembly.ts`（宿主侧惰性加载 + 场景化选片，产物经 deriveInputWithSessionContext 并入 developerInstructions） | 选片条件/包裹标签/顺序/黄线剥除正则与上游同式；Claude 措辞最小适配清单见 prompt-assembly.ts 头注释（skill-routing→.skills 索引、background-tasks 去 Task 工具、memory 去 Read/Edit 工具名 + host 模式 /workspace/global 字面替换、channels 去 send_image/send_file、品牌词/API key 名） |
| `container/skills/`（3 个 SKILL.md）+ 四源 skills 发现/symlink 农场（claude-context-resolver 四源目录 + syncHostClaudeContext linkEntries + 容器 entrypoint 链接 + SDK skills:'all'） | `container/skills/`（port，post-test-cleanup 容器名/会话措辞适配）+ `src/skills-materializer.ts`（四源**复制**物化到 {groupDir}/.skills/ + manifest 受管语义 + AGENTS.md 技能索引经 buildCodexContextPlan.skillsIndex 通道） | codex 无 SKILL.md 发现/Skill 工具机制 → 索引进 CODEX_HOME/AGENTS.md、模型按需 cat 入口；同名后者胜出顺序 builtin→external→project→user 对齐上游；install_skill/uninstall_skill 落盘端（data/skills/{ownerId}）即 user 源，下次 spawn 物化生效 |

## 主动修复的上游继承缺陷（偏离记录）

迁移时 1:1 继承自上游、经 review 实证后在 happycodex 侧主动修复的缺陷。上游若日后
自行修复，按本表对照消偏（行号均为基线 `2599989` 下的上游位置）：

| 编号 | 缺陷 | 上游位置（2599989） | happycodex 修复 |
|---|---|---|---|
| CR#1 | 请求-响应 IPC（list_tasks 等）结果写回硬编码 `data/ipc/{folder}/tasks`，请求来自 agents/{aid}/ 或 tasks-run/{id}/ 子命名空间时轮询方永远收不到回执（假超时） | `src/index.ts:5570-5574` 等写回点 | `src/ipc-paths.ts` resolveIpcResultPath（锚定请求所在 tasks 目录）+ index.ts 全部写回点接入；tests/ipc-result-routing.test.ts 钉死 |
| CR#2 | send_file/send_image 路径校验纯词法（startsWith），工作区内 symlink 可外读/外发任意主机文件 | `src/index.ts:5865-5866`（消费端）；agent-runner mcp-tools 生产端同 | 两侧独立 realpath 物理校验：producer `ipc-bridge.resolveWorkspaceFile`、consumer `ipc-paths.isRealPathWithinRoots` |
| CR#8 | send_file 相对路径消费端恒锚 `GROUPS_DIR/{folder}`，host+customCwd 群组（生产端按注入的 customCwd 产出相对路径）发文件永远 not found | `src/container-runner.ts:1326/1584`（注入）vs `src/index.ts:5861`（消费） | `src/ipc-paths.ts` resolveSendFileAnchor（与 container-runner 注入同源的 customCwd 映射） |

## happycodex 自有扩展（非上游 1:1）

codex 引擎特有、上游 happyclaw 无对应物的功能，记此以便区分"搬迁"与"衍生"：

| 功能 | 说明 | 触点 |
|---|---|---|
| per-user codex OAuth 登录 | 每个 Web 用户用自己的 codex 账号（device-auth 一键登录 / API key / access-token），凭据存 `data/config/user-im/{userId}/codex/auth.json`（明文 0o600，codex 原生形状）；provision 时按 `group.created_by` 选源，缺失时按 `HAPPYCODEX_PERUSER_AUTH_FALLBACK`（默认 true）回退共享账号。上游是 Claude provider 池（per-user UI 录入），codex 是单账号引擎，故此为衍生而非搬迁。详见 `docs/CODEX-PERUSER-AUTH.md` | `src/codex-paths.ts`（userCodexHomeDir/hasUserCodexAuth/perUserAuthFallbackEnabled/readCodexAuthStatus(userId?)）、`src/codex-device-auth.ts`（device-auth 子进程编排）、`src/routes/config.ts`（6 端点）、`src/runtime/multitenant/codex-home.ts`（authSourceDir 选源）、`src/container-runner.ts`（resolveAuthSourceDir）、`web/src/components/settings/CodexAuthCard.tsx` |
| per-user codex 自定义模型 provider | 每个 Web 用户配第三方模型（兼容 OpenAI Responses API 的 GLM 等）：codex 走 `config.toml` 顶层 `model` + `model_provider` + `[model_providers.<id>]`（`wire_api="responses"`，codex 0.137.0 仅此可用）。一个用户一个 active provider；配置存 `data/config/user-im/{userId}/codex/provider.json`（apiKey 经 `encryptChannelSecret` 加密 + `writeSecretFile` 0o600，复用 Feishu/Telegram per-user 加密范式）；apiKey 不落 `config.toml`，由 `buildAgentEnvLines` 按 owner 注入 env `CODEX_CUSTOM_API_KEY`（`config.toml` 只写 `env_key` 引用）。无 key 不写 provider 段、回退默认账号（无半配置）。上游是 Claude provider 池（per-user UI 录入 ANTHROPIC_*），codex provider 机制不同（config.toml model_providers + Responses API 约束），故衍生而非搬迁。详见 `docs/CODEX-PERUSER-AUTH.md`「自定义模型 provider」节 | `src/runtime-config.ts`（getUserCodexProvider/toPublicCodexProvider/saveUserCodexProvider/deleteUserCodexProvider/hasUserCodexProvider）、`src/runtime/multitenant/codex-home.ts`（provisionModelProvider/CodexModelProviderConfig/CODEX_CUSTOM_API_KEY_ENV）、`src/container-runner.ts`（resolveModelProvider/buildAgentEnvLines env 注入）、`src/routes/config.ts`（3 端点：GET/PUT/DELETE /api/config/codex/provider）、`web/src/components/settings/CodexAuthCard.tsx` |

## 迁移水位线 / 台账

- **基线**：riba2534/happyclaw main @ `2599989`（2026-06-08）= 当前已对照基线。
- **已 port**：R1 流式 / R2 运行中注入 / R3 工具+多租户 / R4 审批 + Stage5（compact /
  sub-agent / hooks）= happycodex Stage 0–5（standalone 引擎本体，未接主仓）。
- **待办**：A 接主仓（引擎 swap + 真实 IPC/sessions/memory + 旁路 Claude env/provider）。
- **下次**：`git fetch upstream` 后评估 `2599989..新HEAD` 的 happyclaw 新功能逐条是否需 port，
  并更新本基线水位线。
