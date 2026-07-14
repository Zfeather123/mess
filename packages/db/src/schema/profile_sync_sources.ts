import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { accountProfiles } from "./account_profiles.js";

/**
 * 档案来源同步状态:原型第 7 张图「重新同步全部来源」下面那一排状态行。
 *
 * 一行 = 一个档案的一个来源。为什么要单独一张表,而不是在 account_profiles 上开几个列:
 *   1. 来源是会加的(第二期要加「私信记录」「直播回放」),开列就要改表,建行不用
 *   2. 每个来源的同步是**独立成功/独立失败**的 —— TikHub 挂了不该让「简历解析成功」一起变红。
 *      状态挂在来源上,UI 才能一行绿一行红地如实显示
 *   3. 失败要能重试:attempt_count / next_retry_at 挂在来源粒度上才有意义
 *
 * source 的取值与 account_profile_facts.source 的 CHECK 保持一致(user/tikhub/resume/history_content),
 * 少了 agent_inference —— 那是**推断**出来的,不是**同步**来的,没有「同步状态」可言。
 */
export const profileSyncSources = pgTable(
  "profile_sync_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull().references(() => accountProfiles.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    status: text("status").notNull().default("never_synced"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** 稳定错误码(给 UI 分支用),人话错误写 last_error_message */
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    /** 本次同步产出了几条事实 —— 「同步了但什么都没拿到」和「没同步」要能分开 */
    factsWritten: integer("facts_written").notNull().default(0),
    /** 来源特有的游标/引用:TikHub 存 max_cursor,简历存 attachment_id */
    cursor: jsonb("cursor").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 一个档案的一个来源只有一行 —— 「重新同步」是 upsert,不是每次插一条新记录 */
    profileSourceUq: uniqueIndex("profile_sync_sources_profile_source_uq").on(table.profileId, table.source),
    companyIdx: index("profile_sync_sources_company_idx").on(table.companyId),
    /** 调度:找出该重试的来源 */
    statusIdx: index("profile_sync_sources_status_idx").on(table.status, table.lastAttemptAt),
    sourceCheck: check(
      "profile_sync_sources_source_check",
      sql`${table.source} in ('user', 'tikhub', 'resume', 'history_content')`,
    ),
    statusCheck: check(
      "profile_sync_sources_status_check",
      sql`${table.status} in ('never_synced', 'syncing', 'synced', 'error')`,
    ),
  }),
);
