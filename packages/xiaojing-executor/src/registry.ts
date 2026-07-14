import type { Capability, ExecutionContext, Executor, ToolCall, ToolResult, ToolSpec } from './types.js';
import { fail } from './types.js';

/**
 * 工具 → 能力域 → 执行器 的路由表。
 *
 * agent-runtime 唯一依赖的东西。第二期把 PlaywrightExecutor 注册进来,
 * 路由自动把 local.browser 的工具打到它身上。
 */
export class ExecutorRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly byCapability = new Map<Capability, Executor>();

  registerExecutor(executor: Executor): this {
    for (const cap of executor.capabilities) {
      const existing = this.byCapability.get(cap);
      if (existing && existing.id !== executor.id) {
        throw new Error(
          `能力域 "${cap}" 已由执行器 "${existing.id}" 占用,不能再注册给 "${executor.id}"。` +
            `一个能力域只能有一个执行器 —— 否则工具调用路由就不确定了。`,
        );
      }
      this.byCapability.set(cap, executor);
    }
    return this;
  }

  registerTool(spec: ToolSpec): this {
    if (this.tools.has(spec.name)) {
      throw new Error(`工具 "${spec.name}" 重复注册`);
    }
    this.tools.set(spec.name, spec);
    return this;
  }

  listTools(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /**
   * 只列出当前有执行器可跑的工具。
   *
   * 这很重要:MVP 阶段没有 PlaywrightExecutor,local.browser 的工具就不该出现在
   * 上送给模型的工具定义里 —— 否则模型会去调一个必然失败的工具,白烧 token 还
   * 让用户看到报错。
   */
  listRunnableTools(): ToolSpec[] {
    return this.listTools().filter((t) => this.byCapability.has(t.capability));
  }

  resolve(toolName: string): Executor | undefined {
    const spec = this.tools.get(toolName);
    if (!spec) return undefined;
    return this.byCapability.get(spec.capability);
  }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult> {
    const spec = this.tools.get(call.toolName);
    if (!spec) return fail(`未知工具:${call.toolName}`);

    const executor = this.byCapability.get(spec.capability);
    if (!executor) {
      return fail(`工具 ${call.toolName} 需要能力域 "${spec.capability}",当前没有执行器提供该能力。`);
    }

    try {
      return await executor.execute(call, ctx);
    } catch (err) {
      // 工具抛异常必须变成 isError 的 tool_result 回给模型,而不是炸掉 agent loop。
      // 模型看到错误后可以改参数重试或换条路 —— 这是 agent 的自愈能力。
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`工具 ${call.toolName} 执行失败(执行器 ${executor.id}):${msg}`);
    }
  }
}
