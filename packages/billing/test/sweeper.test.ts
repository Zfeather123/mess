import { describe, expect, it } from 'vitest';
import {
  BillingService,
  DEFAULT_TTL_MS,
  InMemoryCreditLedger,
  sweepExpiredReservations,
  type ChargeContext,
} from '../src/index.js';

const ctx = (over: Partial<ChargeContext> = {}): ChargeContext => ({
  accountId: 'acct-1',
  agentId: 'agent-wenan',
  issueId: 'issue-7',
  model: 'glm-4.6',
  requestId: 'req-1',
  ...over,
});

const TTL = 15 * 60 * 1000;

describe('超时预留回收(用户点数凭空消失 = P0)', () => {
  it('reserve → 进程死 → sweeper 把冻结的点数还回来', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 100_000 });
    const billing = new BillingService(ledger, undefined, TTL);

    const hold = await billing.reserveForRequest(ctx(), { max_tokens: 8192 });
    const afterHold = await ledger.balance('acct-1');
    expect(afterHold).toBeLessThan(100_000); // 钱被冻住了

    // 网关在这里被 kill:settle 永远不会跑到
    ledger.__backdate(hold.id, TTL + 1000); // 时间来到 TTL 之后

    const recovered = await sweepExpiredReservations(ledger, { ttlMs: TTL });

    expect(recovered).toBe(1);
    expect(await ledger.balance('acct-1')).toBe(100_000); // 一分不少地还回来了
    expect(await ledger.listCostEvents('acct-1')).toHaveLength(0); // 没消费,不该有明细
  });

  it('没到 TTL 的预留不能被回收 —— 那是正在跑的请求', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 100_000 });
    const billing = new BillingService(ledger, undefined, TTL);

    const hold = await billing.reserveForRequest(ctx(), { max_tokens: 8192 });
    const held = await ledger.balance('acct-1');

    const recovered = await sweepExpiredReservations(ledger, { ttlMs: TTL });

    expect(recovered).toBe(0); // 请求还在跑,别动它
    expect(await ledger.balance('acct-1')).toBe(held);
    expect(hold.state).toBe('held');
  });

  it('sweeper 和 settle 撞车:只能有一方生效,绝不双花', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 100_000 });
    const billing = new BillingService(ledger, undefined, TTL);

    const hold = await billing.reserveForRequest(ctx(), { max_tokens: 8192 });
    ledger.__backdate(hold.id, TTL + 1000);

    // 卡住的请求刚好在 sweeper 扫到它的同一刻活过来了
    const [swept, settled] = await Promise.all([
      sweepExpiredReservations(ledger, { ttlMs: TTL }),
      billing.settleFromUsage(hold, ctx(), { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 }),
    ]);

    const events = await ledger.listCostEvents('acct-1');
    const balance = await ledger.balance('acct-1');

    // 要么 settle 赢(扣真实用量 + 1 条明细),要么 sweeper 赢(全额退还 + 0 条明细)
    if (events.length === 1) {
      expect(swept).toBe(0);
      expect(balance).toBe(100_000 - events[0]!.points);
    } else {
      expect(swept).toBe(1);
      expect(balance).toBe(100_000); // 全额退回
    }
    // 无论谁赢,余额都不可能超过初始值 —— 那就是凭空多出来的钱
    expect(balance).toBeLessThanOrEqual(100_000);
    void settled;
  });

  it('sweeper 重复跑不会多退钱(幂等)', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 100_000 });
    const billing = new BillingService(ledger, undefined, TTL);

    const hold = await billing.reserveForRequest(ctx(), { max_tokens: 8192 });
    ledger.__backdate(hold.id, TTL + 1000);

    expect(await sweepExpiredReservations(ledger, { ttlMs: TTL })).toBe(1);
    expect(await sweepExpiredReservations(ledger, { ttlMs: TTL })).toBe(0); // 第二轮 no-op
    expect(await sweepExpiredReservations(ledger, { ttlMs: TTL })).toBe(0);

    expect(await ledger.balance('acct-1')).toBe(100_000); // 只退了一次
  });

  it('已 settle 的预留不会被 sweeper 二次退款', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 100_000 });
    const billing = new BillingService(ledger, undefined, TTL);

    const hold = await billing.reserveForRequest(ctx(), { max_tokens: 8192 });
    const points = await billing.settleFromUsage(hold, ctx(), {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
    });
    ledger.__backdate(hold.id, TTL + 1000); // 即使它"超时"了

    expect(await sweepExpiredReservations(ledger, { ttlMs: TTL })).toBe(0);
    expect(await ledger.balance('acct-1')).toBe(100_000 - points); // 钱没被退回来
  });

  it('批量回收有上限,不会一次扫爆', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 1_000_000 });
    const billing = new BillingService(ledger, undefined, TTL);

    for (let i = 0; i < 5; i++) {
      const h = await billing.reserveForRequest(ctx({ requestId: `req-${i}` }), { max_tokens: 1024 });
      ledger.__backdate(h.id, TTL + 1000);
    }

    expect(await sweepExpiredReservations(ledger, { ttlMs: TTL, batchSize: 2 })).toBe(2);
    expect(await sweepExpiredReservations(ledger, { ttlMs: TTL, batchSize: 2 })).toBe(2);
    expect(await sweepExpiredReservations(ledger, { ttlMs: TTL, batchSize: 2 })).toBe(1);
    expect(await ledger.balance('acct-1')).toBe(1_000_000); // 全部还清
  });

  it('默认 TTL 是 15 分钟(配置项 BILLING_RESERVATION_TTL_MS)', () => {
    expect(DEFAULT_TTL_MS).toBe(15 * 60 * 1000);
  });
});
