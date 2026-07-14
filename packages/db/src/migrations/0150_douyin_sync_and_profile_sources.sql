-- ============================================================================
-- 0150_douyin_sync_and_profile_sources — TikHub 同步层(作品 / 作品指标 / 档案来源同步状态)
--
-- 承接 0148:douyin_accounts 的表注释把「作品维度」明确划给了 TikHub 同步任务(JIN-54),
-- 这里补齐,外键回挂 douyin_accounts.id,不重复定义账号身份。
--
-- 设计原则同 0148:纯加法,3 张新表,对 Paperclip 原表与 0148 的表**零改动**。
-- 手写 SQL + 手工追加 _journal.json(不跑 drizzle-kit generate —— upstream snapshot 已坏,
-- 跑了会把整片迁移重写掉,这条纪律见 JIN-50)。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. 抖音作品
-- ---------------------------------------------------------------------------
CREATE TABLE "douyin_videos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "douyin_account_id" uuid NOT NULL,
  "aweme_id" text NOT NULL,
  "description" text,
  "published_at" timestamp with time zone,
  "duration_ms" integer,
  "cover_url" text,
  "share_url" text,
  "hashtags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "tikhub_synced_at" timestamp with time zone,
  "raw_aweme" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "douyin_videos_status_check" CHECK ("status" IN ('active', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "douyin_videos" ADD CONSTRAINT "douyin_videos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "douyin_videos" ADD CONSTRAINT "douyin_videos_douyin_account_id_douyin_accounts_id_fk" FOREIGN KEY ("douyin_account_id") REFERENCES "public"."douyin_accounts"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "douyin_videos_company_aweme_uq" ON "douyin_videos" USING btree ("company_id","aweme_id");--> statement-breakpoint
CREATE INDEX "douyin_videos_account_published_idx" ON "douyin_videos" USING btree ("douyin_account_id","published_at" DESC);--> statement-breakpoint
CREATE INDEX "douyin_videos_company_idx" ON "douyin_videos" USING btree ("company_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- B. 作品指标(时序,追加不覆盖)
--
-- ⚠️ play_count 可空是**刻意的**:抖音大多数接口已不再返回播放数,作品列表里的 play_count
-- 基本是 0/缺失,必须额外调 app/v3/fetch_video_statistics 才拿得到(一次最多 2 个 aweme_id)。
-- 「没拉到播放量」(NULL)必须能和「真的 0 播放」(0)区分,否则爆款识别会把没拉到数据的
-- 作品误判成扑街。play_count_source 记录这个数到底可不可信。
-- 详见 docs/jin/TIKHUB_CAPABILITIES.md §4.1。
-- ---------------------------------------------------------------------------
CREATE TABLE "douyin_video_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "video_id" uuid NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "play_count" bigint,
  "play_count_source" text,
  "digg_count" integer DEFAULT 0 NOT NULL,
  "comment_count" integer DEFAULT 0 NOT NULL,
  "share_count" integer DEFAULT 0 NOT NULL,
  "collect_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "douyin_video_metrics_play_source_check" CHECK ("play_count_source" IS NULL OR "play_count_source" IN ('statistics_api', 'aweme_payload')),
  CONSTRAINT "douyin_video_metrics_non_negative_check" CHECK ("digg_count" >= 0 AND "comment_count" >= 0 AND "share_count" >= 0 AND "collect_count" >= 0 AND ("play_count" IS NULL OR "play_count" >= 0))
);
--> statement-breakpoint
ALTER TABLE "douyin_video_metrics" ADD CONSTRAINT "douyin_video_metrics_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "douyin_video_metrics" ADD CONSTRAINT "douyin_video_metrics_video_id_douyin_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."douyin_videos"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "douyin_video_metrics_video_captured_uq" ON "douyin_video_metrics" USING btree ("video_id","captured_at");--> statement-breakpoint
CREATE INDEX "douyin_video_metrics_video_latest_idx" ON "douyin_video_metrics" USING btree ("video_id","captured_at" DESC);--> statement-breakpoint
CREATE INDEX "douyin_video_metrics_company_idx" ON "douyin_video_metrics" USING btree ("company_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- C. 档案来源同步状态(原型第 7 张图:「重新同步全部来源」+ 每来源状态/时间)
--
-- 一行 = 一个档案的一个来源。来源独立成功/独立失败:TikHub 挂了不该让「简历解析成功」一起变红。
-- source 取值与 account_profile_facts.source 对齐,但少一个 agent_inference ——
-- 那是**推断**出来的,不是**同步**来的,没有同步状态可言。
-- ---------------------------------------------------------------------------
CREATE TABLE "profile_sync_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  "source" text NOT NULL,
  "status" text DEFAULT 'never_synced' NOT NULL,
  "last_synced_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "last_error_code" text,
  "last_error_message" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "facts_written" integer DEFAULT 0 NOT NULL,
  "cursor" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "profile_sync_sources_source_check" CHECK ("source" IN ('user', 'tikhub', 'resume', 'history_content')),
  CONSTRAINT "profile_sync_sources_status_check" CHECK ("status" IN ('never_synced', 'syncing', 'synced', 'error'))
);
--> statement-breakpoint
ALTER TABLE "profile_sync_sources" ADD CONSTRAINT "profile_sync_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "profile_sync_sources" ADD CONSTRAINT "profile_sync_sources_profile_id_account_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."account_profiles"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_sync_sources_profile_source_uq" ON "profile_sync_sources" USING btree ("profile_id","source");--> statement-breakpoint
CREATE INDEX "profile_sync_sources_company_idx" ON "profile_sync_sources" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "profile_sync_sources_status_idx" ON "profile_sync_sources" USING btree ("status","last_attempt_at");
