/**
 * Codex 接入初始化占位页（happycodex 适配）。
 *
 * Tombstone：上游 HappyClaw 此处是 STEP 2/2 的 Claude Provider 接入向导
 * （官方 OAuth / setup-token / API Key / 第三方 BASE_URL+TOKEN + 飞书配置），
 * 依赖已作废的 provider failover 体系与 /api/config/claude/* 路由，整页重写为占位页。
 *
 * happycodex 的 codex 认证在服务端完成（`codex login` / ~/.codex/config.toml）；
 * Web 端接入向导待后端 routes/config 重写（另一条线）后补全。
 * 保留上游的路由与跳转骨架：未登录 → /login；非 admin → /chat；
 * setupStatus 不再 needsSetup → /settings?tab=claude。
 */
import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Terminal } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { useAuthStore } from '../stores/auth';

export function SetupProvidersPage() {
  const navigate = useNavigate();
  const { user, setupStatus, checkAuth, initialized } = useAuthStore();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (user === null && initialized === true) {
      navigate('/login', { replace: true });
    } else if (user && user.role !== 'admin') {
      navigate('/chat', { replace: true });
    }
  }, [user, initialized, navigate]);

  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup) {
      navigate('/settings?tab=claude', { replace: true });
    }
  }, [setupStatus, navigate]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await checkAuth();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="h-screen bg-background overflow-y-auto p-4">
      <div className="w-full max-w-2xl mx-auto space-y-5 pt-12">
        <div className="text-center">
          <p className="text-xs font-semibold text-primary tracking-wider mb-2">STEP 2 / 2</p>
          <h1 className="text-2xl font-bold text-foreground mb-2">Codex 接入初始化</h1>
          <p className="text-sm text-muted-foreground">完成服务端 codex 配置后即可进入正式后台。</p>
        </div>

        <section className="bg-card rounded-xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-2 mb-3">
            <Terminal className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">在服务端完成 codex 配置</h2>
          </div>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              happycodex 通过本机 <code className="bg-muted px-1 rounded">codex</code> CLI 运行。
              请在部署服务器上完成认证与模型配置：
            </p>
            <ol className="list-decimal list-inside space-y-1.5">
              <li>
                运行 <code className="bg-muted px-1 rounded">codex login</code>（或在
                <code className="bg-muted px-1 rounded">~/.codex/config.toml</code> 配置 API 凭据）
              </li>
              <li>
                按需在 <code className="bg-muted px-1 rounded">~/.codex/config.toml</code> 设置默认模型
                （如 <code className="bg-muted px-1 rounded">gpt-5.1-codex</code>）
              </li>
              <li>重启 happycodex 服务，然后点击下方"刷新状态"</li>
            </ol>
            <p className="text-xs">
              Web 端的 codex 配置界面尚未提供（后端 routes/config 重写中），本页为占位向导。
            </p>
          </div>
        </section>

        <div className="flex items-center justify-center gap-3">
          <Button onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            刷新状态
          </Button>
          <Button variant="outline" onClick={() => navigate('/chat', { replace: true })}>
            进入后台
          </Button>
        </div>
      </div>
    </div>
  );
}
