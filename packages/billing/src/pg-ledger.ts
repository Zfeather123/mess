import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import {
  computeAccounts,
  computeReservations,
  computeTransactions,
  costEvents,
  type Db,
} from '@paperclipai/db';
import { InsufficientCreditsError, type CostEvent, type CreditLedger, type Reservation } from './ledger.js';
import { ZERO_USAGE, type TokenUsage } from './pricing.js';

/**
 * Postgres 算力账本 —— `InMemoryCreditLedger` 的生产实现。
 *
 * 落在三张表上(0148 / 0149):
 *   compute_accounts      余额 / 冻结 / 累计充值 / 累计消费(+ version 乐观锁)
 *   compute_reservations  每笔冻结的明细 + TTL(sweeper 靠它回收)
 *   compute_transactions  用量明细(「我的 → 算力」页面直接读这张表)
 *
 * ## 与内存实现的一个**有意的语义差异**
 *
 * 内存版没有「冻结」这个列,它在 reserve 时直接把 balance 减掉,settle 时再回冲。
 * DB 版按 schema 的语义走:
 *
 *   reserve : frozen += points        (balance 不动)
 *   settle  : frozen -= reserved,balance -= actual
 *   release : frozen -= reserved      (balance 不动)
 *
 * 「可用额度」= balance - frozen。`balance()` 返回的就是这个可用额度 —— 网关关心的
 * 永远是「还能不能再发一个请求」,而不是账面数字。要拿账面/冻结的原始值用
 * `snapshot()`。
 *
 * ## 三条不变量(靠 DB,不靠「应用层记得检查」)
 *
 * 1. **不超卖**:reserve 在事务里 `SELECT ... FOR UPDATE` 锁住账户行再判断可用额度。
 *    并发 reserve 被行锁排队,不会出现「10 个请求都看到余额够」。
 * 2. **不双花**:settle / release 都先 `SELECT ... FOR UPDATE` 锁住 reservation 行,
 *    只有 state='held' 才推进。sweeper 和 settle 撞车时,谁先拿到行锁谁生效,
 *    另一边返回 false(no-op)。
 * 3. **不重复扣/重复加**:
 *    - reserve 的幂等靠 `compute_reservations.request_id` 唯一索引(重试返回同一笔)。
 *    - credit 的幂等靠 `compute_transactions (company_id, idempotency_key)` 唯一索引
 *      —— 支付回调一定会重复投递,重放不能把钱加两次。
 */
export class PgCreditLedger implements CreditLedger {
  constructor(private readonly db: Db) {}

  // -------------------------------------------------------------------------
  // reserve
  // -------------------------------------------------------------------------

  async reserve(accountId: string, points: number, requestId: string, ttlMs: number): Promise<Reservation> {
    if (points < 0) throw new Error('reserve 点数不能为负');

    try {
      return await this.db.transaction(async (tx) => {
        // 幂等:同一 requestId 重放(网关重试)不重复冻结
        const existing = await findReservationByRequestId(tx, requestId);
        if (existing) return existing;

        const account = await lockAccount(tx, accountId);
        if (account.status !== 'active') {
          // 停用的账户当作 0 可用 —— 网关据此 402,不转发
          throw new InsufficientCreditsError(accountId, points, 0);
        }

        const available = Number(account.balancePoints) - Number(account.frozenPoints);
        if (available < points) {
          throw new InsufficientCreditsError(accountId, points, available);
        }

        await tx
          .update(computeAccounts)
          .set({
            frozenPoints: sql`${computeAccounts.frozenPoints} + ${points}`,
            version: sql`${computeAccounts.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(computeAccounts.id, accountId));

        const [row] = await tx
          .insert(computeReservations)
          .values({
            companyId: account.companyId,
            accountId,
            reservedPoints: points,
            state: 'held',
            requestId,
            expiresAt: new Date(Date.now() + ttlMs),
          })
          .returning();
        if (!row) throw new Error('compute_reservations insert returned no row');
        return toReservation(row);
      });
    } catch (error) {
      // 并发的同 requestId 重试撞上唯一索引 —— 这不是错误,正是幂等生效了
      if (isUniqueViolation(error)) {
        const existing = await findReservationByRequestId(this.db, requestId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // settle
  // -------------------------------------------------------------------------

  async settle(
    reservationId: string,
    actualPoints: number,
    event: Omit<CostEvent, 'points'>,
  ): Promise<boolean> {
    if (actualPoints < 0) throw new Error('settle 点数不能为负');

    return await this.db.transaction(async (tx) => {
      const reservation = await lockReservation(tx, reservationId);
      if (!reservation) throw new Error(`预留不存在:${reservationId}`);
      // 已被 settle / release(或 sweeper)抢先 → no-op,不双花
      if (reservation.state !== 'held') return false;

      const account = await lockAccount(tx, reservation.accountId);
      const reserved = Number(reservation.reservedPoints);
      const balanceBefore = Number(account.balancePoints);

      // 真实用量理论上不会超过预留上界(output 受 max_tokens 约束),但上游若返回了
      // 超出上界的用量,我们照实收 —— 只是不能把余额扣成负数(DB 有 CHECK >= 0),
      // 所以封顶在账面余额。封顶发生时账面「少收」了,memo 里留痕,能被对账查出来。
      const charged = Math.min(actualPoints, balanceBefore);
      const balanceAfter = balanceBefore - charged;

      await tx
        .update(computeReservations)
        .set({ state: 'settled', settledAt: new Date() })
        .where(and(eq(computeReservations.id, reservationId), eq(computeReservations.state, 'held')));

      await tx
        .update(computeAccounts)
        .set({
          balancePoints: balanceAfter,
          frozenPoints: sql`greatest(${computeAccounts.frozenPoints} - ${reserved}, 0)`,
          totalConsumedPoints: sql`${computeAccounts.totalConsumedPoints} + ${charged}`,
          version: sql`${computeAccounts.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(computeAccounts.id, reservation.accountId));

      // points > 0 是 DB 的 CHECK:0 点消费不落流水(免费调用没有明细可看)
      if (charged > 0) {
        const memo = encodeUsageMemo(event.model, event.usage, charged < actualPoints ? actualPoints : null);
        await tx
          .insert(computeTransactions)
          .values({
            companyId: reservation.companyId,
            accountId: reservation.accountId,
            direction: 'debit',
            points: charged,
            balanceAfter,
            reason: 'consume',
            agentId: event.agentId ?? reservation.agentId ?? null,
            issueId: event.issueId ?? reservation.issueId ?? null,
            // 一次请求一条扣费:requestId 天然就是幂等键
            idempotencyKey: event.requestId,
            memo,
          })
          .onConflictDoNothing();
      }

      return true;
    });
  }

  // -------------------------------------------------------------------------
  // release
  // -------------------------------------------------------------------------

  async release(reservationId: string): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const reservation = await lockReservation(tx, reservationId);
      if (!reservation || reservation.state !== 'held') return false; // 抢先者已处理 → no-op

      await tx
        .update(computeReservations)
        .set({ state: 'released', settledAt: new Date() })
        .where(and(eq(computeReservations.id, reservationId), eq(computeReservations.state, 'held')));

      await tx
        .update(computeAccounts)
        .set({
          frozenPoints: sql`greatest(${computeAccounts.frozenPoints} - ${Number(reservation.reservedPoints)}, 0)`,
          version: sql`${computeAccounts.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(computeAccounts.id, reservation.accountId));

      return true;
    });
  }

  // -------------------------------------------------------------------------
  // 读 / 充值
  // -------------------------------------------------------------------------

  async findExpiredHolds(cutoff: Date, limit: number): Promise<Reservation[]> {
    const rows = await this.db
      .select()
      .from(computeReservations)
      .where(and(eq(computeReservations.state, 'held'), lte(computeReservations.createdAt, cutoff)))
      .orderBy(asc(computeReservations.createdAt))
      .limit(limit);
    return rows.map(toReservation);
  }

  /** 可用额度(= balance - frozen)。账户不存在按 0 算。 */
  async balance(accountId: string): Promise<number> {
    const snapshot = await this.snapshot(accountId);
    if (!snapshot) return 0;
    return snapshot.availablePoints;
  }

  /** 账面 / 冻结 / 可用的原始值 —— 「我的 → 算力」页面要三个数都露出来。 */
  async snapshot(accountId: string): Promise<{
    accountId: string;
    companyId: string;
    balancePoints: number;
    frozenPoints: number;
    availablePoints: number;
    lowBalanceThreshold: number;
    status: 'active' | 'suspended';
  } | null> {
    const [row] = await this.db
      .select()
      .from(computeAccounts)
      .where(eq(computeAccounts.id, accountId))
      .limit(1);
    if (!row) return null;
    const balancePoints = Number(row.balancePoints);
    const frozenPoints = Number(row.frozenPoints);
    return {
      accountId: row.id,
      companyId: row.companyId,
      balancePoints,
      frozenPoints,
      availablePoints: balancePoints - frozenPoints,
      lowBalanceThreshold: Number(row.lowBalanceThreshold),
      status: row.status === 'suspended' ? 'suspended' : 'active',
    };
  }

  /**
   * 充值 / 赠送加点。
   *
   * `requestId` 就是幂等键:支付回调**一定**会重复投递,重放不能把钱加两次。
   * 靠 `compute_transactions (company_id, idempotency_key)` 的唯一索引兜底,
   * 而不是「先查有没有再插」那种 TOCTOU 写法。
   */
  async credit(
    accountId: string,
    points: number,
    requestId: string,
    options: { reason?: 'recharge' | 'gift' | 'adjust' | 'refund'; rechargeOrderId?: string | null; memo?: string | null } = {},
  ): Promise<void> {
    if (points <= 0) throw new Error('credit 点数必须为正');

    try {
      await this.db.transaction(async (tx) => {
        const account = await lockAccount(tx, accountId);

        const [existing] = await tx
          .select({ id: computeTransactions.id })
          .from(computeTransactions)
          .where(
            and(
              eq(computeTransactions.companyId, account.companyId),
              eq(computeTransactions.idempotencyKey, requestId),
            ),
          )
          .limit(1);
        if (existing) return; // 回调重放 → no-op

        const balanceAfter = Number(account.balancePoints) + points;

        await tx
          .update(computeAccounts)
          .set({
            balancePoints: balanceAfter,
            totalRechargedPoints: sql`${computeAccounts.totalRechargedPoints} + ${points}`,
            version: sql`${computeAccounts.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(computeAccounts.id, accountId));

        await tx.insert(computeTransactions).values({
          companyId: account.companyId,
          accountId,
          direction: 'credit',
          points,
          balanceAfter,
          reason: options.reason ?? 'recharge',
          rechargeOrderId: options.rechargeOrderId ?? null,
          idempotencyKey: requestId,
          memo: options.memo ?? null,
        });
      });
    } catch (error) {
      // 并发重放撞唯一索引 = 幂等生效,不是错误
      if (isUniqueViolation(error)) return;
      throw error;
    }
  }

  /** 对账用:把消费流水还原成 CostEvent。 */
  async listCostEvents(accountId: string): Promise<CostEvent[]> {
    const rows = await this.db
      .select({ tx: computeTransactions, ce: costEvents })
      .from(computeTransactions)
      .leftJoin(costEvents, eq(costEvents.id, computeTransactions.costEventId))
      .where(
        and(eq(computeTransactions.accountId, accountId), eq(computeTransactions.reason, 'consume')),
      )
      .orderBy(desc(computeTransactions.createdAt));

    return rows.map(({ tx, ce }) => {
      const decoded = decodeUsageMemo(tx.memo);
      return {
        accountId,
        agentId: tx.agentId,
        issueId: tx.issueId,
        // cost_events 是用量事实的原生表(网关落的);没有关联时回落到 memo 里的快照
        model: ce?.model ?? decoded.model,
        usage: ce
          ? {
              inputTokens: ce.inputTokens,
              cachedInputTokens: ce.cachedInputTokens,
              outputTokens: ce.outputTokens,
            }
          : decoded.usage,
        points: Number(tx.points),
        requestId: tx.idempotencyKey,
        occurredAt: ce?.occurredAt ?? tx.createdAt,
      } satisfies CostEvent;
    });
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** drizzle 的事务句柄类型 —— 从 Db['transaction'] 反推,不手写。 */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Queryable = Pick<Db, 'select'> | Tx;

type AccountRow = typeof computeAccounts.$inferSelect;
type ReservationRow = typeof computeReservations.$inferSelect;

async function lockAccount(tx: Tx, accountId: string): Promise<AccountRow> {
  const [row] = await tx
    .select()
    .from(computeAccounts)
    .where(eq(computeAccounts.id, accountId))
    .limit(1)
    .for('update');
  if (!row) throw new Error(`算力账户不存在:${accountId}`);
  return row;
}

async function lockReservation(tx: Tx, reservationId: string): Promise<ReservationRow | null> {
  const [row] = await tx
    .select()
    .from(computeReservations)
    .where(eq(computeReservations.id, reservationId))
    .limit(1)
    .for('update');
  return row ?? null;
}

async function findReservationByRequestId(
  db: Queryable,
  requestId: string,
): Promise<Reservation | null> {
  const [row] = await db
    .select()
    .from(computeReservations)
    .where(eq(computeReservations.requestId, requestId))
    .limit(1);
  return row ? toReservation(row) : null;
}

function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    accountId: row.accountId,
    reservedPoints: Number(row.reservedPoints),
    requestId: row.requestId,
    state: row.state as Reservation['state'],
    expiresAt: row.expiresAt,
  };
}

/**
 * 用量快照写进 memo:既是 UI 上「用量明细」那一行的人话,也能被 `listCostEvents` 原样解回来。
 * 形如 `glm-4.6 · 输入 120 · 缓存 3328 · 输出 500`。
 */
export function encodeUsageMemo(model: string, usage: TokenUsage, cappedFrom: number | null = null): string {
  const base = `${model} · 输入 ${usage.inputTokens} · 缓存 ${usage.cachedInputTokens} · 输出 ${usage.outputTokens}`;
  // 余额封顶只会在「实际用量 > 账面余额」时发生 —— 留痕,别让账悄悄少收
  return cappedFrom === null ? base : `${base} · 余额封顶(实际 ${cappedFrom} 点)`;
}

export function decodeUsageMemo(memo: string | null): { model: string; usage: TokenUsage } {
  if (!memo) return { model: 'unknown', usage: { ...ZERO_USAGE } };
  const match = /^(.*?) · 输入 (\d+) · 缓存 (\d+) · 输出 (\d+)/.exec(memo);
  if (!match) return { model: 'unknown', usage: { ...ZERO_USAGE } };
  return {
    model: match[1] ?? 'unknown',
    usage: {
      inputTokens: Number(match[2]),
      cachedInputTokens: Number(match[3]),
      outputTokens: Number(match[4]),
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === '23505';
}
