/**
 * 共享测试替身：FakeToolBridge —— 记录每次调用、返回可预测的 canned 结果。
 * 供 builtin 工具测试、dispatcher 测试复用，避免各写一份不一致的 fake。
 */

import type {
  ToolBridge,
  ScheduleTaskInput,
  TaskSummary,
  MemoryHit,
  SendImageResult,
  DiscordHistoryOptions,
  DiscordHistoryMessage,
} from '../../src/runtime/tools/types.js';
import type { InjectContext } from '../../src/contracts.js';

export interface RecordedCall {
  op: string;
  args: unknown[];
}

export class FakeToolBridge implements ToolBridge {
  readonly calls: RecordedCall[] = [];

  /** 可被测试覆盖的 canned 返回。 */
  tasks: TaskSummary[] = [];
  memoryHits: MemoryHit[] = [];
  memoryValue: string | null = 'remembered-value';
  nextTaskId = 'task_fake_1';
  sendImageResult: SendImageResult = {
    fileName: 'chart.png',
    mimeType: 'image/png',
    sizeBytes: 2048,
  };
  installedSkills: string[] = [];
  discordMessages: DiscordHistoryMessage[] = [];
  discordChannel: unknown = { name: 'general', type: 'guild_text' };
  discordGuild: unknown | null = { name: 'My Server', memberCount: 5 };

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  opNames(): string[] {
    return this.calls.map((c) => c.op);
  }

  lastCall(): RecordedCall | undefined {
    return this.calls.at(-1);
  }

  async sendMessage(folder: string, message: string): Promise<void> {
    this.record('sendMessage', folder, message);
  }
  async sendImage(folder: string, filePath: string, caption?: string): Promise<SendImageResult> {
    this.record('sendImage', folder, filePath, caption);
    return this.sendImageResult;
  }
  async sendFile(folder: string, filePath: string, fileName: string): Promise<void> {
    this.record('sendFile', folder, filePath, fileName);
  }
  async scheduleTask(folder: string, input: ScheduleTaskInput): Promise<{ taskId: string }> {
    this.record('scheduleTask', folder, input);
    return { taskId: this.nextTaskId };
  }
  async listTasks(folder: string): Promise<TaskSummary[]> {
    this.record('listTasks', folder);
    return this.tasks;
  }
  async pauseTask(folder: string, taskId: string): Promise<void> {
    this.record('pauseTask', folder, taskId);
  }
  async resumeTask(folder: string, taskId: string): Promise<void> {
    this.record('resumeTask', folder, taskId);
  }
  async cancelTask(folder: string, taskId: string): Promise<void> {
    this.record('cancelTask', folder, taskId);
  }
  async registerGroup(folder: string, jid: string, name?: string): Promise<void> {
    this.record('registerGroup', folder, jid, name);
  }
  async installSkill(folder: string, name: string): Promise<{ installed?: string[] }> {
    this.record('installSkill', folder, name);
    return { installed: this.installedSkills };
  }
  async uninstallSkill(folder: string, name: string): Promise<void> {
    this.record('uninstallSkill', folder, name);
  }
  async memoryAppend(folder: string, content: string, scope?: string): Promise<void> {
    this.record('memoryAppend', folder, content, scope);
  }
  async memorySearch(folder: string, query: string): Promise<MemoryHit[]> {
    this.record('memorySearch', folder, query);
    return this.memoryHits;
  }
  async memoryGet(folder: string, path: string): Promise<string | null> {
    this.record('memoryGet', folder, path);
    return this.memoryValue;
  }
  async discordGetHistory(
    folder: string,
    opts?: DiscordHistoryOptions,
  ): Promise<DiscordHistoryMessage[]> {
    this.record('discordGetHistory', folder, opts);
    return this.discordMessages;
  }
  async discordGetChannelInfo(folder: string): Promise<unknown> {
    this.record('discordGetChannelInfo', folder);
    return this.discordChannel;
  }
  async discordGetServerInfo(folder: string): Promise<unknown | null> {
    this.record('discordGetServerInfo', folder);
    return this.discordGuild;
  }

  /** #F1r：记录 per-turn 上下文绑定，供 CodexRunner turn-绑定测试断言。 */
  readonly turnContexts: InjectContext[] = [];
  setTurnContext(ctx: InjectContext): void {
    this.record('setTurnContext', ctx);
    this.turnContexts.push(ctx);
  }
}
