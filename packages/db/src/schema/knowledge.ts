import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { collectionItems } from "./collections.js";

/**
 * 知识库(RAG)的向量层。JIN-55。
 *
 * 为什么不是 pgvector:本仓库跑 embedded postgres(见 packages/db/src/embedded-postgres-native.ts),
 * 机器上根本没有 vector.control —— 建 extension 会直接失败,CI 和本地全红。
 * 所以向量落成原生 `real[]`,余弦在应用层算(retrieve() 里)。
 *
 * 这不是「凑合」,是当前规模下的正确取舍:一家公司的收藏条目是百~千级,
 * 候选集还先被「可引用」过滤砍过一刀,暴力余弦是亚毫秒级的。
 * 等单公司 chunk 数量级上到 1e5,再换 pgvector / 外部向量库 —— 换的时候
 * 只有 knowledgeChunks 的读写实现要动,retrieve() 的调用方一行都不用改。
 */
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").notNull().references(() => collectionItems.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    /** 该 chunk 文本的 sha256。重新索引时用它跳过没变的 chunk,省 embedding 钱。 */
    contentHash: text("content_hash").notNull(),
    /**
     * 单位向量(L2 归一化后落库)。归一化在写入侧做掉,查询侧的余弦就退化成点积。
     * 允许为 null:chunk 先落库、embedding 后补(provider 挂了不丢原文)。
     */
    embedding: real("embedding").array(),
    embeddingModel: text("embedding_model"),
    embeddingDims: integer("embedding_dims"),
    charCount: integer("char_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemChunkUq: uniqueIndex("knowledge_chunks_item_chunk_uq").on(table.itemId, table.chunkIndex),
    companyItemIdx: index("knowledge_chunks_company_item_idx").on(table.companyId, table.itemId),
    /** 检索热路径:按公司捞「已经有向量」的 chunk。 */
    companyEmbeddedIdx: index("knowledge_chunks_company_embedded_idx")
      .on(table.companyId, table.updatedAt.desc())
      .where(sql`${table.embedding} is not null`),
  }),
);

/**
 * 每个收藏条目的索引状态。
 *
 * 为什么单开一张表而不是往 collection_items 加列:collection_items 是 0148 协作层的表,
 * 归属另一条线;索引状态是本 issue 的派生数据,写入频率也完全不同(每次重索引都写)。
 * 分表 = 两条 PR 不会在同一张表上打架,也不会让「收藏」的读路径带上一堆用不到的列。
 */
export const collectionItemIndexState = pgTable(
  "collection_item_index_state",
  {
    itemId: uuid("item_id")
      .primaryKey()
      .references(() => collectionItems.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** 索引时那份原文的 sha256。和当前原文对不上 = stale,该重索引了。 */
    sourceHash: text("source_hash").notNull(),
    status: text("status").notNull().default("pending"),
    chunkCount: integer("chunk_count").notNull().default(0),
    embeddingModel: text("embedding_model"),
    embeddingDims: integer("embedding_dims"),
    /** 失败原因(provider 429 / 超时…)。留着给运维看,不吞。 */
    error: text("error"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("collection_item_index_state_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    statusCheck: check(
      "collection_item_index_state_status_check",
      sql`${table.status} in ('pending', 'indexed', 'failed')`,
    ),
  }),
);
