import { z } from "zod";
import {
  AGENT_FEEDBACK_NOTE_INJECTION_STATES,
  AGENT_FEEDBACK_NOTE_KINDS,
  AGENT_FEEDBACK_NOTE_SCOPE_TYPES,
  AGENT_FEEDBACK_NOTE_SOURCE_TYPES,
  AGENT_FEEDBACK_NOTE_STATUSES,
} from "../constants.js";
import {
  createAgentFeedbackNoteSchema,
  updateAgentFeedbackNoteSchema,
} from "../validators/agent-feedback-note.js";
import { dtoTimestamp, dtoUserId, dtoUuid } from "./primitives.js";

/**
 * 反馈笔记的响应契约。
 *
 * 注意这里**没有** `scopeLabel` / `sourceLabel` —— 前端一度以为有(手抄的镜像类型里写了),
 * 服务端从来没发过。富标签是展示层的事,由前端按 `scopeType` / `sourceType` 自己渲染:
 * 服务端预渲染文案 = 把 i18n 和排版决策焊死在 API 里。
 */
export const agentFeedbackNoteDto = z
  .object({
    id: dtoUuid(),
    companyId: dtoUuid(),
    agentId: dtoUuid(),
    scopeType: z.enum(AGENT_FEEDBACK_NOTE_SCOPE_TYPES),
    douyinAccountId: dtoUuid().nullable(),
    projectId: dtoUuid().nullable(),
    kind: z.enum(AGENT_FEEDBACK_NOTE_KINDS),
    content: z.string(),
    sourceType: z.enum(AGENT_FEEDBACK_NOTE_SOURCE_TYPES),
    sourceMessageId: dtoUuid().nullable(),
    sourceIssueId: dtoUuid().nullable(),
    sourceApprovalId: dtoUuid().nullable(),
    createdByUserId: dtoUserId().nullable(),
    createdByAgentId: dtoUuid().nullable(),
    status: z.enum(AGENT_FEEDBACK_NOTE_STATUSES),
    /** 注入优先级:按 weight desc, createdAt desc 取 top-N 进 task context。 */
    weight: z.number().int(),
    timesApplied: z.number().int(),
    lastAppliedAt: dtoTimestamp().nullable(),
    expiresAt: dtoTimestamp().nullable(),
    createdAt: dtoTimestamp(),
    updatedAt: dtoTimestamp(),
    /**
     * 这条笔记下一次会不会真的进 prompt。**服务端算,前端只负责如实画。**
     * 让前端拿 status + weight + expiresAt 自己推,等于把注入查询的口径抄第二遍 ——
     * 抄错了就是 UI 替系统撒谎,而这正是 JIN-80 要收掉的那件事。
     */
    injection: z.enum(AGENT_FEEDBACK_NOTE_INJECTION_STATES),
    /**
     * 判定 `injection` 时用的注入名额(prompt 每次最多吃几条,可由环境变量覆盖)。
     * 随每条笔记一起发,是因为「未生效 · 超出前 N 条」这句话里的 N 必须是**服务端此刻真实的 N**,
     * 前端写死 10 迟早又是一句谎话。
     */
    injectLimit: z.number().int().nonnegative(),
  })
  .strict();

export type AgentFeedbackNoteDto = z.infer<typeof agentFeedbackNoteDto>;

export type CreateAgentFeedbackNoteInput = z.input<typeof createAgentFeedbackNoteSchema>;
export type UpdateAgentFeedbackNoteInput = z.input<typeof updateAgentFeedbackNoteSchema>;
