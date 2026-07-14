import type { Capability, ExecutionContext, Executor, ToolCall, ToolResult } from './types.js';
import { fail, ok } from './types.js';

/**
 * 云端执行器:把工具调用转发到我们的服务端执行。
 *
 * MVP 阶段所有内容生产类工具都走这里。为什么不在客户端直接调 TikHub / CogView?
 * 因为那些 token 和 key 只存在服务端 —— 一旦下发到客户端就等于公开泄露。
 * 客户端只带 sessionToken(可撤销)。
 */
export class RemoteExecutor implements Executor {
  readonly id = 'remote';
  readonly capabilities: readonly Capability[] = ['cloud.content', 'cloud.data', 'cloud.vision'];

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/tools/${encodeURIComponent(call.toolName)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.sessionToken}`,
        'x-xiaojing-run-id': ctx.runId,
      },
      body: JSON.stringify({ input: call.input, agentId: ctx.agentId }),
      signal: ctx.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return fail(`云端工具 ${call.toolName} 返回 ${res.status}:${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as { text?: string };
    return ok(data.text ?? JSON.stringify(data));
  }
}
