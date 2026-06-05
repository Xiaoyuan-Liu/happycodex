/**
 * ToolRegistry —— 工具注册表（IToolRegistry 实现）。
 *
 * 职责：
 * - 聚合 ToolDefinition（按 spec.name 索引）。
 * - 产出 dynamicTools 的 schema 列表（specs()），传给 thread/start.dynamicTools。
 * - 按工具名分发模型调用（dispatch），**绝不抛错**：未知工具 / handler 异常都收敛成
 *   success:false 的 DynamicToolCallResponse —— dispatcher 依赖此不变量直接 respond。
 *
 * 重名策略：后注册覆盖先注册（同名 def.spec.name 直接替换 Map 内条目）。注册顺序由插入序保留，
 * 覆盖时不改变首次插入的位置（Map 语义），specs() 因此对未覆盖项保持稳定顺序。
 */

import type {
  DynamicToolSpec,
  DynamicToolCallResponse,
} from '../../appserver/protocol.js';
import { toolTextResult } from '../../appserver/protocol.js';
import type {
  IToolRegistry,
  ToolContext,
  ToolDefinition,
} from './types.js';

export class ToolRegistry implements IToolRegistry {
  /** 按工具名索引；插入序即 Map 迭代序，specs() 借此保持稳定。 */
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    // 重名后注册覆盖（Map.set 在 key 已存在时保留原插入位置，仅替换 value）。
    this.tools.set(def.spec.name, def);
  }

  specs(): DynamicToolSpec[] {
    const out: DynamicToolSpec[] = [];
    for (const def of this.tools.values()) {
      out.push(def.spec);
    }
    return out;
  }

  has(tool: string): boolean {
    return this.tools.has(tool);
  }

  async dispatch(
    tool: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<DynamicToolCallResponse> {
    const def = this.tools.get(tool);
    if (def === undefined) {
      return toolTextResult(`unknown tool: ${tool}`, false);
    }
    try {
      return await def.handler(args, ctx);
    } catch (e) {
      const message = (e as Error)?.message ?? e;
      return toolTextResult(String(message), false);
    }
  }
}
