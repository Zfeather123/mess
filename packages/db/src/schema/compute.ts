import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { costEvents } from "./cost_events.js";

/**
 * 算力账户(预付费点数钱包)。
 *
 * 与 Paperclip 既有计费的分工 —— 这三张原生表都复用,不重造:
 *   cost_events     (原生) 「花了多少」:model / input / cached_input / output / cost_cents
 *   finance_events  (原生) 财务流水
 *   budget_policies (原生) 「不许超过多少」:月度限额 + hard_stop
 *   本模块          (新增) 「还剩多少」:余额、充值、扣费明细
 *
 * 为什么 budget_policies 不够:限额 ≠ 余额。
 * 限额是「这个月最多花 500 元」,余额是「你充了 100 元,花完就停」。
 * 预付费产品必须有钱包,Paperclip 是后付费内部工具,没有这个概念。
 *
 * 单位约定:1 点 = 1 分(人民币)。cost_events.cost_cents 与 points 天然 1:1,对账无需换算。
 * 1M token = 5 元 = 500 点。
 */
export const computeAccounts = pgTable(
  "compute_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ownerType: text("owner_type").notNull().default("company"),
    ownerId: text("owner_id"),
    balancePoints: bigint("balance_points", { mode: "number" }).notNull().default(0),
    frozenPoints: bigint("frozen_points", { mode: "number" }).notNull().default(0),
    totalRechargedPoints: bigint("total_recharged_points", { mode: "number" }).notNull().default(0),
    totalConsumedPoints: bigint("total_consumed_points", { mode: "number" }).notNull().default(0),
    lowBalanceThreshold: bigint("low_balance_threshold", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("active"),
    /** 乐观锁:并发扣费下防止丢失更新 */
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOwnerUq: uniqueIndex("compute_accounts_company_owner_uq").on(
      table.companyId,
      table.ownerType,
      sql`coalesce(${table.ownerId}, '')`,
    ),
    ownerTypeCheck: check("compute_accounts_owner_type_check", sql`${table.ownerType} in ('company', 'user')`),
    statusCheck: check("compute_accounts_status_check", sql`${table.status} in ('active', 'suspended')`),
    /** 余额不可为负 —— DB 层兜底。不依赖「应用层记得先检查再扣」,那是竞态的温床。 */
    balanceCheck: check("compute_accounts_balance_check", sql`${table.balancePoints} >= 0`),
    frozenCheck: check("compute_accounts_frozen_check", sql`${table.frozenPoints} >= 0`),
  }),
);

/**
 * 定价规则,按 effectiveFrom 版本化。
 *
 * 为什么不是一行可变的 settings:改价那一刻,所有历史账单的重算结果都会跟着变,对账即失效。
 * 单价必须是「事件发生时点」的快照,而不是「现在的值」。扣费时把 pricingRuleId 记进流水,
 * 任何一笔历史消费都能原样复算。
 *
 * 三档分列存储(input / cached_input / output):
 * JIN-51 实测 prompt caching 命中可省 94% input tokens。
 * 现在默认三档同价(= 1M token 5 元),但列先留好 —— 将来对缓存命中单独降价无需改表。
 */
export const computePricingRules = pgTable(
  "compute_pricing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null = 全局默认价 */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    model: text("model").notNull().default("*"),
    pointsPer1mInput: integer("points_per_1m_input").notNull(),
    pointsPer1mCachedInput: integer("points_per_1m_cached_input").notNull(),
    pointsPer1mOutput: integer("points_per_1m_output").notNull(),
    note: text("note"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("compute_pricing_rules_lookup_idx").on(
      table.companyId,
      table.model,
      table.effectiveFrom.desc(),
    ),
    pointsCheck: check(
      "compute_pricing_rules_points_check",
      sql`${table.pointsPer1mInput} >= 0 and ${table.pointsPer1mCachedInput} >= 0 and ${table.pointsPer1mOutput} >= 0`,
    ),
  }),
);

/** 点数流水 = 用量明细(哪个员工、哪个任务、花了多少) */
export const computeTransactions = pgTable(
  "compute_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => computeAccounts.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    points: bigint("points", { mode: "number" }).notNull(),
    /** 记录扣费后余额:对账时无需重放全部流水即可定位分歧点 */
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    /** 指回 Paperclip 原生用量事实,一条扣费 ↔ 一条 cost_event,可双向对账 */
    costEventId: uuid("cost_event_id").references(() => costEvents.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id"),
    rechargeOrderId: uuid("recharge_order_id"),
    pricingRuleId: uuid("pricing_rule_id").references(() => computePricingRules.id, { onDelete: "set null" }),
    /**
     * 幂等键。run 失败重试会重放扣费 —— 没有它就是重复扣钱,真金白银的 bug。
     * 约定形如 `run:<runId>:cost:<costEventId>`。
     */
    idempotencyKey: text("idempotency_key").notNull(),
    memo: text("memo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUq: uniqueIndex("compute_transactions_idempotency_uq").on(table.companyId, table.idempotencyKey),
    /** 一条 cost_event 最多扣一次费 */
    costEventUq: uniqueIndex("compute_transactions_cost_event_uq")
      .on(table.costEventId)
      .where(sql`${table.costEventId} is not null`),
    accountCreatedIdx: index("compute_transactions_account_created_idx").on(
      table.accountId,
      table.createdAt.desc(),
    ),
    companyAgentIdx: index("compute_transactions_company_agent_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt.desc(),
    ),
    directionCheck: check("compute_transactions_direction_check", sql`${table.direction} in ('credit', 'debit')`),
    reasonCheck: check(
      "compute_transactions_reason_check",
      sql`${table.reason} in ('recharge', 'consume', 'refund', 'adjust', 'gift', 'freeze', 'unfreeze')`,
    ),
    pointsCheck: check("compute_transactions_points_check", sql`${table.points} > 0`),
  }),
);

export const computeRechargeOrders = pgTable(
  "compute_recharge_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => computeAccounts.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id"),
    points: bigint("points", { mode: "number" }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    channel: text("channel").notNull(),
    externalOrderId: text("external_order_id"),
    status: text("status").notNull().default("pending"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    rawCallback: jsonb("raw_callback").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 支付回调会重复投递:外部订单号唯一,回调重放不会重复加点 */
    channelExternalUq: uniqueIndex("compute_recharge_orders_channel_external_uq")
      .on(table.channel, table.externalOrderId)
      .where(sql`${table.externalOrderId} is not null`),
    accountIdx: index("compute_recharge_orders_account_idx").on(table.accountId, table.createdAt.desc()),
    channelCheck: check(
      "compute_recharge_orders_channel_check",
      sql`${table.channel} in ('wechat', 'alipay', 'manual', 'gift')`,
    ),
    statusCheck: check(
      "compute_recharge_orders_status_check",
      sql`${table.status} in ('pending', 'paid', 'failed', 'refunded')`,
    ),
    pointsCheck: check("compute_recharge_orders_points_check", sql`${table.points} > 0`),
  }),
);

/**
 * 算力预留(两阶段扣费的 hold 记录)。
 *
 * `compute_accounts.frozen_points` 只是个**汇总数字**,冻结的明细没落地 —— 于是:
 *   - settle/release 时不知道该回冲多少
 *   - 网关在 reserve 之后、settle 之前被 kill,frozen_points 永远挂着,
 *     用户点数凭空消失,且**没有线索能找回来**
 *
 * 所以每笔冻结都要有一行记录 + TTL,让 sweeper 能扫出超时的 held 退还。
 */
export const computeReservations = pgTable(
  "compute_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => computeAccounts.id, { onDelete: "cascade" }),
    /** 按最坏情况冻结的点数(output 上界 = max_tokens) */
    reservedPoints: bigint("reserved_points", { mode: "number" }).notNull(),
    state: text("state").notNull().default("held"),
    /** 幂等键:客户端重试同一请求不重复冻结 */
    requestId: text("request_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    model: text("model"),
    /** TTL:超过还挂在 held,就是进程死了,sweeper 负责退还 */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    requestUq: uniqueIndex("compute_reservations_request_uq").on(table.requestId),
    /** sweeper 的查询路径 */
    stateExpiresIdx: index("compute_reservations_state_expires_idx").on(table.state, table.expiresAt),
    accountIdx: index("compute_reservations_account_idx").on(table.accountId, table.createdAt),
    pointsCheck: check("compute_reservations_points_positive", sql`${table.reservedPoints} >= 0`),
    stateCheck: check(
      "compute_reservations_state_check",
      sql`${table.state} in ('held', 'settled', 'released')`,
    ),
  }),
);
