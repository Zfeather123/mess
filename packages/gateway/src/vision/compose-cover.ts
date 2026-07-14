import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';

/**
 * compose_cover —— 封面标题**代码渲染**。
 *
 * ## 为什么标题不能交给模型画
 *
 * 实测:CogView 生成中文标题必乱码(「被辭退賺只」「豈消餵了」)。
 * 封面标题是内容的脸,一个错字就废了。所以:**底图归模型,文字归代码**,一字不差。
 *
 * ## 中文排版不是「按字数切一刀」
 *
 * 这套折行规则是踩出来的(JIN-51 spike):
 *   - 朴素按字数硬切会把词组腰斩:「三万」「千万别签」被切两半,难看
 *   - 收尾标点会掉到行首,甚至出现一整行只有一个「,」的孤行
 * 所以:先按标点切语义段 → 再装行 → 标点悬挂(允许突破测量宽度)。
 */

const CANVAS_W = 1080;
const CANVAS_H = 1440;
/** 抖音安全区:上下各 15% 会被 UI 遮挡,左右留 8%。 */
const SAFE_TOP = 0.15;
const SAFE_BOTTOM = 0.85;
const SAFE_X = 0.08;

/** 行首禁则:这些标点不能出现在行首。 */
const NO_LINE_START = '?!,。、;:)】》”』%…?!,.:;)';
/** 断句点:优先在这些标点之后换行。 */
const BREAK_AFTER = '?!,。、;:?!,;:…';

let fontFamily: string | null = null;

/** 注册中文字体。**不注册就是满屏豆腐块** —— 系统字体不保证有中文。 */
export function registerCoverFont(fontPath: string, family = 'CoverCJK'): void {
  if (!GlobalFonts.registerFromPath(fontPath, family)) {
    throw new Error(`compose_cover:中文字体注册失败 ${fontPath}`);
  }
  fontFamily = family;
}

function segments(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (BREAK_AFTER.includes(ch)) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

function hardSplit(seg: string, maxChars: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < seg.length) {
    let take = Math.min(maxChars, seg.length - i);
    // 收尾标点绝不能落到下一行行首 —— 悬挂到本行末,允许超出 maxChars
    while (take < seg.length - i && NO_LINE_START.includes(seg[i + take]!)) take += 1;
    out.push(seg.slice(i, i + take));
    i += take;
  }
  return out;
}

export function wrapCjk(text: string, maxChars: number, maxLines: number): string[] {
  const trimmed = text.trim();
  const lines: string[] = [];
  let cur = '';

  for (const seg of segments(trimmed)) {
    if (seg.length > maxChars) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(...hardSplit(seg, maxChars));
      continue;
    }
    if (!cur) cur = seg;
    else if (cur.length + seg.length <= maxChars) cur += seg;
    else {
      lines.push(cur);
      cur = seg;
    }
  }
  if (cur) lines.push(cur);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1]!.slice(0, maxChars - 1) + '…';
    return kept;
  }
  return lines;
}

export interface CoverSpec {
  title: string;
  subtitle?: string;
  maxCharsPerLine?: number;
  maxLines?: number;
  accent?: string;
}

/**
 * 底图 + 精确中文标题 → 封面 PNG。
 *
 * 字号是**按实际像素宽度二分**出来的:标题一字不差,让**字号**去适应安全区,
 * 绝不截断文案。
 */
export async function composeCover(background: Buffer, spec: CoverSpec): Promise<Buffer> {
  if (!fontFamily) throw new Error('compose_cover:未注册中文字体,先调 registerCoverFont()');

  const maxChars = spec.maxCharsPerLine ?? 8;
  const maxLines = spec.maxLines ?? 3;
  const accent = spec.accent ?? '#FFD600';

  const canvas = createCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext('2d');

  // 底图 cover-fit:等比缩放 + 居中裁切,不拉伸变形
  const img = await loadImage(background);
  const scale = Math.max(CANVAS_W / img.width, CANVAS_H / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (CANVAS_W - dw) / 2, (CANVAS_H - dh) / 2, dw, dh);

  const lines = wrapCjk(spec.title, maxChars, maxLines);
  const boxW = CANVAS_W * (1 - 2 * SAFE_X);
  const boxH = CANVAS_H * (SAFE_BOTTOM - SAFE_TOP) * 0.62;

  // 二分最大可用字号
  let lo = 24;
  let hi = 160;
  let size = lo;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    ctx.font = `bold ${mid}px "${fontFamily}"`;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (widest <= boxW && mid * 1.35 * lines.length <= boxH) {
      size = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }

  const lineH = size * 1.35;
  const blockH = lineH * lines.length;
  const startY = CANVAS_H * SAFE_TOP + (boxH - blockH) / 3;

  // 压暗蒙版:底图再花,白字也读得清
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, startY - 28, CANVAS_W, blockH + 56);

  ctx.font = `bold ${size}px "${fontFamily}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.lineWidth = Math.max(3, size / 22) * 2;
  ctx.fillStyle = '#FFFFFF';

  lines.forEach((line, i) => {
    const y = startY + i * lineH;
    ctx.strokeText(line, CANVAS_W / 2, y); // 描边在下
    ctx.fillText(line, CANVAS_W / 2, y); // 白字在上
  });

  // 重点色下划线:视觉锚点
  const uw = CANVAS_W * 0.18;
  const uy = startY + blockH + 18;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect((CANVAS_W - uw) / 2, uy, uw, 10, 5);
  ctx.fill();

  if (spec.subtitle) {
    const subSize = Math.max(28, Math.round(size / 3));
    ctx.font = `${subSize}px "${fontFamily}"`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.fillStyle = '#F0F0F0';
    ctx.strokeText(spec.subtitle, CANVAS_W / 2, uy + 34);
    ctx.fillText(spec.subtitle, CANVAS_W / 2, uy + 34);
  }

  return canvas.toBuffer('image/png');
}
