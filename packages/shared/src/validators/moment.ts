import { z } from "zod";

/**
 * 朋友圈(JIN-56)的请求校验。
 *
 * 取值集合与 @xiaojing/protocol 的 MomentCategory / MomentKind / MomentCardType 一一对应,
 * 也与 0148 / 0151 迁移里的 CHECK 约束一一对应 —— 三处必须同时改,少改一处就会出现
 * 「zod 放过了、DB 抛 23514」的 500。
 *
 * ⚠️ 这里**故意不收** authorType / authorAgentId / authorUserId:
 * 作者身份一律由服务端从 `getActorInfo(req)` 推。客户端说自己是谁,不作数 ——
 * 否则任何一把 agent key 都能冒充别的员工发动态。
 */

export const MOMENT_CATEGORIES = ["ai_update", "industry", "promo"] as const;
export const MOMENT_KINDS = ["update", "insight", "milestone", "work_product"] as const;
export const MOMENT_CARD_TYPES = ["method_pack", "rule_set", "trend", "service"] as const;

export const momentCardSchema = z.object({
  type: z.enum(MOMENT_CARD_TYPES),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(2000).optional().nullable(),
  items: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  version: z.string().trim().max(40).optional().nullable(),
  actionLabel: z.string().trim().max(40).optional().nullable(),
  href: z.string().trim().max(2000).optional().nullable(),
});

export const createMomentSchema = z.object({
  content: z.string().trim().min(1).max(5000),
  category: z.enum(MOMENT_CATEGORIES).optional(),
  kind: z.enum(MOMENT_KINDS).optional(),
  /** 不传 = 服务端用 parseTags(content) 从正文抽 #标签 */
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  card: momentCardSchema.optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  douyinAccountId: z.string().uuid().optional().nullable(),
});

export type CreateMoment = z.infer<typeof createMomentSchema>;

/**
 * 信息流游标分页。cursor = 上一页最后一条的 createdAt(ISO 串),不是 offset:
 * 信息流边刷边有新动态插到头部,offset 会让第二页重复/漏掉记录。
 */
export const momentFeedQuerySchema = z.object({
  category: z.enum(MOMENT_CATEGORIES).optional(),
  cursor: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export type MomentFeedQuery = z.infer<typeof momentFeedQuerySchema>;

export const createMomentCommentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  parentCommentId: z.string().uuid().optional().nullable(),
});

export type CreateMomentComment = z.infer<typeof createMomentCommentSchema>;

export const listMomentCommentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

export type ListMomentCommentsQuery = z.infer<typeof listMomentCommentsQuerySchema>;

/** 收藏可选落到某个收藏夹;不传 = 落进「未分类」(collection_id 为空)。 */
export const favoriteMomentSchema = z.object({
  collectionId: z.string().uuid().optional().nullable(),
});

export type FavoriteMoment = z.infer<typeof favoriteMomentSchema>;
