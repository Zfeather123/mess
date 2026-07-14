import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ExecutionContext, ExecutorRegistry } from '@xiaojing/executor';
import type { UsageReport } from '@xiaojing/protocol';
import { buildMcpServer, MCP_SERVER_NAME } from './mcp-bridge.js';
import { buildHardenedOptions } from './options.js';

/**
 * AgentHost —— agent loop 就在这个进程里跑。
 *
 * 跑在用户的电脑上,吃用户的内存和 CPU,不占我们的服务器。我们的服务端只做两件事:
 * 转发模型请求(持 key)+ 记账。所以服务器可以很薄 —— 这是整个架构的成本支点。
 */

export interface AgentDefinition {
  id: string;
  name: string;
  /** 人设 + 话术库。静态、可缓存 —— 放在 cache 断点之前。 */
  staticPrompt: string[];
}

export interface RunRequest {
  runId: string;
  agent: AgentDefinition;
  prompt: string;
  /** 每次都变的上下文(当前账号数据、今日任务)。放在 cache 断点之后。 */
  dynamicContext?: string[];
  model?: string;
}

export type AgentEvent =
  | { type: 'text'; runId: string; text: string }
  | { type: 'tool_call'; runId: string; tool: string; input: unknown }
  | { type: 'tool_result'; runId: string; tool: string; isError: boolean }
  | { type: 'done'; runId: string; usage: UsageReport; turns: number }
  | { type: 'error'; runId: string; message: string };

export interface AgentHostConfig {
  registry: ExecutorRegistry;
  gatewayBaseUrl: string;
  /** 每次运行时重新取 —— token 会刷新,不能在构造时快照下来。 */
  getSessionToken: () => string;
  userDataDir: string;
  defaultModel?: string;
  pathToClaudeCodeExecutable?: string;
}

export class AgentHost {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly config: AgentHostConfig) {}

  /** 取消一次运行(用户点了"停止")。 */
  cancel(runId: string): boolean {
    const ctrl = this.running.get(runId);
    if (!ctrl) return false;
    ctrl.abort();
    this.running.delete(runId);
    return true;
  }

  get activeRuns(): string[] {
    return [...this.running.keys()];
  }

  async *run(req: RunRequest): AsyncGenerator<AgentEvent> {
    const controller = new AbortController();
    this.running.set(req.runId, controller);

    const ctx: ExecutionContext = {
      runId: req.runId,
      agentId: req.agent.id,
      sessionToken: this.config.getSessionToken(),
      userDataDir: this.config.userDataDir,
      signal: controller.signal,
    };

    const { server, toolNames } = buildMcpServer(this.config.registry, () => ctx);

    const options = buildHardenedOptions({
      gatewayBaseUrl: this.config.gatewayBaseUrl,
      sessionToken: ctx.sessionToken,
      model: req.model ?? this.config.defaultModel ?? 'glm-4.6',
      mcpServers: { [MCP_SERVER_NAME]: server },
      toolNames,
      staticSystemPrompt: req.agent.staticPrompt,
      dynamicSystemPrompt: req.dynamicContext ?? [],
      ...(this.config.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.config.pathToClaudeCodeExecutable }
        : {}),
    });

    try {
      for await (const msg of query({ prompt: req.prompt, options })) {
        if (controller.signal.aborted) break;

        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              yield { type: 'text', runId: req.runId, text: block.text };
            } else if (block.type === 'tool_use') {
              yield { type: 'tool_call', runId: req.runId, tool: block.name, input: block.input };
            }
          }
        } else if (msg.type === 'user') {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
                yield {
                  type: 'tool_result',
                  runId: req.runId,
                  tool: String((block as { tool_use_id?: string }).tool_use_id ?? ''),
                  isError: Boolean((block as { is_error?: boolean }).is_error),
                };
              }
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            yield {
              type: 'done',
              runId: req.runId,
              turns: msg.num_turns,
              usage: {
                runId: req.runId,
                agentId: req.agent.id,
                model: options.model ?? 'unknown',
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
                cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
                clientTs: Date.now(),
              },
            };
          } else {
            yield { type: 'error', runId: req.runId, message: `agent 运行失败:${msg.subtype}` };
          }
        }
      }
    } catch (err) {
      yield {
        type: 'error',
        runId: req.runId,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.running.delete(req.runId);
    }
  }
}
