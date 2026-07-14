import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * 算力账户 schema —— **只新增,不改 Paperclip 原表**(保住 upstream 可合并)。
 *
 * ## 与 Paperclip 现有计费的分工(核过代码,别重造)
 *
 * | 需求            | 用什么                                                          |
 * |-----------------|-----------------------------------------------------------------|
 * | 用量明细        | ✅ **复用** Paperclip 的 `cost_events`(已有 agent/issue/model/  |
 * |                 |    input/cached_input/output/cost_cents + 索引齐全)             |
 * | 花费上限告警    | ✅ **复用** `budget_policies`(事后上限,warn/hard_stop)          |
 * | **点数余额 + 拦截** | ❌ **Paperclip 没有** —— 下面三张表                            |
 *
 * `budget_policies` 是「花超了拦」(允许透支到超出那一次),点数制是「不够就不让发」
 * (一分不能透支)。语义不同,不能拿它顶。
 */

/** 点数余额。一个账户 = 一个公司/用户的算力钱包。 */
export const creditAccounts = pgTable('credit_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  /**
   * 可用余额(已扣掉冻结中的预留)。
   *
   * ⚠️ 扣减**必须**用单条原子语句:
   *   UPDATE credit_accounts SET balance_points = balance_points - $1
   *    WHERE id = $2 AND balance_points >= $1
   * 靠受影响行数判断成败。先 SELECT 再 UPDATE = 并发超卖。
   *
   * bigint:点数是「元 × 100」量级,长期累计会超 int4(21 亿)。
   */
  balancePoints: bigint('balance_points', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  companyUnique: uniqueIndex('credit_accounts_company_unique_idx').on(t.companyId),
}));

/** 流水:充值 / 扣费 / 退款。只追加,不可变 —— 对账的唯一事实来源。 */
export const creditTransactions = pgTable('credit_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => creditAccounts.id),
  /** topup(充值) | charge(扣费) | refund(结算回冲) | release(请求失败退还) */
  kind: text('kind').notNull(),
  /** 正数=入账,负数=出账。 */
  deltaPoints: bigint('delta_points', { mode: 'number' }).notNull(),
  /**
   * 幂等键。充值回调会重复投递、客户端会重试 —— 靠唯一索引兜住,
   * 重复的那次直接冲突丢弃,绝不重复加/扣钱。
   */
  requestId: text('request_id').notNull(),
  reservationId: uuid('reservation_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // 幂等的兜底靠这条唯一索引,不是靠应用层判断
  idempotency: uniqueIndex('credit_transactions_kind_request_unique_idx').on(t.kind, t.requestId),
  accountCreated: index('credit_transactions_account_created_idx').on(t.accountId, t.createdAt),
}));

/** 冻结中的预留。请求前按最坏情况冻结,响应后按真实 usage 回冲。 */
export const creditReservations = pgTable('credit_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => creditAccounts.id),
  reservedPoints: bigint('reserved_points', { mode: 'number' }).notNull(),
  /** held | settled | released */
  state: text('state').notNull().default('held'),
  requestId: text('request_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (t) => ({
  requestUnique: uniqueIndex('credit_reservations_request_unique_idx').on(t.requestId),
  /**
   * 扫「卡住的预留」用。
   *
   * ⚠️ 运维必须有一个补偿任务:网关进程如果在 reserve 之后、settle 之前被 kill,
   * 这笔冻结会永远挂在 held —— 用户的点数凭空消失。定时扫 state='held' 且
   * created_at 超时(如 15 分钟)的记录,一律 release。
   */
  stateCreated: index('credit_reservations_state_created_idx').on(t.state, t.createdAt),
}));
