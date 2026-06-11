import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
// Tombstone（happycodex）：上游此处导入 ProviderSwitcher（运行中切换 Claude provider），
// provider failover 已作废，组件删除，Provider 行随之摘除；group props 里上游的
// selectedProviderId/selectedProviderName 两个 provider 字段也一并删除。

interface GroupStatusCardProps {
  group: {
    jid: string;
    active: boolean;
    pendingMessages: boolean;
    pendingTasks: number;
    containerName: string | null;
    displayName: string | null;
    groupFolder: string | null;
    ownerUsername: string | null;
  };
}

export function GroupStatusCard({ group }: GroupStatusCardProps) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-foreground truncate mr-2">
          {group.jid}
        </span>
        {group.active ? (
          <Badge variant="default" className="bg-success-bg text-success hover:bg-success-bg shrink-0">
            运行中
          </Badge>
        ) : (
          <Badge variant="secondary" className="shrink-0">
            空闲
          </Badge>
        )}
      </div>

      <div className="space-y-1.5 text-xs text-muted-foreground">
        {group.ownerUsername && (
          <div className="flex items-center justify-between">
            <span>账号</span>
            <span className="text-foreground">{group.ownerUsername}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span>队列</span>
          <span className="text-foreground">
            {group.pendingTasks} 个任务 / {group.pendingMessages ? '有新消息' : '无新消息'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>进程标识</span>
          <span className="text-foreground font-mono truncate ml-2 max-w-[60%] text-right">
            {group.displayName || group.containerName || '-'}
          </span>
        </div>
        </div>
      </CardContent>
    </Card>
  );
}
