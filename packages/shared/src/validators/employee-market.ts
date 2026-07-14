import { z } from "zod";
import {
  AGENT_TEMPLATE_VISIBILITIES,
  EMPLOYEE_MARKET_CATEGORIES,
  EMPLOYEE_SOURCES,
} from "../constants.js";

/**
 * 方法包(skills)绑定。既接受裸 key,也接受钉死版本的 {key, versionId} ——
 * 与 Paperclip agents 的 desiredSkills 形状一致,招聘时原样交给 companySkills 解析。
 */
export const employeeSkillSelectionSchema = z.union([
  z.string().trim().min(1),
  z.object({
    key: z.string().trim().min(1),
    versionId: z.string().uuid().optional().nullable(),
  }),
]);

export type EmployeeSkillSelection = z.infer<typeof employeeSkillSelectionSchema>;

export const listEmployeeMarketQuerySchema = z.object({
  source: z.enum(EMPLOYEE_SOURCES).optional(),
  category: z.enum(EMPLOYEE_MARKET_CATEGORIES).optional(),
  /** true = 只看已招募的(产品原型里的「已招募」分类) */
  hired: z.coerce.boolean().optional(),
  q: z.string().trim().max(200).optional(),
});

export type ListEmployeeMarketQuery = z.infer<typeof listEmployeeMarketQuerySchema>;

/**
 * 招一个 AI 员工。
 *
 * ⚠️ materialize(展开人格 / 方法包 / adapter 配置)发生在这个 POST 里,**不是**在审批回调里。
 * agent-hires 的审批流(approvals.ts → activatePendingApproval)只会「激活一行早已建好的 agent」,
 * 里面没有任何 catalog/template 展开逻辑 —— 把 materialize 挂上去会静默招出一个空壳员工。
 */
export const createEmployeeHireSchema = z.object({
  source: z.enum(EMPLOYEE_SOURCES),
  /** preset → EmployeeCard.refId(catalog 团队/员工坐标);custom → agent_templates.id */
  refId: z.string().trim().min(1).max(400),
  /** 招进来后改个名(不改模板本身) */
  nameOverride: z.string().trim().min(1).max(120).optional(),
  adapterType: z.string().trim().min(1).max(64).optional(),
  reportsTo: z.string().uuid().optional().nullable(),
  sourceIssueId: z.string().uuid().optional().nullable(),
});

export type CreateEmployeeHire = z.infer<typeof createEmployeeHireSchema>;

const agentTemplateFields = {
  name: z.string().trim().min(1).max(120),
  avatarUrl: z.string().trim().max(2000).optional().nullable(),
  role: z.string().trim().min(1).max(64),
  title: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  category: z.enum(EMPLOYEE_MARKET_CATEGORIES).optional().nullable(),
  /** 人格 / 系统指令。空指令 = 招出来一定是空壳员工,DB 也有 CHECK 兜底。 */
  instructions: z.string().trim().min(1).max(200_000),
  adapterType: z.string().trim().min(1).max(64).optional().nullable(),
  adapterConfig: z.record(z.unknown()).optional(),
  desiredSkills: z.array(employeeSkillSelectionSchema).max(100).optional(),
  visibility: z.enum(AGENT_TEMPLATE_VISIBILITIES).optional(),
  metadata: z.record(z.unknown()).optional(),
};

export const createAgentTemplateSchema = z.object(agentTemplateFields);

export type CreateAgentTemplate = z.infer<typeof createAgentTemplateSchema>;

/**
 * 「把这个员工存为模板」—— 从一个已存在的 agent 反向抽取配方。
 * 与 createAgentTemplateSchema 二选一(路由上按 body 里有没有 fromAgentId 分流)。
 */
export const createAgentTemplateFromAgentSchema = z.object({
  fromAgentId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  category: z.enum(EMPLOYEE_MARKET_CATEGORIES).optional().nullable(),
  visibility: z.enum(AGENT_TEMPLATE_VISIBILITIES).optional(),
});

export type CreateAgentTemplateFromAgent = z.infer<typeof createAgentTemplateFromAgentSchema>;

export const updateAgentTemplateSchema = z
  .object({
    ...agentTemplateFields,
    instructions: agentTemplateFields.instructions.optional(),
    name: agentTemplateFields.name.optional(),
    role: agentTemplateFields.role.optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .partial();

export type UpdateAgentTemplate = z.infer<typeof updateAgentTemplateSchema>;
