/**
 * 共享测试替身：FakeToolBridge —— 记录每次调用、返回可预测的 canned 结果。
 * 供 builtin 工具测试、dispatcher 测试复用，避免各写一份不一致的 fake。
 */

import type {
  ToolBridge,
  ScheduleTaskInput,
  TaskSummary,
  MemoryHit,
} from '../../src/runtime/tools/types.js';

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
  async installSkill(folder: string, name: string): Promise<void> {
    this.record('installSkill', folder, name);
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
}
