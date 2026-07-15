import { existsSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { composeCover, registerCoverFont } from '../src/vision/compose-cover.js';

/**
 * compose_cover 中文渲染冒烟(JIN-87)。
 *
 * 守的是那条 P1 上线阻断链:字体真装进镜像 → `registerCoverFont()` 不 throw →
 * `composeCover()` 用真字体渲出一张 1080×1440 的中文封面 PNG。
 * 字体缺失 / 路径写错时,`registerCoverFont()` 拿到 falsy 会 throw —— 这个用例立刻红,
 * 而不是等到生产里网关**启动即崩**才发现。
 *
 * 字体路径从 `JIN_COVER_FONT_PATH` 取(CI 的 cover_smoke job 装了 fonts-noto-cjk 并设了它,
 * 与生产镜像同款);本机没装 CJK 字体时整组跳过 —— 真正的门禁在 CI + 镜像里。
 */
function resolveFontPath(): string | null {
  const candidates = [
    process.env.JIN_COVER_FONT_PATH?.trim(),
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** 造一张纯色底图,免得冒烟依赖外部素材文件。 */
function solidBackgroundPng(): Buffer {
  const canvas = createCanvas(1080, 1440);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#334155';
  ctx.fillRect(0, 0, 1080, 1440);
  return canvas.toBuffer('image/png');
}

const fontPath = resolveFontPath();

describe('compose_cover 渲染冒烟(需真中文字体)', () => {
  it.skipIf(!fontPath)('注册字体不 throw + 渲出 1080×1440 的中文封面 PNG', async () => {
    // registerCoverFont 内部:注册失败(falsy)直接 throw —— 这一步就是网关启动崩溃的根因所在
    expect(() => registerCoverFont(fontPath!)).not.toThrow();

    const png = await composeCover(solidBackgroundPng(), {
      title: '被辞退还倒赔三万,千万别签',
      subtitle: '封面标题 · 中文渲染冒烟',
    });

    // PNG 魔数 —— 确实是张图,不是错误字符串
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // 尺寸正确 = 真渲染出来了
    const img = await loadImage(png);
    expect(img.width).toBe(1080);
    expect(img.height).toBe(1440);
    // 有实际内容(底图 + 标题 + 蒙版),不是几百字节的空图
    expect(png.byteLength).toBeGreaterThan(5_000);
  });
});
