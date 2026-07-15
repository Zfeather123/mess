import { z } from "zod";
import {
  SQUAD_DISPATCH_REQUESTED_BY_TYPES,
  SQUAD_DISPATCH_STATES,
  SQUAD_MEMBER_ROLES,
  SQUAD_MEMBER_TYPES,
  SQUAD_STATUSES,
} from "../constants.js";
import {
  addSquadMemberSchema,
  createSquadSchema,
  decideSquadDispatchSchema,
  declineSquadDispatchSchema,
  listSquadDispatchesQuerySchema,
  updateSquadSchema,
} from "../validators/squad.js";
import { dtoJsonObject, dtoTimestamp, dtoUserId, dtoUuid } from "./primitives.js";

/**
 * 小队 / 派单的**响应契约**。
 *
 * `.strict()` 是这层的全部意义:多出一个未声明的 key 就 parse 失败。
 * 于是「有人往 squads 表加了一列、mapper 顺手 spread 出去」这件事会在契约测试里当场变红,
 * 而不是等前端某天依赖上它、再也删不掉的时候才发现。
 * 反过来,加列**不影响**这份契约 —— 没写进 DTO 的列压根不出线。
 */
export const squadDto = z
  .object({
    id: dtoUuid(),
    companyId: dtoUuid(),
    projectId: dtoUuid().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    leaderAgentId: dtoUuid().nullable(),
    douyinAccountId: dtoUuid().nullable(),
    status: z.enum(SQUAD_STATUSES),
    dispatchPolicy: dtoJsonObject(),
    metadata: dtoJsonObject(),
    createdAt: dtoTimestamp(),
    updatedAt: dtoTimestamp(),
  })
  .strict();

export type SquadDto = z.infer<typeof squadDto>;

/**
 * 成员是「一个 id + 一个角色」,**没有**内嵌的 agent / user 对象 ——
 * 路由不 join,调用方拿自己已有的公司花名册去解人。
 * (JIN-63 里前端就是把接口跑一遍才发现没有 `agent` 对象的 —— 现在它被写进契约了。)
 */
export const squadMemberDto = z
  .object({
    id: dtoUuid(),
    companyId: dtoUuid(),
    squadId: dtoUuid(),
    memberType: z.enum(SQUAD_MEMBER_TYPES),
    agentId: dtoUuid().nullable(),
    userId: dtoUserId().nullable(),
    role: z.enum(SQUAD_MEMBER_ROLES),
    position: z.number().int(),
    createdAt: dtoTimestamp(),
    updatedAt: dtoTimestamp(),
  })
  .strict();

export type SquadMemberDto = z.infer<typeof squadMemberDto>;

/**
 * 派单链上的一环:活落到小队 → 队长决定谁接 → `decisionReason` 说明为什么。
 * 改派不覆盖旧行(旧的置 `reassigned`,另开一条),所以这是一条 append-only 的审计链。
 */
export const squadDispatchDto = z
  .object({
    id: dtoUuid(),
    companyId: dtoUuid(),
    squadId: dtoUuid(),
    issueId: dtoUuid(),
    state: z.enum(SQUAD_DISPATCH_STATES),
    requestedByType: z.enum(SQUAD_DISPATCH_REQUESTED_BY_TYPES),
    requestedByUserId: dtoUserId().nullable(),
    requestedByAgentId: dtoUuid().nullable(),
    sourceMessageId: dtoUuid().nullable(),
    assignedAgentId: dtoUuid().nullable(),
    assignedUserId: dtoUserId().nullable(),
    decidedByAgentId: dtoUuid().nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: dtoTimestamp().nullable(),
    /** 被指派人做完的时刻(派单落 `completed` 的那一刻)—— 队长的评审队列按它排 */
    completedAt: dtoTimestamp().nullable(),
    failureReason: z.string().nullable(),
    attemptCount: z.number().int(),
    createdAt: dtoTimestamp(),
    updatedAt: dtoTimestamp(),
  })
  .strict();

export type SquadDispatchDto = z.infer<typeof squadDispatchDto>;

/**
 * 请求侧的入参类型:用 `z.input` 而不是 `z.infer` ——
 * `z.infer` 是**校验之后**的形状(默认值已填好,`role` 变成必填),
 * 调用方手里的是**校验之前**的形状(`role` 可省)。前端拿 infer 会被逼着填一堆本可省略的字段。
 */
export type CreateSquadInput = z.input<typeof createSquadSchema>;
export type UpdateSquadInput = z.input<typeof updateSquadSchema>;
export type AddSquadMemberInput = z.input<typeof addSquadMemberSchema>;
export type DecideSquadDispatchInput = z.input<typeof decideSquadDispatchSchema>;
export type DeclineSquadDispatchInput = z.input<typeof declineSquadDispatchSchema>;
export type ListSquadDispatchesQueryInput = z.input<typeof listSquadDispatchesQuerySchema>;
