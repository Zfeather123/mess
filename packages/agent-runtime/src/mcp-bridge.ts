import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ExecutionContext, ExecutorRegistry } from '@xiaojing/executor';

export const MCP_SERVER_NAME = 'xiaojing';

/** SDK 会把工具名前缀成 mcp__<server>__<tool>。上送给模型的就是这个全名。 */
export function toolFullName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/**
 * 把 ExecutorRegistry 变成一个**进程内** MCP server。
 *
 * "进程内"是关键:工具函数就在 Electron 主进程里执行,不是另起一个 MCP 子进程。
 * 所以第二期 Playwright 驱动的浏览器、用户的抖音登录态,全都在这个进程手里 ——
 * 这正是我们要桌面端的理由。
 *
 * 只暴露 listRunnableTools():没有执行器能跑的工具(MVP 阶段的 local.browser)
 * 根本不会出现在模型的工具定义里。不给模型一把注定拧不动的螺丝刀。
 */
export function buildMcpServer(registry: ExecutorRegistry, getContext: () => ExecutionContext) {
  const specs = registry.listRunnableTools();

  return {
    server: createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: '0.1.0',
      tools: specs.map((spec) =>
        tool(spec.name, spec.description, spec.schema, async (input) => {
          const result = await registry.execute(
            { toolName: spec.name, input: input as Record<string, unknown> },
            getContext(),
          );
          return { content: result.content, isError: result.isError };
        }),
      ),
    }),
    toolNames: specs.map((s) => toolFullName(s.name)),
  };
}
