import { agentFeedbackNotes, squadDispatches, squadMembers, squads } from "@paperclipai/db";
import {
  toIso,
  toIsoOrNull,
  type AgentFeedbackNoteDto,
  type SquadDispatchDto,
  type SquadDto,
  type SquadMemberDto,
} from "@paperclipai/shared";

/**
 * 表行 → 响应 DTO。
 *
 * 两条纪律,别绕:
 *   1. **逐字段写**,不许 `...row`。spread 一时爽,加一列就等于给前端加了一条撤不回的承诺。
 *   2. 入参类型是 drizzle 的 `$inferSelect`。列改名 → 这里**编译期**就红,而不是等前端在线上读到 undefined。
 *
 * 加了新列想对外发?来这里加一行,并在 DTO 里声明它 —— 这一步的「麻烦」是故意的:
 * 它把「这个字段从此是对外契约」变成一个需要有人签字的动作。
 */

type SquadRow = typeof squads.$inferSelect;
type SquadMemberRow = typeof squadMembers.$inferSelect;
type SquadDispatchRow = typeof squadDispatches.$inferSelect;
type AgentFeedbackNoteRow = typeof agentFeedbackNotes.$inferSelect;

export function toSquadDto(row: SquadRow): SquadDto {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    leaderAgentId: row.leaderAgentId,
    douyinAccountId: row.douyinAccountId,
    status: row.status as SquadDto["status"],
    dispatchPolicy: row.dispatchPolicy,
    metadata: row.metadata,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toSquadMemberDto(row: SquadMemberRow): SquadMemberDto {
  return {
    id: row.id,
    companyId: row.companyId,
    squadId: row.squadId,
    memberType: row.memberType as SquadMemberDto["memberType"],
    agentId: row.agentId,
    userId: row.userId,
    role: row.role as SquadMemberDto["role"],
    position: row.position,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toSquadDispatchDto(row: SquadDispatchRow): SquadDispatchDto {
  return {
    id: row.id,
    companyId: row.companyId,
    squadId: row.squadId,
    issueId: row.issueId,
    state: row.state as SquadDispatchDto["state"],
    requestedByType: row.requestedByType as SquadDispatchDto["requestedByType"],
    requestedByUserId: row.requestedByUserId,
    requestedByAgentId: row.requestedByAgentId,
    sourceMessageId: row.sourceMessageId,
    assignedAgentId: row.assignedAgentId,
    assignedUserId: row.assignedUserId,
    decidedByAgentId: row.decidedByAgentId,
    decisionReason: row.decisionReason,
    decidedAt: toIsoOrNull(row.decidedAt),
    failureReason: row.failureReason,
    attemptCount: row.attemptCount,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/**
 * `injection` / `injectLimit` 不是表里的列 —— 它们是服务端按注入查询的真实口径算出来的,
 * 必须由调用方显式传进来(见 `agentFeedbackNoteService.listAnnotated`)。
 * 逐字段写、显式传参,就是不让「这条笔记会不会生效」这件事被谁顺手忘掉。
 */
export function toAgentFeedbackNoteDto(
  row: AgentFeedbackNoteRow,
  injection: AgentFeedbackNoteDto["injection"],
  injectLimit: number,
): AgentFeedbackNoteDto {
  return {
    injection,
    injectLimit,
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    scopeType: row.scopeType as AgentFeedbackNoteDto["scopeType"],
    douyinAccountId: row.douyinAccountId,
    projectId: row.projectId,
    kind: row.kind as AgentFeedbackNoteDto["kind"],
    content: row.content,
    sourceType: row.sourceType as AgentFeedbackNoteDto["sourceType"],
    sourceMessageId: row.sourceMessageId,
    sourceIssueId: row.sourceIssueId,
    sourceApprovalId: row.sourceApprovalId,
    createdByUserId: row.createdByUserId,
    createdByAgentId: row.createdByAgentId,
    status: row.status as AgentFeedbackNoteDto["status"],
    weight: row.weight,
    timesApplied: row.timesApplied,
    lastAppliedAt: toIsoOrNull(row.lastAppliedAt),
    expiresAt: toIsoOrNull(row.expiresAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}
