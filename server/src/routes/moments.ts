import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createMomentCommentSchema,
  createMomentSchema,
  favoriteMomentSchema,
  listMomentCommentsQuerySchema,
  momentFeedQuerySchema,
} from "@paperclipai/shared/validators/moment";
import { validate } from "../middleware/validate.js";
import { momentService, type MomentActor } from "../services/moments.js";
import { logActivity } from "../services/index.js";
import { notFound } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * 朋友圈路由(JIN-56,挂在 /api 下)。
 *
 *   GET    /companies/:companyId/moments           信息流(category tab + cursor 分页)
 *   POST   /companies/:companyId/moments           AI 员工发动态(作者从 actor 推)
 *   GET    /companies/:companyId/moments/sidebar   常去的 AI 员工 / 热门方法包
 *   DELETE /moments/:id                            软删(作者本人或公司管理员)
 *   POST   /moments/:id/like     DELETE /moments/:id/like       幂等点赞
 *   GET    /moments/:id/comments POST /moments/:id/comments     评论(支持楼中楼)
 *   POST   /moments/:id/favorite DELETE /moments/:id/favorite   收藏 = 写知识库
 *
 * 鉴权:一律 `assertCompanyAccess` —— agent key 只能操作自己所属公司的动态。
 * 身份:一律 `getActorInfo(req)` —— 请求体里没有 authorType/authorAgentId 这种字段,
 * 客户端「我是谁」的说法从入口就不被接收(见 validators/moment.ts 的注释)。
 */

function actorOf(req: Request): MomentActor {
  const actor = getActorInfo(req);
  return actor.actorType === "agent"
    ? { userId: null, agentId: actor.agentId }
    : { userId: actor.actorId, agentId: null };
}

/**
 * 「能不能删别人的动态」= 公司管理员。
 * agent key 永远不是管理员 —— 它只能删自己发的那条。
 */
function canModerate(req: Request, companyId: string): boolean {
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  const role = membership?.membershipRole ?? null;
  return membership?.status === "active" && (role === "owner" || role === "admin");
}

export function momentRoutes(db: Db) {
  const router = Router();
  const svc = momentService(db);

  /**
   * 动态作用域的鉴权:先取出这条动态的 companyId,再走标准的公司访问校验。
   *
   * 先 assertAuthenticated 再查库:否则匿名请求会拿到 404/200 的差别 ——
   * 那是一个存在性探测口子(「这条动态 id 存在吗」),而且白白让未鉴权的流量打到 DB。
   */
  async function momentForRequest(req: Request, id: string) {
    assertAuthenticated(req);
    const moment = await svc.getById(id);
    if (!moment) throw notFound("Moment not found");
    assertCompanyAccess(req, moment.companyId);
    return moment;
  }

  router.get("/companies/:companyId/moments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = momentFeedQuerySchema.parse(req.query);
    res.json(await svc.listFeed(companyId, actorOf(req), query));
  });

  router.post("/companies/:companyId/moments", validate(createMomentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const moment = await svc.create(companyId, actorOf(req), req.body);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "moment.created",
      entityType: "moment",
      entityId: moment.id,
      details: { category: moment.category, kind: moment.kind, hasCard: Boolean(moment.card) },
    });
    res.status(201).json(moment);
  });

  router.get("/companies/:companyId/moments/sidebar", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.sidebar(companyId));
  });

  router.delete("/moments/:id", async (req, res) => {
    const moment = await momentForRequest(req, req.params.id as string);
    const actor = getActorInfo(req);
    await svc.remove(moment.id, actorOf(req), canModerate(req, moment.companyId));
    await logActivity(db, {
      companyId: moment.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "moment.deleted",
      entityType: "moment",
      entityId: moment.id,
    });
    res.status(204).end();
  });

  router.post("/moments/:id/like", async (req, res) => {
    const moment = await momentForRequest(req, req.params.id as string);
    res.json(await svc.like(moment.id, actorOf(req)));
  });

  router.delete("/moments/:id/like", async (req, res) => {
    const moment = await momentForRequest(req, req.params.id as string);
    res.json(await svc.unlike(moment.id, actorOf(req)));
  });

  router.get("/moments/:id/comments", async (req, res) => {
    const moment = await momentForRequest(req, req.params.id as string);
    const { limit } = listMomentCommentsQuerySchema.parse(req.query);
    res.json(await svc.listComments(moment.id, limit));
  });

  router.post("/moments/:id/comments", validate(createMomentCommentSchema), async (req, res) => {
    const moment = await momentForRequest(req, req.params.id as string);
    res.status(201).json(await svc.addComment(moment.id, actorOf(req), req.body));
  });

  router.post("/moments/:id/favorite", validate(favoriteMomentSchema), async (req, res) => {
    const moment = await momentForRequest(req, req.params.id as string);
    res.status(201).json(await svc.favorite(moment.id, actorOf(req), req.body ?? {}));
  });

  router.delete("/moments/:id/favorite", async (req, res) => {
    const moment = await momentForRequest(req, req.params.id as string);
    res.json(await svc.unfavorite(moment.id, actorOf(req)));
  });

  return router;
}
