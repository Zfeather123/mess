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
import { issueComments } from "./issue_comments.js";
import { douyinAccounts } from "./douyin_accounts.js";

/**
 * 小队:产品里「账号主理人」是队长,统筹派活。
 * Paperclip 只有 agents.reports_to(单一上级链),表达不了「一个小队 + 一个队长 + 一组成员」,
 * 也表达不了「任务派给小队,由队长决定分给谁」。故新增。
 */
export const squads = pgTable(
  "squads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    leaderAgentId: uuid("leader_agent_id").references(() => agents.id, { onDelete: "set null" }),
    douyinAccountId: uuid("douyin_account_id").references(() => douyinAccounts.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    /** 队长路由策略(轮询/按能力/固定人选等),留给执行层解释 */
    dispatchPolicy: jsonb("dispatch_policy").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("squads_company_status_idx").on(table.companyId, table.status),
    companyProjectIdx: index("squads_company_project_idx").on(table.companyId, table.projectId),
    leaderIdx: index("squads_leader_idx").on(table.leaderAgentId),
    douyinAccountIdx: index("squads_douyin_account_idx").on(table.douyinAccountId),
    statusCheck: check("squads_status_check", sql`${table.status} in ('active', 'archived')`),
  }),
);

export const squadMembers = pgTable(
  "squad_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    squadId: uuid("squad_id").notNull().references(() => squads.id, { onDelete: "cascade" }),
    memberType: text("member_type").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    /** 沿用 Paperclip 约定:domain 表不外键到 better-auth 的 user 表,user_id 为裸 text */
    userId: text("user_id"),
    role: text("role").notNull().default("member"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    squadAgentUq: uniqueIndex("squad_members_squad_agent_uq")
      .on(table.squadId, table.agentId)
      .where(sql`${table.agentId} is not null`),
    squadUserUq: uniqueIndex("squad_members_squad_user_uq")
      .on(table.squadId, table.userId)
      .where(sql`${table.userId} is not null`),
    /** 一个小队最多一个队长 —— 由 DB 兜底,不靠应用层记得检查 */
    singleLeaderUq: uniqueIndex("squad_members_single_leader_uq")
      .on(table.squadId)
      .where(sql`${table.role} = 'leader'`),
    companySquadIdx: index("squad_members_company_squad_idx").on(table.companyId, table.squadId),
    agentIdx: index("squad_members_agent_idx").on(table.agentId),
    memberTypeCheck: check("squad_members_member_type_check", sql`${table.memberType} in ('agent', 'user')`),
    roleCheck: check("squad_members_role_check", sql`${table.role} in ('leader', 'member')`),
    principalCheck: check(
      "squad_members_principal_check",
      sql`(${table.memberType} = 'agent' and ${table.agentId} is not null and ${table.userId} is null)
        or (${table.memberType} = 'user' and ${table.userId} is not null and ${table.agentId} is null)`,
    ),
  }),
);

/**
 * 派单记录:任务派给小队 → 队长决定分给谁。
 * 既是「队长的待办队列」,也是「谁把活派给了谁、为什么」的审计轨迹 ——
 * 这是 issues.assignee_agent_id 单个字段表达不了的,它只有最终结果、没有决策过程。
 */
export const squadDispatches = pgTable(
  "squad_dispatches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    squadId: uuid("squad_id").notNull().references(() => squads.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("pending"),
    requestedByType: text("requested_by_type").notNull(),
    requestedByUserId: text("requested_by_user_id"),
    requestedByAgentId: uuid("requested_by_agent_id"),
    /** 派单往往源于群里一句话,留档便于队长回看上下文 */
    sourceMessageId: uuid("source_message_id"),
    assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, { onDelete: "set null" }),
    assignedUserId: text("assigned_user_id"),
    decidedByAgentId: uuid("decided_by_agent_id").references((): AnyPgColumn => agents.id, { onDelete: "set null" }),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    /**
     * 队长唤醒(Option B「派单即评论」)的公告留痕。
     *
     * 队长不是 issue 的 assignee —— 派单那一刻 assignee 正好是 NULL(等他来指派),
     * 而 heartbeat 的 claim 阶段会断言 assignee === run.agentId,只对「带真实评论的交互唤醒」放行。
     * 所以派单要先在 issue 上发一条真实评论并 @ 队长,复用 issue_comment_mentioned 这条路。
     *
     * notified_at 是**公告认领标记**:认领靠 `UPDATE ... WHERE notified_at IS NULL` 原子完成。
     * 不能靠应用层「先查再发」—— issue 的 create/update 都会调派单钩子,并发下会重复发评论、
     * 重复唤醒队长。
     */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /** 那条 @ 队长的评论。pause-hold 会回库校验「wake 的 actor == 评论作者」,留档便于排障 */
    dispatchCommentId: uuid("dispatch_comment_id").references((): AnyPgColumn => issueComments.id, {
      onDelete: "set null",
    }),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** 一个 issue 同时只能有一条未决派单:防止并发/重试造成重复派单 */
    issuePendingUq: uniqueIndex("squad_dispatches_issue_pending_uq")
      .on(table.issueId)
      .where(sql`${table.state} = 'pending'`),
    /** 队长拉取待办队列的热路径(部分索引,只覆盖 pending) */
    pendingQueueIdx: index("squad_dispatches_pending_queue_idx")
      .on(table.companyId, table.squadId, table.createdAt)
      .where(sql`${table.state} = 'pending'`),
    companyIssueIdx: index("squad_dispatches_company_issue_idx").on(table.companyId, table.issueId),
    stateCheck: check(
      "squad_dispatches_state_check",
      sql`${table.state} in ('pending', 'dispatched', 'reassigned', 'declined', 'failed')`,
    ),
    requestedByCheck: check(
      "squad_dispatches_requested_by_check",
      sql`${table.requestedByType} in ('user', 'agent', 'system')`,
    ),
  }),
);
