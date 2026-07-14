import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createAgentTemplateFromAgentSchema,
  createAgentTemplateSchema,
  createEmployeeHireSchema,
  listEmployeeMarketQuerySchema,
  updateAgentTemplateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { employeeMarketService, type EmployeeMarketActor } from "../services/employee-market.js";
import { unprocessable } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * AI 员工市场 + 招聘。
 *
 * 前端只认 EmployeeCard 这一个形状,不关心底下是文件(操盘手预制)还是表(用户自定义)。
 *
 *   GET  /api/companies/:companyId/employee-market   → EmployeeCard[](preset ∪ custom)
 *   POST /api/companies/:companyId/employee-hires    → 招一个 AI 员工(materialize 当场发生)
 *   POST /api/companies/:companyId/agent-templates   → 自定义 / 「把这个员工存为模板」
 */
export function employeeMarketRoutes(db: Db) {
  const router = Router();
  const svc = employeeMarketService(db);

  function actorFor(req: Parameters<typeof getActorInfo>[0]): EmployeeMarketActor {
    const actor = getActorInfo(req);
    return {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
    };
  }

  router.get("/companies/:companyId/employee-market", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listEmployeeMarketQuerySchema.parse(req.query);
    res.json(await svc.listEmployeeMarket(companyId, query));
  });

  router.post(
    "/companies/:companyId/employee-hires",
    validate(createEmployeeHireSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = actorFor(req);

      const result = await svc.hireEmployee(companyId, req.body, actor);

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "employee.hired",
        entityType: "agent",
        entityId: result.agentId,
        details: {
          source: req.body.source,
          refId: req.body.refId,
          requiresApproval: result.requiresApproval,
          approvalId: result.approvalId,
          warnings: result.warnings,
        },
      });

      res.status(201).json(result);
    },
  );

  router.get("/companies/:companyId/agent-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listTemplates(companyId));
  });

  router.post("/companies/:companyId/agent-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = actorFor(req);

    // 两种建法:从零写一个,或者「把这个员工存为模板」(带 fromAgentId)
    const card = req.body?.fromAgentId
      ? await svc.createTemplateFromAgent(
          companyId,
          parseOrThrow(createAgentTemplateFromAgentSchema, req.body),
          actor,
        )
      : await svc.createTemplate(companyId, parseOrThrow(createAgentTemplateSchema, req.body), actor);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent_template.created",
      entityType: "agent_template",
      entityId: card.refId,
      details: { name: card.name, fromAgentId: req.body?.fromAgentId ?? null },
    });

    res.status(201).json(card);
  });

  router.patch(
    "/companies/:companyId/agent-templates/:templateId",
    validate(updateAgentTemplateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const card = await svc.updateTemplate(companyId, req.params.templateId as string, req.body);
      res.json(card);
    },
  );

  router.delete("/companies/:companyId/agent-templates/:templateId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await svc.archiveTemplate(companyId, req.params.templateId as string);
    res.status(204).end();
  });

  return router;
}

function parseOrThrow<T>(schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success || !result.data) {
    throw unprocessable(`Invalid agent template payload: ${JSON.stringify(result.error)}`);
  }
  return result.data;
}
