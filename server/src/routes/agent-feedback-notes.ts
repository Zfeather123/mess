import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  createAgentFeedbackNoteSchema,
  listAgentFeedbackNotesQuerySchema,
  updateAgentFeedbackNoteSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { toAgentFeedbackNoteDto } from "../dto/collab.js";
import { agentFeedbackNoteService, logActivity } from "../services/index.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentFeedbackNoteRoutes(db: Db) {
  const router = Router();
  const svc = agentFeedbackNoteService(db);

  async function loadAgentForRequest(req: Parameters<typeof getActorInfo>[0], agentId: string) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    return agent;
  }

  router.get("/agents/:id/feedback-notes", async (req, res) => {
    const agent = await loadAgentForRequest(req, req.params.id as string);
    const query = listAgentFeedbackNotesQuerySchema.parse(req.query);
    res.json((await svc.list(agent.id, query)).map(toAgentFeedbackNoteDto));
  });

  router.post("/agents/:id/feedback-notes", validate(createAgentFeedbackNoteSchema), async (req, res) => {
    const agent = await loadAgentForRequest(req, req.params.id as string);
    const actor = getActorInfo(req);
    const note = await svc.create({
      ...req.body,
      companyId: agent.companyId,
      agentId: agent.id,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByAgentId: actor.agentId,
    });
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent.feedback_note_created",
      entityType: "agent_feedback_note",
      entityId: note.id,
      details: { agentId: agent.id, kind: note.kind, scopeType: note.scopeType },
    });
    res.status(201).json(toAgentFeedbackNoteDto(note));
  });

  router.patch(
    "/agent-feedback-notes/:id",
    validate(updateAgentFeedbackNoteSchema),
    async (req, res) => {
      const existing = await svc.getById(req.params.id as string);
      if (!existing) throw notFound("Feedback note not found");
      assertCompanyAccess(req, existing.companyId);
      const note = await svc.update(existing.id, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: note.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "agent.feedback_note_updated",
        entityType: "agent_feedback_note",
        entityId: note.id,
        details: req.body,
      });
      res.json(toAgentFeedbackNoteDto(note));
    },
  );

  return router;
}
