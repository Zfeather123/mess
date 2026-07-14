import { z } from "zod";
import {
  SQUAD_DISPATCH_STATES,
  SQUAD_MEMBER_ROLES,
  SQUAD_MEMBER_TYPES,
  SQUAD_STATUSES,
} from "../constants.js";

export const createSquadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  leaderAgentId: z.string().uuid().optional().nullable(),
  douyinAccountId: z.string().uuid().optional().nullable(),
  dispatchPolicy: z.record(z.unknown()).optional(),
});

export type CreateSquad = z.infer<typeof createSquadSchema>;

export const updateSquadSchema = createSquadSchema.partial().extend({
  status: z.enum(SQUAD_STATUSES).optional(),
});

export type UpdateSquad = z.infer<typeof updateSquadSchema>;

/**
 * 成员身份 XOR:agent 成员必须带 agentId,user 成员必须带 userId。
 * DB 上有 squad_members_principal_check 兜底,这里提前给出 400 而不是 500。
 */
export const addSquadMemberSchema = z
  .object({
    memberType: z.enum(SQUAD_MEMBER_TYPES),
    agentId: z.string().uuid().optional().nullable(),
    /** 沿用 Paperclip 约定:user_id 是裸 text,不外键 better-auth 的 user 表 */
    userId: z.string().trim().min(1).optional().nullable(),
    role: z.enum(SQUAD_MEMBER_ROLES).optional().default("member"),
    position: z.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.memberType === "agent" && (!value.agentId || value.userId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent members require agentId and must not carry userId",
        path: ["agentId"],
      });
    }
    if (value.memberType === "user" && (!value.userId || value.agentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user members require userId and must not carry agentId",
        path: ["userId"],
      });
    }
  });

export type AddSquadMember = z.infer<typeof addSquadMemberSchema>;

export const listSquadDispatchesQuerySchema = z.object({
  state: z.enum(SQUAD_DISPATCH_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type ListSquadDispatchesQuery = z.infer<typeof listSquadDispatchesQuerySchema>;

/**
 * decisionReason 必填:「队长为什么派给文案编导而不是选题策划师」是产品要展示的核心价值,
 * 必须留痕(架构师在 JIN-50 明确要求)。
 */
export const decideSquadDispatchSchema = z
  .object({
    assignedAgentId: z.string().uuid().optional().nullable(),
    assignedUserId: z.string().trim().min(1).optional().nullable(),
    decisionReason: z.string().trim().min(1).max(2000),
    decidedByAgentId: z.string().uuid().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    const hasAgent = Boolean(value.assignedAgentId);
    const hasUser = Boolean(value.assignedUserId);
    if (hasAgent === hasUser) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of assignedAgentId or assignedUserId is required",
        path: ["assignedAgentId"],
      });
    }
  });

export type DecideSquadDispatch = z.infer<typeof decideSquadDispatchSchema>;

export const declineSquadDispatchSchema = z.object({
  failureReason: z.string().trim().min(1).max(2000),
  decidedByAgentId: z.string().uuid().optional().nullable(),
});

export type DeclineSquadDispatch = z.infer<typeof declineSquadDispatchSchema>;
