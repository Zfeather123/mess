import { pgTable, uuid, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { messages } from "./conversations.js";
import { douyinAccounts } from "./douyin_accounts.js";

/**
 * Agent 反馈学习:「最近被纠正」/「下次注意」—— agent 的长期记忆与自我改进。
 *
 * 与 account_profiles 的分工(很容易混,写清楚):
 *   account_profiles = 关于「账号」的事实(定位/受众/禁用表达)—— 全体员工共享
 *   agent_feedback_notes = 关于「这个员工怎么干活」的教训 —— 每个员工私有
 * 「这个账号不许说『家人们』」是账号事实;「你上次写标题太标题党了」是员工教训。
 *
 * 注入策略:按 weight desc, createdAt desc 取 top-N 进系统提示词。
 * 不能全塞 —— 注意力有限,且这块内容每轮都带,是 prompt caching 的缓存断点。
 */
export const agentFeedbackNotes = pgTable(
  "agent_feedback_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    /**
     * 作用域:同一个 agent 服务多个抖音账号时,
     * 「A 账号不让说家人们」不该污染 B 账号的输出。
     */
    scopeType: text("scope_type").notNull().default("global"),
    douyinAccountId: uuid("douyin_account_id").references(() => douyinAccounts.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    sourceType: text("source_type").notNull(),
    sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceApprovalId: uuid("source_approval_id"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    status: text("status").notNull().default("active"),
    weight: integer("weight").notNull().default(100),
    timesApplied: integer("times_applied").notNull().default(0),
    lastAppliedAt: timestamp("last_applied_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * prompt 注入热路径。
     *
     * ⚠️ 排序键之前不要放 scope 列。真实查询是
     *   WHERE agent_id = ? AND status='active' AND (douyin_account_id IS NULL OR douyin_account_id = ?)
     * 这个 OR 让 scope 列无法作为有序索引前缀:planner 只能走 bitmap scan(bitmap 不保序),
     * 于是退化成「全量取回 + top-N sort」。
     *
     * 实测(5 万条笔记):
     *   索引含 scope 前缀 → Seq Scan 45,000 行 / 15.9ms
     *   索引去掉 scope    → 有序 Index Scan,读满 20 行即停 / 0.30ms(≈45x)
     * scope 放在 filter 回查即可 —— 同一 agent 的笔记绝大多数在 scope 内,提前终止几乎立即命中。
     */
    injectIdx: index("agent_feedback_notes_inject_idx")
      .on(table.agentId, table.weight.desc(), table.createdAt.desc())
      .where(sql`${table.status} = 'active'`),
    companyAgentIdx: index("agent_feedback_notes_company_agent_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    scopeCheck: check(
      "agent_feedback_notes_scope_check",
      sql`${table.scopeType} in ('global', 'douyin_account', 'project')`,
    ),
    kindCheck: check(
      "agent_feedback_notes_kind_check",
      sql`${table.kind} in ('correction', 'reminder', 'preference')`,
    ),
    sourceCheck: check(
      "agent_feedback_notes_source_check",
      sql`${table.sourceType} in ('user_message', 'approval_rejection', 'review', 'self_reflection', 'manual')`,
    ),
    statusCheck: check(
      "agent_feedback_notes_status_check",
      sql`${table.status} in ('active', 'archived', 'superseded')`,
    ),
  }),
);
