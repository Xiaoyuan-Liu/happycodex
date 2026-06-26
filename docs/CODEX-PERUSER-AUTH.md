# Per-user codex 认证（OAuth / API key / access-token）

happycodex 是 codex-only 引擎，认证 = codex 的 `auth.json`。本功能让**每个 Web 用户用自己的 codex 账号**登录，凭据按用户隔离；未登录时默认回退到共享账号（可关）。

## 模型一览

| 维度 | 说明 |
|---|---|
| 凭据源（per-user） | `data/config/user-im/{userId}/codex/auth.json`（明文 `0o600`，codex 原生形状——codex 必须明文读取，**不加密**，与宿主机 `~/.codex/auth.json` 一致） |
| 凭据源（共享） | `sharedCodexHomeDir()`（`HAPPYCODEX_SHARED_CODEX_HOME` > `CODEX_HOME` > `~/.codex`），即原"共享单账号" |
| 选源时机 | 每次会话 provision，按 `group.created_by`（=owner userId）选：有 per-user 用 per-user，否则按回退开关 |
| 物理隔离 | 仍是 per-folder `CODEX_HOME`（`data/sessions/{folder}/.codex`）；per-user `auth.json` 在 provision 时同步进去 |

## 回退开关

环境变量 **`HAPPYCODEX_PERUSER_AUTH_FALLBACK`**（`src/codex-paths.ts` `perUserAuthFallbackEnabled()`）：

- 缺省 / `true`（大小写不敏感）：用户没登录自己的 codex → **回退共享账号**。平滑兼容、单用户/dev 无感、admin 不会被 setup 门控锁死。
- `false`：无 per-user 凭据 → provision 的 `copyIfAbsent(auth.json)` 抛错（"未登录"），经现有 `agent_error` 通路呈现为"请先登录"。账号/计费严格隔离。

`resolveAuthSourceDir(ownerId)`（`src/container-runner.ts`）四分支：
1. 有 per-user 凭据 → `userCodexHomeDir(ownerId)`
2. 无 + fallback 开 → `sharedCodexHomeDir()`
3. 无 + fallback 关 → 故意指向不含 auth 的 per-user 目录（→ provision 抛错，不静默用共享，杜绝越权使用他人/共享凭据）
4. `ownerId` 缺失 → `sharedCodexHomeDir()`

## 三种登录方式（前端统一在「设置 → CodexAuthCard」）

### 1. device-auth 一键登录（推荐，本机/远程都行）

`POST /api/config/codex/auth/device/start` → 后端以 `CODEX_HOME=userCodexHomeDir(userId)` spawn `codex login --device-auth` → 解析 stdout 的 verification URL + 短码 → 经 WS `codex_device_auth` 推前端 → 用户在**任意设备/浏览器**打开 URL 输码授权 → codex 进程退出 0 即把 `auth.json` 落该用户目录 → 推 `authorized`。

- 设备码流程**无 localhost 回调**，所以远程部署（服务在远端、浏览器在笔记本）同样可用。
- 重新登录会更新 per-user `auth.json`；下一次会话 provision 会把更新后的凭据同步到旧 per-folder `CODEX_HOME`，避免旧会话继续使用 revoked refresh token。
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

## 自定义模型 provider（第三方模型，如 GLM）

per-user 自登的是 **OpenAI/codex 官方账号**。若用户要用第三方模型（兼容 OpenAI Responses API 的 GLM 等），走本节的「自定义模型 provider」——与上节认证正交：认证选 `auth.json`，provider 选 `config.toml` 的 `model` + `model_provider`。一个用户一个 active provider（非列表）。

### codex `config.toml` `model_providers` 机制

codex 自定义 provider 由 per-folder `CODEX_HOME` 的 `config.toml` 描述：

```toml
model = "glm-4.6"               # 顶层：选用的模型
model_provider = "glm"          # 顶层：选用的 provider id

[model_providers.glm]
name = "GLM"
base_url = "https://open.bigmodel.cn/api/coding/paas/v4"
env_key = "CODEX_CUSTOM_API_KEY"   # codex 运行时从该 env 读 API key
wire_api = "responses"
```

- happycodex 默认不注入 `model`（`session.model` 为 null 时 `config.toml` 的 `model` 胜出，已确认无默认 model 注入），故上面顶层 `model` + `model_provider` 能真正生效。
- 写入由 `FsCodexHomeProvisioner.provisionModelProvider`（`src/runtime/multitenant/codex-home.ts`）**调和式**完成（非只追加，支持删除/改名/改 model 的收敛）：每次 provision 先剥离上一次 happycodex 写入的 provider 配置（靠 `env_key = "CODEX_CUSTOM_API_KEY"` 这个独有标记识别 `[model_providers.*]` 段并整段移除；顶层 `model_provider` 指向被剥离 id 时连同顶层 `model` 一并移除），再按当前 provider 重写——顶层 `model`/`model_provider` 置最前（与 `ensureProjectDocSettings` 同款顶层键插入，互不冲突）+ `[model_providers.<id>]` 段。配 provider 时 happycodex **拥有**顶层 `model`/`model_provider` 与该 id 段（覆盖任何既有 pin/同 id 段，避免重复键/段头非法 TOML）；**删除/无 key** 时只剥不写 → codex 回退默认账号（**自愈**，无需手改 config.toml）。`strip` 是 `insert` 的左逆，二次 provision 结果稳定（`next===content` 免写盘）。用户手工写的 *其它* provider 段（无该 env_key、不同 id）不动。
  - 注意：删除 provider 后回退的是 codex 内置默认（非此前从共享 config.toml 复制的 model pin——它在配 provider 时已被覆盖）。
  - `name`/`model` 拒绝控制字符（`[\x00-\x1f\x7f\u2028\u2029]`，`normalizeProviderName`/`normalizeCodexModel`），防止原始控制字符落入 config.toml 破坏 TOML 解析。
- `id` 由 `name` slug 化（`[a-z0-9-]` 小写，`slugifyProviderId`），用户不另填；空则回退 `"custom"`。

### `wire_api=responses` 约束与第三方兼容性

- codex 0.137.0 的 `wire_api` **只有 `"responses"` 真正可用**（`"chat"` 已废弃报错），故 happycodex **默认 `wire_api="responses"`**，前端不暴露此字段（仅一行小字说明）。数据层 `CodexWireApi = 'responses' | 'chat'` 保留 `chat` 仅为类型完整，正常路径恒 `responses`。
- 由此对第三方模型的硬要求：**provider 的 `base_url` 必须兼容 OpenAI Responses API**（`/responses` 端点语义），而非仅 Chat Completions。配错只兼容 chat 的 endpoint 会在 codex 起会话时失败。GLM 等需用其 Responses 兼容入口（如 coding paas 的 `/v4`）。
- `base_url` 强制 **https**（`normalizeCodexBaseUrl` 红线，非 https 直接拒）。

### `CODEX_CUSTOM_API_KEY` 注入（apiKey 不落 `config.toml`）

apiKey 与 `config.toml` **解耦**：`config.toml` 只写 `env_key="CODEX_CUSTOM_API_KEY"` 引用，真正的 key 由运行时按 owner 注入到 agent 进程 env：

- `buildAgentEnvLines(folder, ownerId)`（`src/container-runner.ts`）当 owner 配了 provider 且 `hasApiKey` 时，push 一行 `CODEX_CUSTOM_API_KEY=<解密 apiKey>`。apiKey 已由 `normalizeSecret` 剥空白/非 ASCII（无换行），容器侧再经 `shellQuoteEnvLines` 单引号转义，特殊字符不破坏 env 文件。
- 固定 env 名安全：每用户一个 provider + per-folder `CODEX_HOME` 物理隔离，`CODEX_CUSTOM_API_KEY`（`CODEX_CUSTOM_API_KEY_ENV` 常量）不会跨用户串号。
- **无 key 不半配置**：`resolveModelProvider`（container-runner）在 `!provider.apiKey` 时返回 `undefined` —— 既不写 `config.toml` 的 provider 段、也不注入 env，回退默认账号；杜绝「写了 provider 段却无 key、codex 起不来」的破窗。

### per-user 存储与加密（`src/runtime-config.ts`）

复用 Feishu/Telegram per-user 加密范式（`encryptChannelSecret`/`decryptChannelSecret` + `writeSecretFile` 0o600，同一 key 文件 `claude-provider.key`）：

- 落盘 `data/config/user-im/{userId}/codex/provider.json`（`StoredCodexProviderConfigV1`：`version/id/name/baseUrl/model/wireApi/updatedAt` 明文 + `secret` 密文）。**apiKey 用 `encryptChannelSecret` 加密**，绝不明文落盘。
- `getUserCodexProvider(userId)`：解密返回 `CodexCustomProvider`（含 apiKey，**仅运行时内部用**）；无配置或解密失败 → null。
- `toPublicCodexProvider(userId)`：脱敏 `PublicCodexCustomProvider` —— apiKey 仅暴露 `hasApiKey:boolean` + `apiKeyMask`（形如 `••••1234`，末 4 位），**绝不回明文**；解密失败视为无 key（不抛错、不泄漏密文）。
- `saveUserCodexProvider(userId, {name, baseUrl, model, wireApi?, apiKey?})`：校验 `baseUrl` 是 https、slug 化 id、加密 apiKey、原子写。**apiKey 可选**：未传（`undefined`）保留旧 key（仅改 model/baseUrl 不重置 key）；传空串视为清空。
- `deleteUserCodexProvider(userId)`（幂等）、`hasUserCodexProvider(userId)`。
- userId 逃逸校验复用 `userImDir` 同款白名单 `^[a-zA-Z0-9_-]+$`（拒 `..`/路径分隔/空段），与 per-user `auth.json` 同安全模型。

### 路由（`src/routes/config.ts`，per-user，`authMiddleware`，作用域恒 `c.get('user').id`）

- `GET /api/config/codex/provider` → `toPublicCodexProvider`（脱敏，无 apiKey 明文）。
- `PUT /api/config/codex/provider` `{name, baseUrl, model, wireApi?, apiKey?}` → `saveUserCodexProvider`；apiKey 可选（仅改 model/baseUrl 时不重置 key）；校验 baseUrl https；审计 `appendClaudeConfigAudit`（不记 apiKey 值）。
- `DELETE /api/config/codex/provider` → `deleteUserCodexProvider`。
- 写端点只作用于自己 `user.id` 目录，不从请求体取 userId，无越权面。

### 前端（`web/`）

`web/src/components/settings/CodexAuthCard.tsx` 内（或同页）「自定义模型 provider」区块：表单 name / base_url / model / API key（password 输入），保存(PUT)/清除(DELETE)；状态展示当前 provider（name/model/baseUrl/`hasApiKey` mask）。`wire_api` 不暴露（默认 `responses`，加一行小字说明 provider 需兼容 OpenAI Responses API）。store 见 `web/src/stores/codex-provider.ts`（或 `codex-auth.ts`）。

### 安全（自定义 provider 维度）

- **apiKey 不泄漏**：落盘密文（`encryptChannelSecret`）；GET 脱敏（`hasApiKey` + mask）；`config.toml` 只存 env_key 引用，明文 key 仅在 spawn 时进 agent env，且经 `shellQuoteEnvLines` 转义。
- **越权**：所有端点 `authMiddleware` + `userImDir` 白名单，作用域恒为本人 user.id。
- **审计**：PUT/DELETE 经 `appendClaudeConfigAudit` 记 actor + action（不记 apiKey 值）。
- **加密密钥**：apiKey 走 `claude-provider.key`（与 Feishu/Telegram 同 key 文件），区别于 per-user `auth.json`（codex 必须明文读、不加密）。

## 相关文件

per-user OAuth：`src/codex-paths.ts` · `src/codex-device-auth.ts` · `src/routes/config.ts` · `src/routes/auth.ts` · `src/runtime/multitenant/codex-home.ts` · `src/container-runner.ts` · `src/web.ts` · `web/src/components/settings/CodexAuthCard.tsx` · `web/src/stores/codex-auth.ts`

自定义模型 provider：`src/runtime-config.ts`（`getUserCodexProvider`/`toPublicCodexProvider`/`saveUserCodexProvider`/`deleteUserCodexProvider`/`hasUserCodexProvider`）· `src/runtime/multitenant/codex-home.ts`（`provisionModelProvider`/`CodexModelProviderConfig`/`CODEX_CUSTOM_API_KEY_ENV`）· `src/container-runner.ts`（`resolveModelProvider`/`buildAgentEnvLines` env 注入）· `src/routes/config.ts`（3 端点）· `web/src/components/settings/CodexAuthCard.tsx`
