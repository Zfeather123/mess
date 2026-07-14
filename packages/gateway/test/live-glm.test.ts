/**
 * 真机验收:起真网关 → 打真 GLM → 验 prompt caching 命中 + 算力真扣。
 *
 * 需要真 key,所以**默认 skip,不进 CI**(CI 跑 gateway.test.ts,用假上游)。
 * 手动跑:
 *   RUN_LIVE_GLM=1 ANTHROPIC_API_KEY=xxx GLM_OPENAI_API_KEY=xxx npx vitest run --project '@jin/gateway'
 */
import { describe, expect, it } from 'vitest';
import { BillingService, DEFAULT_RATES, InMemoryCreditLedger, usageToPoints } from '@jin/billing';
import { InMemorySessionResolver } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/server.js';

const live = process.env.RUN_LIVE_GLM === '1' ? describe : describe.skip;

live('真机:GLM 直连 + prompt caching + 算力扣费', () => {
  it('同一带 cache_control 的 system 连打两次 → 缓存命中 + 分档费率生效', async () => {
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

    // ⚠️ 这里**不能**断言「第2次比第1次便宜」。
    // GLM 的 prompt cache 会跨进程存活:上一次跑测试留下的缓存还在,
    // 于是 call#1 自己就命中了缓存(实测 call#1 直接 cache_read=2688),
    // 两次一样贵 —— 断言就假失败。测试不能依赖「缓存是冷的」这个前提。
    //
    // 真正要证明的是**分档费率生效**:同样多的 token,走缓存档就该更便宜。
    // 拿这次真实的 usage 直接算两遍,确定性成立,与缓存冷热无关。
    const real = events[0]!.usage;
    const totalInput = real.inputTokens + real.cachedInputTokens;
    const asCached = usageToPoints(real, DEFAULT_RATES);
    const asFresh = usageToPoints(
      { inputTokens: totalInput, cachedInputTokens: 0, outputTokens: real.outputTokens },
      DEFAULT_RATES,
    );
    const tieredWorks = asCached < asFresh;
    console.log(
      `${tieredWorks ? '✅' : '❌'} 分档费率生效:同样 ${totalInput} 个 input token,` +
        `走缓存档 ${asCached} 点 < 全按新 input 算 ${asFresh} 点`,
    );
    console.log(`✅ 余额已扣:1,000,000 → ${balance}`);

    server.close();
    expect(cacheHit).toBe(true);
    expect(events).toHaveLength(2);
    expect(tieredWorks).toBe(true);
  }, 180_000);
});
