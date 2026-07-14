-- ============================================================================
-- 0151_moments_feed_and_me — 朋友圈信息流三列 + 「我的」两张表(JIN-56)
--
-- 承接 0148:moments / moment_likes / moment_comments 三张表已经建好,这里只补
-- 「信息流刷起来」缺的三列,以及「我的」页面绕不开的两张表。
--
-- 设计原则同 0148 / 0150:纯加法。对 Paperclip 原表零改动;对 0148 的表只 ADD COLUMN
-- (带 DEFAULT,不回填、不重写),不动已有列、不动已有约束。
-- 手写 SQL + 手工追加 _journal.json —— 不跑 drizzle-kit generate(upstream snapshot 已坏,
-- 跑了会把整片迁移重写掉,这条纪律见 JIN-50)。
--
-- ⚠️ 收藏(朋友圈的「收藏」动作)**不在这里建表** —— 0148 的 collection_items 已经有
-- source_moment_id 外键,收藏一条动态 = 往知识库塞一条 item。另建 moment_favorites 会
-- 造出第二份真相:用户在「收藏」模块里删掉它,朋友圈上的收藏星标却还亮着。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. moments 补三列:category / tags / card
--
-- category 为什么不复用 kind:两个轴。
--   kind     = 这条动态是什么性质的产出(update / insight / milestone / work_product)
--   category = 用户在哪个 tab 下看到它(AI员工动态 / 行业资讯 / 服务推广)
-- 合成一个会互相拧:操盘手的「本周点评名额剩余 2 个」kind 是 update,但它属于服务推广,
-- 不该混进员工动态流。
--
-- DEFAULT 'ai_update' 让存量行(如果有)自动落进员工动态 tab,不需要回填脚本。
-- ---------------------------------------------------------------------------
ALTER TABLE "moments" ADD COLUMN "category" text DEFAULT 'ai_update' NOT NULL;--> statement-breakpoint
ALTER TABLE "moments" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- 结构化卡片(方法包 / 禁用规则 / 趋势 / 服务名额)。卡片才是朋友圈的信息密度所在:
-- 「已更新『高净值场景开头』方法 v2.1」下面那张能点进去的方法包卡,是这条动态的价值本体。
ALTER TABLE "moments" ADD COLUMN "card" jsonb;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_category_check" CHECK ("category" IN ('ai_update', 'industry', 'promo'));--> statement-breakpoint

-- 信息流按分类刷:(company, category, created_at desc),软删的行不进索引。
CREATE INDEX "moments_company_category_feed_idx" ON "moments" USING btree ("company_id","category","created_at" DESC) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "moments_tags_idx" ON "moments" USING gin ("tags");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- B. coach_bindings — 绑定操盘手(真人)
--
-- 操盘手是**供给方**:他造 agent 卖给用户,还提供真人点评服务。所以这不是 agent 关系,
-- 是「用户 ↔ 真人」的关系,不能塞进 squad_members(那里装的是 AI 员工)。
--
-- 一个用户在一家公司下只能绑一个操盘手(唯一约束) —— 「更换操盘手」是 UPDATE 不是 INSERT,
-- 否则「我现在的操盘手是谁」会有多个答案。
--
-- conversation_id 指向和这位操盘手的私聊会话(0148 的 conversations,kind='direct')。
-- 可空 = 还没聊过;点「私聊」时服务端现建再回填。
-- ---------------------------------------------------------------------------
CREATE TABLE "coach_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "coach_user_id" text NOT NULL,
  "coach_name" text NOT NULL,
  "coach_title" text,
  "coach_avatar_url" text,
  "coach_bio" text,
  "conversation_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "bound_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "coach_bindings_status_check" CHECK ("status" IN ('active', 'ended')),
  -- 自己不能绑自己当操盘手
  CONSTRAINT "coach_bindings_not_self_check" CHECK ("coach_user_id" <> "user_id")
);
--> statement-breakpoint
ALTER TABLE "coach_bindings" ADD CONSTRAINT "coach_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "coach_bindings" ADD CONSTRAINT "coach_bindings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null;--> statement-breakpoint
-- 「当前绑定」唯一:一个用户在一家公司下只有一个 active 的操盘手。
-- 历史绑定(status='ended')不受约束,换过谁留得下痕迹。
CREATE UNIQUE INDEX "coach_bindings_active_uq" ON "coach_bindings" USING btree ("company_id","user_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "coach_bindings_coach_idx" ON "coach_bindings" USING btree ("company_id","coach_user_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- C. user_notification_prefs — 通知设置
--
-- 三个开关对应原型:今日任务提醒 / 员工工作小结 / 合规风险提醒。
-- 三列 boolean 而不是一个 jsonb:开关是有限且稳定的枚举,列出来才能被 SQL 直接筛
-- (「给所有开了合规提醒的用户推送」是一条 WHERE,不是全表扫 jsonb)。
--
-- 默认全开:新用户不该因为「没设置过」就收不到合规风险提醒 —— 那是这个产品里最不该
-- 静默失败的一条。
-- ---------------------------------------------------------------------------
CREATE TABLE "user_notification_prefs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "notify_daily_tasks" boolean DEFAULT true NOT NULL,
  "notify_agent_summary" boolean DEFAULT true NOT NULL,
  "notify_compliance_risk" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_notification_prefs" ADD CONSTRAINT "user_notification_prefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "user_notification_prefs_company_user_uq" ON "user_notification_prefs" USING btree ("company_id","user_id");
