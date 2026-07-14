import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { douyinAccounts } from "./douyin_accounts.js";

/** 朋友圈:AI 员工主动发的动态(「我发现了一个爆款规律」),不是被问才答。 */
export const moments = pgTable(
  "moments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    douyinAccountId: uuid("douyin_account_id").references(() => douyinAccounts.id, { onDelete: "set null" }),
    authorType: text("author_type").notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id"),
    content: text("content").notNull(),
    media: jsonb("media").$type<Record<string, unknown>[]>().notNull().default([]),
    kind: text("kind").notNull().default("update"),
    /**
     * 信息流分类(0151):AI员工动态 / 行业资讯 / 服务推广。
     *
     * 与 kind 是两个轴,不能合并:kind 说的是「这是什么性质的产出」,category 说的是
     * 「用户在哪个 tab 下看到它」。操盘手的「本周点评名额剩余 2 个」kind=update,
     * 但它属于服务推广,合成一个轴就会混进员工动态流。
     */
    category: text("category").notNull().default("ai_update"),
    /** #抖音趋势 #内容建议 */
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** 结构化卡片:方法包 / 禁用规则 / 趋势 / 服务名额。见 @xiaojing/protocol 的 MomentCard。 */
    card: jsonb("card").$type<Record<string, unknown> | null>(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    documentId: uuid("document_id"),
    visibility: text("visibility").notNull().default("company"),
    /** 计数器冗余:信息流每条都要显示点赞/评论数,现算是 N+1 的经典来源 */
    likeCount: integer("like_count").notNull().default(0),
    commentCount: integer("comment_count").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFeedIdx: index("moments_company_feed_idx")
      .on(table.companyId, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null`),
    /** 按分类刷信息流的查询路径(0151) */
    companyCategoryFeedIdx: index("moments_company_category_feed_idx")
      .on(table.companyId, table.category, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null`),
    tagsIdx: index("moments_tags_idx").using("gin", table.tags),
    categoryCheck: check(
      "moments_category_check",
      sql`${table.category} in ('ai_update', 'industry', 'promo')`,
    ),
    authorIdx: index("moments_author_idx")
      .on(table.companyId, table.authorAgentId, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null`),
    authorTypeCheck: check("moments_author_type_check", sql`${table.authorType} in ('agent', 'user')`),
    visibilityCheck: check("moments_visibility_check", sql`${table.visibility} in ('company', 'project')`),
    kindCheck: check("moments_kind_check", sql`${table.kind} in ('update', 'insight', 'milestone', 'work_product')`),
    authorPrincipalCheck: check(
      "moments_author_principal_check",
      sql`(${table.authorType} = 'agent' and ${table.authorAgentId} is not null and ${table.authorUserId} is null)
        or (${table.authorType} = 'user' and ${table.authorUserId} is not null and ${table.authorAgentId} is null)`,
    ),
  }),
);

export const momentLikes = pgTable(
  "moment_likes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    momentId: uuid("moment_id").notNull().references(() => moments.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id"),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 同一人/同一 agent 对同一条只能点一次赞 */
    momentUserUq: uniqueIndex("moment_likes_moment_user_uq")
      .on(table.momentId, table.actorUserId)
      .where(sql`${table.actorUserId} is not null`),
    momentAgentUq: uniqueIndex("moment_likes_moment_agent_uq")
      .on(table.momentId, table.actorAgentId)
      .where(sql`${table.actorAgentId} is not null`),
    actorTypeCheck: check("moment_likes_actor_type_check", sql`${table.actorType} in ('agent', 'user')`),
    actorPrincipalCheck: check(
      "moment_likes_actor_principal_check",
      sql`(${table.actorType} = 'agent' and ${table.actorAgentId} is not null and ${table.actorUserId} is null)
        or (${table.actorType} = 'user' and ${table.actorUserId} is not null and ${table.actorAgentId} is null)`,
    ),
  }),
);

export const momentComments = pgTable(
  "moment_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    momentId: uuid("moment_id").notNull().references(() => moments.id, { onDelete: "cascade" }),
    parentCommentId: uuid("parent_comment_id").references((): AnyPgColumn => momentComments.id, {
      onDelete: "cascade",
    }),
    authorType: text("author_type").notNull(),
    authorUserId: text("author_user_id"),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    momentIdx: index("moment_comments_moment_idx")
      .on(table.momentId, table.createdAt)
      .where(sql`${table.deletedAt} is null`),
    authorTypeCheck: check("moment_comments_author_type_check", sql`${table.authorType} in ('agent', 'user')`),
    authorPrincipalCheck: check(
      "moment_comments_author_principal_check",
      sql`(${table.authorType} = 'agent' and ${table.authorAgentId} is not null and ${table.authorUserId} is null)
        or (${table.authorType} = 'user' and ${table.authorUserId} is not null and ${table.authorAgentId} is null)`,
    ),
  }),
);
