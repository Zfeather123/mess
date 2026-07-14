import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { documents } from "./documents.js";
import { messages } from "./conversations.js";
import { moments } from "./moments.js";
import { douyinAccounts } from "./douyin_accounts.js";

/** 收藏分类(树) */
export const collections = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => collections.id, { onDelete: "cascade" }),
    douyinAccountId: uuid("douyin_account_id").references(() => douyinAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),
    position: integer("position").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyParentIdx: index("collections_company_parent_idx").on(table.companyId, table.parentId, table.position),
  }),
);

/**
 * 收藏条目 = 知识库条目。可以是一段话术、一个链接、一条群消息、一份文档、一条朋友圈。
 *
 * defaultCitable:引用权限的默认值。产品要求「按 AI 员工粒度控制可被引用」
 * (选题策划师 ✅ / 账号诊断师 ❌)。
 */
export const collectionItems = pgTable(
  "collection_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id").references(() => collections.id, { onDelete: "set null" }),
    douyinAccountId: uuid("douyin_account_id").references(() => douyinAccounts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    contentType: text("content_type").notNull().default("text"),
    body: text("body"),
    url: text("url"),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    sourceMomentId: uuid("source_moment_id").references(() => moments.id, { onDelete: "set null" }),
    media: jsonb("media").$type<Record<string, unknown>[]>().notNull().default([]),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    defaultCitable: boolean("default_citable").notNull().default(true),
    createdByType: text("created_by_type").notNull().default("user"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCollectionIdx: index("collection_items_company_collection_idx")
      .on(table.companyId, table.collectionId, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null`),
    accountCitableIdx: index("collection_items_account_citable_idx")
      .on(table.companyId, table.douyinAccountId)
      .where(sql`${table.deletedAt} is null and ${table.defaultCitable} = true`),
    tagsIdx: index("collection_items_tags_idx").using("gin", table.tags),
    contentTypeCheck: check(
      "collection_items_content_type_check",
      sql`${table.contentType} in ('text', 'link', 'image', 'video', 'document', 'message', 'moment')`,
    ),
  }),
);

/**
 * 引用授权:只存「与默认不同」的例外。
 *
 * 为什么不是「每个 item × 每个 agent 一行」的全量授权表:
 * 那是 M×N 行,加一个员工要回填全部历史条目,加一条收藏要回填全部员工 —— 必然漂移。
 * 「默认开关 + 例外行」让授权表始终很小(产品里「账号诊断师不可引用」就只是一行),
 * 解析式:allowed = COALESCE(例外.allowed, item.default_citable)。
 */
export const collectionCitationGrants = pgTable(
  "collection_citation_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").notNull().references(() => collectionItems.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    allowed: boolean("allowed").notNull(),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemAgentUq: uniqueIndex("collection_citation_grants_item_agent_uq").on(table.itemId, table.agentId),
    agentIdx: index("collection_citation_grants_agent_idx").on(table.companyId, table.agentId),
  }),
);
