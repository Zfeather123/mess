import { z } from "zod";

/**
 * 「我的」(JIN-56):绑定操盘手 / 通知设置。
 *
 * 操盘手是**真人供给方**(造 agent 卖给用户 + 提供真人点评),不是 AI 员工 ——
 * 所以绑定的是 userId,展示信息在 coach_bindings 上冗余一份(他不一定是本 company 的成员,
 * join 不出来)。
 */
export const bindCoachSchema = z.object({
  coachUserId: z.string().trim().min(1).max(200),
  /** 冗余展示字段:操盘手可能不在本 company 的用户表里,现查不到就得留空。 */
  name: z.string().trim().min(1).max(100),
  title: z.string().trim().max(100).optional().nullable(),
  avatarUrl: z.string().trim().url().max(500).optional().nullable(),
  bio: z.string().trim().max(1000).optional().nullable(),
});

export type BindCoach = z.infer<typeof bindCoachSchema>;

/**
 * 通知设置:三个开关。缺省 = 全开 —— 没设置过的新用户不该静默收不到合规风险提醒。
 * PUT 是 upsert:传哪个改哪个,没传的保持原值(没有行时按默认全开)。
 */
export const updateNotificationPrefsSchema = z
  .object({
    dailyTasks: z.boolean().optional(),
    agentSummary: z.boolean().optional(),
    complianceRisk: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field is required",
  });

export type UpdateNotificationPrefs = z.infer<typeof updateNotificationPrefsSchema>;
