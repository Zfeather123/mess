-- ============================================================================
-- 0148_collab_layer — 协作层数据模型(小队路由 / 账号档案 / IM / 收藏 / Agent 学习 / 朋友圈 / 算力)
--
-- 设计原则:纯加法。21 张新表 + 对 Paperclip 原表仅 1 处可空列新增(issues.owner_squad_id),
-- 保住 upstream 可合并性。所有表以 company_id 为租户锚点,复合索引 company_id 前置,
-- 与 Paperclip 既有约定一致。domain 表不外键到 better-auth 的 "user" 表(沿用 Paperclip 约定:
-- user_id 为裸 text),避免 auth 层替换时的连锁改动。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. 小队与队长路由
-- ---------------------------------------------------------------------------
CREATE TABLE "squads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "project_id" uuid,
  "name" text NOT NULL,
  "description" text,
  "leader_agent_id" uuid,
  "douyin_account_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "dispatch_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "squads_status_check" CHECK ("status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "squads" ADD CONSTRAINT "squads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "squads" ADD CONSTRAINT "squads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "squads" ADD CONSTRAINT "squads_leader_agent_id_agents_id_fk" FOREIGN KEY ("leader_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "squads_company_status_idx" ON "squads" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "squads_company_project_idx" ON "squads" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "squads_leader_idx" ON "squads" USING btree ("leader_agent_id");--> statement-breakpoint

CREATE TABLE "squad_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "squad_id" uuid NOT NULL,
  "member_type" text NOT NULL,
  "agent_id" uuid,
  "user_id" text,
  "role" text DEFAULT 'member' NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "squad_members_member_type_check" CHECK ("member_type" IN ('agent', 'user')),
  CONSTRAINT "squad_members_role_check" CHECK ("role" IN ('leader', 'member')),
  -- 成员身份 XOR:agent 成员必须有 agent_id 且无 user_id,反之亦然
  CONSTRAINT "squad_members_principal_check" CHECK (
    ("member_type" = 'agent' AND "agent_id" IS NOT NULL AND "user_id" IS NULL)
    OR ("member_type" = 'user' AND "user_id" IS NOT NULL AND "agent_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "squad_members" ADD CONSTRAINT "squad_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "squad_members" ADD CONSTRAINT "squad_members_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "squad_members" ADD CONSTRAINT "squad_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "squad_members_squad_agent_uq" ON "squad_members" USING btree ("squad_id","agent_id") WHERE "agent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "squad_members_squad_user_uq" ON "squad_members" USING btree ("squad_id","user_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
-- 一个小队最多一个队长
CREATE UNIQUE INDEX "squad_members_single_leader_uq" ON "squad_members" USING btree ("squad_id") WHERE "role" = 'leader';--> statement-breakpoint
CREATE INDEX "squad_members_company_squad_idx" ON "squad_members" USING btree ("company_id","squad_id");--> statement-breakpoint
CREATE INDEX "squad_members_agent_idx" ON "squad_members" USING btree ("agent_id");--> statement-breakpoint

-- 派单记录:任务派给小队 -> 队长决定分给谁。既是路由队列,也是审计轨迹。
CREATE TABLE "squad_dispatches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "squad_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "requested_by_type" text NOT NULL,
  "requested_by_user_id" text,
  "requested_by_agent_id" uuid,
  "source_message_id" uuid,
  "assigned_agent_id" uuid,
  "assigned_user_id" text,
  "decided_by_agent_id" uuid,
  "decision_reason" text,
  "decided_at" timestamp with time zone,
  "failure_reason" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "squad_dispatches_state_check" CHECK ("state" IN ('pending', 'dispatched', 'reassigned', 'declined', 'failed')),
  CONSTRAINT "squad_dispatches_requested_by_check" CHECK ("requested_by_type" IN ('user', 'agent', 'system'))
);
--> statement-breakpoint
ALTER TABLE "squad_dispatches" ADD CONSTRAINT "squad_dispatches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "squad_dispatches" ADD CONSTRAINT "squad_dispatches_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "squad_dispatches" ADD CONSTRAINT "squad_dispatches_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "squad_dispatches" ADD CONSTRAINT "squad_dispatches_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "squad_dispatches" ADD CONSTRAINT "squad_dispatches_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;--> statement-breakpoint
-- 一个 issue 同时只能有一条未决派单(防止重复派单/并发双写)
CREATE UNIQUE INDEX "squad_dispatches_issue_pending_uq" ON "squad_dispatches" USING btree ("issue_id") WHERE "state" = 'pending';--> statement-breakpoint
-- 队长拉取待办队列的热路径
CREATE INDEX "squad_dispatches_pending_queue_idx" ON "squad_dispatches" USING btree ("company_id","squad_id","created_at") WHERE "state" = 'pending';--> statement-breakpoint
CREATE INDEX "squad_dispatches_company_issue_idx" ON "squad_dispatches" USING btree ("company_id","issue_id");--> statement-breakpoint

-- Paperclip 原表唯一改动:可空列 + 部分索引(无默认值 => 不重写表,无锁风险)
ALTER TABLE "issues" ADD COLUMN "owner_squad_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_squad_id_squads_id_fk" FOREIGN KEY ("owner_squad_id") REFERENCES "public"."squads"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "issues_company_owner_squad_status_idx" ON "issues" USING btree ("company_id","owner_squad_id","status") WHERE "owner_squad_id" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- B. 抖音账号 + 账号档案(全体 AI 员工的共享记忆底座)
-- ---------------------------------------------------------------------------
CREATE TABLE "douyin_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "project_id" uuid,
  "douyin_uid" text,
  "sec_uid" text,
  "unique_id" text,
  "nickname" text NOT NULL,
  "avatar_url" text,
  "signature" text,
  "follower_count" integer DEFAULT 0 NOT NULL,
  "following_count" integer DEFAULT 0 NOT NULL,
  "aweme_count" integer DEFAULT 0 NOT NULL,
  "total_favorited" bigint DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "tikhub_synced_at" timestamp with time zone,
  "tikhub_sync_error" text,
  "raw_profile" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "douyin_accounts_status_check" CHECK ("status" IN ('active', 'paused', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "douyin_accounts" ADD CONSTRAINT "douyin_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "douyin_accounts" ADD CONSTRAINT "douyin_accounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null;--> statement-breakpoint
CREATE UNIQUE INDEX "douyin_accounts_company_sec_uid_uq" ON "douyin_accounts" USING btree ("company_id","sec_uid") WHERE "sec_uid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "douyin_accounts_company_status_idx" ON "douyin_accounts" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "douyin_accounts_sync_due_idx" ON "douyin_accounts" USING btree ("tikhub_synced_at") WHERE "status" = 'active';--> statement-breakpoint

ALTER TABLE "squads" ADD CONSTRAINT "squads_douyin_account_id_douyin_accounts_id_fk" FOREIGN KEY ("douyin_account_id") REFERENCES "public"."douyin_accounts"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "squads_douyin_account_idx" ON "squads" USING btree ("douyin_account_id");--> statement-breakpoint

-- 档案头表:1:1 于账号。curated_snapshot 是注入 prompt 的「共享记忆」快照,
-- 让 agent 一次读取即可,不必扫 facts 表。completeness/missing 由档案管家维护。
CREATE TABLE "account_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "douyin_account_id" uuid NOT NULL,
  "positioning" text,
  "target_audience" text,
  "tone_preferences" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "banned_expressions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "effective_methods" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "curated_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "completeness_pct" integer DEFAULT 0 NOT NULL,
  "missing_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "spec_version" text DEFAULT 'v1' NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "last_curated_by_agent_id" uuid,
  "last_curated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_profiles_completeness_check" CHECK ("completeness_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "account_profiles" ADD CONSTRAINT "account_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "account_profiles" ADD CONSTRAINT "account_profiles_douyin_account_id_douyin_accounts_id_fk" FOREIGN KEY ("douyin_account_id") REFERENCES "public"."douyin_accounts"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "account_profiles" ADD CONSTRAINT "account_profiles_last_curated_by_agent_id_agents_id_fk" FOREIGN KEY ("last_curated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_profiles_douyin_account_uq" ON "account_profiles" USING btree ("douyin_account_id");--> statement-breakpoint
CREATE INDEX "account_profiles_company_idx" ON "account_profiles" USING btree ("company_id");--> statement-breakpoint

-- 字段级事实表:每条事实带来源与置信度。完整度% / 缺失项由此可计算,
-- 且「用户手填」可稳定压过「模型推断」——这是档案能被信任的前提。
CREATE TABLE "account_profile_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  "field_key" text NOT NULL,
  "value" jsonb NOT NULL,
  "source" text NOT NULL,
  "source_priority" integer DEFAULT 0 NOT NULL,
  "confidence" integer DEFAULT 100 NOT NULL,
  "evidence_ref" jsonb,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "superseded_by_id" uuid,
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_profile_facts_source_check" CHECK ("source" IN ('user', 'tikhub', 'resume', 'history_content', 'agent_inference')),
  CONSTRAINT "account_profile_facts_status_check" CHECK ("status" IN ('active', 'superseded', 'rejected')),
  CONSTRAINT "account_profile_facts_confidence_check" CHECK ("confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "account_profile_facts" ADD CONSTRAINT "account_profile_facts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "account_profile_facts" ADD CONSTRAINT "account_profile_facts_profile_id_account_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."account_profiles"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "account_profile_facts" ADD CONSTRAINT "account_profile_facts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "account_profile_facts" ADD CONSTRAINT "account_profile_facts_superseded_by_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."account_profile_facts"("id") ON DELETE set null;--> statement-breakpoint
-- 每个字段同一时刻只有一条生效事实(冲突消解后的结果)
CREATE UNIQUE INDEX "account_profile_facts_active_field_uq" ON "account_profile_facts" USING btree ("profile_id","field_key") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "account_profile_facts_profile_status_idx" ON "account_profile_facts" USING btree ("profile_id","status");--> statement-breakpoint
CREATE INDEX "account_profile_facts_company_idx" ON "account_profile_facts" USING btree ("company_id","profile_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- C. IM 消息(群聊 / 私聊 / 线程 / 卡片 / @提及 / 已读)
-- ---------------------------------------------------------------------------
CREATE TABLE "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "project_id" uuid,
  "squad_id" uuid,
  "douyin_account_id" uuid,
  "kind" text NOT NULL,
  "title" text,
  "avatar_url" text,
  -- 会话内单调递增序号的分配源。消息插入与 last_seq 自增在同一事务内完成,
  -- 保证每会话消息全序且无空洞;WebSocket 推送与客户端补洞都依赖它。
  -- created_at 不可用于排序:同毫秒并发 + 时钟漂移都会乱序。
  "last_seq" bigint DEFAULT 0 NOT NULL,
  "last_message_id" uuid,
  "last_message_at" timestamp with time zone,
  "created_by_type" text DEFAULT 'user' NOT NULL,
  "created_by_user_id" text,
  "created_by_agent_id" uuid,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversations_kind_check" CHECK ("kind" IN ('group', 'direct'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_douyin_account_id_douyin_accounts_id_fk" FOREIGN KEY ("douyin_account_id") REFERENCES "public"."douyin_accounts"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "conversations_company_recent_idx" ON "conversations" USING btree ("company_id","last_message_at" DESC);--> statement-breakpoint
CREATE INDEX "conversations_company_squad_idx" ON "conversations" USING btree ("company_id","squad_id");--> statement-breakpoint

CREATE TABLE "conversation_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "member_type" text NOT NULL,
  "user_id" text,
  "agent_id" uuid,
  "role" text DEFAULT 'member' NOT NULL,
  -- 已读游标:微信式群聊只需「未读数」,不需要每条消息的已读回执。
  -- unread = conversations.last_seq - last_read_seq,O(1) 计算,无需 messages 扫描。
  "last_read_seq" bigint DEFAULT 0 NOT NULL,
  "last_read_at" timestamp with time zone,
  "muted" boolean DEFAULT false NOT NULL,
  "pinned" boolean DEFAULT false NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "left_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_members_member_type_check" CHECK ("member_type" IN ('agent', 'user')),
  CONSTRAINT "conversation_members_role_check" CHECK ("role" IN ('owner', 'admin', 'member')),
  CONSTRAINT "conversation_members_principal_check" CHECK (
    ("member_type" = 'agent' AND "agent_id" IS NOT NULL AND "user_id" IS NULL)
    OR ("member_type" = 'user' AND "user_id" IS NOT NULL AND "agent_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_conv_agent_uq" ON "conversation_members" USING btree ("conversation_id","agent_id") WHERE "agent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_conv_user_uq" ON "conversation_members" USING btree ("conversation_id","user_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
-- 「我的会话列表」热路径
CREATE INDEX "conversation_members_user_idx" ON "conversation_members" USING btree ("company_id","user_id") WHERE "left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "conversation_members_agent_idx" ON "conversation_members" USING btree ("company_id","agent_id") WHERE "left_at" IS NULL;--> statement-breakpoint

CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "seq" bigint NOT NULL,
  "sender_type" text NOT NULL,
  "sender_user_id" text,
  "sender_agent_id" uuid,
  "kind" text DEFAULT 'text' NOT NULL,
  "body" text,
  -- 卡片消息:选题列表 / 文案初稿 / 诊断报告 / 待确认审批 等结构化载荷。
  -- card_payload 只存渲染所需的快照 + 指向权威实体的外键,避免 UI 二次拉取,
  -- 同时保证点击卡片能落到真实实体(issue / document / approval)。
  "card_type" text,
  "card_payload" jsonb,
  "issue_id" uuid,
  "document_id" uuid,
  "approval_id" uuid,
  "reply_to_message_id" uuid,
  "thread_root_id" uuid,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "heartbeat_run_id" uuid,
  "client_nonce" text,
  "edited_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "messages_sender_type_check" CHECK ("sender_type" IN ('user', 'agent', 'system')),
  CONSTRAINT "messages_kind_check" CHECK ("kind" IN ('text', 'card', 'image', 'file', 'system')),
  CONSTRAINT "messages_card_check" CHECK ("kind" <> 'card' OR "card_type" IS NOT NULL),
  CONSTRAINT "messages_sender_principal_check" CHECK (
    ("sender_type" = 'agent' AND "sender_agent_id" IS NOT NULL AND "sender_user_id" IS NULL)
    OR ("sender_type" = 'user' AND "sender_user_id" IS NOT NULL AND "sender_agent_id" IS NULL)
    OR ("sender_type" = 'system' AND "sender_agent_id" IS NULL AND "sender_user_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_root_id_fk" FOREIGN KEY ("thread_root_id") REFERENCES "public"."messages"("id") ON DELETE set null;--> statement-breakpoint
-- 全序保证:每会话 seq 唯一。也是分页游标(keyset pagination)。
CREATE UNIQUE INDEX "messages_conversation_seq_uq" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
-- 倒序拉取最近 N 条(打开会话的首屏查询)
CREATE INDEX "messages_conversation_seq_desc_idx" ON "messages" USING btree ("conversation_id","seq" DESC);--> statement-breakpoint
-- 客户端重发幂等:同一 nonce 只落一条
CREATE UNIQUE INDEX "messages_client_nonce_uq" ON "messages" USING btree ("conversation_id","client_nonce") WHERE "client_nonce" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_root_id","seq") WHERE "thread_root_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_company_issue_idx" ON "messages" USING btree ("company_id","issue_id") WHERE "issue_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_last_message_id_messages_id_fk" FOREIGN KEY ("last_message_id") REFERENCES "public"."messages"("id") ON DELETE set null;--> statement-breakpoint

CREATE TABLE "message_mentions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "mention_type" text NOT NULL,
  "user_id" text,
  "agent_id" uuid,
  "squad_id" uuid,
  -- agent 被 @ 时要不要唤醒执行:由服务层写入,唤醒后回填 run
  "wakeup_state" text DEFAULT 'none' NOT NULL,
  "heartbeat_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_mentions_type_check" CHECK ("mention_type" IN ('user', 'agent', 'squad', 'all')),
  CONSTRAINT "message_mentions_wakeup_check" CHECK ("wakeup_state" IN ('none', 'pending', 'triggered', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_squad_id_squads_id_fk" FOREIGN KEY ("squad_id") REFERENCES "public"."squads"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "message_mentions_message_idx" ON "message_mentions" USING btree ("message_id");--> statement-breakpoint
-- 「@我的」红点
CREATE INDEX "message_mentions_user_idx" ON "message_mentions" USING btree ("company_id","user_id","created_at" DESC) WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_mentions_agent_pending_idx" ON "message_mentions" USING btree ("agent_id","created_at") WHERE "wakeup_state" = 'pending';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- D. 收藏(知识库)+ 按 AI 员工粒度的「可被引用」开关
-- ---------------------------------------------------------------------------
CREATE TABLE "collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "parent_id" uuid,
  "douyin_account_id" uuid,
  "name" text NOT NULL,
  "description" text,
  "icon" text,
  "position" integer DEFAULT 0 NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."collections"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_douyin_account_id_douyin_accounts_id_fk" FOREIGN KEY ("douyin_account_id") REFERENCES "public"."douyin_accounts"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "collections_company_parent_idx" ON "collections" USING btree ("company_id","parent_id","position");--> statement-breakpoint

CREATE TABLE "collection_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "collection_id" uuid,
  "douyin_account_id" uuid,
  "title" text NOT NULL,
  "content_type" text DEFAULT 'text' NOT NULL,
  "body" text,
  "url" text,
  "document_id" uuid,
  "source_message_id" uuid,
  "source_moment_id" uuid,
  "media" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  -- 引用权限:默认开关 + 例外表。默认 true,例外行只存「与默认不同」的 agent,
  -- 所以授权表始终很小(产品里 账号诊断师=false 就是一行例外)。
  "default_citable" boolean DEFAULT true NOT NULL,
  "created_by_type" text DEFAULT 'user' NOT NULL,
  "created_by_user_id" text,
  "created_by_agent_id" uuid,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "collection_items_content_type_check" CHECK ("content_type" IN ('text', 'link', 'image', 'video', 'document', 'message', 'moment'))
);
--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_douyin_account_id_douyin_accounts_id_fk" FOREIGN KEY ("douyin_account_id") REFERENCES "public"."douyin_accounts"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX "collection_items_company_collection_idx" ON "collection_items" USING btree ("company_id","collection_id","created_at" DESC) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "collection_items_account_citable_idx" ON "collection_items" USING btree ("company_id","douyin_account_id") WHERE "deleted_at" IS NULL AND "default_citable" = true;--> statement-breakpoint
CREATE INDEX "collection_items_tags_idx" ON "collection_items" USING gin ("tags");--> statement-breakpoint

CREATE TABLE "collection_citation_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "allowed" boolean NOT NULL,
  "granted_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_citation_grants" ADD CONSTRAINT "collection_citation_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "collection_citation_grants" ADD CONSTRAINT "collection_citation_grants_item_id_collection_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."collection_items"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "collection_citation_grants" ADD CONSTRAINT "collection_citation_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_citation_grants_item_agent_uq" ON "collection_citation_grants" USING btree ("item_id","agent_id");--> statement-breakpoint
-- agent 取「我可引用的条目」时按 agent 过滤例外
CREATE INDEX "collection_citation_grants_agent_idx" ON "collection_citation_grants" USING btree ("company_id","agent_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- E. Agent 反馈学习(「最近被纠正」/「下次注意」)
-- ---------------------------------------------------------------------------
CREATE TABLE "agent_feedback_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  -- 作用域:全局 / 某个抖音账号 / 某个项目。同一 agent 服务多账号时,
  -- 「上次这个账号不让说'家人们'」不应该污染另一个账号。
  "scope_type" text DEFAULT 'global' NOT NULL,
  "douyin_account_id" uuid,
  "project_id" uuid,
  "kind" text NOT NULL,
  "content" text NOT NULL,
  "source_type" text NOT NULL,
  "source_message_id" uuid,
  "source_issue_id" uuid,
  "source_approval_id" uuid,
  "created_by_user_id" text,
  "created_by_agent_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  -- 注入 prompt 时按 weight desc, created_at desc 取 top-N(注意力有限,不能全塞)
  "weight" integer DEFAULT 100 NOT NULL,
  "times_applied" integer DEFAULT 0 NOT NULL,
  "last_applied_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_feedback_notes_scope_check" CHECK ("scope_type" IN ('global', 'douyin_account', 'project')),
  CONSTRAINT "agent_feedback_notes_kind_check" CHECK ("kind" IN ('correction', 'reminder', 'preference')),
  CONSTRAINT "agent_feedback_notes_source_check" CHECK ("source_type" IN ('user_message', 'approval_rejection', 'review', 'self_reflection', 'manual')),
  CONSTRAINT "agent_feedback_notes_status_check" CHECK ("status" IN ('active', 'archived', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "agent_feedback_notes" ADD CONSTRAINT "agent_feedback_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "agent_feedback_notes" ADD CONSTRAINT "agent_feedback_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "agent_feedback_notes" ADD CONSTRAINT "agent_feedback_notes_douyin_account_id_fk" FOREIGN KEY ("douyin_account_id") REFERENCES "public"."douyin_accounts"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "agent_feedback_notes" ADD CONSTRAINT "agent_feedback_notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "agent_feedback_notes" ADD CONSTRAINT "agent_feedback_notes_source_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "agent_feedback_notes" ADD CONSTRAINT "agent_feedback_notes_source_issue_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null;--> statement-breakpoint
-- prompt 注入热路径:某 agent 的生效笔记按权重取 top-N。
-- ⚠️ 排序键之前不要放 scope 列:真实查询是 (scope='global' OR douyin_account_id=X) 的 OR,
-- 若把 douyin_account_id 放进索引前缀,planner 只能走 bitmap scan(bitmap 不保序)→ 回退成
-- 全量取回 + top-N sort。实测 50k 笔记时:含 scope 前缀 = Seq Scan 45k 行 / 15.9ms;
-- 去掉 scope 前缀后 = 有序 Index Scan,读满 20 行即停 / 0.30ms(约 45 倍)。
-- scope 作为 filter 回查即可——同一 agent 的笔记绝大多数在 scope 内,提前终止几乎立即命中。
CREATE INDEX "agent_feedback_notes_inject_idx" ON "agent_feedback_notes" USING btree ("agent_id","weight" DESC,"created_at" DESC) WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "agent_feedback_notes_company_agent_idx" ON "agent_feedback_notes" USING btree ("company_id","agent_id","status");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- F. 朋友圈(agent 主动发的动态流)
-- ---------------------------------------------------------------------------
CREATE TABLE "moments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "project_id" uuid,
  "douyin_account_id" uuid,
  "author_type" text NOT NULL,
  "author_agent_id" uuid,
  "author_user_id" text,
  "content" text NOT NULL,
  "media" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "kind" text DEFAULT 'update' NOT NULL,
  "issue_id" uuid,
  "document_id" uuid,
  "visibility" text DEFAULT 'company' NOT NULL,
  "like_count" integer DEFAULT 0 NOT NULL,
  "comment_count" integer DEFAULT 0 NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "moments_author_type_check" CHECK ("author_type" IN ('agent', 'user')),
  CONSTRAINT "moments_visibility_check" CHECK ("visibility" IN ('company', 'project')),
  CONSTRAINT "moments_kind_check" CHECK ("kind" IN ('update', 'insight', 'milestone', 'work_product')),
  CONSTRAINT "moments_author_principal_check" CHECK (
    ("author_type" = 'agent' AND "author_agent_id" IS NOT NULL AND "author_user_id" IS NULL)
    OR ("author_type" = 'user' AND "author_user_id" IS NOT NULL AND "author_agent_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_douyin_account_id_fk" FOREIGN KEY ("douyin_account_id") REFERENCES "public"."douyin_accounts"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "moments" ADD CONSTRAINT "moments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null;--> statement-breakpoint
-- 信息流:公司维度倒序翻页
CREATE INDEX "moments_company_feed_idx" ON "moments" USING btree ("company_id","created_at" DESC) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "moments_author_idx" ON "moments" USING btree ("company_id","author_agent_id","created_at" DESC) WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE TABLE "moment_likes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "moment_id" uuid NOT NULL,
  "actor_type" text NOT NULL,
  "actor_user_id" text,
  "actor_agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "moment_likes_actor_type_check" CHECK ("actor_type" IN ('agent', 'user')),
  CONSTRAINT "moment_likes_actor_principal_check" CHECK (
    ("actor_type" = 'agent' AND "actor_agent_id" IS NOT NULL AND "actor_user_id" IS NULL)
    OR ("actor_type" = 'user' AND "actor_user_id" IS NOT NULL AND "actor_agent_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "moment_likes" ADD CONSTRAINT "moment_likes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "moment_likes" ADD CONSTRAINT "moment_likes_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "moment_likes" ADD CONSTRAINT "moment_likes_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "moment_likes_moment_user_uq" ON "moment_likes" USING btree ("moment_id","actor_user_id") WHERE "actor_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "moment_likes_moment_agent_uq" ON "moment_likes" USING btree ("moment_id","actor_agent_id") WHERE "actor_agent_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "moment_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "moment_id" uuid NOT NULL,
  "parent_comment_id" uuid,
  "author_type" text NOT NULL,
  "author_user_id" text,
  "author_agent_id" uuid,
  "body" text NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "moment_comments_author_type_check" CHECK ("author_type" IN ('agent', 'user')),
  CONSTRAINT "moment_comments_author_principal_check" CHECK (
    ("author_type" = 'agent' AND "author_agent_id" IS NOT NULL AND "author_user_id" IS NULL)
    OR ("author_type" = 'user' AND "author_user_id" IS NOT NULL AND "author_agent_id" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "moment_comments" ADD CONSTRAINT "moment_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "moment_comments" ADD CONSTRAINT "moment_comments_moment_id_moments_id_fk" FOREIGN KEY ("moment_id") REFERENCES "public"."moments"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "moment_comments" ADD CONSTRAINT "moment_comments_parent_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."moment_comments"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "moment_comments" ADD CONSTRAINT "moment_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "moment_comments_moment_idx" ON "moment_comments" USING btree ("moment_id","created_at") WHERE "deleted_at" IS NULL;--> statement-breakpoint

ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_source_moment_id_moments_id_fk" FOREIGN KEY ("source_moment_id") REFERENCES "public"."moments"("id") ON DELETE set null;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- G. 算力账户(点数余额 / 充值 / 用量明细)
--
-- 与 Paperclip 既有计费的分工:
--   cost_events    (原生) = 「花了多少」的用量事实(model/input/cached_input/output/cost_cents)
--   finance_events (原生) = 财务流水
--   budget_policies(原生) = 「不许超过多少」的限额策略(月度硬停)
--   本模块         (新增) = 「还剩多少」的预付费点数账户 —— Paperclip 没有余额概念,
--                          限额 ≠ 余额,预付费产品必须有钱包与充值。
-- 单位约定:1 点 = 1 分(人民币)。cost_events.cost_cents 与 points 天然 1:1,对账无需换算。
--          1M token = 5 元 = 500 点(见 compute_pricing_rules 默认行)。
-- ---------------------------------------------------------------------------
CREATE TABLE "compute_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "owner_type" text DEFAULT 'company' NOT NULL,
  "owner_id" text,
  "balance_points" bigint DEFAULT 0 NOT NULL,
  "frozen_points" bigint DEFAULT 0 NOT NULL,
  "total_recharged_points" bigint DEFAULT 0 NOT NULL,
  "total_consumed_points" bigint DEFAULT 0 NOT NULL,
  "low_balance_threshold" bigint DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  -- 乐观锁:并发扣费时防止丢失更新
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "compute_accounts_owner_type_check" CHECK ("owner_type" IN ('company', 'user')),
  CONSTRAINT "compute_accounts_status_check" CHECK ("status" IN ('active', 'suspended')),
  -- 余额不可为负:数据库层兜底,不依赖应用层记得检查
  CONSTRAINT "compute_accounts_balance_check" CHECK ("balance_points" >= 0),
  CONSTRAINT "compute_accounts_frozen_check" CHECK ("frozen_points" >= 0)
);
--> statement-breakpoint
ALTER TABLE "compute_accounts" ADD CONSTRAINT "compute_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "compute_accounts_company_owner_uq" ON "compute_accounts" USING btree ("company_id","owner_type",COALESCE("owner_id", ''));--> statement-breakpoint

-- 定价规则按 effective_from 版本化:历史账单必须可复算。
-- 若把单价放在可变的 settings 行里,改价那一刻所有历史账单的重算结果都会变,对账即失效。
CREATE TABLE "compute_pricing_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid,
  "model" text DEFAULT '*' NOT NULL,
  "points_per_1m_input" integer NOT NULL,
  "points_per_1m_cached_input" integer NOT NULL,
  "points_per_1m_output" integer NOT NULL,
  "note" text,
  "effective_from" timestamp with time zone DEFAULT now() NOT NULL,
  "effective_to" timestamp with time zone,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "compute_pricing_rules_points_check" CHECK (
    "points_per_1m_input" >= 0 AND "points_per_1m_cached_input" >= 0 AND "points_per_1m_output" >= 0
  )
);
--> statement-breakpoint
ALTER TABLE "compute_pricing_rules" ADD CONSTRAINT "compute_pricing_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "compute_pricing_rules_lookup_idx" ON "compute_pricing_rules" USING btree ("company_id","model","effective_from" DESC);--> statement-breakpoint
-- 全局默认价:1M token = 5 元 = 500 点。三档分列存储,便于后续对缓存命中单独降价
-- (JIN-51 实测 prompt caching 命中可省 94% input,定价可以跟进而无需改表)。
INSERT INTO "compute_pricing_rules"
  ("company_id", "model", "points_per_1m_input", "points_per_1m_cached_input", "points_per_1m_output", "note")
VALUES
  (NULL, '*', 500, 500, 500, '默认:1M token = 5 元 = 500 点(1 点 = 1 分)');--> statement-breakpoint

CREATE TABLE "compute_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "direction" text NOT NULL,
  "points" bigint NOT NULL,
  "balance_after" bigint NOT NULL,
  "reason" text NOT NULL,
  -- 指回 Paperclip 原生用量事实,一条扣费对应一条 cost_event,可双向对账
  "cost_event_id" uuid,
  "agent_id" uuid,
  "issue_id" uuid,
  "conversation_id" uuid,
  "recharge_order_id" uuid,
  "pricing_rule_id" uuid,
  -- 幂等键:run 失败重试会重放扣费,没有它就是重复扣钱(真金白银的 bug)
  "idempotency_key" text NOT NULL,
  "memo" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "compute_transactions_direction_check" CHECK ("direction" IN ('credit', 'debit')),
  CONSTRAINT "compute_transactions_reason_check" CHECK ("reason" IN ('recharge', 'consume', 'refund', 'adjust', 'gift', 'freeze', 'unfreeze')),
  CONSTRAINT "compute_transactions_points_check" CHECK ("points" > 0)
);
--> statement-breakpoint
ALTER TABLE "compute_transactions" ADD CONSTRAINT "compute_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "compute_transactions" ADD CONSTRAINT "compute_transactions_account_id_compute_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."compute_accounts"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "compute_transactions" ADD CONSTRAINT "compute_transactions_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "compute_transactions" ADD CONSTRAINT "compute_transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "compute_transactions" ADD CONSTRAINT "compute_transactions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "compute_transactions" ADD CONSTRAINT "compute_transactions_pricing_rule_id_fk" FOREIGN KEY ("pricing_rule_id") REFERENCES "public"."compute_pricing_rules"("id") ON DELETE set null;--> statement-breakpoint
CREATE UNIQUE INDEX "compute_transactions_idempotency_uq" ON "compute_transactions" USING btree ("company_id","idempotency_key");--> statement-breakpoint
-- 一条 cost_event 最多扣一次费
CREATE UNIQUE INDEX "compute_transactions_cost_event_uq" ON "compute_transactions" USING btree ("cost_event_id") WHERE "cost_event_id" IS NOT NULL;--> statement-breakpoint
-- 用量明细:按账户倒序翻页 / 按员工聚合
CREATE INDEX "compute_transactions_account_created_idx" ON "compute_transactions" USING btree ("account_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "compute_transactions_company_agent_idx" ON "compute_transactions" USING btree ("company_id","agent_id","created_at" DESC);--> statement-breakpoint

CREATE TABLE "compute_recharge_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "created_by_user_id" text,
  "points" bigint NOT NULL,
  "amount_cents" integer NOT NULL,
  "channel" text NOT NULL,
  "external_order_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "paid_at" timestamp with time zone,
  "raw_callback" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "compute_recharge_orders_channel_check" CHECK ("channel" IN ('wechat', 'alipay', 'manual', 'gift')),
  CONSTRAINT "compute_recharge_orders_status_check" CHECK ("status" IN ('pending', 'paid', 'failed', 'refunded')),
  CONSTRAINT "compute_recharge_orders_points_check" CHECK ("points" > 0)
);
--> statement-breakpoint
ALTER TABLE "compute_recharge_orders" ADD CONSTRAINT "compute_recharge_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "compute_recharge_orders" ADD CONSTRAINT "compute_recharge_orders_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."compute_accounts"("id") ON DELETE cascade;--> statement-breakpoint
-- 支付回调会重复投递:外部订单号唯一,回调重放不会重复加点
CREATE UNIQUE INDEX "compute_recharge_orders_channel_external_uq" ON "compute_recharge_orders" USING btree ("channel","external_order_id") WHERE "external_order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "compute_recharge_orders_account_idx" ON "compute_recharge_orders" USING btree ("account_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE "compute_transactions" ADD CONSTRAINT "compute_transactions_recharge_order_id_fk" FOREIGN KEY ("recharge_order_id") REFERENCES "public"."compute_recharge_orders"("id") ON DELETE set null;
