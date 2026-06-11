import type { LucideIcon } from 'lucide-react';

export function SettingsCard({ icon: Icon, title, desc, action, children }: {
  icon: LucideIcon;
  title: string;
  desc?: string;
  /** 可选：右侧 header 槽（如刷新按钮 / 状态徽标）。 */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {desc && <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="px-5 py-4 space-y-4">{children}</div>
    </div>
  );
}
