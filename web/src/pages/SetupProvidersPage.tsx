/**
 * Codex 接入初始化向导（happycodex 适配）。
 *
 * Tombstone：上游 HappyClaw 此处是 STEP 2/2 的 Claude Provider 接入向导
 * （官方 OAuth / setup-token / API Key / 第三方 BASE_URL+TOKEN + 飞书配置），
 * 依赖已作废的 provider failover 体系与 /api/config/claude/* 路由。
 *
 * happycodex 改为在本页直接挂载 CodexAuthCard（浏览器 / 设备码 / API Key /
 * Access Token 四法俱全），让全新机器 admin **纯浏览器**完成 codex 登录，不必再
 * SSH 上服务器敲 `codex login`。配合后端 resolveCodexLoginTarget：bootstrap 期
 * （admin + 共享账号未配置）的登录写**共享**基线账号，登录成功后 needsSetup 翻转、
 * 门控自动放行。AuthGuard 仍把未完成 setup 的 admin 钉在本页（location≠/setup/providers
 * 即重定向回来），但本页现在自带登录闭环，不再是死页。
 *
 * 路由骨架沿用上游：未登录 → /login；非 admin → /chat；needsSetup 翻 false → /settings?tab=claude。
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { CodexAuthCard } from '../components/settings/CodexAuthCard';
import { useAuthStore } from '../stores/auth';

export function SetupProvidersPage() {
  const navigate = useNavigate();
  const { user, setupStatus, checkAuth, initialized } = useAuthStore();
  const [refreshing, setRefreshing] = useState(false);
  // ③ 验证翻转守卫：登录写入成功但门控仍未过（多半凭据落了 per-user 而非共享）时提示。
  const [gateStuck, setGateStuck] = useState(false);

  useEffect(() => {
    if (user === null && initialized === true) {
      navigate('/login', { replace: true });
    } else if (user && user.role !== 'admin') {
      navigate('/chat', { replace: true });
    }
  }, [user, initialized, navigate]);

  // 门控翻 false → 进入正式后台（codex 配置页）。
  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup) {
      navigate('/settings?tab=claude', { replace: true });
    }
  }, [setupStatus, navigate]);

  // 登录成功（CodexAuthCard 任一方式）后刷新门控；仍 needsSetup 则给出诊断提示。
  const handleLoginSuccess = useCallback(async () => {
    setGateStuck(false);
    // force=true：绕过 in-flight 去重，确保读到「写入凭据之后」的门控状态（见 store.checkAuth）。
    await checkAuth(true);
    // checkAuth 已写回 store；读最新值判断是否真翻转（闭包内 setupStatus 是旧值）。
    const fresh = useAuthStore.getState().setupStatus;
    if (fresh && fresh.needsSetup) {
      setGateStuck(true);
    }
    // 翻转成功的导航交给上面的 effect（监听 setupStatus.needsSetup）。
  }, [checkAuth]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await handleLoginSuccess();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="h-screen bg-background overflow-y-auto p-4">
      <div className="w-full max-w-2xl mx-auto space-y-5 pt-12">
        <div className="text-center">
          <p className="text-xs font-semibold text-primary tracking-wider mb-2">STEP 2 / 2</p>
          <h1 className="text-2xl font-bold text-foreground mb-2">登录 Codex 账号</h1>
          <p className="text-sm text-muted-foreground">
            完成登录即解锁正式后台。作为首位管理员，你这次登录会写入
            <span className="text-foreground font-medium"> 共享基线账号</span>
            ，供所有工作区使用（之后每位成员仍可在配置页登录自己的账号）。
          </p>
        </div>

        <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground">
          <ShieldCheck className="w-3.5 h-3.5 text-primary" />
          凭据仅写入本机 codex 目录（0600 权限），不经第三方
        </div>

        {gateStuck && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              凭据已写入，但 setup 门控仍未通过。通常意味着凭据落进了 per-user 目录而非共享基线账号
              （bootstrap 判定未命中）。请点「刷新状态」重试；若持续如此，需检查服务端共享
              CODEX_HOME 是否可写。
            </div>
          </div>
        )}

        <CodexAuthCard onLoginSuccess={handleLoginSuccess} />

        <div className="flex items-center justify-center gap-3">
          <Button onClick={handleRefresh} disabled={refreshing} variant="outline">
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            刷新状态
          </Button>
        </div>
      </div>
    </div>
  );
}
