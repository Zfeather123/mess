import { z } from "zod";

/**
 * 算力钱包(JIN-56)的请求校验。
 *
 * 单位:1 点 = 1 分人民币(POINTS_PER_YUAN = 100)。
 * ⚠️ 充值金额(amountCents)**不在请求体里** —— 服务端按 points 复算,
 * 客户端传什么价都不认。少一个字段,就少一条「改价买算力」的路。
 */

export const RECHARGE_CHANNELS = ["wechat", "alipay", "manual", "gift"] as const;
export type RechargeChannelInput = (typeof RECHARGE_CHANNELS)[number];

/** 用量明细分页:keyset 游标(createdAt desc),不是 offset —— 边翻边扣费时 offset 会漏行/重行。 */
export const listComputeUsageQuerySchema = z.object({
  /** 上一页返回的 nextCursor(createdAt 的 ISO 串 + id)。 */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type ListComputeUsageQuery = z.infer<typeof listComputeUsageQuerySchema>;

export const createRechargeSchema = z.object({
  /** 最小 100 点 = 1 元;上限 1,000,000 点 = 1 万元(超过走线下对公,不走这个口子)。 */
  points: z.number().int().min(100).max(1_000_000),
  channel: z.enum(RECHARGE_CHANNELS),
});

export type CreateRecharge = z.infer<typeof createRechargeSchema>;

/** 人工确认到账(线下打款)。这个接口会凭空造钱,只有实例管理员能调。 */
export const settleRechargeSchema = z.object({
  /** 线下流水号 / 支付平台订单号,留痕用。 */
  externalOrderId: z.string().trim().min(1).max(200).optional(),
  memo: z.string().trim().max(500).optional(),
});

export type SettleRecharge = z.infer<typeof settleRechargeSchema>;
