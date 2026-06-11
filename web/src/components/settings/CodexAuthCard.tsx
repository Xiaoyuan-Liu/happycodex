import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Key,
  Loader2,
  LogOut,
  RefreshCw,
  Server,
  Terminal,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCodexAuthStore } from '../../stores/codex-auth';
import { getErrorMessage } from './types';

/**
 * Per-user codex 认证卡片。
 *
 * 三种登录方式：
 *   - ChatGPT 登录（device-auth）：POST /device/start → 订阅 WS codex_device_auth →
 *     渲染 verificationUri + userCode + 状态机（pending/authorized/expired/error）。
 *   - API Key：POST /api-key（写 per-user auth.json {OPENAI_API_KEY}）。
 *   - Access Token：POST /access-token（codex login --with-access-token）。
 * 登出：DELETE /api/config/codex/auth（回退共享）。
 *
 * 骨架对标 WhatsAppChannelCard（WS 订阅 + 状态机）与 ProviderEditor（凭据表单）。
 */

type LoginMethod = 'chatgpt' | 'api_key' | 'access_token';

const METHOD_LABEL: Record<string, string> = {
  chatgpt: 'ChatGPT 登录',
  api_key: 'API Key',
  unknown: '已登录',
};

export function CodexAuthCard() {
  const {
    status,
    loading,
    device,
    provider,
    loadStatus,
    submitApiKey,
    submitAccessToken,
    startDeviceAuth,
    startBrowserLogin,
    logout,
    resetDevice,
    subscribeDeviceAuth,
    loadProvider,
    saveProvider,
    deleteProvider,
  } = useCodexAuthStore();

  const [method, setMethod] = useState<LoginMethod>('chatgpt');
  const [apiKey, setApiKey] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [startingDevice, setStartingDevice] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // ── 自定义模型 provider 表单状态 ──
  const [providerName, setProviderName] = useState('');
  const [providerBaseUrl, setProviderBaseUrl] = useState('');
  const [providerModel, setProviderModel] = useState('');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [savingProvider, setSavingProvider] = useState(false);
  const [deletingProvider, setDeletingProvider] = useState(false);

  // 初次加载状态。
  useEffect(() => {
    loadStatus().catch(() => {
      /* error 已落进 store.error */
    });
  }, [loadStatus]);

  // 初次加载自定义 provider（脱敏）。
  useEffect(() => {
    loadProvider().catch(() => {
      /* 未配置 / 加载失败：保持 provider=null，区块仍可新建 */
    });
  }, [loadProvider]);

  // provider 加载后回填表单（apiKey 不回填——脱敏永不回明文）。
  useEffect(() => {
    if (provider) {
      setProviderName(provider.name);
      setProviderBaseUrl(provider.baseUrl);
      setProviderModel(provider.model);
    }
  }, [provider]);

  // 订阅 codex_device_auth WS 事件（含重连恢复——后端 getState 重发当前 phase）。
  useEffect(() => {
    const unsub = subscribeDeviceAuth();
    return () => unsub();
  }, [subscribeDeviceAuth]);

  const handleStartDevice = useCallback(async () => {
    setStartingDevice(true);
    try {
      await startDeviceAuth();
      toast.info('已发起设备码登录，请稍候获取授权链接…');
    } catch (err) {
      toast.error(getErrorMessage(err, '发起设备码登录失败'));
    } finally {
      setStartingDevice(false);
    }
  }, [startDeviceAuth]);

  const handleStartBrowser = useCallback(async () => {
    setStartingDevice(true);
    try {
      await startBrowserLogin();
      toast.info('已发起浏览器登录，浏览器应会自动打开授权页…');
    } catch (err) {
      toast.error(getErrorMessage(err, '发起浏览器登录失败'));
    } finally {
      setStartingDevice(false);
    }
  }, [startBrowserLogin]);

  const handleRetryDevice = useCallback(async () => {
    resetDevice();
    await handleStartDevice();
  }, [resetDevice, handleStartDevice]);

  const handleSaveApiKey = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      toast.error('请填写 OpenAI API Key');
      return;
    }
    setSavingKey(true);
    try {
      await submitApiKey(trimmed);
      setApiKey('');
      toast.success('API Key 已保存到你的 codex 凭据');
    } catch (err) {
      // 已有 ChatGPT 登录态时后端返回 409，提示用户确认覆盖。
      const msg = getErrorMessage(err, '保存 API Key 失败');
      const isConflict =
        typeof err === 'object' && err !== null && 'status' in err
          ? (err as { status?: number }).status === 409
          : false;
      if (isConflict && window.confirm(`${msg}\n\n确认要用 API Key 覆盖现有登录态吗？`)) {
        try {
          await submitApiKey(trimmed, true);
          setApiKey('');
          toast.success('API Key 已保存（已覆盖原登录态）');
        } catch (err2) {
          toast.error(getErrorMessage(err2, '保存 API Key 失败'));
        }
      } else {
        toast.error(msg);
      }
    } finally {
      setSavingKey(false);
    }
  }, [apiKey, submitApiKey]);

  const handleSaveAccessToken = useCallback(async () => {
    const trimmed = accessToken.trim();
    if (!trimmed) {
      toast.error('请粘贴 Access Token');
      return;
    }
    setSavingToken(true);
    try {
      await submitAccessToken(trimmed);
      setAccessToken('');
      toast.success('Access Token 已保存到你的 codex 凭据');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 Access Token 失败'));
    } finally {
      setSavingToken(false);
    }
  }, [accessToken, submitAccessToken]);

  const handleLogout = useCallback(async () => {
    if (
      !window.confirm(
        '登出会删除你自己的 codex 凭据；之后会回退到共享账号（若已启用）。继续？',
      )
    ) {
      return;
    }
    setLoggingOut(true);
    try {
      await logout();
      toast.success('已登出，已清除你的 codex 凭据');
    } catch (err) {
      toast.error(getErrorMessage(err, '登出失败'));
    } finally {
      setLoggingOut(false);
    }
  }, [logout]);

  const handleSaveProvider = useCallback(async () => {
    const name = providerName.trim();
    const baseUrl = providerBaseUrl.trim();
    const model = providerModel.trim();
    const key = providerApiKey.trim();
    if (!name) {
      toast.error('请填写 provider 名称');
      return;
    }
    if (!baseUrl) {
      toast.error('请填写 base URL');
      return;
    }
    if (!/^https:\/\//i.test(baseUrl)) {
      toast.error('base URL 必须以 https:// 开头');
      return;
    }
    if (!model) {
      toast.error('请填写模型名称');
      return;
    }
    // 新建时必须提供 apiKey；已有 provider 仅改 model/baseUrl 时可不重置 key。
    if (!key && !provider?.hasApiKey) {
      toast.error('请填写 API Key');
      return;
    }
    setSavingProvider(true);
    try {
      await saveProvider({
        name,
        baseUrl,
        model,
        // 仅在用户填了新 key 时才上送，避免覆盖/重置旧 key。
        ...(key ? { apiKey: key } : {}),
      });
      setProviderApiKey('');
      toast.success('自定义模型 provider 已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存自定义 provider 失败'));
    } finally {
      setSavingProvider(false);
    }
  }, [providerName, providerBaseUrl, providerModel, providerApiKey, provider, saveProvider]);

  const handleDeleteProvider = useCallback(async () => {
    if (
      !window.confirm(
        '清除后将不再使用自定义模型 provider，codex 会回退到默认模型。继续？',
      )
    ) {
      return;
    }
    setDeletingProvider(true);
    try {
      await deleteProvider();
      setProviderName('');
      setProviderBaseUrl('');
      setProviderModel('');
      setProviderApiKey('');
      toast.success('已清除自定义模型 provider');
    } catch (err) {
      toast.error(getErrorMessage(err, '清除自定义 provider 失败'));
    } finally {
      setDeletingProvider(false);
    }
  }, [deleteProvider]);

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label}已复制`);
    } catch {
      toast.error('复制失败，请手动选择');
    }
  }, []);

  const hasUserAuth = status?.hasUserAuth ?? false;
  const usingShared = status?.usingShared ?? false;
  const loggedIn = status?.loggedIn ?? false;

  // 状态点颜色：用自己的=绿；回退共享=琥珀；未登录=灰。
  const dotColor = hasUserAuth
    ? 'bg-success'
    : usingShared && loggedIn
      ? 'bg-amber-500'
      : 'bg-muted-foreground/40';

  const headerSubtitle = loading
    ? '加载中…'
    : hasUserAuth
      ? `已用你自己的 codex 账号（${status?.method ? METHOD_LABEL[status.method] ?? status.method : '已登录'}）`
      : usingShared && loggedIn
        ? '当前回退到共享账号——登录后将改用你自己的账号'
        : '尚未登录 codex';

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/50">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${dotColor}`}
          />
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Terminal className="w-4 h-4 text-primary" />
              Codex 认证
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {headerSubtitle}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => loadStatus().catch(() => {})}
          disabled={loading}
          title="刷新状态"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </Button>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* 状态摘要 */}
        {status && (
          <div
            className={`rounded-lg border px-3 py-2.5 text-xs ${
              hasUserAuth
                ? 'border-success/20 bg-success/5'
                : usingShared && loggedIn
                  ? 'border-amber-500/20 bg-amber-500/5'
                  : 'border-border bg-muted/30'
            }`}
          >
            <p className="text-muted-foreground">{status.loginHint}</p>
            {status.method && hasUserAuth && (
              <div className="mt-1.5 text-muted-foreground">
                认证方式：
                <span className="font-medium text-foreground">
                  {METHOD_LABEL[status.method] ?? status.method}
                </span>
              </div>
            )}
            {status.lastRefresh && (
              <div className="text-muted-foreground">
                上次刷新：
                {new Date(status.lastRefresh).toLocaleString('zh-CN')}
              </div>
            )}
          </div>
        )}

        {/* 登录方式选择 */}
        <Tabs value={method} onValueChange={(v) => setMethod(v as LoginMethod)}>
          <TabsList className="w-full">
            <TabsTrigger value="chatgpt">用 ChatGPT 登录</TabsTrigger>
            <TabsTrigger value="api_key">API Key</TabsTrigger>
            <TabsTrigger value="access_token">Access Token</TabsTrigger>
          </TabsList>

          {/* ─── ChatGPT 登录（浏览器 / 设备码）─── */}
          <TabsContent value="chatgpt" className="pt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              用你自己的 ChatGPT 账号登录 codex。本机部署推荐「浏览器登录」（自动开浏览器、点一下即可）；
              远程/无头服务器用「设备码登录」（在任意设备打开链接 + 输验证码）。
            </p>

            {device.phase === 'pending' && (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                {device.verificationUri ? (
                  <>
                    <div className="text-sm font-medium text-foreground">
                      请完成 ChatGPT 授权
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">
                        授权链接
                      </Label>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">
                          {device.verificationUri}
                        </code>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            copyToClipboard(device.verificationUri!, '链接')
                          }
                          title="复制链接"
                        >
                          <Copy className="size-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            window.open(
                              device.verificationUri,
                              '_blank',
                              'noopener,noreferrer',
                            )
                          }
                          title="打开链接"
                        >
                          <ExternalLink className="size-4" />
                        </Button>
                      </div>
                    </div>
                    {device.userCode ? (
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">
                          验证码
                        </Label>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 rounded bg-muted px-2 py-1.5 text-base font-mono tracking-widest">
                            {device.userCode}
                          </code>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              copyToClipboard(device.userCode!, '验证码')
                            }
                            title="复制验证码"
                          >
                            <Copy className="size-4" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        浏览器应已自动打开授权页；若没有，点击上方链接登录即可（无需验证码）。
                      </p>
                    )}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      等待授权完成…
                      {device.expiresInSec
                        ? `（链接约 ${Math.round(device.expiresInSec / 60)} 分钟内有效）`
                        : ''}
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    正在获取授权链接…
                  </div>
                )}
              </div>
            )}

            {device.phase === 'authorized' && (
              <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-3 text-sm flex items-center gap-2">
                <CheckCircle2 className="size-4 text-success" />
                <span className="font-medium text-success">
                  授权成功，已使用你自己的 codex 账号
                </span>
              </div>
            )}

            {(device.phase === 'expired' || device.phase === 'error') && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-3 text-sm space-y-2">
                <div className="text-destructive">
                  {device.phase === 'expired'
                    ? '授权超时，验证码已过期。'
                    : `授权失败：${device.error ?? '未知错误'}`}
                </div>
                <Button variant="outline" size="sm" onClick={handleRetryDevice}>
                  <RefreshCw className="size-4" />
                  重试
                </Button>
              </div>
            )}

            {(device.phase === 'idle' || device.phase === 'authorized') && (
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleStartBrowser} disabled={startingDevice}>
                  {startingDevice ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ExternalLink className="size-4" />
                  )}
                  {device.phase === 'authorized' ? '重新用浏览器登录' : '浏览器登录（本机推荐）'}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleStartDevice}
                  disabled={startingDevice}
                  title="远程/无头服务器用；需在 ChatGPT 安全设置启用设备代码授权"
                >
                  设备码登录
                </Button>
              </div>
            )}
          </TabsContent>

          {/* ─── API Key ─── */}
          <TabsContent value="api_key" className="pt-3 space-y-3">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5" />
                OpenAI API Key
              </Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={savingKey}
                placeholder="sk-…"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                直接写入你自己的 codex 凭据（<code className="bg-muted px-1 rounded">auth.json</code>
                {' '}的 <code className="bg-muted px-1 rounded">OPENAI_API_KEY</code>），等价于
                {' '}<code className="bg-muted px-1 rounded">codex login --api-key</code>。
              </p>
            </div>
            <Button onClick={handleSaveApiKey} disabled={savingKey}>
              {savingKey && <Loader2 className="size-4 animate-spin" />}
              保存 API Key
            </Button>
          </TabsContent>

          {/* ─── Access Token ─── */}
          <TabsContent value="access_token" className="pt-3 space-y-3">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5" />
                ChatGPT Access Token
              </Label>
              <Input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                disabled={savingToken}
                placeholder="粘贴 access token"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                适合无法打开浏览器授权页的场景；经
                {' '}<code className="bg-muted px-1 rounded">codex login --with-access-token</code>
                {' '}写入你自己的 codex 凭据。
              </p>
            </div>
            <Button onClick={handleSaveAccessToken} disabled={savingToken}>
              {savingToken && <Loader2 className="size-4 animate-spin" />}
              保存 Access Token
            </Button>
          </TabsContent>
        </Tabs>

        {/* 登出（仅在用自己的凭据时可见） */}
        {hasUserAuth && (
          <div className="border-t border-border pt-3">
            <Button
              variant="outline"
              onClick={handleLogout}
              disabled={loggingOut}
              title="删除你自己的 codex 凭据，回退共享账号"
            >
              {loggingOut ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LogOut className="size-4" />
              )}
              登出（清除我的 codex 凭据）
            </Button>
          </div>
        )}

        {/* ─── 自定义模型 provider（配第三方模型，如 GLM）─── */}
        <div className="border-t border-border pt-4 space-y-3">
          <div className="flex items-center gap-1.5">
            <Server className="w-4 h-4 text-primary" />
            <h4 className="text-sm font-semibold text-foreground">
              自定义模型 provider
            </h4>
          </div>
          <p className="text-xs text-muted-foreground">
            配置第三方模型（如 GLM）。codex 要求 provider 兼容 OpenAI
            {' '}<span className="font-medium text-foreground">Responses API</span>。
            保存后会写入你自己的 codex 配置并选用该模型。
          </p>

          {/* 当前 provider 脱敏状态 */}
          {provider && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs space-y-1">
              <div className="text-muted-foreground">
                当前 provider：
                <span className="font-medium text-foreground">{provider.name}</span>
                <span className="ml-1 text-muted-foreground/70">
                  （id: {provider.id}）
                </span>
              </div>
              <div className="text-muted-foreground">
                模型：
                <span className="font-mono text-foreground">{provider.model}</span>
              </div>
              <div className="truncate text-muted-foreground">
                base URL：
                <span className="font-mono text-foreground">{provider.baseUrl}</span>
              </div>
              <div className="text-muted-foreground">
                API Key：
                {provider.hasApiKey ? (
                  <span className="font-mono text-foreground">
                    {provider.apiKeyMask ?? '已配置'}
                  </span>
                ) : (
                  <span className="text-amber-500">未配置</span>
                )}
              </div>
            </div>
          )}

          {/* 表单 */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">名称（name）</Label>
              <Input
                value={providerName}
                onChange={(e) => setProviderName(e.target.value)}
                disabled={savingProvider}
                placeholder="例如 GLM"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">base URL</Label>
              <Input
                value={providerBaseUrl}
                onChange={(e) => setProviderBaseUrl(e.target.value)}
                disabled={savingProvider}
                placeholder="https://…/v1"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">模型（model）</Label>
              <Input
                value={providerModel}
                onChange={(e) => setProviderModel(e.target.value)}
                disabled={savingProvider}
                placeholder="例如 glm-4.6"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5" />
                API Key
              </Label>
              <Input
                type="password"
                value={providerApiKey}
                onChange={(e) => setProviderApiKey(e.target.value)}
                disabled={savingProvider}
                placeholder={
                  provider?.hasApiKey
                    ? '已保存，留空则保留原有 key'
                    : '输入 provider 的 API Key'
                }
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                加密保存，绝不回显明文。
                {provider?.hasApiKey
                  ? '仅修改名称 / base URL / 模型时可留空，将保留原有 key。'
                  : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={handleSaveProvider} disabled={savingProvider}>
              {savingProvider && <Loader2 className="size-4 animate-spin" />}
              保存 provider
            </Button>
            {provider && (
              <Button
                variant="outline"
                onClick={handleDeleteProvider}
                disabled={deletingProvider}
                title="清除自定义模型 provider，回退 codex 默认模型"
              >
                {deletingProvider ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                清除
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
