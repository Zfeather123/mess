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

  // 每条笔记都带 `injection`(会不会真的进 prompt)+ 当前 injectLimit:
  // 主页展示 100 条、prompt 只吃前 10 条,前端必须能把两者分开画,否则就是在替系统撒谎(JIN-80)。
  router.get("/agents/:id/feedback-notes", async (req, res) => {
    const agent = await loadAgentForRequest(req, req.params.id as string);
    const query = listAgentFeedbackNotesQuerySchema.parse(req.query);
    const listed = await svc.listAnnotated(agent.id, query);
    res.json(
      listed.notes.map((note) => toAgentFeedbackNoteDto(note, note.injection, listed.injectLimit)),
    );
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
    // 带上注入状态,前端的「已记下,下次会照做」才有资格说出口。
    const annotated = await svc.annotateOne(agent.id, note);
    res.status(201).json(
      toAgentFeedbackNoteDto(annotated, annotated.injection, annotated.injectLimit),
    );
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
      const annotated = await svc.annotateOne(note.agentId, note);
      res.json(toAgentFeedbackNoteDto(annotated, annotated.injection, annotated.injectLimit));
    },
  );

  return router;
}
