import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExecutorRegistry, ok } from '@xiaojing/executor';
import type { Capability, Executor, ToolCall } from '@xiaojing/executor';
import { AgentHost } from '../src/host.js';
import type { AgentEvent } from '../src/host.js';
import { startMockGateway } from './mock-gateway.js';

/**
 * JIN-58 验收证据。这个测试同时证明四件事:
 *
 *   1. agent loop 在本地进程里跑通了一次**完整的工具调用**
 *      (tool_use → 工具在本进程执行 → tool_result → 模型收尾)
 *   2. 客户端**不持有模型 key** —— 上送给网关的是 sessionToken
 *   3. 工具定义被裁到只剩我们注册的那些(不加固时是 53 个)
 *   4. 没有执行器的能力域(local.browser)不会出现在模型的工具定义里
 *
 * 跑法:pnpm --filter @xiaojing/agent-runtime test
 */

const SESSION_TOKEN = 'xj_session_token_NOT_a_model_key';

/** 假的云端数据执行器 —— 记录自己是否真的在本进程被执行过。 */
class SpyDataExecutor implements Executor {
  readonly id = 'spy-data';
  readonly capabilities: readonly Capability[] = ['cloud.data'];
  ranInPid: number | null = null;
  receivedInput: unknown = null;

  async execute(call: ToolCall) {
    this.ranInPid = process.pid;
    this.receivedInput = call.input;
    return ok(JSON.stringify({ followers: 12800, new_followers_yesterday: 340 }));
  }
}

describe('本地 agent loop(内嵌 Agent SDK)', () => {
  it('完成一次完整的工具调用,且客户端不持有模型 key', async () => {
    const gateway = await startMockGateway({
      toolToCall: 'douyin_stats',
      toolInput: { account: 'lawyer_zhang' },
      finalText: '已拿到数据:粉丝 12800,昨日涨粉 340。',
    });

    const spy = new SpyDataExecutor();
    const registry = new ExecutorRegistry()
      .registerExecutor(spy)
      .registerTool({
        name: 'douyin_stats',
        description: '查询抖音账号数据',
        capability: 'cloud.data',
        // schema 不是装饰:MCP 层按它校验并**剥掉**未声明的字段。
        // 这里漏掉 account,模型传的 account 就会被静默丢弃,工具收到空对象。
        schema: { account: z.string().describe('抖音账号 ID') },
      })
      // 这个工具的能力域(local.browser)在 MVP 里**没有**执行器 ——
      // 断言它不会被上送给模型。第二期注册 PlaywrightExecutor 后它才该出现。
      .registerTool({
        name: 'douyin_reply_dm',
        description: '【第二期】自动回复抖音私信',
        capability: 'local.browser',
        schema: {},
      });

    const host = new AgentHost({
      registry,
      gatewayBaseUrl: gateway.url,
      getSessionToken: () => SESSION_TOKEN,
      userDataDir: '/tmp/xiaojing-test',
      defaultModel: 'glm-4.6',
    });

    const events: AgentEvent[] = [];
    for await (const e of host.run({
      runId: 'run_test_1',
      agent: {
        id: 'account-doctor',
        name: '账号诊断师',
        staticPrompt: ['你是小镜的账号诊断师。', '【话术库】...(静态、可缓存)'],
      },
      dynamicContext: ['当前账号:lawyer_zhang'],
      prompt: '查一下 lawyer_zhang 的抖音数据',
    })) {
      events.push(e);
    }

    await gateway.close();

    // ── 1. 完整的工具调用回路
    const toolCall = events.find((e) => e.type === 'tool_call');
    const toolResult = events.find((e) => e.type === 'tool_result');
    const done = events.find((e) => e.type === 'done');
    const errors = events.filter((e) => e.type === 'error');

    expect(errors, `agent 报错:${JSON.stringify(errors)}`).toHaveLength(0);
    expect(toolCall, ' 模型应发起 tool_use').toBeDefined();
    expect(toolCall).toMatchObject({ tool: 'mcp__xiaojing__douyin_stats' });
    expect(toolResult, '工具结果应回传给模型').toBeDefined();
    expect(done, 'agent loop 应正常收尾').toBeDefined();

    // ── 工具确实在**本进程**执行(不是服务端、不是子进程)
    expect(spy.ranInPid, '工具应在本地 Node 进程内执行').toBe(process.pid);
    expect(spy.receivedInput).toEqual({ account: 'lawyer_zhang' });

    // ── 模型最终基于工具结果作答
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    expect(text).toContain('12800');

    // ── 2. 客户端不持有模型 key:网关收到的是 sessionToken
    expect(gateway.requests.length).toBeGreaterThan(0);
    for (const r of gateway.requests) {
      expect(r.apiKey).toBe(SESSION_TOKEN);
      expect(r.apiKey).not.toMatch(/^sk-/); // 不是 Anthropic/GLM 的真 key 格式
    }

    // ── 3 & 4. 工具定义被裁剪:只有 douyin_stats,没有内置工具、没有 local.browser
    for (const turn of gateway.agentTurns) {
      expect(turn.toolNames).toEqual(['mcp__xiaojing__douyin_stats']);
      expect(turn.toolNames).not.toContain('Bash');
      expect(turn.toolNames.some((n) => n.includes('douyin_reply_dm'))).toBe(false);
    }

    // ── 算力上报数据齐全(服务端据此计费:1M token = 5 元)
    if (done?.type === 'done') {
      expect(done.usage.runId).toBe('run_test_1');
      expect(done.usage.agentId).toBe('account-doctor');
      expect(done.usage.inputTokens).toBeGreaterThan(0);
    }
  }, 180_000);
});
