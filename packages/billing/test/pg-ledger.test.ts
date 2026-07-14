import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  companies,
  computeAccounts,
  computeReservations,
  computeTransactions,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from '@paperclipai/db';
import { PgCreditLedger } from '../src/pg-ledger.js';
import { InsufficientCreditsError } from '../src/ledger.js';
import { sweepExpiredReservations } from '../src/sweeper.js';
import type { CostEvent } from '../src/ledger.js';

/**
 * Postgres 账本的真机测试 —— 内存版能过不代表 SQL 版能过:
 * 超卖、双花、重复扣费全都是**并发 + 落库**才暴露的问题。
 *
 * 没有 embedded postgres 的宿主机上整体跳过(而不是假装通过)。
 */
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`跳过 PgCreditLedger 测试(本机不支持 embedded Postgres):${support.reason ?? 'unsupported'}`);
}

function costEvent(accountId: string, requestId: string): Omit<CostEvent, 'points'> {
  return {
    accountId,
    agentId: null,
    issueId: null,
    model: 'glm-4.6',
    usage: { inputTokens: 120, cachedInputTokens: 3328, outputTokens: 500 },
    requestId,
    occurredAt: new Date(),
  };
}

describeDb('PgCreditLedger', () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let ledger: PgCreditLedger;
  let companyId: string;
  let accountId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase('jin-pg-ledger-');
    db = createDb(tempDb.connectionString);
    ledger = new PgCreditLedger(db);

    const company = await db
      .insert(companies)
      .values({
        name: `Ledger ${randomUUID()}`,
        issuePrefix: `LG${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(computeTransactions);
    await db.delete(computeReservations);
    await db.delete(computeAccounts);
    const account = await db
      .insert(computeAccounts)
      .values({ companyId, ownerType: 'company', balancePoints: 1_000 })
      .returning()
      .then((rows) => rows[0]!);
    accountId = account.id;
  });

  async function account() {
    const [row] = await db.select().from(computeAccounts).where(eq(computeAccounts.id, accountId));
    return row!;
  }

  it('reserve 只冻结、不动账面余额;可用额度 = 余额 - 冻结', async () => {
    const hold = await ledger.reserve(accountId, 300, `req-${randomUUID()}`, 60_000);

    const row = await account();
    expect(Number(row.balancePoints)).toBe(1_000);
    expect(Number(row.frozenPoints)).toBe(300);
    expect(await ledger.balance(accountId)).toBe(700);
    expect(hold.state).toBe('held');
    expect(hold.reservedPoints).toBe(300);
  });

  it('余额不足抛 InsufficientCreditsError,且不留下任何冻结', async () => {
    await expect(ledger.reserve(accountId, 1_001, `req-${randomUUID()}`, 60_000)).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    expect(Number((await account()).frozenPoints)).toBe(0);
  });

  it('同一 requestId 重试不重复冻结 —— 返回同一笔预留', async () => {
    const requestId = `req-${randomUUID()}`;
    const first = await ledger.reserve(accountId, 200, requestId, 60_000);
    const second = await ledger.reserve(accountId, 200, requestId, 60_000);

    expect(second.id).toBe(first.id);
    expect(Number((await account()).frozenPoints)).toBe(200);
  });

  it('并发 reserve 不超卖:余额 1000,10 个各要 200 → 只有 5 个成功', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => ledger.reserve(accountId, 200, `req-${randomUUID()}`, 60_000)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(5);
    for (const r of failed) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditsError);
    }
    const row = await account();
    expect(Number(row.frozenPoints)).toBe(1_000);
    expect(await ledger.balance(accountId)).toBe(0);
  });

  it('settle 按真实用量扣款,多退少补,并落一条用量明细', async () => {
    const requestId = `req-${randomUUID()}`;
    const hold = await ledger.reserve(accountId, 500, requestId, 60_000);

    const settled = await ledger.settle(hold.id, 120, costEvent(accountId, requestId));
    expect(settled).toBe(true);

    const row = await account();
    expect(Number(row.balancePoints)).toBe(880); // 1000 - 120
    expect(Number(row.frozenPoints)).toBe(0); // 冻结的 500 全部回冲
    expect(Number(row.totalConsumedPoints)).toBe(120);

    const txs = await db.select().from(computeTransactions);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.direction).toBe('debit');
    expect(txs[0]!.reason).toBe('consume');
    expect(Number(txs[0]!.points)).toBe(120);
    expect(Number(txs[0]!.balanceAfter)).toBe(880);
    expect(txs[0]!.idempotencyKey).toBe(requestId);

    const events = await ledger.listCostEvents(accountId);
    expect(events).toHaveLength(1);
    expect(events[0]!.model).toBe('glm-4.6');
    expect(events[0]!.usage).toEqual({ inputTokens: 120, cachedInputTokens: 3328, outputTokens: 500 });
    expect(events[0]!.points).toBe(120);
  });

  it('重复 settle 是 no-op —— 不会扣两次钱', async () => {
    const requestId = `req-${randomUUID()}`;
    const hold = await ledger.reserve(accountId, 500, requestId, 60_000);

    expect(await ledger.settle(hold.id, 120, costEvent(accountId, requestId))).toBe(true);
    expect(await ledger.settle(hold.id, 120, costEvent(accountId, requestId))).toBe(false);

    expect(Number((await account()).balancePoints)).toBe(880);
    expect(await db.select().from(computeTransactions)).toHaveLength(1);
  });

  it('并发 settle 只有一个生效(不丢失更新)', async () => {
    const requestId = `req-${randomUUID()}`;
    const hold = await ledger.reserve(accountId, 500, requestId, 60_000);

    const results = await Promise.all([
      ledger.settle(hold.id, 100, costEvent(accountId, requestId)),
      ledger.settle(hold.id, 100, costEvent(accountId, requestId)),
      ledger.settle(hold.id, 100, costEvent(accountId, requestId)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(Number((await account()).balancePoints)).toBe(900);
    expect(await db.select().from(computeTransactions)).toHaveLength(1);
  });

  it('release 只退冻结、不产生明细;重复 release 是 no-op', async () => {
    const hold = await ledger.reserve(accountId, 400, `req-${randomUUID()}`, 60_000);

    expect(await ledger.release(hold.id)).toBe(true);
    expect(await ledger.release(hold.id)).toBe(false);

    const row = await account();
    expect(Number(row.balancePoints)).toBe(1_000);
    expect(Number(row.frozenPoints)).toBe(0);
    expect(await db.select().from(computeTransactions)).toHaveLength(0);
  });

  it('settle 与 release 撞车:谁先推离 held 谁生效,不双花', async () => {
    const requestId = `req-${randomUUID()}`;
    const hold = await ledger.reserve(accountId, 400, requestId, 60_000);

    const [settled, released] = await Promise.all([
      ledger.settle(hold.id, 200, costEvent(accountId, requestId)),
      ledger.release(hold.id),
    ]);

    expect([settled, released].filter(Boolean)).toHaveLength(1);
    const row = await account();
    expect(Number(row.frozenPoints)).toBe(0);
    // settle 赢 → 扣 200;release 赢 → 一分不扣。两者必居其一,不会「既退又扣」
    expect([800, 1_000]).toContain(Number(row.balancePoints));
  });

  it('sweeper 回收超时的 held(进程猝死场景)', async () => {
    const hold = await ledger.reserve(accountId, 300, `req-${randomUUID()}`, 1_000);
    // 模拟「很久以前 reserve 了,然后进程被 kill」
    await db
      .update(computeReservations)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(computeReservations.id, hold.id));

    const recovered = await sweepExpiredReservations(ledger, { ttlMs: 60_000 });
    expect(recovered).toBe(1);

    const row = await account();
    expect(Number(row.frozenPoints)).toBe(0);
    expect(Number(row.balancePoints)).toBe(1_000);
  });

  it('credit 幂等:支付回调重复投递不会重复加点', async () => {
    const orderKey = `recharge:${randomUUID()}`;
    await ledger.credit(accountId, 5_000, orderKey);
    await ledger.credit(accountId, 5_000, orderKey); // 回调重放

    const row = await account();
    expect(Number(row.balancePoints)).toBe(6_000);
    expect(Number(row.totalRechargedPoints)).toBe(5_000);
    expect(await db.select().from(computeTransactions)).toHaveLength(1);
  });

  it('并发 credit 同一幂等键也只加一次', async () => {
    const orderKey = `recharge:${randomUUID()}`;
    await Promise.all([
      ledger.credit(accountId, 1_000, orderKey),
      ledger.credit(accountId, 1_000, orderKey),
      ledger.credit(accountId, 1_000, orderKey),
    ]);

    expect(Number((await account()).balancePoints)).toBe(2_000);
    expect(await db.select().from(computeTransactions)).toHaveLength(1);
  });

  it('findExpiredHolds 只返回仍挂在 held 的预留', async () => {
    const held = await ledger.reserve(accountId, 100, `req-${randomUUID()}`, 60_000);
    const releasedHold = await ledger.reserve(accountId, 100, `req-${randomUUID()}`, 60_000);
    await ledger.release(releasedHold.id);

    const cutoff = new Date(Date.now() + 1_000);
    const expired = await ledger.findExpiredHolds(cutoff, 10);
    expect(expired.map((r) => r.id)).toEqual([held.id]);
  });
});
