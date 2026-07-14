import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { douyinAccounts } from "./douyin_accounts.js";

/**
 * 账号档案(头表):全体 AI 员工的共享记忆底座,1:1 于抖音账号。
 *
 * curatedSnapshot 是「注入 prompt 的那一份」—— agent 一次读取即可拿到全部档案,
 * 不必扫 facts 表再自己聚合。它由档案管家在 facts 变更后重算并回写。
 * 这块内容每次对话都会带上,是 prompt caching 的天然缓存断点(见 JIN-51:命中可省 94% input)。
 */
export const accountProfiles = pgTable(
  "account_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    douyinAccountId: uuid("douyin_account_id").notNull().references(() => douyinAccounts.id, { onDelete: "cascade" }),
    positioning: text("positioning"),
    targetAudience: text("target_audience"),
    tonePreferences: jsonb("tone_preferences").$type<string[]>().notNull().default([]),
    /** 禁用表达:合规审稿员的硬约束来源 */
    bannedExpressions: jsonb("banned_expressions").$type<string[]>().notNull().default([]),
    effectiveMethods: jsonb("effective_methods").$type<Record<string, unknown>[]>().notNull().default([]),
    curatedSnapshot: jsonb("curated_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    completenessPct: integer("completeness_pct").notNull().default(0),
    missingFields: jsonb("missing_fields").$type<string[]>().notNull().default([]),
    /** 字段规格版本:完整度分母来自代码里的 PROFILE_FIELD_SPEC[specVersion] */
    specVersion: text("spec_version").notNull().default("v1"),
    revision: integer("revision").notNull().default(0),
    lastCuratedByAgentId: uuid("last_curated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    lastCuratedAt: timestamp("last_curated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    douyinAccountUq: uniqueIndex("account_profiles_douyin_account_uq").on(table.douyinAccountId),
    companyIdx: index("account_profiles_company_idx").on(table.companyId),
    completenessCheck: check(
      "account_profiles_completeness_check",
      sql`${table.completenessPct} between 0 and 100`,
    ),
  }),
);

/**
 * 档案事实(字段级):每条事实带来源与置信度。
 *
 * 为什么不是一张宽表就够?因为档案有四个来源(TikHub 同步 / 简历 / 历史文案 / 用户手填),
 * 它们会冲突。宽表只能存「最后写入的那个值」,谁覆盖了谁、凭什么覆盖,全部丢失。
 * 字段级事实表让三件事成为可能:
 *   1. 完整度% = 已填字段数 / 规格要求字段数(可计算,不是人肉估)
 *   2. 缺失项 = 规格字段 - 已有字段(直接得出,驱动「档案管家去补哪一项」)
 *   3. 冲突消解:sourcePriority 让「用户手填」稳定压过「模型推断」,且留有证据链
 */
export const accountProfileFacts = pgTable(
  "account_profile_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull().references(() => accountProfiles.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    value: jsonb("value").notNull(),
    source: text("source").notNull(),
    /** 约定:user=100 > resume=80 > tikhub=60 > history_content=40 > agent_inference=10 */
    sourcePriority: integer("source_priority").notNull().default(0),
    confidence: integer("confidence").notNull().default(100),
    /** 证据链:这条事实是从哪条视频/哪段对话/哪份简历推出来的 */
    evidenceRef: jsonb("evidence_ref").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("active"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    supersededById: uuid("superseded_by_id").references((): AnyPgColumn => accountProfileFacts.id, {
      onDelete: "set null",
    }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 每个字段同一时刻只有一条生效事实 —— 冲突必须被显式消解,不能靠「谁最后写谁赢」 */
    activeFieldUq: uniqueIndex("account_profile_facts_active_field_uq")
      .on(table.profileId, table.fieldKey)
      .where(sql`${table.status} = 'active'`),
    profileStatusIdx: index("account_profile_facts_profile_status_idx").on(table.profileId, table.status),
    companyIdx: index("account_profile_facts_company_idx").on(table.companyId, table.profileId),
    sourceCheck: check(
      "account_profile_facts_source_check",
      sql`${table.source} in ('user', 'tikhub', 'resume', 'history_content', 'agent_inference')`,
    ),
    statusCheck: check(
      "account_profile_facts_status_check",
      sql`${table.status} in ('active', 'superseded', 'rejected')`,
    ),
    confidenceCheck: check("account_profile_facts_confidence_check", sql`${table.confidence} between 0 and 100`),
  }),
);
