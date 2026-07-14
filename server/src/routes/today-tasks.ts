import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { TODAY_TASK_BUCKETS } from "@paperclipai/shared";
import { todayTasksService, TODAY_TASK_MAX_LIMIT } from "../services/today-tasks.js";
import { assertCompanyAccess } from "./authz.js";
import { toTodayTaskPageDto, toTodayTaskSummaryDto } from "../dto/jin54.js";

const bucketSchema = z.enum(TODAY_TASK_BUCKETS);

/** Accepts `?buckets=todo,done` or repeated `?buckets=todo&buckets=done`. */
const bucketsQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const raw = Array.isArray(value) ? value : value.split(",");
    const parsed = raw.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    return parsed.length > 0 ? parsed : undefined;
  })
  .pipe(z.array(bucketSchema).max(TODAY_TASK_BUCKETS.length).optional());

const todayTasksQuerySchema = z.object({
  assigneeAgentId: z.string().uuid().optional(),
  assigneeUserId: z.string().trim().min(1).max(255).optional(),
  squadId: z.string().uuid().optional(),
  buckets: bucketsQuerySchema,
  limit: z.coerce.number().int().min(1).max(TODAY_TASK_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

const todayTasksSummaryQuerySchema = todayTasksQuerySchema.omit({
  buckets: true,
  limit: true,
  cursor: true,
});

export function todayTasksRoutes(db: Db) {
  const router = Router();
  const svc = todayTasksService(db);

  // 今日任务 list. Route modules are mounted prefix-less, so the full path is declared here.
  router.get("/companies/:companyId/today-tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = todayTasksQuerySchema.parse(req.query);
    const result = await svc.listForCompany(companyId, query);
    res.json(toTodayTaskPageDto(result));
  });

  // Bucket counts for the tab badges (进行中 / 已完成 / 待确认 / 待处理).
  router.get("/companies/:companyId/today-tasks/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = todayTasksSummaryQuerySchema.parse(req.query);
    const result = await svc.getSummary(companyId, query);
    res.json(toTodayTaskSummaryDto(result));
  });

  return router;
}
