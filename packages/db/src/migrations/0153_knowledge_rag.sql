-- ============================================================================
-- 0153_knowledge_rag — 知识库(RAG)向量层(JIN-55)
--
-- 承接 0148:collections / collection_items / collection_citation_grants 三张表已经建好,
-- 「按 AI 员工粒度的可引用开关」的数据模型也已经在了(默认值 + 例外行)。
-- 这条迁移只补检索缺的两张表:chunk 向量表 + 条目索引状态表。
--
-- 设计原则同 0148 / 0150 / 0151:纯加法。对已有表零改动 —— 不 ADD COLUMN、不动约束。
-- 手写 SQL + 手工追加 _journal.json —— 不跑 drizzle-kit generate(upstream snapshot 已坏)。
--
-- ⚠️ 为什么不用 pgvector:本仓库跑 embedded postgres,机器上没有 vector.control,
-- CREATE EXTENSION vector 会直接失败 → CI 和本地全红。向量落成原生 real[],
-- 余弦在应用层算。候选集先被「可引用」过滤砍过一刀,当前规模(百~千 chunk)是亚毫秒级。
-- 换 pgvector 时只有 knowledge_chunks 的读写实现要动,retrieve() 的调用方不用改。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. knowledge_chunks —— 切片 + 向量
--
-- embedding 允许 NULL:chunk 先落库、向量后补。embedding provider 挂了(限流/欠费)
-- 不能把原文一起丢掉 —— 否则一次 429 就要用户重新上传资料。
--
-- 向量在**写入侧**做 L2 归一化,所以查询侧的余弦相似度退化成点积。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "item_id" uuid NOT NULL REFERENCES "collection_items"("id") ON DELETE CASCADE,
  "chunk_index" integer NOT NULL,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "embedding" real[],
  "embedding_model" text,
  "embedding_dims" integer,
  "char_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_item_chunk_uq"
  ON "knowledge_chunks" ("item_id", "chunk_index");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "knowledge_chunks_company_item_idx"
  ON "knowledge_chunks" ("company_id", "item_id");
--> statement-breakpoint

-- 检索热路径:按公司捞「已经有向量」的 chunk。没向量的 chunk 检索期一律跳过。
CREATE INDEX IF NOT EXISTS "knowledge_chunks_company_embedded_idx"
  ON "knowledge_chunks" ("company_id", "updated_at" DESC)
  WHERE "embedding" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- B. collection_item_index_state —— 每个收藏条目一行的索引状态
--
-- source_hash 是「索引时那份原文」的 sha256:和当前原文对不上 = 该重索引了。
-- 没有它,「这条收藏改过之后向量还是旧的」这种静默失效就只能靠人肉发现。
--
-- error 列不吞失败原因(provider 429 / 欠费 / 超时),留给运维和告警。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "collection_item_index_state" (
  "item_id" uuid PRIMARY KEY REFERENCES "collection_items"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "chunk_count" integer DEFAULT 0 NOT NULL,
  "embedding_model" text,
  "embedding_dims" integer,
  "error" text,
  "indexed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "collection_item_index_state_status_check"
    CHECK ("status" IN ('pending', 'indexed', 'failed'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "collection_item_index_state_company_status_idx"
  ON "collection_item_index_state" ("company_id", "status");
