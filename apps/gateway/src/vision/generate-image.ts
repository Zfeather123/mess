import type { GatewayConfig } from '../config.js';

/**
 * generate_image —— 出**底图**。
 *
 * ## ⚠️ 铁律:只让它出图,绝不让它写字
 *
 * 实测:CogView 画中文标题必乱码(「被辭退賺只」「豈消餵了」)。
 * 所以 prompt 里强制拼上「不要出现任何文字」的约束,标题一律交给 compose_cover 代码渲染。
 */

/** CogView 的尺寸约束(实测报错文案):512–2880px、**16 的整数倍**、总像素 ≤ 2^21。 */
const MIN_SIDE = 512;
const MAX_SIDE = 2880;
const MAX_PIXELS = 2 ** 21;

/**
 * 把任意目标尺寸吸附到 CogView 能接受的尺寸。
 *
 * 我们的封面是 1080×1440,而 **1080 不是 16 的整数倍** —— 直接传会被上游 400 打回
 * (实测:`size的长宽均需满足512px-2880px之间,且为16整数倍`)。所以必须吸附,
 * 不能透传。1080×1440 → 1056×1408(仍是精确 3:4,compose_cover 再 cover-fit 回去)。
 */
export function snapSize(width: number, height: number): { width: number; height: number } {
  const snap = (v: number) => {
    const clamped = Math.min(MAX_SIDE, Math.max(MIN_SIDE, v));
    return Math.max(MIN_SIDE, Math.floor(clamped / 16) * 16);
  };
  let w = snap(width);
  let h = snap(height);

  // 总像素超上限时等比缩,缩完再对齐 16
  if (w * h > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (w * h));
    w = snap(w * k);
    h = snap(h * k);
  }
  return { width: w, height: h };
}

const NO_TEXT = '严格要求:画面中不要出现任何文字、字母、数字、logo、水印。';

export interface GenerateImageResult {
  /** 上游返回的临时 URL(有有效期,调用方需自行落盘/转存)。 */
  url: string;
  size: { width: number; height: number };
}

export async function generateImage(
  input: { prompt: string; width?: number; height?: number },
  config: GatewayConfig,
): Promise<GenerateImageResult> {
  const size = snapSize(input.width ?? 1056, input.height ?? 1408);

  const res = await fetch(`${config.glmNativeBaseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.glmApiKey}`,
    },
    body: JSON.stringify({
      model: config.models.image,
      prompt: `${input.prompt}\n${NO_TEXT}`,
      size: `${size.width}x${size.height}`,
    }),
  });

  if (!res.ok) {
    throw new Error(`generate_image 上游失败 ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: { url?: string }[] };
  const url = json.data?.[0]?.url;
  if (!url) throw new Error('generate_image:上游没返回图片 URL');

  return { url, size };
}
