-- 0152:agent_templates —— AI 员工市场的「用户自定义」供给源
--
-- 编号说明:issue 里写的是 0149,但 0149 已被 compute_reservations 占用,0150 已被
-- douyin_sync_and_profile_sources 占用(均已在主干),0151 被飞行中的 PR #32(JIN-56)占用,
-- 所以顺延到 0152。check-migration-numbering.ts 要求文件名与 journal 严格一一对应、不许重号;
-- 跳号只 warning,重号直接红,所以宁可跳号也不抢号。
--
-- 手写 SQL(不跑 drizzle-kit generate):meta/ 里最后一份快照停在 0099_snapshot.json,
-- 快照链早就断了,generate 出来的 diff 本身不可信。
--
-- 纯加法:1 张新表,不动 Paperclip 任何原表。
--
-- 为什么 version 用触发器兜底,而不是让应用层 +1:
-- out-of-date 徽章的整个正确性都挂在「模板变了 version 就一定变」上。如果靠调用方记得写
-- version = version + 1,那么任何一条漏写的 UPDATE 路径(后台脚本、以后加的批量导入、
-- 手工 psql 改一行)都会让徽章**静默失灵** —— 模板明明改了,前端却说是最新的,而且不报错。
-- 这类 bug 没有任何测试能兜住,只能由 DB 兜底。
CREATE TABLE "agent_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "avatar_url" text,
  "role" text NOT NULL,
  "title" text,
  "description" text,
  "category" text,
  "instructions" text NOT NULL,
  "adapter_type" text,
  "adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "desired_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "visibility" text DEFAULT 'company' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_type" text NOT NULL,
  "created_by_user_id" text,
  "created_by_agent_id" uuid,
  "version" integer DEFAULT 1 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_templates_visibility_check" CHECK ("visibility" IN ('private', 'company', 'public')),
  CONSTRAINT "agent_templates_status_check" CHECK ("status" IN ('active', 'archived')),
  -- 创建者身份 XOR(沿用 0148 squad_members 的约定)
  CONSTRAINT "agent_templates_created_by_check" CHECK (
    ("created_by_type" = 'user' AND "created_by_user_id" IS NOT NULL AND "created_by_agent_id" IS NULL)
    OR ("created_by_type" = 'agent' AND "created_by_agent_id" IS NOT NULL AND "created_by_user_id" IS NULL)
  ),
  -- 空指令的模板 = 招出来一定是空壳员工。不许进库。
  CONSTRAINT "agent_templates_instructions_check" CHECK (length(btrim("instructions")) > 0),
  CONSTRAINT "agent_templates_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;--> statement-breakpoint

-- 市场列表主查询:WHERE company_id = ? AND status = 'active' ORDER BY updated_at DESC
CREATE INDEX "agent_templates_company_status_idx" ON "agent_templates" USING btree ("company_id","status","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "agent_templates_company_visibility_idx" ON "agent_templates" USING btree ("company_id","visibility");--> statement-breakpoint
-- 外键必须建索引:级联删除会全表扫,JOIN 也要用
CREATE INDEX "agent_templates_created_by_agent_idx" ON "agent_templates" USING btree ("created_by_agent_id");--> statement-breakpoint
-- 在架模板同公司内不许重名(archived 的不占名字,可以重新建同名的)
CREATE UNIQUE INDEX "agent_templates_company_name_uq" ON "agent_templates" USING btree ("company_id","name") WHERE "status" = 'active';--> statement-breakpoint

-- 内容列变了才 bump version;只改 status(归档)/ visibility 不算内容变更,
-- 否则「归档一下」都会让所有已招员工无端显示「模板已更新」。
CREATE OR REPLACE FUNCTION agent_templates_bump_version() RETURNS trigger AS $$
BEGIN
  IF (
    NEW."name" IS DISTINCT FROM OLD."name"
    OR NEW."avatar_url" IS DISTINCT FROM OLD."avatar_url"
    OR NEW."role" IS DISTINCT FROM OLD."role"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."category" IS DISTINCT FROM OLD."category"
    OR NEW."instructions" IS DISTINCT FROM OLD."instructions"
    OR NEW."adapter_type" IS DISTINCT FROM OLD."adapter_type"
    OR NEW."adapter_config" IS DISTINCT FROM OLD."adapter_config"
    OR NEW."desired_skills" IS DISTINCT FROM OLD."desired_skills"
  ) THEN
    NEW."version" := OLD."version" + 1;
    NEW."updated_at" := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "agent_templates_bump_version_trg"
  BEFORE UPDATE ON "agent_templates"
  FOR EACH ROW EXECUTE FUNCTION agent_templates_bump_version();
