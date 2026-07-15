import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 架构红线的守卫:**生产入口不许再构造内存会话解析器**。
 *
 * 这条红线是用一个上线硬阻断换来的(JIN-84):`src/index.ts` 里那句
 * `new InMemorySessionResolver()` 构造的是一个**空 map** —— 它对任何 token 都返回 null,
 * 于是每一个真实用户都被 401 挡在门外,而本地/CI 里塞了假 session 的测试全绿。
 * **这类洞不会自己暴露,只在接真实用户的那一刻炸。** 所以要有人看着源码。
 *
 * 这个用例**不依赖 embedded Postgres**,任何机器上都会真跑 —— 它是那道永远不会被 skip 掉的门禁。
 */
const indexSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

describe('生产入口的会话解析', () => {
  it('src/index.ts 用 PgSessionResolver(真 session 表)', () => {
    expect(indexSource).toContain('PgSessionResolver');
    expect(indexSource).toContain('new PgSessionResolver(runtime.db)');
  });

  it('src/index.ts 不许出现 InMemorySessionResolver —— 内存会话是测试专用', () => {
    expect(indexSource).not.toContain('InMemorySessionResolver');
  });

  it('鉴权不许「起不来就回落内存」—— 生产入口没有任何 fallback 分支', () => {
    // 计费上「优雅降级到内存」= 无声丢钱;鉴权上 = **无声放行**。宁可起不来。
    expect(indexSource).not.toMatch(/catch[\s\S]{0,200}SessionResolver/);
  });
});
