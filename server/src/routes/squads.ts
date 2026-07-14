import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import {
  addSquadMemberSchema,
  createSquadSchema,
  decideSquadDispatchSchema,
  declineSquadDispatchSchema,
  listSquadDispatchesQuerySchema,
  updateSquadSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { toSquadDispatchDto, toSquadDto, toSquadMemberDto } from "../dto/collab.js";
import { heartbeatService, logActivity, squadService } from "../services/index.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { resolveSquadLeaderAgentId } from "../services/squad-dispatch-notify.js";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function squadRoutes(db: Db) {
  const router = Router();
  const svc = squadService(db);
  const heartbeat = heartbeatService(db);

  /**
   * 队长写回决策 → 被指派人开工。
   *
   * 这一段走的是标准 assignee 路径:decide 已经把 `issues.assignee_agent_id` 写成了被指派人,
   * 所以 claim 阶段的 `assignee === run.agentId` 断言天然成立 —— 不需要队长唤醒那套评论把戏。
   * (队长自己为什么唤不醒,见 `services/squad-dispatch-notify.ts`。)
   */
  async function wakeAssignedAgent(
    dispatch: { issueId: string; assignedAgentId: string | null },
    actor: ReturnType<typeof getActorInfo>,
    mutation: string,
  ) {
    if (!dispatch.assignedAgentId) return;
    const issue = await db
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, dispatch.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) return;
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation,
      contextSource: "squad.dispatch_decided",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });
  }

  async function loadSquadForRequest(req: Parameters<typeof getActorInfo>[0], id: string) {
    const squad = await svc.getById(id);
    if (!squad) throw notFound("Squad not found");
    assertCompanyAccess(req, squad.companyId);
    return squad;
  }

  router.get("/companies/:companyId/squads", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json((await svc.list(companyId)).map(toSquadDto));
  });

  router.post("/companies/:companyId/squads", validate(createSquadSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const squad = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "squad.created",
      entityType: "squad",
      entityId: squad.id,
      details: { name: squad.name, leaderAgentId: squad.leaderAgentId },
    });
    res.status(201).json(toSquadDto(squad));
  });

  router.get("/squads/:id", async (req, res) => {
    res.json(toSquadDto(await loadSquadForRequest(req, req.params.id as string)));
  });

  router.patch("/squads/:id", validate(updateSquadSchema), async (req, res) => {
    const existing = await loadSquadForRequest(req, req.params.id as string);
    const squad = await svc.update(existing.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: squad.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "squad.updated",
      entityType: "squad",
      entityId: squad.id,
      details: req.body,
    });
    res.json(toSquadDto(squad));
  });

  router.get("/squads/:id/members", async (req, res) => {
    const squad = await loadSquadForRequest(req, req.params.id as string);
    res.json((await svc.listMembers(squad.id)).map(toSquadMemberDto));
  });

  router.post("/squads/:id/members", validate(addSquadMemberSchema), async (req, res) => {
    const squad = await loadSquadForRequest(req, req.params.id as string);
    const member = await svc.addMember(squad.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: squad.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "squad.member_added",
      entityType: "squad",
      entityId: squad.id,
      details: { memberId: member.id, memberType: member.memberType, role: member.role },
    });
    res.status(201).json(toSquadMemberDto(member));
  });

  router.delete("/squads/:id/members/:memberId", async (req, res) => {
    const squad = await loadSquadForRequest(req, req.params.id as string);
    const member = await svc.removeMember(squad.id, req.params.memberId as string);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: squad.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "squad.member_removed",
      entityType: "squad",
      entityId: squad.id,
      details: { memberId: member.id, memberType: member.memberType },
    });
    res.status(204).end();
  });

  /** 队长的待办队列 */
  router.get("/squads/:id/dispatches", async (req, res) => {
    const squad = await loadSquadForRequest(req, req.params.id as string);
    const query = listSquadDispatchesQuerySchema.parse(req.query);
    const dispatches = await svc.listDispatches(squad.id, { state: query.state, limit: query.limit });
    res.json(dispatches.map(toSquadDispatchDto));
  });

  async function loadDispatchForRequest(req: Parameters<typeof getActorInfo>[0], id: string) {
    const dispatch = await svc.getDispatchById(id);
    if (!dispatch) throw notFound("Dispatch not found");
    assertCompanyAccess(req, dispatch.companyId);
    return dispatch;
  }

  /**
   * 决策(decide / decline)只有**队长**能做。
   *
   * `assertCompanyAccess` 只回答「你是不是这家公司的人」—— 光靠它,公司里**任何一个 agent** 都能替队长
   * 写回决策,而 `decidedByAgentId` 还会默认记成调用者:审计链看着完整,实际是冒名。
   * 派单本身是「队长凭候选人的历史表现来分活」,决策权跑到别的 agent 手上,这条链就没有意义了。
   *
   * - agent 调用方:必须就是这个小队的队长本人,否则 403。
   * - 人类(board)调用方:放行 —— 操盘手/管理员本来就可以替队长兜底决策(队长掉线、误判等)。
   *   他们已经过了 `assertCompanyAccess` 的公司边界校验。
   */
  async function assertSquadDecisionAuthority(
    req: Parameters<typeof getActorInfo>[0],
    dispatch: { squadId: string },
  ) {
    const actor = getActorInfo(req);
    if (actor.actorType !== "agent") return;

    const squad = await svc.getById(dispatch.squadId);
    if (!squad) throw notFound("Squad not found");
    const leaderAgentId = await resolveSquadLeaderAgentId(db, squad.id, squad.leaderAgentId);
    if (!leaderAgentId || actor.agentId !== leaderAgentId) {
      throw forbidden("Only the squad leader can decide this dispatch");
    }
  }

  /**
   * 队长决策。已经 dispatched 的派单再决策一次 = 改派:
   * 老的置 reassigned、另开一条新 dispatch,审计链完整保留(不原地覆盖)。
   */
  router.post("/squad-dispatches/:id/decide", validate(decideSquadDispatchSchema), async (req, res) => {
    const existing = await loadDispatchForRequest(req, req.params.id as string);
    await assertSquadDecisionAuthority(req, existing);
    const actor = getActorInfo(req);
    const payload = { ...req.body, decidedByAgentId: req.body.decidedByAgentId ?? actor.agentId ?? null };
    const reassigning = existing.state === "dispatched";
    const dispatch = reassigning
      ? await svc.reassign(existing.id, payload)
      : await svc.decide(existing.id, payload);
    await logActivity(db, {
      companyId: dispatch.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: reassigning ? "squad.dispatch_reassigned" : "squad.dispatch_decided",
      entityType: "squad_dispatch",
      entityId: dispatch.id,
      details: {
        issueId: dispatch.issueId,
        assignedAgentId: dispatch.assignedAgentId,
        assignedUserId: dispatch.assignedUserId,
        decisionReason: dispatch.decisionReason,
        ...(reassigning ? { previousDispatchId: existing.id } : {}),
      },
    });
    await wakeAssignedAgent(dispatch, actor, reassigning ? "squad_dispatch_reassign" : "squad_dispatch_decide");
    res.status(reassigning ? 201 : 200).json(toSquadDispatchDto(dispatch));
  });

  router.post("/squad-dispatches/:id/decline", validate(declineSquadDispatchSchema), async (req, res) => {
    const existing = await loadDispatchForRequest(req, req.params.id as string);
    await assertSquadDecisionAuthority(req, existing);
    const actor = getActorInfo(req);
    const dispatch = await svc.decline(existing.id, {
      ...req.body,
      decidedByAgentId: req.body.decidedByAgentId ?? actor.agentId ?? null,
    });
    await logActivity(db, {
      companyId: dispatch.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "squad.dispatch_declined",
      entityType: "squad_dispatch",
      entityId: dispatch.id,
      details: { issueId: dispatch.issueId, failureReason: dispatch.failureReason },
    });
    res.json(toSquadDispatchDto(dispatch));
  });

  return router;
}
