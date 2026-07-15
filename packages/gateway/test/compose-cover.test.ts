import { describe, expect, it } from 'vitest';
import { wrapCjk } from '../src/vision/compose-cover.js';

/**
 * 回归门禁:封面标题**一字不差**。
 *
 * ## 为什么这个测试非有不可
 *
 * 封面标题是内容的脸,一个错字就废了。CogView 直接画中文标题必乱码
 * (实测:「被辭退賺只」「豈消餵了」),所以标题走 compose_cover 代码渲染。
 *
 * 但「代码渲染」不等于「一定不掉字」—— 折行逻辑(wrapCjk)本身就可能吞字符:
 * 切片下标算错一位、标点悬挂时 take 越界、超行截断多切一刀,都会让标题少字,
 * 而且**渲染出来的图看着挺正常**,没人会发现。
 *
 * 在这个文件之前,compose_cover 的唯一验收在 live-vision.test.ts —— 需要真 key、
 * 默认 skip、不进 CI。也就是说「一字不差」这条验收在 CI 里是零覆盖的。
 *
 * wrapCjk 是纯函数,不需要 key、不需要字体、不需要网络 —— 没有任何理由不进 CI。
 */

/** 一字不差的核心不变量:未截断时,所有行拼回去必须和原标题完全一致。 */
function assertLossless(title: string, lines: string[]) {
  expect(lines.join('')).toBe(title.trim());
}

describe('wrapCjk:封面标题一字不差(JIN-57 回归门禁)', () => {
  /**
   * ✅ 已修复(JIN-89):**容量够却把标题截断丢字**。
   *
   * 生产默认值 maxChars=8 / maxLines=3 = 24 字容量,这个标题只有 21 字,本该放得下。
   * 修复前输出:「被辞退后公司不给 / 赔偿金, / 三万块该怎么要…」—— 「回来」被吃掉了。
   *
   * 成因:折行按语义段(标点切)装行,超长段硬切后**行尾剩余空间不再回填**,于是每个
   * 超长段都浪费半行;行数被撑到 4 > maxLines=3,最后一行再被 slice + '…' 截断——截掉真字符。
   *
   * 修法:wrapCjk 改为逐段消化 + 回填行尾——超长段按剩余空间硬切,尾巴留给后续段继续装满,
   * 24 字容量下 21 字标题正好落进 3 行、一字不差,兑现 composeCover「标题一字不差,绝不截断文案」契约。
   */
  it('普通标题:折行不丢字、不改字、不重排', () => {
    const title = '被辞退后公司不给赔偿金,三万块该怎么要回来';
    const lines = wrapCjk(title, 8, 3);
    assertLossless(title, lines);
  });

  it('无标点长标题:硬切也必须无损', () => {
    const title = '劳动仲裁全流程指南从立案到开庭再到执行一步都不能少';
    const lines = wrapCjk(title, 8, 5);
    assertLossless(title, lines);
    expect(lines.every((l) => l.length > 0)).toBe(true);
  });

  it('标点悬挂:收尾标点绝不落到行首(否则会出现一整行只有一个逗号的孤行)', () => {
    const NO_START = '?!,。、;:)】》”』%…?!,.:;)';
    for (const title of [
      '千万别签,这份合同有坑!',
      '公司说:你被优化了。然后呢?',
      '加班费、年假、赔偿金,一个都别放过!!',
      '他问我:「还要打官司吗?」我说:要。',
    ]) {
      for (const line of wrapCjk(title, 6, 4)) {
        expect(NO_START.includes(line[0]!), `行首出现禁则标点「${line[0]}」:${line}`).toBe(false);
      }
    }
  });

  /**
   * ✅ 已修复(JIN-89,同上另一个触发面):连续收尾标点 + 段落装行浪费 → 提前触顶 maxLines → 丢字。
   *
   * 修复前:19 字标题、24 字容量,输出「加班费、/ 年假、/ 赔偿金,/ 一个都别放…」——「过!!」没了;
   * 前三行只用了 4/3/4 格,空转一半版面却仍截断。回填行尾后正好落进 4 行、一字不差。
   */
  it('连续标点结尾的标题:容量足够时也不该丢字', () => {
    const title = '加班费、年假、赔偿金,一个都别放过!!';
    assertLossless(title, wrapCjk(title, 6, 4));
  });

  it('超出 maxLines:唯一允许的丢字是省略号截断,且行数被钉死', () => {
    const title = '劳动仲裁全流程指南从立案到开庭再到执行再到强制执行一步都不能少还有很多细节';
    const lines = wrapCjk(title, 8, 3);

    expect(lines).toHaveLength(3);
    // 截断是显式的、可见的 —— 用户看得出来「这里被截了」,而不是无声少几个字。
    expect(lines[2]!.endsWith('…')).toBe(true);
    // 截断之前的内容仍然必须是原文的前缀,不许改写。
    expect(title.startsWith(lines.slice(0, 2).join(''))).toBe(true);
  });

  it('不超行时绝不加省略号(别把没截断的标题也标成截断)', () => {
    const lines = wrapCjk('三招要回赔偿金', 8, 3);
    expect(lines.join('')).toBe('三招要回赔偿金');
    expect(lines.some((l) => l.endsWith('…'))).toBe(false);
  });

  it('每行不超过 maxChars —— 标点悬挂是唯一例外,且最多多挂标点', () => {
    const title = '公司不给赔偿金,劳动仲裁怎么打,三万块能不能要回来';
    const maxChars = 8;
    const lines = wrapCjk(title, maxChars, 6);
    assertLossless(title, lines);
    for (const line of lines) {
      if (line.length > maxChars) {
        // 超出的部分只能是被悬挂上来的收尾标点,不能是正文字符。
        const overflow = line.slice(maxChars);
        expect(/^[?!,。、;:)】》”』%…?!,.:;)]+$/.test(overflow), `第 ${maxChars} 字之后混入了正文:${line}`).toBe(true);
      }
    }
  });

  it('首尾空白只 trim 两端,不吃掉内部字符', () => {
    const lines = wrapCjk('  赔偿金怎么算  ', 8, 3);
    expect(lines.join('')).toBe('赔偿金怎么算');
  });
});
