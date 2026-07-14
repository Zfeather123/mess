import type { ServerResponse } from 'node:http';
import { InsufficientCreditsError, type BillingService, type ChargeContext, type Reservation } from '@jin/billing';
import type { Principal } from '../auth.js';
import type { GatewayConfig } from '../config.js';
import { composeCover } from '../vision/compose-cover.js';
import { generateImage } from '../vision/generate-image.js';
import { readImage } from '../vision/read-image.js';

/**
 * /vision/* —— 三个视觉工具。
 *
 * 客户端的 Agent SDK 把它们注册成 MCP 工具;工具内部走 **GLM 原生 OpenAI 端点**
 * (Anthropic 兼容端点看不到图,实测 0/6)。
 *
 * 计费口径:
 *   - read_image  → 按上游返回的 token 用量走点数(和文字一样)
 *   - generate_image → 按张计费(出图不是 token 计价),`VISION_POINTS_PER_IMAGE` 配置项
 *   - compose_cover → **纯本地渲染,不调模型,不计费**
 */
function pointsPerImage(): number {
  const v = Number(process.env.VISION_POINTS_PER_IMAGE ?? 20);
  return Number.isFinite(v) && v >= 0 ? v : 20;
}

export async function handleVision(
  tool: string,
  body: Record<string, unknown>,
  principal: Principal,
  res: ServerResponse,
  deps: { config: GatewayConfig; billing: BillingService; requestId: string },
): Promise<void> {
  const { config, billing, requestId } = deps;

  // compose_cover 不调模型 —— 纯代码渲染,直接干活,不碰账本
  if (tool === 'compose_cover') {
    const bg = Buffer.from(String(body['backgroundBase64'] ?? ''), 'base64');
    if (bg.length === 0) return bad(res, 'compose_cover 需要 backgroundBase64');
    const title = String(body['title'] ?? '');
    if (!title) return bad(res, 'compose_cover 需要 title');

    const png = await composeCover(bg, {
      title,
      subtitle: body['subtitle'] ? String(body['subtitle']) : undefined,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ imageBase64: png.toString('base64') }));
    return;
  }

  const ctx: ChargeContext = {
    accountId: principal.accountId,
    agentId: principal.agentId,
    issueId: principal.issueId,
    model: tool === 'read_image' ? config.models.vision : config.models.image,
    requestId,
  };

  let hold: Reservation;
  try {
    // 出图按张预留;读图按 token 上界预留
    hold =
      tool === 'generate_image'
        ? await billing.reserveFixed(ctx, pointsPerImage())
        : await billing.reserveForRequest(ctx, { max_tokens: 1500 });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'insufficient_credits', message: err.message } }));
      return;
    }
    throw err;
  }

  try {
    if (tool === 'read_image') {
      const out = await readImage(
        {
          imageBase64: String(body['imageBase64'] ?? ''),
          mimeType: body['mimeType'] ? String(body['mimeType']) : undefined,
          question: String(body['question'] ?? '逐字读出这张图里的文字内容。只读图上真实存在的字。'),
        },
        config,
      );
      await billing.settleFromUsage(hold, ctx, out.usage);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: out.text, usage: out.usage }));
      return;
    }

    if (tool === 'generate_image') {
      const out = await generateImage(
        {
          prompt: String(body['prompt'] ?? ''),
          width: body['width'] ? Number(body['width']) : undefined,
          height: body['height'] ? Number(body['height']) : undefined,
        },
        config,
      );
      // 按张计费:用量明细里 token 记 0,点数记固定值
      await billing.settleFixed(hold, ctx, pointsPerImage());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    await billing.releaseOnFailure(hold);
    bad(res, `未知的视觉工具:${tool}`, 404);
  } catch (err) {
    await billing.releaseOnFailure(hold);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'upstream_error', message: String(err) } }));
  }
}

function bad(res: ServerResponse, message: string, status = 400): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'bad_request', message } }));
}
