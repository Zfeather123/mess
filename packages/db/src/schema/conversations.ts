import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  bigint,
  boolean,
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
import { documents } from "./documents.js";
import { approvals } from "./approvals.js";
import { squads } from "./squads.js";
import { douyinAccounts } from "./douyin_accounts.js";

/** 会话:微信式群聊 / 私聊。群里坐着真人 + 一队 AI 员工。 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    squadId: uuid("squad_id").references(() => squads.id, { onDelete: "set null" }),
    douyinAccountId: uuid("douyin_account_id").references(() => douyinAccounts.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    title: text("title"),
    avatarUrl: text("avatar_url"),
    /**
     * 会话内单调递增序号的分配源。消息插入与 lastSeq 自增在同一事务内完成,
     * 保证每会话消息「全序 + 无空洞」;WebSocket 推送顺序与客户端补洞都依赖它。
     *
     * 为什么不用 createdAt 排序:同毫秒并发写入会并列,多实例间时钟漂移会乱序 ——
     * 群聊里消息顺序错乱是致命体验问题,必须由 DB 给出确定性全序。
     */
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    lastMessageId: uuid("last_message_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdByType: text("created_by_type").notNull().default("user"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRecentIdx: index("conversations_company_recent_idx").on(table.companyId, table.lastMessageAt.desc()),
    companySquadIdx: index("conversations_company_squad_idx").on(table.companyId, table.squadId),
    kindCheck: check("conversations_kind_check", sql`${table.kind} in ('group', 'direct')`),
  }),
);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    memberType: text("member_type").notNull(),
    userId: text("user_id"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    /**
     * 已读游标。未读数 = conversations.lastSeq - lastReadSeq,O(1) 得出,永不扫 messages。
     * 微信式群聊只需要「未读数」,不需要每条消息的已读回执 —— 后者要 N×M 行,
     * 且产品里没有任何界面消费它。真要做「已读 12 人」再补 message_read_receipts 表。
     */
    lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull().default(0),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    muted: boolean("muted").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    convAgentUq: uniqueIndex("conversation_members_conv_agent_uq")
      .on(table.conversationId, table.agentId)
      .where(sql`${table.agentId} is not null`),
    convUserUq: uniqueIndex("conversation_members_conv_user_uq")
      .on(table.conversationId, table.userId)
      .where(sql`${table.userId} is not null`),
    /** 「我的会话列表」热路径 */
    userIdx: index("conversation_members_user_idx")
      .on(table.companyId, table.userId)
      .where(sql`${table.leftAt} is null`),
    agentIdx: index("conversation_members_agent_idx")
      .on(table.companyId, table.agentId)
      .where(sql`${table.leftAt} is null`),
    memberTypeCheck: check("conversation_members_member_type_check", sql`${table.memberType} in ('agent', 'user')`),
    roleCheck: check("conversation_members_role_check", sql`${table.role} in ('owner', 'admin', 'member')`),
    principalCheck: check(
      "conversation_members_principal_check",
      sql`(${table.memberType} = 'agent' and ${table.agentId} is not null and ${table.userId} is null)
        or (${table.memberType} = 'user' and ${table.userId} is not null and ${table.agentId} is null)`,
    ),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    /** 见 conversations.lastSeq:会话内全序,同时充当 keyset 分页游标 */
    seq: bigint("seq", { mode: "number" }).notNull(),
    senderType: text("sender_type").notNull(),
    senderUserId: text("sender_user_id"),
    senderAgentId: uuid("sender_agent_id").references(() => agents.id, { onDelete: "set null" }),
    kind: text("kind").notNull().default("text"),
    body: text("body"),
    /**
     * 卡片消息:选题列表 / 文案初稿 / 诊断报告 / 待确认审批。
     * cardPayload 存渲染快照,外键(issueId/documentId/approvalId)指向权威实体。
     * 两者并存是刻意的:快照让消息流「历史即所见」(不会因实体后续被改而回溯篡改聊天记录),
     * 外键让「点击卡片 → 跳到真实实体去操作」成立。
     */
    cardType: text("card_type"),
    cardPayload: jsonb("card_payload").$type<Record<string, unknown>>(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    replyToMessageId: uuid("reply_to_message_id").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
    threadRootId: uuid("thread_root_id").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
    attachments: jsonb("attachments").$type<Record<string, unknown>[]>().notNull().default([]),
    heartbeatRunId: uuid("heartbeat_run_id"),
    /** 客户端重发幂等:断网重连后重发同一条不会变成两条 */
    clientNonce: text("client_nonce"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 全序保证 + keyset 分页游标。实测 20 万条消息下首屏 0.20ms(Index Scan Backward,5 buffers) */
    conversationSeqUq: uniqueIndex("messages_conversation_seq_uq").on(table.conversationId, table.seq),
    conversationSeqDescIdx: index("messages_conversation_seq_desc_idx").on(table.conversationId, table.seq.desc()),
    clientNonceUq: uniqueIndex("messages_client_nonce_uq")
      .on(table.conversationId, table.clientNonce)
      .where(sql`${table.clientNonce} is not null`),
    threadIdx: index("messages_thread_idx")
      .on(table.threadRootId, table.seq)
      .where(sql`${table.threadRootId} is not null`),
    companyIssueIdx: index("messages_company_issue_idx")
      .on(table.companyId, table.issueId)
      .where(sql`${table.issueId} is not null`),
    senderTypeCheck: check("messages_sender_type_check", sql`${table.senderType} in ('user', 'agent', 'system')`),
    kindCheck: check("messages_kind_check", sql`${table.kind} in ('text', 'card', 'image', 'file', 'system')`),
    cardCheck: check("messages_card_check", sql`${table.kind} <> 'card' or ${table.cardType} is not null`),
    senderPrincipalCheck: check(
      "messages_sender_principal_check",
      sql`(${table.senderType} = 'agent' and ${table.senderAgentId} is not null and ${table.senderUserId} is null)
        or (${table.senderType} = 'user' and ${table.senderUserId} is not null and ${table.senderAgentId} is null)
        or (${table.senderType} = 'system' and ${table.senderAgentId} is null and ${table.senderUserId} is null)`,
    ),
  }),
);

/** @提及:既驱动「@我的」红点,也驱动「@某员工 → 唤醒该 agent 执行」 */
export const messageMentions = pgTable(
  "message_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    mentionType: text("mention_type").notNull(),
    userId: text("user_id"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    /** @小队 → 走队长路由(squad_dispatches),而不是直接唤醒某个 agent */
    squadId: uuid("squad_id").references(() => squads.id, { onDelete: "cascade" }),
    wakeupState: text("wakeup_state").notNull().default("none"),
    heartbeatRunId: uuid("heartbeat_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageIdx: index("message_mentions_message_idx").on(table.messageId),
    userIdx: index("message_mentions_user_idx")
      .on(table.companyId, table.userId, table.createdAt.desc())
      .where(sql`${table.userId} is not null`),
    /** 唤醒队列:待唤醒的 agent @ 事件 */
    agentPendingIdx: index("message_mentions_agent_pending_idx")
      .on(table.agentId, table.createdAt)
      .where(sql`${table.wakeupState} = 'pending'`),
    typeCheck: check("message_mentions_type_check", sql`${table.mentionType} in ('user', 'agent', 'squad', 'all')`),
    wakeupCheck: check(
      "message_mentions_wakeup_check",
      sql`${table.wakeupState} in ('none', 'pending', 'triggered', 'skipped')`,
    ),
  }),
);
