import { pgTable, uuid, text, integer, bigint, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { douyinAccounts } from "./douyin_accounts.js";

/**
 * 抖音作品:TikHub 同步的第二层(账号 → 作品 → 指标)。
 *
 * 0148 里 douyin_accounts 的注释把这张表的所有权划给了「TikHub 同步任务」(= JIN-54),
 * 这里补上,外键回挂 douyin_accounts.id,不重复定义账号身份。
 *
 * 作品是「有效方法」的证据来源:档案里那条 effective_methods 事实说
 * 「开头具体身份+风险场景的视频完播更好」,evidence_ref 就指回这里的 aweme_id。
 */
export const douyinVideos = pgTable(
  "douyin_videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    douyinAccountId: uuid("douyin_account_id").notNull().references(() => douyinAccounts.id, { onDelete: "cascade" }),
    awemeId: text("aweme_id").notNull(),
    /** 抖音的 desc 字段 = 我们所说的「标题/文案」,是选题与话术分析的主输入 */
    description: text("description"),
    /** 抖音返回秒级 unix,这里落成 timestamptz,查询才用得上索引 */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    coverUrl: text("cover_url"),
    shareUrl: text("share_url"),
    /** text_extra[] 里的话题词,提炼「业务领域」事实用 */
    hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    tikhubSyncedAt: timestamp("tikhub_synced_at", { withTimezone: true }),
    rawAweme: jsonb("raw_aweme").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** aweme_id 在抖音全局唯一,但仍按 company 收口,避免跨租户串数据 */
    companyAwemeUq: uniqueIndex("douyin_videos_company_aweme_uq").on(table.companyId, table.awemeId),
    /** 「这个账号最近发了什么」—— 档案预填与选题分析的主查询 */
    accountPublishedIdx: index("douyin_videos_account_published_idx").on(
      table.douyinAccountId,
      table.publishedAt.desc(),
    ),
    companyIdx: index("douyin_videos_company_idx").on(table.companyId),
    statusCheck: check("douyin_videos_status_check", sql`${table.status} in ('active', 'deleted')`),
  }),
);

/**
 * 作品指标(时序):同一条作品每次同步追加一行,不覆盖。
 *
 * ⚠️ 为什么 play_count 可空、且单列一个 source —— 这是 TikHub 的头号坑:
 * 抖音大多数接口**已经不再返回播放数**,作品列表里的 play_count 基本是 0/缺失,
 * 必须额外调 app/v3/fetch_video_statistics(一次最多 2 个 aweme_id)才拿得到。
 * 所以「没同步到播放量」(null)和「真的是 0 播放」(0)必须能区分,
 * 否则爆款识别会把没拉到数据的作品判成扑街。见 docs/jin/TIKHUB_CAPABILITIES.md §4.1。
 *
 * 时序而非宽表:互动数会随时间涨,「发布 48h 内的点赞增速」才是判断爆款的信号,
 * 只存最新值就永远算不出增速。
 */
export const douyinVideoMetrics = pgTable(
  "douyin_video_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    videoId: uuid("video_id").notNull().references(() => douyinVideos.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    /** null = 本次没拉到播放量(≠ 0 播放)。see 表注释 */
    playCount: bigint("play_count", { mode: "number" }),
    /** 播放量是从哪个接口拿的:statistics_api = 专用统计接口(可信)/ aweme_payload = 列表里带的(多半是 0,不可信) */
    playCountSource: text("play_count_source"),
    diggCount: integer("digg_count").notNull().default(0),
    commentCount: integer("comment_count").notNull().default(0),
    shareCount: integer("share_count").notNull().default(0),
    collectCount: integer("collect_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 同一条作品同一采集时刻只有一行,重放同步不会写重 */
    videoCapturedUq: uniqueIndex("douyin_video_metrics_video_captured_uq").on(table.videoId, table.capturedAt),
    /** 取某条作品最新一次指标:(video_id, captured_at desc) 直接走索引 */
    videoLatestIdx: index("douyin_video_metrics_video_latest_idx").on(table.videoId, table.capturedAt.desc()),
    companyIdx: index("douyin_video_metrics_company_idx").on(table.companyId),
    playSourceCheck: check(
      "douyin_video_metrics_play_source_check",
      sql`${table.playCountSource} is null or ${table.playCountSource} in ('statistics_api', 'aweme_payload')`,
    ),
    nonNegativeCheck: check(
      "douyin_video_metrics_non_negative_check",
      sql`${table.diggCount} >= 0 and ${table.commentCount} >= 0 and ${table.shareCount} >= 0 and ${table.collectCount} >= 0 and (${table.playCount} is null or ${table.playCount} >= 0)`,
    ),
  }),
);
