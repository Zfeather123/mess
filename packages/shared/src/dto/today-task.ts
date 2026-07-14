import { z } from "zod";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  TODAY_TASK_BUCKETS,
  TODAY_TASK_OPEN_APPROVAL_STATUSES,
} from "../constants.js";
import { dtoTimestamp, dtoUserId, dtoUuid } from "./primitives.js";

/**
 * 今日任务的**响应契约**(JIN-54)。
 *
 * 今日任务 = issue 系统,所以这里出线的是 issue 的一个**子集视图**。
 * 刻意不复用「完整 issue」的形状:`issues` 表有 40+ 列(executionPolicy / monitor* /
 * checkoutRunId / harnessKind …),那些是 Paperclip 的执行层内务,
 * 一旦出线就成了对前端的承诺,而 upstream 随时会改它们。
 * 今日任务只承诺这 17 个字段 —— 前端要更多,来加一行并签字。
 */
export const todayTaskIssueDto = z
  .object({
    id: dtoUuid(),
    companyId: dtoUuid(),
    projectId: dtoUuid().nullable(),
    parentId: dtoUuid().nullable(),
    identifier: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(ISSUE_STATUSES),
    priority: z.enum(ISSUE_PRIORITIES),
    assigneeAgentId: dtoUuid().nullable(),
    assigneeUserId: dtoUserId().nullable(),
    ownerSquadId: dtoUuid().nullable(),
    startedAt: dtoTimestamp().nullable(),
    completedAt: dtoTimestamp().nullable(),
    cancelledAt: dtoTimestamp().nullable(),
    createdAt: dtoTimestamp(),
    updatedAt: dtoTimestamp(),
  })
  .strict();
export type TodayTaskIssueDto = z.infer<typeof todayTaskIssueDto>;

/** 挂在任务上的未决审批 —— 「待确认」这个桶的**唯一**依据 */
export const todayTaskOpenApprovalDto = z
  .object({
    id: dtoUuid(),
    type: z.string(),
    status: z.enum(TODAY_TASK_OPEN_APPROVAL_STATUSES),
    createdAt: dtoTimestamp(),
    updatedAt: dtoTimestamp(),
  })
  .strict();
export type TodayTaskOpenApprovalDto = z.infer<typeof todayTaskOpenApprovalDto>;

/**
 * 进度(「补充 3 项关键信息 2/5」)。
 *
 * **`null` 是合法值,而且很常见** —— `issues` 上没有进度列,进度只从子 issue 推。
 * 没有子 issue 就没有分母,那就如实返回 null,**绝不编一个百分比**。
 * 契约把 nullable 写死,前端就必须处理「没有进度」这一态,而不是拿到 undefined 渲染成 0%。
 */
export const todayTaskProgressDto = z
  .object({
    completed: z.number().int(),
    total: z.number().int(),
    label: z.string(),
  })
  .strict();
export type TodayTaskProgressDto = z.infer<typeof todayTaskProgressDto>;

export const todayTaskDto = z
  .object({
    issue: todayTaskIssueDto,
    bucket: z.enum(TODAY_TASK_BUCKETS),
    progress: todayTaskProgressDto.nullable(),
    openApprovals: z.array(todayTaskOpenApprovalDto),
  })
  .strict();
export type TodayTaskDto = z.infer<typeof todayTaskDto>;

export const todayTaskPageDto = z
  .object({
    tasks: z.array(todayTaskDto),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type TodayTaskPageDto = z.infer<typeof todayTaskPageDto>;

/** tab 角标计数 */
export const todayTaskSummaryDto = z
  .object({
    total: z.number().int(),
    buckets: z.array(
      z
        .object({
          bucket: z.enum(TODAY_TASK_BUCKETS),
          count: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();
export type TodayTaskSummaryDto = z.infer<typeof todayTaskSummaryDto>;
