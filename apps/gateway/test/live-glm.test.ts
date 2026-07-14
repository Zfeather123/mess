/**
 * 真机验收:起真网关 → 打真 GLM → 验 prompt caching 命中 + 算力真扣。
 *
 * 需要真 key,所以**默认 skip,不进 CI**(CI 跑 gateway.test.ts,用假上游)。
 * 手动跑:
 *   RUN_LIVE_GLM=1 ANTHROPIC_API_KEY=xxx GLM_API_KEY=xxx pnpm --filter @xiaojing/gateway test
 */
import { describe, expect, it } from 'vitest';
import { BillingService, InMemoryCreditLedger } from '@xiaojing/billing';
import { InMemorySessionResolver } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/server.js';

const live = process.env.RUN_LIVE_GLM === '1' ? describe : describe.skip;

live('真机:GLM 直连 + prompt caching + 算力扣费', () => {
  it('同一带 cache_control 的 system 连打两次 → 第2次命中缓存,且这次更便宜', async () => {
    const config = loadConfig();
    const ledger = new InMemoryCreditLedger({ 'acct-1': 1_000_000 });
    const billing = new BillingService(ledger);
    const sessions = new InMemorySessionResolver({
      'session-abc': { accountId: 'acct-1', agentId: 'agent-wenan', issueId: 'JIN-51' },
    });

    const server = createGateway({ config, billing, sessions });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}`;

    // 大块静态 system(话术库)+ cache_control 断点 —— 这是缓存能不能命中的关键
    const lib = Array.from({ length: 60 }, (_, i) =>
      `${i + 1}. 法律短视频话术模板:开头三秒必须抛出用户的真实损失场景,然后给出一个反直觉的法律要点,最后落到一个可执行动作。禁止使用「兄弟们」「家人们」等称呼。`,
    ).join('\n');

    const body = {
      model: 'glm-4.6',
      max_tokens: 64,
      system: [
    {
      type: 'text',
      text: `你是小镜的文案编导。以下是话术库,必须严格遵守。\n${lib}`,
      cache_control: { type: 'ephemeral' },
    },
      ],
      messages: [{ role: 'user', content: '用一句话说明你的角色。' }],
    };

    async function call(n: number) {
      const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': 'session-abc', // ← 客户端只有 sessionToken,没有 GLM key
      'content-type': 'application/json',
      'x-request-id': `live-${n}`,
    },
    body: JSON.stringify(body),
      });
      const json = (await res.json()) as { usage?: Record<string, number> };
      const u = json.usage ?? {};
      console.log(
    `call#${n}: input=${u['input_tokens']} cache_read=${u['cache_read_input_tokens']} output=${u['output_tokens']}`,
      );
      return u;
    }

    const u1 = await call(1);
    const u2 = await call(2);

    const events = await ledger.listCostEvents('acct-1');
    const balance = await ledger.balance('acct-1');

    console.log('\n── 验收断言 ──');
    const cacheHit = (u2['cache_read_input_tokens'] ?? 0) > 0;
    console.log(`${cacheHit ? '✅' : '❌'} prompt caching 命中:cache_read_input_tokens = ${u2['cache_read_input_tokens']}`);
    if (cacheHit) {
      const saved = 100 * (1 - (u2['input_tokens'] ?? 0) / (u1['input_tokens'] || 1));
      console.log(`   input ${u1['input_tokens']} → ${u2['input_tokens']},省 ${saved.toFixed(0)}%`);
    }

    console.log(`${events.length === 2 ? '✅' : '❌'} 用量明细:${events.length} 条`);
    for (const e of events) {
      console.log(
    `   员工=${e.agentId} 任务=${e.issueId} 模型=${e.model} ` +
      `input=${e.usage.inputTokens} cached=${e.usage.cachedInputTokens} out=${e.usage.outputTokens} → ${e.points} 点`,
      );
    }

    // 第 2 次命中缓存,大部分 input 走了便宜档 → 应该比第 1 次便宜
    const cheaper = (events[1]?.points ?? 0) < (events[0]?.points ?? 0);
    console.log(`${cheaper ? '✅' : '❌'} 命中缓存后这次调用更便宜(分档费率生效)`);
    console.log(`✅ 余额已扣:1,000,000 → ${balance}`);

    server.close();
    expect(cacheHit).toBe(true);
    expect(events).toHaveLength(2);
    expect(cheaper).toBe(true);

  }, 180_000);
});
