import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 我们的模型网关的测试替身。
 *
 * 它扮演的角色和生产环境的网关一模一样:对外说 Anthropic Messages 协议,
 * 校验客户端送来的 sessionToken,然后(生产里)换成真 key 转发给 GLM。
 * 测试里我们不转发,直接编一个 tool_use 回去,这样就能在没有任何模型 key 的
 * 情况下,把完整的 agent loop 跑通。
 *
 * 它同时是一个**断言点**:记录每一次上游请求里到底带了多少个工具定义、
 * 带的是什么凭证 —— 这正是我们要证明的两件事。
 */

export interface CapturedRequest {
  toolNames: string[];
  apiKey: string | undefined;
  hasToolResult: boolean;
  systemBlocks: number;
}

export interface MockGateway {
  url: string;
  requests: CapturedRequest[];
  /** 真正的 agent 轮次(排除掉 SDK 的辅助调用 —— 那些不带工具)。 */
  agentTurns: CapturedRequest[];
  close(): Promise<void>;
}

/** 回复内容由测试指定:第一轮调工具,拿到 tool_result 后收尾。 */
export async function startMockGateway(opts: {
  toolToCall: string;
  toolInput: Record<string, unknown>;
  finalText: string;
}): Promise<MockGateway> {
  const requests: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!req.url?.includes('/v1/messages')) {
        res.writeHead(404).end();
        return;
      }

      const payload = JSON.parse(body || '{}') as {
        tools?: Array<{ name: string }>;
        messages?: unknown;
        system?: unknown;
      };
      const toolNames = (payload.tools ?? []).map((t) => t.name);
      const hasToolResult = JSON.stringify(payload.messages ?? []).includes('tool_result');

      requests.push({
        toolNames,
        apiKey: req.headers['x-api-key'] as string | undefined,
        hasToolResult,
        systemBlocks: Array.isArray(payload.system) ? payload.system.length : 0,
      });

      const target = toolNames.find((n) => n.endsWith(opts.toolToCall));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

      const sse = (type: string, data: Record<string, unknown>) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

      sse('message_start', {
        message: {
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: 'glm-4.6',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1223, output_tokens: 1, cache_read_input_tokens: 0 },
        },
      });

      if (target && !hasToolResult) {
        sse('content_block_start', {
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_mock_1', name: target, input: {} },
        });
        sse('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(opts.toolInput) },
        });
        sse('content_block_stop', { index: 0 });
        sse('message_delta', {
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 20 },
        });
      } else {
        sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: opts.finalText } });
        sse('content_block_stop', { index: 0 });
        sse('message_delta', {
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 20 },
        });
      }
      sse('message_stop', {});
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get agentTurns() {
      return requests.filter((r) => r.toolNames.length > 0);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
