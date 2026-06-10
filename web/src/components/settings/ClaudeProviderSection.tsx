/**
 * Codex 配置占位页（happycodex 适配）。
 *
 * Tombstone：上游 HappyClaw 此处是 Claude Provider 管理（多 provider CRUD + 健康轮询 +
 * 负载均衡 + OAuth 用量条），依赖已作废的 provider failover 体系，相关组件已随之移除：
 *   - ProviderList.tsx / ProviderEditor.tsx / BalancingSettings.tsx / UsageBars.tsx（已删除）
 *   - /api/config/claude/providers、/api/config/claude/balancing 等后端路由不再提供
 *
 * happycodex 的 codex 配置（模型、认证、MCP 等）由服务端 codex config 管理，
 * Web 端配置界面待 routes/config 重写（另一条线）后补全。
 * 保留文件名与 props 形状，维持与上游 SettingsPage 调用点逐字一致。
 */
import { Terminal } from 'lucide-react';

interface ClaudeProviderSectionProps {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function ClaudeProviderSection(_props: ClaudeProviderSectionProps) {
  return (
    <section className="bg-card rounded-xl border border-border shadow-sm p-5">
      <div className="flex items-center gap-2 mb-3">
        <Terminal className="w-4 h-4 text-primary" />
        <h2 className="text-base font-semibold text-foreground">Codex 配置</h2>
      </div>
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          happycodex 通过本机 <code className="bg-muted px-1 rounded">codex</code> CLI 运行，
          模型与认证配置由服务端的 codex 配置（<code className="bg-muted px-1 rounded">~/.codex/config.toml</code>
          、<code className="bg-muted px-1 rounded">codex login</code>）管理。
        </p>
        <p>
          Web 端的 codex 配置界面尚未提供（后端 routes/config 重写中）。
          如需调整模型或 API 凭据，请在服务端直接修改 codex 配置后重启会话。
        </p>
      </div>
    </section>
  );
}
