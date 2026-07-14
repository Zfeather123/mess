import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import {
  agents,
  budgetPolicies,
  computeAccounts,
  computeRechargeOrders,
  computeTransactions,
  issues,
  type Db,
} from "@paperclipai/db";
import { PgCreditLedger } from "@jin/billing";
import {
  POINTS_PER_YUAN,
  type ComputeBalance,
  type ComputeTransaction,
  type ComputeUsagePage,
  type RechargeChannel,
  type RechargeOrder,
  type RechargeStatus,
} from "@xiaojing/protocol";
import type {
  CreateRecharge,
  ListComputeUsageQuery,
  SettleRecharge,
} from "@paperclipai/shared/validators/compute";
import { conflict, notFound, unprocessable } from "../errors.js";

/**
 * 算力钱包服务(JIN-56)。
 *
 * JIN-51 把计费做成了一个**库**,只有 InMemoryCreditLedger —— 进程一重启余额就没了,
 * 三张表建好了但没人读也没人写,更没有任何 HTTP 面。这里是那层面:
 * 余额 / 用量明细 / 充值单,全部落 Postgres(PgCreditLedger)。
 *
 * 单位:1 点 = 1 分人民币。POINTS_PER_YUAN = 100(1 元 = 100 点)。
 * 所以 amountCents === points —— 但**不要**因此就在代码里写 `amountCents = points`,
 * 那是巧合不是契约;老老实实按 POINTS_PER_YUAN 复算,换算率一改代码自动跟着走。
 */

/** 账面低于这个点数时 UI 弹「余额不足」横幅(= 10 元)。 */
export const DEFAULT_LOW_BALANCE_THRESHOLD = 1_000;

export function pointsToAmountCents(points: number): number {
  return Math.round((points / POINTS_PER_YUAN) * 100);
}

/** keyset 游标:`<createdAt ISO>|<id>`。offset 分页在「边翻页边扣费」时会漏行/重行。 */
export function encodeUsageCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

export function decodeUsageCursor(cursor: string): { createdAt: Date; id: string } | null {
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) return null;
  const createdAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function toRechargeOrder(row: typeof computeRechargeOrders.$inferSelect): RechargeOrder {
  return {
    id: row.id,
    points: Number(row.points),
    amountCents: row.amountCents,
    channel: row.channel as RechargeChannel,
    status: row.status as RechargeStatus,
    // 收银台还没接:wechat / alipay 建单成功但没有可跳转的地址,不能假装有
    payUrl: null,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
  };
}

export function computeService(db: Db) {
  const ledger = new PgCreditLedger(db);

  /**
   * 取账户,没有就现建。
   *
   * 从没充过值的用户也得看到「0 点」,而不是 404 —— 「我的 → 算力」是个常驻入口,
   * 它不该因为「你还没花过钱」而报错。并发首读用 onConflictDoNothing 兜住。
   */
  async function ensureAccount(companyId: string) {
    const existing = await db
      .select()
      .from(computeAccounts)
      .where(and(eq(computeAccounts.companyId, companyId), eq(computeAccounts.ownerType, "company")))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    await db
      .insert(computeAccounts)
      .values({
        companyId,
        ownerType: "company",
        lowBalanceThreshold: DEFAULT_LOW_BALANCE_THRESHOLD,
      })
      .onConflictDoNothing();

    const created = await db
      .select()
      .from(computeAccounts)
      .where(and(eq(computeAccounts.companyId, companyId), eq(computeAccounts.ownerType, "company")))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!created) throw new Error(`compute account bootstrap failed for company ${companyId}`);
    return created;
  }

  /**
   * 本月额度:来自原生的 budget_policies(「不许超过多少」),不是余额(「还剩多少」)。
   * 没配策略 = 不限额 → null。metric 是 billed_cents,而 1 点 = 1 分,所以 amount 直接就是点数。
   */
  async function monthlyQuotaPoints(companyId: string): Promise<number | null> {
    const [policy] = await db
      .select({ amount: budgetPolicies.amount })
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, "company"),
          eq(budgetPolicies.windowKind, "calendar_month_utc"),
          eq(budgetPolicies.metric, "billed_cents"),
          eq(budgetPolicies.isActive, true),
        ),
      )
      .limit(1);
    return policy ? policy.amount : null;
  }

  return {
    ensureAccount,

    async getBalance(companyId: string, now: Date = new Date()): Promise<ComputeBalance> {
      const account = await ensureAccount(companyId);

      const [used] = await db
        .select({ points: sql<string | null>`sum(${computeTransactions.points})` })
        .from(computeTransactions)
        .where(
          and(
            eq(computeTransactions.accountId, account.id),
            eq(computeTransactions.direction, "debit"),
            gte(computeTransactions.createdAt, startOfMonth(now)),
          ),
        );

      const balancePoints = Number(account.balancePoints);
      const frozenPoints = Number(account.frozenPoints);

      return {
        accountId: account.id,
        balancePoints,
        frozenPoints,
        // 冻结的点是「正在跑的 agent 占着的」—— 不减掉的话用户会看到「余额没变但钱不够用」
        availablePoints: balancePoints - frozenPoints,
        monthlyUsedPoints: Number(used?.points ?? 0),
        monthlyQuotaPoints: await monthlyQuotaPoints(companyId),
        lowBalanceThreshold: Number(account.lowBalanceThreshold),
        status: account.status === "suspended" ? "suspended" : "active",
      };
    },

    /**
     * 用量明细。走 `compute_transactions_account_created_idx` (account_id, created_at desc),
     * 员工名 / 任务标题在同一条 SQL 里 left join 出来 —— 明细页一屏 20 行,
     * 每行再发一次请求就是 40 次往返。
     */
    async listUsage(companyId: string, query: ListComputeUsageQuery): Promise<ComputeUsagePage> {
      const account = await ensureAccount(companyId);
      const limit = query.limit ?? 20;
      const cursor = query.cursor ? decodeUsageCursor(query.cursor) : null;

      const rows = await db
        .select({
          tx: computeTransactions,
          agentName: agents.name,
          issueTitle: issues.title,
        })
        .from(computeTransactions)
        .leftJoin(agents, eq(agents.id, computeTransactions.agentId))
        .leftJoin(issues, eq(issues.id, computeTransactions.issueId))
        .where(
          and(
            eq(computeTransactions.accountId, account.id),
            cursor
              ? or(
                  lt(computeTransactions.createdAt, cursor.createdAt),
                  and(
                    eq(computeTransactions.createdAt, cursor.createdAt),
                    lt(computeTransactions.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(computeTransactions.createdAt), desc(computeTransactions.id))
        // 多取一行来判断「还有没有下一页」,不用再发一次 count(*)
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = page.at(-1);

      return {
        transactions: page.map(({ tx, agentName, issueTitle }) => ({
          id: tx.id,
          direction: tx.direction as ComputeTransaction["direction"],
          points: Number(tx.points),
          balanceAfter: Number(tx.balanceAfter),
          reason: tx.reason as ComputeTransaction["reason"],
          agentId: tx.agentId,
          agentName: agentName ?? null,
          issueId: tx.issueId,
          issueTitle: issueTitle ?? null,
          memo: tx.memo,
          createdAt: tx.createdAt.toISOString(),
        })),
        nextCursor: hasMore && last ? encodeUsageCursor(last.tx.createdAt, last.tx.id) : null,
      };
    },

    /**
     * 建充值单。
     *
     * ⚠️ 金额由服务端按 POINTS_PER_YUAN 复算 —— 请求体里**没有** amountCents 这个字段,
     * 客户端根本没机会传一个「1 分钱买 10 万点」的价。
     *
     * MVP 下没有接任何支付渠道:wechat / alipay 建出来的单是 pending + payUrl=null,
     * 需要有人去接收银台和回调;manual / gift 走「线下打款 + 管理员人工确认」(settleRecharge)。
     */
    async createRecharge(
      companyId: string,
      createdByUserId: string | null,
      input: CreateRecharge,
    ): Promise<RechargeOrder> {
      const account = await ensureAccount(companyId);
      const [row] = await db
        .insert(computeRechargeOrders)
        .values({
          companyId,
          accountId: account.id,
          createdByUserId,
          points: input.points,
          amountCents: pointsToAmountCents(input.points),
          channel: input.channel,
          status: "pending",
        })
        .returning();
      if (!row) throw new Error("compute_recharge_orders insert returned no row");
      return toRechargeOrder(row);
    },

    getRechargeOrder: (orderId: string) =>
      db
        .select()
        .from(computeRechargeOrders)
        .where(eq(computeRechargeOrders.id, orderId))
        .limit(1)
        .then((rows) => rows[0] ?? null),

    /**
     * 人工确认到账(线下打款)。**这个接口凭空造钱**,路由层必须挡成实例管理员。
     *
     * 顺序是「先加钱,后置 paid」而不是反过来:如果在两步之间崩了,
     * - 先加钱:重试时 credit 因幂等键成为 no-op,再把单置 paid —— 钱不会加两次。
     * - 先置 paid:重试时看到 paid 就跳过 credit —— 钱**永远不会到账**,且账面看起来是成功的。
     */
    async settleRecharge(
      companyId: string,
      orderId: string,
      input: SettleRecharge,
    ): Promise<RechargeOrder> {
      const order = await db
        .select()
        .from(computeRechargeOrders)
        .where(and(eq(computeRechargeOrders.id, orderId), eq(computeRechargeOrders.companyId, companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!order) throw notFound("Recharge order not found");

      if (order.status === "paid") throw conflict("Recharge order is already paid");
      if (order.status !== "pending") {
        throw conflict(`Recharge order is ${order.status}, not pending`);
      }
      if (order.channel !== "manual" && order.channel !== "gift") {
        // 没有接支付provider,就别把在线渠道的单人工点亮 —— 那等于「没收到钱也发货」
        throw unprocessable(
          "Only manual / gift orders can be settled by hand — no payment provider is wired for wechat / alipay",
        );
      }

      const points = Number(order.points);
      await ledger.credit(order.accountId, points, `recharge:${order.id}`, {
        reason: order.channel === "gift" ? "gift" : "recharge",
        rechargeOrderId: order.id,
        memo: input.memo ?? null,
      });

      const [updated] = await db
        .update(computeRechargeOrders)
        .set({
          status: "paid",
          paidAt: new Date(),
          externalOrderId: input.externalOrderId ?? order.externalOrderId,
          updatedAt: new Date(),
        })
        .where(eq(computeRechargeOrders.id, order.id))
        .returning();
      if (!updated) throw new Error("recharge order update returned no row");
      return toRechargeOrder(updated);
    },
  };
}
