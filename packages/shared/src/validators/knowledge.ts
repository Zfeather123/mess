import { z } from "zod";

/**
 * 知识库(RAG)+ 方法包(JIN-55)的请求校验。
 *
 * ⚠️ 这里**故意不收** agentId 之外的任何身份字段:检索永远以「哪个 AI 员工在问」为准,
 * 而「这个员工能引用哪些条目」由服务端从 collection_citation_grants 解析,
 * 客户端说了不算 —— 否则任何一把 agent key 都能把别人关掉的收藏读出来。
 */

/** 方法包分类。与产品原型的「平台方法 / 专属方法 / 合规规则」一一对应。 */
export const METHOD_PACK_CATEGORIES = [
  "platform_method",
  "exclusive_method",
  "compliance_rule",
] as const;
export type MethodPackCategory = (typeof METHOD_PACK_CATEGORIES)[number];

/** 展示名。UI 直接用,不要在前端再散落一份中文映射。 */
export const METHOD_PACK_CATEGORY_LABELS: Record<MethodPackCategory, string> = {
  platform_method: "平台方法",
  exclusive_method: "专属方法",
  compliance_rule: "合规规则",
};

/**
 * 方法包 = company_skills 里带这个前缀分类的 skill。
 *
 * 为什么复用 company_skills 而不是新建表:Paperclip 的 skills 系统已经有
 * 版本(company_skill_versions.revision_number + label,「v2.1」就是 label)、
 * 评论、测试用例、按员工绑定(agents.adapter_config.paperclipSkillSync)。
 * 新建一张 method_packs 表 = 把这些全部重写一遍,还要再造一套版本机制。
 */
export const methodPackCategorySchema = z.enum(METHOD_PACK_CATEGORIES);

export const knowledgeSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(2000),
  /** 以哪个 AI 员工的身份检索 —— 引用开关按它解析。 */
  agentId: z.string().uuid(),
  topK: z.coerce.number().int().min(1).max(20).optional(),
  /** 限定某个抖音账号的知识范围(不传 = 全公司)。 */
  douyinAccountId: z.string().uuid().optional().nullable(),
});
export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;

/** 引用开关:allowed=null 表示「删掉例外,回落到条目默认值」。 */
export const setCitationGrantSchema = z.object({
  allowed: z.boolean().nullable(),
});
export type SetCitationGrant = z.infer<typeof setCitationGrantSchema>;

export const reindexItemSchema = z.object({
  /** 强制重算向量,即使原文哈希没变(换 embedding 模型时用)。 */
  force: z.boolean().optional(),
});

export const createMethodPackSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: methodPackCategorySchema,
  description: z.string().trim().max(2000).optional().nullable(),
  /** 方法包正文(SKILL.md 的 markdown)。 */
  markdown: z.string().min(1).max(200_000),
  /** 版本标签,如 "v2.1"。不传则由 revision_number 兜底。 */
  versionLabel: z.string().trim().max(40).optional().nullable(),
});
export type CreateMethodPack = z.infer<typeof createMethodPackSchema>;

export const publishMethodPackVersionSchema = z.object({
  markdown: z.string().min(1).max(200_000),
  versionLabel: z.string().trim().max(40).optional().nullable(),
});

/** 把方法包绑定到 AI 员工。versionId 不传 = 跟随最新版;传了 = 钉死在这一版。 */
export const bindMethodPackSchema = z.object({
  agentId: z.string().uuid(),
  versionId: z.string().uuid().optional().nullable(),
});

export const listMethodPacksQuerySchema = z.object({
  category: methodPackCategorySchema.optional(),
  agentId: z.string().uuid().optional(),
});
