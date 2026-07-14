import type { TokenUsage } from '@xiaojing/billing';
import type { GatewayConfig } from '../config.js';

/**
 * read_image —— 读客户发的截图 / 合同图。
 *
 * ## ⚠️ 为什么这是个「工具」,而不是往消息流里塞 image block
 *
 * 实测(JIN-51,同一张中文劳动合同截图,6 个事实点核对):
 *
 * | 走法                       | 结果                                   |
 * |----------------------------|----------------------------------------|
 * | 原生 OpenAI 端点 + glm-4.6v | **6/6 全读对**(公司名/工号/日期/金额/条款) |
 * | Anthropic 兼容端点          | **0/6** —— 模型答「我不具备识别图像的能力」 |
 *
 * GLM 的 Anthropic 兼容端点**看不到图**。图片走消息流是死路,
 * 所以视觉必须封装成工具,内部绕到原生端点。
 */
export interface ReadImageResult {
  text: string;
  usage: TokenUsage;
}

export async function readImage(
  input: { imageBase64: string; mimeType?: string; question: string },
  config: GatewayConfig,
): Promise<ReadImageResult> {
  const mime = input.mimeType ?? 'image/png';
  const res = await fetch(`${config.glmNativeBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.glmApiKey}`,
    },
    body: JSON.stringify({
      model: config.models.vision,
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${input.imageBase64}` } },
            { type: 'text', text: input.question },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`read_image 上游失败 ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: Record<string, number>;
  };

  const u = json.usage ?? {};
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: {
      // 原生端点是 OpenAI 口径:prompt_tokens / completion_tokens
      inputTokens: u['prompt_tokens'] ?? 0,
      cachedInputTokens: 0,
      outputTokens: u['completion_tokens'] ?? 0,
    },
  };
}
