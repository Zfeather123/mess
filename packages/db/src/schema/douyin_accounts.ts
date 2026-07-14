import { pgTable, uuid, text, integer, bigint, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * 抖音账号:TikHub 同步的目标,也是「账号档案」「小队」「收藏」的挂载锚点。
 *
 * 边界声明:本表只存账号身份与最新概览。
 * 视频维度的 douyin_videos / douyin_video_metrics(时序)属于 TikHub 同步任务的范围,
 * 由该任务外键到本表 id,避免两边重复定义。
 */
export const douyinAccounts = pgTable(
  "douyin_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    douyinUid: text("douyin_uid"),
    /** sec_uid 是抖音的稳定标识,uid/unique_id 都可能变 */
    secUid: text("sec_uid"),
    uniqueId: text("unique_id"),
    nickname: text("nickname").notNull(),
    avatarUrl: text("avatar_url"),
    signature: text("signature"),
    followerCount: integer("follower_count").notNull().default(0),
    followingCount: integer("following_count").notNull().default(0),
    awemeCount: integer("aweme_count").notNull().default(0),
    totalFavorited: bigint("total_favorited", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("active"),
    tikhubSyncedAt: timestamp("tikhub_synced_at", { withTimezone: true }),
    tikhubSyncError: text("tikhub_sync_error"),
    rawProfile: jsonb("raw_profile").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySecUidUq: uniqueIndex("douyin_accounts_company_sec_uid_uq")
      .on(table.companyId, table.secUid)
      .where(sql`${table.secUid} is not null`),
    companyStatusIdx: index("douyin_accounts_company_status_idx").on(table.companyId, table.status),
    /** 同步调度:找出最久没同步的活跃账号 */
    syncDueIdx: index("douyin_accounts_sync_due_idx")
      .on(table.tikhubSyncedAt)
      .where(sql`${table.status} = 'active'`),
    statusCheck: check("douyin_accounts_status_check", sql`${table.status} in ('active', 'paused', 'archived')`),
  }),
);
