import { describe, expect, it } from 'vitest';
import {
  BillingService,
  DEFAULT_RATES,
  InMemoryCreditLedger,
  InsufficientCreditsError,
  usageToPoints,
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

describe('分档费率', () => {
  it('缓存 token 按更便宜的一档计价,不能和新 input 一口价', () => {
    // 用大额度量:小额度下 ceil() 的进位会盖过费率比
    // (1 万 token 的缓存价只值 0.5 点,进位成 1 点后比值就不是 10 了)
    const n = 10_000_000;
    const fresh = usageToPoints({ inputTokens: n, cachedInputTokens: 0, outputTokens: 0 }, DEFAULT_RATES);
    const cached = usageToPoints({ inputTokens: 0, cachedInputTokens: n, outputTokens: 0 }, DEFAULT_RATES);
    expect(cached).toBeLessThan(fresh);
    expect(fresh / cached).toBeCloseTo(10, 5); // 5.0 vs 0.5 元/1M
  });

  it('用实测数据算账:命中缓存后这次调用便宜了多少', () => {
    // JIN-51 实测:第1次 input=3448 cache_read=0;第2次 input=120 cache_read=3328
    const call1 = usageToPoints({ inputTokens: 3448, cachedInputTokens: 0, outputTokens: 38 }, DEFAULT_RATES);
    const call2 = usageToPoints({ inputTokens: 120, cachedInputTokens: 3328, outputTokens: 13 }, DEFAULT_RATES);
    expect(call2).toBeLessThan(call1);
  });

  it('不足 1 点的调用向上取整,不能出现免费调用', () => {
    expect(usageToPoints({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }, DEFAULT_RATES)).toBe(1);
  });
});

describe('两阶段扣费', () => {
  it('余额不足直接拒绝 —— 请求根本不该发给上游', async () => {
    const billing = new BillingService(new InMemoryCreditLedger({ 'acct-1': 1 }));
    await expect(billing.reserveForRequest(ctx(), { max_tokens: 4096 })).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
  });

  it('结算按真实 usage 多退少补:预留的上界要退回来', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 100_000 });
    const billing = new BillingService(ledger);

    const hold = await billing.reserveForRequest(ctx(), { max_tokens: 8192 });
    const afterHold = await ledger.balance('acct-1');
    expect(afterHold).toBe(100_000 - hold.reservedPoints); // 冻结生效

    // 真实只花了一点点
    const points = await billing.settleFromUsage(hold, ctx(), {
      inputTokens: 120,
      cachedInputTokens: 3328,
      outputTokens: 13,
    });

    const afterSettle = await ledger.balance('acct-1');
    expect(afterSettle).toBe(100_000 - points); // 只扣真实用量
    expect(afterSettle).toBeGreaterThan(afterHold); // 多余的冻结退回来了
  });

  it('上游失败原样退款,且不产生用量明细', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 50_000 });
    const billing = new BillingService(ledger);

    const hold = await billing.reserveForRequest(ctx(), { max_tokens: 4096 });
    await billing.releaseOnFailure(hold);

    expect(await ledger.balance('acct-1')).toBe(50_000);
    expect(await ledger.listCostEvents('acct-1')).toHaveLength(0);
  });

  it('用量明细记得住「哪个员工、哪个任务、花了多少」', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 100_000 });
    const billing = new BillingService(ledger);
    const c = ctx({ agentId: 'agent-xuanti', issueId: 'issue-42' });

    const hold = await billing.reserveForRequest(c, { max_tokens: 1024 });
    await billing.settleFromUsage(hold, c, { inputTokens: 500, cachedInputTokens: 0, outputTokens: 200 });

    const [event] = await ledger.listCostEvents('acct-1');
    expect(event).toMatchObject({ agentId: 'agent-xuanti', issueId: 'issue-42', model: 'glm-4.6' });
    expect(event!.points).toBeGreaterThan(0);
  });
});

describe('并发安全(这组是这个包存在的理由)', () => {
  it('余额只够 1 个请求时,10 个并发请求只能有 1 个通过 —— 绝不超卖', async () => {
    // 恰好够 1 次 max_tokens=1024 的最坏情况预留
    const ledger = new InMemoryCreditLedger({ 'acct-1': 0 });
    const billing = new BillingService(ledger);
    const probe = { max_tokens: 1024 };

    // 先算出一次预留要多少点,再把余额设成刚好够一次
    const tmp = new BillingService(new InMemoryCreditLedger({ x: Number.MAX_SAFE_INTEGER }));
    const one = (await tmp.reserveForRequest(ctx({ accountId: 'x' }), probe)).reservedPoints;
    await ledger.credit('acct-1', one, 'topup-1');

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => billing.reserveForRequest(ctx({ requestId: `req-${i}` }), probe)),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1); // ← 事后 sum() 拦截在这里会放行 10 个
    expect(rejected).toHaveLength(9);
    expect(await ledger.balance('acct-1')).toBe(0);
    expect(await ledger.balance('acct-1')).toBeGreaterThanOrEqual(0); // 永不为负
  });

  it('同一 requestId 重试不重复冻结(幂等)', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 100_000 });
    const billing = new BillingService(ledger);

    const a = await billing.reserveForRequest(ctx({ requestId: 'same' }), { max_tokens: 1024 });
    const b = await billing.reserveForRequest(ctx({ requestId: 'same' }), { max_tokens: 1024 });

    expect(b.id).toBe(a.id);
    expect(await ledger.balance('acct-1')).toBe(100_000 - a.reservedPoints); // 只冻结了一次
  });

  it('充值回调重复投递不重复加钱(幂等)', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 0 });
    await ledger.credit('acct-1', 5_000, 'wxpay-order-9');
    await ledger.credit('acct-1', 5_000, 'wxpay-order-9'); // 支付网关重推
    expect(await ledger.balance('acct-1')).toBe(5_000);
  });

  it('重复结算是 no-op,不会退两次钱', async () => {
    const ledger = new InMemoryCreditLedger({ 'acct-1': 100_000 });
    const billing = new BillingService(ledger);
    const hold = await billing.reserveForRequest(ctx(), { max_tokens: 4096 });

    const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 };
    await billing.settleFromUsage(hold, ctx(), usage);
    const once = await ledger.balance('acct-1');
    await billing.settleFromUsage(hold, ctx(), usage);

    expect(await ledger.balance('acct-1')).toBe(once);
    expect(await ledger.listCostEvents('acct-1')).toHaveLength(1);
  });
});
