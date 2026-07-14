import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { bindCoachSchema, updateNotificationPrefsSchema } from "@paperclipai/shared/validators/me";
import { validate } from "../middleware/validate.js";
import { meService } from "../services/me.js";
import { logActivity } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * 「我的」路由(挂在 /api 下)。
 *
 *   GET  /companies/:companyId/me/coach          当前操盘手(null = 还没绑)
 *   PUT  /companies/:companyId/me/coach          绑定 / 更换操盘手
 *   POST /companies/:companyId/me/coach/dm       打开与操盘手的私聊(没有就现建,幂等)
 *   GET  /companies/:companyId/me/notifications  通知设置(没有行 = 全开)
 *   PUT  /companies/:companyId/me/notifications  改通知设置(upsert)
 *   GET  /companies/:companyId/me/overview       本周概览
 *   GET  /companies/:companyId/me/export         数据导出(只导本人的)
 *
 * 「我的」是**人**的页面:AI 员工没有「我的操盘手」。所以这些接口一律要求 user actor,
 * agent key 打进来直接 403 —— 不是为了防谁,是因为 agent 根本没有一个「自己」可导。
 */
export function meRoutes(db: Db) {
  const router = Router();
  const svc = meService(db);

  /** 「我的」= 调用者本人。agent 没有本人可言。 */
  function requireUser(req: Request): { userId: string; name: string | null; email: string | null } {
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") {
      throw forbidden("「我的」只对真人用户开放,agent key 没有「我」这个主体");
    }
    return {
      userId: actor.actorId,
      name: req.actor.userName ?? null,
      email: req.actor.userEmail ?? null,
    };
  }

  router.get("/companies/:companyId/me/coach", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const user = requireUser(req);
    res.json(await svc.getCoach(companyId, user.userId));
  });

  router.put("/companies/:companyId/me/coach", validate(bindCoachSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const user = requireUser(req);

    const binding = await svc.bindCoach(companyId, user.userId, req.body);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: user.userId,
      action: "me.coach_bound",
      entityType: "coach_binding",
      entityId: binding.coach?.userId ?? user.userId,
      details: { coachUserId: binding.coach?.userId ?? null },
    });

    res.json(binding);
  });

  router.post("/companies/:companyId/me/coach/dm", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const user = requireUser(req);
    res.json(await svc.openCoachDm(companyId, user.userId));
  });

  router.get("/companies/:companyId/me/notifications", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const user = requireUser(req);
    res.json(await svc.getNotificationPrefs(companyId, user.userId));
  });

  router.put(
    "/companies/:companyId/me/notifications",
    validate(updateNotificationPrefsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const user = requireUser(req);
      res.json(await svc.updateNotificationPrefs(companyId, user.userId, req.body));
    },
  );

  router.get("/companies/:companyId/me/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    requireUser(req);
    res.json(await svc.getWeeklyOverview(companyId));
  });

  /** 数据导出:只导调用者自己的数据,别人的一个字节都不带。 */
  router.get("/companies/:companyId/me/export", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const user = requireUser(req);

    const payload = await svc.exportData(companyId, user.userId, {
      userId: user.userId,
      name: user.name,
      email: user.email,
    });

    const filename = `xiaojing-export-${companyId}-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(payload, null, 2));
  });

  return router;
}
