import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingService, InMemoryCreditLedger } from '@jin/billing';
import { InMemorySessionResolver } from '../src/auth.js';
import type { GatewayConfig } from '../src/config.js';
import { createGateway } from '../src/server.js';

/** 假上游:代替 GLM,让我们能在没有网络的情况下断言网关行为。 */
let upstream: Server;
let upstreamUrl: string;
/** 上游收到的 headers —— 用来断言「客户端 token 没被透传出去」。 */
let seenAuth: string | undefined;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seenAuth = req.headers['x-api-key'] as string | undefined;
    const isStream = req.url?.includes('stream');
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { stream?: boolean };

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":3328,"output_tokens":1}}}\n\n',
        );
        res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500}}\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 120, cache_read_input_tokens: 3328, output_tokens: 50 },
        }),
      );
    })();
    void isStream;
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const addr = upstream.address() as { port: number };
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  upstream.close();
});

function makeConfig(): GatewayConfig {
  return {
    port: 0,
    // 这一组用例只验网关行为(鉴权 / 转发 / 计量),账本用内存版 —— 落库的行为
    // (重启存活、崩溃回收、幂等)在 pg-billing.test.ts 里对着真 Postgres 验。
    databaseUrl: 'postgres://unused',
    anthropicBaseUrl: upstreamUrl,
    anthropicApiKey: 'SERVER-SIDE-GLM-KEY',
    glmNativeBaseUrl: upstreamUrl,
    glmApiKey: 'SERVER-SIDE-GLM-KEY',
    models: { vision: 'glm-4.6v', image: 'cogview-4' },
    coverFontPath: '/nonexistent',
  };
}

async function startGateway(balance: number) {
  const ledger = new InMemoryCreditLedger({ 'acct-1': balance });
  const billing = new BillingService(ledger);
  const sessions = new InMemorySessionResolver({
    'session-abc': { accountId: 'acct-1', agentId: 'agent-wenan', issueId: 'issue-7' },
  });
  const server = createGateway({ config: makeConfig(), billing, sessions });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, ledger, server };
}

describe('网关 = 鉴权 + 计量的薄反向代理', () => {
  it('无效 session token → 401,不转发', async () => {
    const { url, server } = await startGateway(100_000);
    const res = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'bogus', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4.6', max_tokens: 100 }),
    });
    expect(res.status).toBe(401);
    server.close();
  });

  it('余额不足 → 402,且请求根本没发给上游', async () => {
    const { url, server } = await startGateway(1); // 1 点,不够
    seenAuth = undefined;

    const res = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'session-abc', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4.6', max_tokens: 4096 }),
    });

    expect(res.status).toBe(402);
    expect((await res.json()).error.type).toBe('insufficient_credits');
    expect(seenAuth).toBeUndefined(); // ← 上游一个 token 都没被花掉
    server.close();
  });

  it('非流式:按真实 usage 扣费 + 落用量明细', async () => {
    const { url, ledger, server } = await startGateway(100_000);

    const res = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'session-abc', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4.6', max_tokens: 1024 }),
    });
    expect(res.status).toBe(200);

    const events = await ledger.listCostEvents('acct-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.usage).toEqual({ inputTokens: 120, cachedInputTokens: 3328, outputTokens: 50 });
    expect(events[0]!.agentId).toBe('agent-wenan'); // 哪个员工
    expect(events[0]!.issueId).toBe('issue-7'); // 哪个任务
    expect(await ledger.balance('acct-1')).toBe(100_000 - events[0]!.points);
    server.close();
  });

  it('流式:usage 从 SSE 里抠出来,output 取 message_delta 的最终值', async () => {
    const { url, ledger, server } = await startGateway(100_000);

    const res = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'session-abc', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4.6', max_tokens: 1024, stream: true }),
    });
    await res.text(); // 把流读完

    const events = await ledger.listCostEvents('acct-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.usage.outputTokens).toBe(500); // 不是 message_start 里的占位值 1
    expect(events[0]!.usage.cachedInputTokens).toBe(3328);
    server.close();
  });

  it('客户端的 session token 绝不透传给上游 —— 上游只看到服务端的 GLM key', async () => {
    const { url, server } = await startGateway(100_000);
    seenAuth = undefined;

    await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'session-abc', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4.6', max_tokens: 100 }),
    });

    expect(seenAuth).toBe('SERVER-SIDE-GLM-KEY');
    expect(seenAuth).not.toBe('session-abc'); // 泄露用户 token = 事故
    server.close();
  });

  it('同一 x-request-id 重试不重复扣费(幂等)', async () => {
    const { url, ledger, server } = await startGateway(100_000);
    const send = () =>
      fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': 'session-abc',
          'content-type': 'application/json',
          'x-request-id': 'retry-me',
        },
        body: JSON.stringify({ model: 'glm-4.6', max_tokens: 1024 }),
      });

    await send();
    const after1 = await ledger.balance('acct-1');
    await send(); // 客户端重试
    expect(await ledger.balance('acct-1')).toBe(after1); // 没被扣第二次
    server.close();
  });
});
