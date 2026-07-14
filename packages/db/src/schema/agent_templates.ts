import {
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
import { agents } from "./agents.js";

/**
 * 用户自定义的「AI 员工模板」—— AI 员工市场的第二个供给源。
 *
 * 供给侧有两条路,读模型只有一个(EmployeeCard):
 *   A. 操盘手预制 → 落在文件里(server/src/services/employee-presets.ts + teams-catalog 目录),不进库
 *   B. 用户自定义 → 就是这张表
 *
 * 为什么不复用 agents 表 + 一个 is_template 标记:
 * agents 行是**活的实例**(有 status / heartbeat / 预算 / runtime state / API key),模板是**死的配方**。
 * 混在一起会让 agents 的每一个查询都要带 `WHERE is_template = false`,漏一处就出灵异 bug。
 *
 * `version`:out-of-date 徽章的比对基准 —— 招聘时把当时的 version/contentHash 写进
 * agents.metadata,之后模板被改动 → 存的值 ≠ 当前值 → 前端显示「模板已更新」。
 * 该列由 DB 触发器兜底自增(见 0150 迁移),**不依赖调用方记得 +1**。
 */
export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),

    // ---- 员工卡片展示面 ----
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    role: text("role").notNull(),
    title: text("title"),
    /** 员工卡片上的一句话职责,列表页直接用,不必去解析 instructions */
    description: text("description"),
    /** 市场分类:内容生产 / 账号经营 / 合规审稿 */
    category: text("category"),

    // ---- 招聘时用来 materialize 出一个真 agent 的配方 ----
    /** 人格 / 系统指令,招聘时写进 agent 的 AGENTS.md 指令包 */
    instructions: text("instructions").notNull(),
    adapterType: text("adapter_type"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    /** 方法包(skills)绑定:string[] 或 {key, versionId}[],招聘时解析成 desiredSkills */
    desiredSkills: jsonb("desired_skills").$type<unknown[]>().notNull().default([]),

    // ---- 可见性与归属 ----
    /** private = 只有创建者可见;company = 全公司可见;public = 跨公司(操盘手上架) */
    visibility: text("visibility").notNull().default("company"),
    status: text("status").notNull().default("active"),
    createdByType: text("created_by_type").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),

    /** out-of-date 比对基准,由触发器兜底自增 */
    version: integer("version").notNull().default(1),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // 市场列表的主查询:按公司 + 状态过滤,按更新时间倒序
    companyStatusIdx: index("agent_templates_company_status_idx").on(
      table.companyId,
      table.status,
      table.updatedAt.desc(),
    ),
    companyVisibilityIdx: index("agent_templates_company_visibility_idx").on(
      table.companyId,
      table.visibility,
    ),
    // 外键必须有索引(级联删除 + JOIN)
    createdByAgentIdx: index("agent_templates_created_by_agent_idx").on(table.createdByAgentId),
    // 同一公司内,在架模板不允许重名 —— 否则市场里两张一模一样的卡片,用户没法选
    companyNameUq: uniqueIndex("agent_templates_company_name_uq")
      .on(table.companyId, table.name)
      .where(sql`${table.status} = 'active'`),

    visibilityCheck: check(
      "agent_templates_visibility_check",
      sql`${table.visibility} IN ('private', 'company', 'public')`,
    ),
    statusCheck: check(
      "agent_templates_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    // 创建者身份 XOR:user 模板不能挂 agent_id,agent 模板不能挂 user_id(沿用 0148 squad_members 的约定)
    createdByCheck: check(
      "agent_templates_created_by_check",
      sql`(
        (${table.createdByType} = 'user' AND ${table.createdByUserId} IS NOT NULL AND ${table.createdByAgentId} IS NULL)
        OR (${table.createdByType} = 'agent' AND ${table.createdByAgentId} IS NOT NULL AND ${table.createdByUserId} IS NULL)
      )`,
    ),
    instructionsCheck: check(
      "agent_templates_instructions_check",
      sql`length(btrim(${table.instructions})) > 0`,
    ),
    versionCheck: check("agent_templates_version_check", sql`${table.version} >= 1`),
  }),
);
