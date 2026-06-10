# A 阶段搬迁路线图（happyclaw → codex-only happycodex）

基线：riba2534/happyclaw main @ `2599989`（快照 `upstream-happyclaw/`）。
全量模块清单（112 模块逐个分类 + file:line 证据）见 `docs/A-GAP-INVENTORY.json`。

## 总体判断

搬迁可行且远比重写便宜：happyclaw 应用层与 Claude 引擎天然解耦，引擎绑定点集中在
`container-runner` / `container/agent-runner` / `claude-context-resolver` / provider 配置面 /
StreamEvent 消费端。

| 分类 | 占比 | 说明 |
|---|---|---|
| port-asis | ~57%（64 模块） | 机械搬 + 改 import（IM 层 18.9k 行几乎全 port、认证/ACL、db） |
| adapt-codex | ~30%（34 模块） | 热点：index.ts(10k行)、routes/config.ts、前端 chat store、skills/prompts、billing |
| have / replace-codex | ~8% | 引擎主体 happycodex 已建成（~4.2k 行实质覆盖） |
| drop-claude-only | ~5% | provider-pool 全家、plugins SDK 注入面等 |

规模：上游 ~123k 行（src 75.5k + web 41k + container 6.85k）；happycodex 已建 7.8k。

## 已拍板决策（2026-06-10，用户确认）

1. **stream-event 契约**：解冻 happycodex 契约，字段名**对齐上游**（`eventType/agentScope/toolUseId/statusText`），让搬来的前端/IM 卡片近乎零改。
2. **首个 IM 渠道**：飞书；telegram/whatsapp 保留 **stub**（不删，im-manager 结构不动）。
3. **前端范围**：**MVP 就上完整前端**（204 文件全量，chat store 按 A0 契约消费）。
4. **插件系统**：adapt 非 drop，**后置到最后阶段**。
5. **容器化**：**首版即 Docker 双轨**（host + Docker 两模式都做，Dockerfile/entrypoint 改装 codex 提前到 A1）。
6. **AGENTS.md / skills 注入**：走**文件挂载/物化**路线（对齐 codex 原生）。**硬约束：不改动 CLAUDE.md**——
   CLAUDE.md 原样保留（只读数据源），resolver 读其内容生成/维护 **AGENTS.md**（codex 原生自动读取）
   与 CODEX_HOME 配置（agents/hooks/config.toml），写入面仅限 AGENTS.md + codex 自有配置文件。
   细节（codex 对 AGENTS.md 的实际读取位置/嵌套规则）A1 前做小 PoC 钉死。
7. **billing**：首版 **token-only 配额**；costUSD 折算推后评估。
8. **index.ts**：**忠实裁剪搬迁**（结构跟上游走、仅删/换 Claude 触点，保持可对照）；后续专门评估拆模块。

## MVP 定义（按决策 3/5 调整后）

db/config/logger 基建 + index.ts 忠实裁剪版主进程 + codex 引擎接线（**host + Docker 双轨**）
+ agent-output-parser + 会话管理 + Web 后端（auth/routes/WS）+ **完整前端**。
**验收**：浏览器登录完整前端 → 发消息 → 入库 → group-queue 调度 → codex 执行（12 工具/resume/多轮，
host 与 Docker 两模式均可）→ 流式渲染 → 回复；重启进程后同一会话 resume。
IM/定时任务/skills 体系/插件/billing-完整版不在 MVP。

## 分阶段（按决策调整后）

| 阶段 | 目标 | 关键内容 | 风险 |
|---|---|---|---|
| **A0 契约+基建** | 契约定稿；db/config/shared 落地 | stream-event 字段名对齐上游（改 happycodex 引擎侧+全测试）；port load-env/logger/config/db(6060行,drop provider sticky)/runtime-config/shared | M |
| **A1 主进程+引擎接线（双轨）** | 端到端跑一条对话（host+Docker） | replace container-runner→agent-runner（host 分支 + **Docker 分支**：Dockerfile/entrypoint 换 codex、卷挂 CODEX_HOME、超时/快照/killProcessTree）；adapt output-parser；port group-queue；index.ts 忠实裁剪版；**AGENTS.md PoC + context-resolver 改造（不动 CLAUDE.md）** | **H**（触点散布+Docker 全新资产） |
| **A2 Web 全量** | 浏览器完整前端可用 | port auth/middleware/ACL/挂载安全/全部 routes；重写 routes/config.ts（codex 认证）；**前端 204 文件全量**：chat store 按新契约、缺失事件 UI 降级、provider 配置页换 codex、usage 管道（token-only） | M-H（量大；chat store 是硬骨头） |
| **A3 飞书 IM** | 飞书群对话+流式卡片 | port im-* / feishu*（telegram/whatsapp stub）；adapt feedStreamEventToCard 映射（缺失事件降级） | M |
| **A4 调度+工具+skills** | 定时任务全链路；12→17 工具；skills 生效 | port task-scheduler；补 send_image/send_file/discord_*×3 + pollIpcResult；prompts/skills 按 AGENTS.md+CODEX_HOME 物化方案落地 | M |
| **A5 收尾：多渠道+插件+billing 完整** | 钉钉/Discord/QQ；插件链路；billing 评估 costUSD | port 其余渠道（卡片 API 签名兼容，映射层零改）；插件 adapt（host 侧展开 + CODEX_HOME 物化）；billing 完整版评估 | L-M |

## MVP 验收记录（2026-06-10 达成 ✅）

E2E 脚本 `scripts/e2e-mvp.mjs`（可重跑）8 项口径全 PASS：build 产物 / 隔离启动 /
Web API 注册登录建群 / 首条消息全管线（入库→调度→codex→WS 流式→回复）/ 多轮上下文 /
工具冒烟（schedule_task+memory_append 副作用落地）/ **重启 resume**（threadId 跨重启不变
且召回重启前内容）/ **Docker 容器模式**（容器内 codex 真执行）。
观察项：容器内 shell 被 approval policy 拦截（待复查 container 侧 approval/sandbox 配置）。

## 最大风险

1. **stream-event 契约**承重墙（已定向：对齐上游）——A0 改名须全测试回归，之后三方消费端近零改。
2. **index.ts 单体**字符串契约（marker/目录/CLI）散布、无编译期保护——需端到端对拍测试兜底。
3. **Docker 双轨提前**：happycodex 零 Docker 资产，容器编排面（卷挂载/超时/快照/killProcessTree）+
   Dockerfile 换装 codex 全部新建，A1 工期显著增加（用户已知并接受）。
4. **前端全量提前**：A3/A4 事件面未定型时上前端，缺失事件（task_*/todo_update 等）按 UI 降级处理，
   后续事件面补齐时前端需小幅跟进（可接受的返工面）。
5. skills/prompts 承载（AGENTS.md 路线已定向，**不动 CLAUDE.md**）：codex AGENTS.md 读取行为待 PoC。
6. 引擎残留缺口：图片附件输入（ipc-input 多模态）、pollIpcResult 回执、isHome 门控、memory-flush。
7. db 39 版 migration + sessions/threadId 语义对齐；usage 管道全新建（token-only 降低了首版复杂度）。
