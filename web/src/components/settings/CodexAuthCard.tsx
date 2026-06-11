import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Key,
  Loader2,
  LogOut,
  RefreshCw,
  Terminal,
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
    loadStatus,
    submitApiKey,
    submitAccessToken,
    startDeviceAuth,
    logout,
    resetDevice,
    subscribeDeviceAuth,
  } = useCodexAuthStore();

  const [method, setMethod] = useState<LoginMethod>('chatgpt');
  const [apiKey, setApiKey] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [startingDevice, setStartingDevice] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // 初次加载状态。
  useEffect(() => {
    loadStatus().catch(() => {
      /* error 已落进 store.error */
    });
  }, [loadStatus]);

  // 订阅 codex_device_auth WS 事件（含重连恢复——后端 getState 重发当前 phase）。
  useEffect(() => {
    const unsub = subscribeDeviceAuth();
    return () => unsub();
  }, [subscribeDeviceAuth]);

  const handleStartDevice = useCallback(async () => {
    setStartingDevice(true);
    try {
      await startDeviceAuth();
      toast.info('已发起 ChatGPT 登录，请稍候获取授权链接…');
    } catch (err) {
      toast.error(getErrorMessage(err, '发起 ChatGPT 登录失败'));
    } finally {
      setStartingDevice(false);
    }
  }, [startDeviceAuth]);

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

          {/* ─── ChatGPT 登录（device-auth）─── */}
          <TabsContent value="chatgpt" className="pt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              点击下方按钮后，在打开的页面登录 ChatGPT，并在页面中输入展示的验证码完成授权。
              授权链接与验证码通过实时推送展示，无需手动刷新。
            </p>

            {device.phase === 'pending' && (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                {device.verificationUri && device.userCode ? (
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
              <Button onClick={handleStartDevice} disabled={startingDevice}>
                {startingDevice ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ExternalLink className="size-4" />
                )}
                {device.phase === 'authorized' ? '重新登录 ChatGPT' : '用 ChatGPT 登录'}
              </Button>
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
      </div>
    </div>
  );
}
