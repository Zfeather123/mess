import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addSquadMemberSchema,
  createSquadSchema,
  decideSquadDispatchSchema,
  declineSquadDispatchSchema,
  listSquadDispatchesQuerySchema,
  updateSquadSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, squadService } from "../services/index.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function squadRoutes(db: Db) {
  const router = Router();
  const svc = squadService(db);

  async function loadSquadForRequest(req: Parameters<typeof getActorInfo>[0], id: string) {
    const squad = await svc.getById(id);
    if (!squad) throw notFound("Squad not found");
    assertCompanyAccess(req, squad.companyId);
    return squad;
  }

  router.get("/companies/:companyId/squads", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
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
    res.status(201).json(squad);
  });

  router.get("/squads/:id", async (req, res) => {
    res.json(await loadSquadForRequest(req, req.params.id as string));
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
    res.json(squad);
  });

  router.get("/squads/:id/members", async (req, res) => {
    const squad = await loadSquadForRequest(req, req.params.id as string);
    res.json(await svc.listMembers(squad.id));
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
    res.status(201).json(member);
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
    res.json(await svc.listDispatches(squad.id, { state: query.state, limit: query.limit }));
  });

  async function loadDispatchForRequest(req: Parameters<typeof getActorInfo>[0], id: string) {
    const dispatch = await svc.getDispatchById(id);
    if (!dispatch) throw notFound("Dispatch not found");
    assertCompanyAccess(req, dispatch.companyId);
    return dispatch;
  }

  /**
   * 队长决策。已经 dispatched 的派单再决策一次 = 改派:
   * 老的置 reassigned、另开一条新 dispatch,审计链完整保留(不原地覆盖)。
   */
  router.post("/squad-dispatches/:id/decide", validate(decideSquadDispatchSchema), async (req, res) => {
    const existing = await loadDispatchForRequest(req, req.params.id as string);
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
    res.status(reassigning ? 201 : 200).json(dispatch);
  });

  router.post("/squad-dispatches/:id/decline", validate(declineSquadDispatchSchema), async (req, res) => {
    const existing = await loadDispatchForRequest(req, req.params.id as string);
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
    res.json(dispatch);
  });

  return router;
}
