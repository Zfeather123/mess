import { z } from "zod";
import {
  AGENT_FEEDBACK_NOTE_KINDS,
  AGENT_FEEDBACK_NOTE_SCOPE_TYPES,
  AGENT_FEEDBACK_NOTE_SOURCE_TYPES,
  AGENT_FEEDBACK_NOTE_STATUSES,
} from "../constants.js";

/**
 * scope 与 scope 载体 id 必须自洽:
 *   scopeType='douyin_account' → 必须带 douyinAccountId
 *   scopeType='project'        → 必须带 projectId
 *   scopeType='global'         → 两者都不带
 * DB 上没有这条 CHECK(只 CHECK 了取值集合),所以在这层挡住,避免写出「作用域是账号但没有账号」的脏数据。
 */
export const createAgentFeedbackNoteSchema = z
  .object({
    kind: z.enum(AGENT_FEEDBACK_NOTE_KINDS),
    content: z.string().trim().min(1).max(2000),
    scopeType: z.enum(AGENT_FEEDBACK_NOTE_SCOPE_TYPES).optional().default("global"),
    douyinAccountId: z.string().uuid().optional().nullable(),
    projectId: z.string().uuid().optional().nullable(),
    sourceType: z.enum(AGENT_FEEDBACK_NOTE_SOURCE_TYPES),
    sourceMessageId: z.string().uuid().optional().nullable(),
    sourceIssueId: z.string().uuid().optional().nullable(),
    sourceApprovalId: z.string().uuid().optional().nullable(),
    /** 注入时按 weight desc, createdAt desc 取 top-N */
    weight: z.number().int().min(0).max(1000).optional(),
    expiresAt: z.string().datetime().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.scopeType === "douyin_account" && !value.douyinAccountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scopeType 'douyin_account' requires douyinAccountId",
        path: ["douyinAccountId"],
      });
    }
    if (value.scopeType === "project" && !value.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scopeType 'project' requires projectId",
        path: ["projectId"],
      });
    }
    if (value.scopeType === "global" && (value.douyinAccountId || value.projectId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scopeType 'global' must not carry douyinAccountId or projectId",
        path: ["scopeType"],
      });
    }
  });

export type CreateAgentFeedbackNote = z.infer<typeof createAgentFeedbackNoteSchema>;

export const updateAgentFeedbackNoteSchema = z
  .object({
    status: z.enum(AGENT_FEEDBACK_NOTE_STATUSES).optional(),
    weight: z.number().int().min(0).max(1000).optional(),
    content: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field is required",
  });

export type UpdateAgentFeedbackNote = z.infer<typeof updateAgentFeedbackNoteSchema>;

export const listAgentFeedbackNotesQuerySchema = z.object({
  status: z.enum(AGENT_FEEDBACK_NOTE_STATUSES).optional(),
  kind: z.enum(AGENT_FEEDBACK_NOTE_KINDS).optional(),
  scopeType: z.enum(AGENT_FEEDBACK_NOTE_SCOPE_TYPES).optional(),
  douyinAccountId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

export type ListAgentFeedbackNotesQuery = z.infer<typeof listAgentFeedbackNotesQuerySchema>;
