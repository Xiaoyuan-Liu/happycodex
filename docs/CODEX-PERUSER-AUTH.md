# Per-user codex 认证（OAuth / API key / access-token）

happycodex 是 codex-only 引擎，认证 = codex 的 `auth.json`。本功能让**每个 Web 用户用自己的 codex 账号**登录，凭据按用户隔离；未登录时默认回退到共享账号（可关）。

## 模型一览

| 维度 | 说明 |
|---|---|
| 凭据源（per-user） | `data/config/user-im/{userId}/codex/auth.json`（明文 `0o600`，codex 原生形状——codex 必须明文读取，**不加密**，与宿主机 `~/.codex/auth.json` 一致） |
| 凭据源（共享） | `sharedCodexHomeDir()`（`HAPPYCODEX_SHARED_CODEX_HOME` > `CODEX_HOME` > `~/.codex`），即原"共享单账号" |
| 选源时机 | 每次会话 provision，按 `group.created_by`（=owner userId）选：有 per-user 用 per-user，否则按回退开关 |
| 物理隔离 | 仍是 per-folder `CODEX_HOME`（`data/sessions/{folder}/.codex`）；per-user `auth.json` 在 provision 时复制进去 |

## 回退开关

环境变量 **`HAPPYCODEX_PERUSER_AUTH_FALLBACK`**（`src/codex-paths.ts` `perUserAuthFallbackEnabled()`）：

- 缺省 / `true`（大小写不敏感）：用户没登录自己的 codex → **回退共享账号**。平滑兼容、单用户/dev 无感、admin 不会被 setup 门控锁死。
- `false`：无 per-user 凭据 → provision 的 `copyIfAbsent(auth.json)` 抛错（"未登录"），经现有 `agent_error` 通路呈现为"请先登录"。账号/计费严格隔离。

`resolveAuthSourceDir(ownerId)`（`src/container-runner.ts`）四分支：
1. 有 per-user 凭据 → `userCodexHomeDir(ownerId)`
2. 无 + fallback 开 → `sharedCodexHomeDir()`
3. 无 + fallback 关 → 故意指向不含 auth 的 per-user 目录（→ provision 抛错，不静默用共享，杜绝越权使用他人/共享凭据）
4. `ownerId` 缺失 → `sharedCodexHomeDir()`

## 三层登录方式（前端统一在「设置 → CodexAuthCard」）

### 1. device-auth 一键登录（推荐，本机/远程都行）

`POST /api/config/codex/auth/device/start` → 后端以 `CODEX_HOME=userCodexHomeDir(userId)` spawn `codex login --device-auth` → 解析 stdout 的 verification URL + 短码 → 经 WS `codex_device_auth` 推前端 → 用户在**任意设备/浏览器**打开 URL 输码授权 → codex 进程退出 0 即把 `auth.json` 落该用户目录 → 推 `authorized`。

- 设备码流程**无 localhost 回调**，所以远程部署（服务在远端、浏览器在笔记本）同样可用——这是相对 `codex login` 默认浏览器回调的关键优势。
- 编排见 `src/codex-device-auth.ts`：同一 userId 单 in-flight（重试抢占旧进程）、15min 超时 kill 进程树、`getDeviceAuthState` 供 WS 重连恢复、`shutdownAllDeviceAuth` 优雅退出清理。

### 2. API key 粘贴

`POST /api/config/codex/auth/api-key` `{apiKey, force?}` → 写 per-user `auth.json {OPENAI_API_KEY}`。已有登录态需 `force=true` 覆盖（仅看用户自己的 per-user 凭据）。

### 3. access-token 粘贴（兜底）

`POST /api/config/codex/auth/access-token` `{accessToken, force?}` → 经 `codex login --with-access-token`（token 走 **stdin**，不进 argv，避免 `ps` 泄漏）落 per-user `auth.json`。

### 其它端点

- `GET /api/config/codex/auth`（authMiddleware）→ 自己的脱敏状态（`loggedIn/method/lastRefresh/hasUserAuth/usingShared/loginHint`，**无** token/key 明文、**无** codexHome 路径）。
- `DELETE /api/config/codex/auth` → 删自己的 `auth.json`（登出 → 回退共享）。
- `GET /api/config/codex/auth/shared`（systemConfigMiddleware）→ 系统级共享态查看（admin）。

## setup 门控

`buildSetupStatus()`（`src/routes/auth.ts`）的 `needsSetup` 钉**共享/admin 态**（无参 `readCodexAuthStatus()`），**绝不**按 per-user 判定——否则默认回退形态下，普通用户没自登 codex 会误锁 admin 的 onboarding 向导。per-user 自登是各用户的可选增强，与 setup 门控解耦。

## 安全

- **越权**：所有 per-user 端点用 `authMiddleware`，作用域恒为 `c.get('user').id`（不从请求体取 userId）；`userCodexHomeDir` 入口白名单校验 `^[a-zA-Z0-9_-]+$`（拒 `..`/路径分隔/空段）。无读写他人凭据的面。
- **凭据不泄漏**：GET 脱敏；device-auth/access-token 子进程的原始 stdout/stderr **不入日志**（只抓公开的 device URL+短码）；access-token 走 stdin；WS `codex_device_auth` 经 `safeBroadcast(..., allowedUserIds=Set([userId]))` 只推给本人。
- **审计**：api-key/access-token/device-start/delete 均经 `appendClaudeConfigAudit` 记 `actor + action + {userId, scope:'per-user'}`（不记凭据值）。
- **落盘**：明文 `0o600`（codex 必须明文读；与 codex 原生 auth.json 同安全模型）。

## 已知限制

- **token 刷新竞争**：同一账号被该用户的多个 per-folder `CODEX_HOME`（`main` + sub-agent 的 `agents/{id}/.codex`）各自刷新时，跨 home 无协调，并发窗口小（token ~1h 有效）。per-user 化后竞争已大幅收窄到"同一用户多 folder 共享自己账号"这一层。**集中 refresh owner** 留待"接主仓"阶段（见 `src/runtime/multitenant/types.ts`、`src/runtime/multitenant/codex-home.ts` 注释）。
- **远程 token 传输**：access-token/api-key 经 stdin/HTTPS；生产远程部署务必走 HTTPS。
- **加密密钥**：本功能凭据明文 0o600，不依赖 `claude-provider.key`（codex 读不了密文）。

## 相关文件

`src/codex-paths.ts` · `src/codex-device-auth.ts` · `src/routes/config.ts` · `src/routes/auth.ts` · `src/runtime/multitenant/codex-home.ts` · `src/container-runner.ts` · `src/web.ts` · `web/src/components/settings/CodexAuthCard.tsx` · `web/src/stores/codex-auth.ts`
