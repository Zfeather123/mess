import { describe, expect, it } from 'vitest';
import { StreamUsageAccumulator, usageFromMessage } from '../src/usage.js';
import { snapSize } from '../src/vision/generate-image.js';
import { wrapCjk } from '../src/vision/compose-cover.js';

describe('usage 提取(读漏 = 白送算力)', () => {
  it('非流式:直接读 usage', () => {
    expect(
      usageFromMessage({ usage: { input_tokens: 120, cache_read_input_tokens: 3328, output_tokens: 13 } }),
    ).toEqual({ inputTokens: 120, cachedInputTokens: 3328, outputTokens: 13 });
  });

  it('流式:output 以 message_delta 为准覆盖,不能只读 message_start', () => {
    const acc = new StreamUsageAccumulator();
    // message_start 里的 output_tokens 是占位初值(1),真实值在 message_delta(842)
    acc.push('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":3328,"output_tokens":1}}}\n\n');
    acc.push('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
    acc.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":842}}\n\n');
    acc.flush();

    expect(acc.usage).toEqual({ inputTokens: 120, cachedInputTokens: 3328, outputTokens: 842 });
  });

  it('流式:SSE 分片可能在任意字节处断开,不能丢事件', () => {
    const acc = new StreamUsageAccumulator();
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":0,"output_tokens":1}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":777}}\n\n';
    // 逐字节喂进去,模拟最恶劣的切包
    for (const ch of sse) acc.push(ch);
    acc.flush();

    expect(acc.usage.outputTokens).toBe(777);
    expect(acc.usage.inputTokens).toBe(50);
  });

  it('坏 JSON 不能把计费带崩', () => {
    const acc = new StreamUsageAccumulator();
    acc.push('data: {不是合法JSON\n\n');
    acc.push('data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n');
    acc.flush();
    expect(acc.usage.outputTokens).toBe(5);
  });
});

describe('CogView 尺寸吸附', () => {
  it('1080 不是 16 的整数倍 —— 必须吸附,否则上游 400', () => {
    // 实测报错:size的长宽均需满足512px-2880px之间,且为16整数倍
    expect(1080 % 16).not.toBe(0);
    const s = snapSize(1080, 1440);
    expect(s.width % 16).toBe(0);
    expect(s.height % 16).toBe(0);
    expect(s).toEqual({ width: 1072, height: 1440 });
  });

  it('总像素不超 2^21', () => {
    const s = snapSize(2880, 2880);
    expect(s.width * s.height).toBeLessThanOrEqual(2 ** 21);
    expect(s.width % 16).toBe(0);
  });

  it('小于下限的尺寸抬到 512', () => {
    const s = snapSize(100, 100);
    expect(s.width).toBeGreaterThanOrEqual(512);
  });
});

describe('中文折行(封面的脸,错一个字就废了)', () => {
  it('不腰斩词组:在标点处断句', () => {
    expect(wrapCjk('被辞退还倒赔公司三万?这三个字千万别签', 8, 3)).toEqual([
      '被辞退还倒赔公司',
      '三万?',
      '这三个字千万别签',
    ]);
  });

  it('标点悬挂:不能出现只有一个「,」的孤行', () => {
    const lines = wrapCjk('公司让你自愿离职,签字前先看这一条', 8, 3);
    for (const line of lines) {
      expect(line.replace(/[?!,。、;:)】》”』%…?!,.:;)]/g, '').length).toBeGreaterThan(0);
    }
  });

  it('折行无损:每个字都在,一个不少', () => {
    const title = '劳动合同里这5个坑,90%的人都踩过';
    expect(wrapCjk(title, 10, 4).join('')).toBe(title);
  });

  it('行首禁则:收尾标点不落行首', () => {
    const lines = wrapCjk('试用期被辞退,能拿到赔偿吗?', 7, 3);
    for (const line of lines.slice(1)) {
      expect('?!,。、;:'.includes(line[0]!)).toBe(false);
    }
  });
});
