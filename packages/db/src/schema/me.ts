import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { conversations } from "./conversations.js";

/**
 * 绑定操盘手(JIN-56)。
 *
 * 操盘手是**供给方**:他造 agent 卖给用户,还提供真人点评服务。所以这是「用户 ↔ 真人」
 * 的关系,不是「用户 ↔ AI 员工」—— 塞不进 squad_members(那里装的是 AI 员工)。
 *
 * 一个用户在一家公司下只能有一个 active 操盘手:「更换操盘手」是把旧行置 ended 再插新行,
 * 「我现在的操盘手是谁」永远只有一个答案。历史绑定留痕,换过谁查得到。
 */
export const coachBindings = pgTable(
  "coach_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    coachUserId: text("coach_user_id").notNull(),
    /**
     * 操盘手的展示信息在这里冗余一份:操盘手是外部供给方,不一定是本 company 的成员,
     * 未必能从 user 表 join 出来。信息流/「我的」页要显示名字和头衔,现查不到就得留空。
     */
    coachName: text("coach_name").notNull(),
    coachTitle: text("coach_title"),
    coachAvatarUrl: text("coach_avatar_url"),
    coachBio: text("coach_bio"),
    /** 和这位操盘手的私聊会话(conversations.kind='direct')。空 = 还没聊过,点「私聊」时现建。 */
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeUq: uniqueIndex("coach_bindings_active_uq")
      .on(table.companyId, table.userId)
      .where(sql`${table.status} = 'active'`),
    coachIdx: index("coach_bindings_coach_idx").on(table.companyId, table.coachUserId),
    statusCheck: check("coach_bindings_status_check", sql`${table.status} in ('active', 'ended')`),
    notSelfCheck: check("coach_bindings_not_self_check", sql`${table.coachUserId} <> ${table.userId}`),
  }),
);

/**
 * 通知设置(JIN-56):今日任务提醒 / 员工工作小结 / 合规风险提醒。
 *
 * 三列 boolean 而不是一个 jsonb:开关是有限且稳定的枚举,列出来才能被 SQL 直接筛
 * (「推给所有开了合规提醒的用户」是一条 WHERE,不是全表扫 jsonb)。
 *
 * 默认全开 —— 新用户不该因为「没设置过」就静默收不到合规风险提醒,那是这个产品里
 * 最不该失败的一条推送。没有行 = 用默认值,读的时候不写库。
 */
export const userNotificationPrefs = pgTable(
  "user_notification_prefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    notifyDailyTasks: boolean("notify_daily_tasks").notNull().default(true),
    notifyAgentSummary: boolean("notify_agent_summary").notNull().default(true),
    notifyComplianceRisk: boolean("notify_compliance_risk").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUq: uniqueIndex("user_notification_prefs_company_user_uq").on(
      table.companyId,
      table.userId,
    ),
  }),
);
