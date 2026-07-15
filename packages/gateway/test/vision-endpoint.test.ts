import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayConfig } from '../src/config.js';
import { generateImage } from '../src/vision/generate-image.js';
import { readImage } from '../src/vision/read-image.js';

/**
 * 回归门禁:视觉工具**必须**打到 GLM 原生 OpenAI 端点,绝不能打到 Anthropic 兼容端点。
 *
 * ## 为什么这个测试非有不可
 *
 * 实测(JIN-51,同一张中文合同截图,6 个事实点):
 *   - 原生端点 + glm-4.6v → 6/6 全读对
 *   - Anthropic 兼容端点  → 0/6,**而且不报错** —— 图被静默丢弃,模型照样一本正经地编
 *
 * 「静默」是这个坑的要害:走错端点不会 500、不会抛异常、没有任何红灯,
 * 只会让 AI 员工开始瞎编客户合同的内容。线上根本发现不了。
 *
 * 真机验收在 live-vision.test.ts,但它需要真 key、**默认 skip、不进 CI** ——
 * 也就是说在这个文件之前,「视觉走哪个端点」在 CI 里是零覆盖的:
 * 谁把 glmNativeBaseUrl 改成 anthropicBaseUrl,流水线全绿。
 *
 * 所以这里用假上游把端点选择钉死:不需要真 key,可以每次 PR 都跑。
 */

/** 假的 GLM 原生端点。 */
let native: Server;
let nativeUrl: string;
/** 假的 Anthropic 兼容端点 —— 它**一次都不该被碰到**。 */
let anthropic: Server;
let anthropicUrl: string;

let nativeHits: string[] = [];
let anthropicHits: string[] = [];
/** 记下 generate_image 实际送出去的 prompt,用来断言「别让 CogView 写字」。 */
let lastImagePrompt = '';

beforeAll(async () => {
  native = createServer((req, res) => {
    nativeHits.push(req.url ?? '');
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { prompt?: string };

      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes('/images/generations')) {
        lastImagePrompt = body.prompt ?? '';
        res.end(JSON.stringify({ data: [{ url: 'https://example.invalid/bg.png' }] }));
      } else {
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '甲方:某某律师事务所;工号:00123' } }],
            usage: { prompt_tokens: 900, completion_tokens: 40 },
          }),
        );
      }
    })();
  });
  await new Promise<void>((r) => native.listen(0, r));
  nativeUrl = `http://127.0.0.1:${(native.address() as { port: number }).port}`;

  anthropic = createServer((req, res) => {
    anthropicHits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: '我不具备识别图像的能力' }] }));
  });
  await new Promise<void>((r) => anthropic.listen(0, r));
  anthropicUrl = `http://127.0.0.1:${(anthropic.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => native.close(() => r()));
  await new Promise<void>((r) => anthropic.close(() => r()));
});

function config(): GatewayConfig {
  return {
    port: 0,
    databaseUrl: 'postgres://unused',
    anthropicBaseUrl: anthropicUrl,
    anthropicApiKey: 'anthropic-key',
    glmNativeBaseUrl: nativeUrl,
    glmApiKey: 'glm-native-key',
    models: { vision: 'glm-4.6v', image: 'cogview-4' },
    coverFontPath: '/unused/in/this/test',
  };
}

describe('视觉工具的端点选择(JIN-57 回归门禁)', () => {
  it('read_image 打原生端点的 /chat/completions,且完全不碰 Anthropic 端点', async () => {
    nativeHits = [];
    anthropicHits = [];

    const out = await readImage(
      { imageBase64: 'ZmFrZQ==', question: '甲方是谁?工号多少?' },
      config(),
    );

    expect(nativeHits).toEqual(['/chat/completions']);
    // 这一条是整个用例的核心:Anthropic 端点会静默吃掉图片然后瞎编,一次都不许打。
    expect(anthropicHits).toEqual([]);
    expect(out.text).toContain('00123');
    // 原生端点是 OpenAI 口径,usage 得按 prompt/completion_tokens 解析,别读成 0。
    expect(out.usage.inputTokens).toBe(900);
    expect(out.usage.outputTokens).toBe(40);
  });

  it('read_image 把图片作为 image_url 送出(不是塞进 text)', async () => {
    nativeHits = [];
    let sent: any;
    const probe = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        sent = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }));
      })();
    });
    await new Promise<void>((r) => probe.listen(0, r));
    const url = `http://127.0.0.1:${(probe.address() as { port: number }).port}`;

    await readImage({ imageBase64: 'ZmFrZQ==', question: '读一下' }, { ...config(), glmNativeBaseUrl: url });
    await new Promise<void>((r) => probe.close(() => r()));

    const parts = sent.messages[0].content;
    const img = parts.find((p: any) => p.type === 'image_url');
    expect(img).toBeTruthy();
    expect(img.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(sent.model).toBe('glm-4.6v');
  });

  it('generate_image 打原生端点,且明确要求 CogView 不要写字(中文必乱码)', async () => {
    nativeHits = [];
    anthropicHits = [];

    await generateImage({ prompt: '律所办公室,暖色调,空镜' }, config());

    expect(nativeHits).toEqual(['/images/generations']);
    expect(anthropicHits).toEqual([]);
    // CogView 画中文标题必乱码(「被辭退賺只」),所以底图必须显式禁止出现文字;
    // 标题一律交给 compose_cover 代码渲染。这条禁令掉了,封面就会开始出乱码。
    expect(lastImagePrompt).toContain('不要出现任何文字');
  });
});
