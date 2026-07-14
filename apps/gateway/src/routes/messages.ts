import type { ServerResponse } from 'node:http';
import { InsufficientCreditsError, type BillingService, type ChargeContext, type Reservation } from '@xiaojing/billing';
import type { Principal } from '../auth.js';
import type { GatewayConfig } from '../config.js';
import { StreamUsageAccumulator, usageFromMessage } from '../usage.js';

/**
 * POST /v1/messages —— Agent SDK 的模型请求走这里。
 *
 * 网关是**薄反向代理 + 计量器**,不是 agent 框架:
 * 工具循环、上下文管理都在客户端内嵌的 Agent SDK 里,我们不碰。
 *
 * 这里只做四件事:
 *   ① 鉴权(sessionToken → 哪个用户/员工)
 *   ② 预留算力(余额不足 → 402,**请求根本不发出去**)
 *   ③ 注入 GLM key 转发(客户端永远拿不到 key)
 *   ④ 从响应的 usage 读真实 token → 结算
 *
 * ⚠️ 请求体**原样透传**,不要「优化」它 —— 尤其不要动 `cache_control` 断点:
 * 动了就等于把用户的 prompt caching 打没了(实测省 97%)。
 */
export async function handleMessages(
  body: Record<string, unknown>,
  principal: Principal,
  res: ServerResponse,
  deps: { config: GatewayConfig; billing: BillingService; requestId: string },
): Promise<void> {
  const { config, billing, requestId } = deps;
  const model = typeof body['model'] === 'string' ? body['model'] : 'glm-4.6';
  const ctx: ChargeContext = {
    accountId: principal.accountId,
    agentId: principal.agentId,
    issueId: principal.issueId,
    model,
    requestId,
  };

  // ② 余额不足在这里就拦死 —— 上游一个 token 都不会被花掉
  let hold: Reservation;
  try {
    hold = await billing.reserveForRequest(ctx, body as { max_tokens?: number });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'insufficient_credits', message: err.message },
        }),
      );
      return;
    }
    throw err;
  }

  try {
    // ③ 注入 GLM key。客户端的头一概不透传。
    const upstream = await fetch(`${config.anthropicBaseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      await billing.releaseOnFailure(hold); // 上游报错,用户不该付钱
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(text);
      return;
    }

    const isStream = body['stream'] === true;

    if (!isStream) {
      const json = (await upstream.json()) as Record<string, unknown>;
      await billing.settleFromUsage(hold, ctx, usageFromMessage(json));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
      return;
    }

    // 流式:边转发边抠 usage。不能等流完再读 —— 客户端要实时看到字。
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const acc = new StreamUsageAccumulator();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        acc.push(chunk);
        res.write(chunk); // 原样透传给客户端
      }
      acc.flush();
    } finally {
      reader.releaseLock();
    }

    res.end();
    // 流已经发完,钱必须照结 —— 哪怕客户端中途断开,token 也已经花出去了
    await billing.settleFromUsage(hold, ctx, acc.usage);
  } catch (err) {
    await billing.releaseOnFailure(hold);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: String(err) } }));
    } else {
      res.end();
    }
  }
}
