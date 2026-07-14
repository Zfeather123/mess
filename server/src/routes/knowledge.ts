import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  bindMethodPackSchema,
  createMethodPackSchema,
  knowledgeSearchQuerySchema,
  listMethodPacksQuerySchema,
  publishMethodPackVersionSchema,
  reindexItemSchema,
  setCitationGrantSchema,
} from "@paperclipai/shared/validators/knowledge";
import { validate } from "../middleware/validate.js";
import { knowledgeBaseService } from "../services/knowledge-base.js";
import { methodPackService } from "../services/method-packs.js";
import { badRequest, notFound } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * 知识库(RAG)+ 方法包路由(JIN-55,挂在 /api 下)。
 *
 *   GET    /companies/:companyId/knowledge/search              以某个 AI 员工的身份检索(★ 引用开关在这里生效)
 *   POST   /companies/:companyId/knowledge/items/:itemId/index (重新)索引一条收藏
 *   POST   /companies/:companyId/knowledge/reindex             批量补索引
 *   GET    /companies/:companyId/knowledge/items/:itemId/grants 引用矩阵(原型里那一列勾选框)
 *   PUT    /companies/:companyId/knowledge/items/:itemId/grants/:agentId  拨开关
 *
 *   GET    /companies/:companyId/method-packs                  方法包列表(可按分类 / 按员工绑定状态)
 *   POST   /companies/:companyId/method-packs                  建方法包 + 发第一版
 *   POST   /companies/:companyId/method-packs/:id/versions     发新版(v2.1)
 *   GET    /companies/:companyId/method-packs/:id/versions     版本历史
 *   PUT    /companies/:companyId/method-packs/:id/bindings     绑定/解绑到 AI 员工
 *
 * 鉴权:一律 assertCompanyAccess —— agent key 只能碰自己公司的知识库。
 *
 * ⚠️ 检索接口的 agentId 是**必填**的:「以谁的身份检索」决定了能看到哪些条目。
 * 没有一个「不指定员工、看全部」的口子 —— 那个口子等于把引用开关绕过去了。
 */
function actorUserId(req: Request): string | null {
  const actor = getActorInfo(req);
  return actor.actorType === "user" ? actor.actorId : null;
}

export function knowledgeRoutes(db: Db) {
  const router = Router();
  const knowledge = knowledgeBaseService(db);
  const methodPacks = methodPackService(db);

  function scope(req: Request): string {
    assertAuthenticated(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  // ── 知识库 ────────────────────────────────────────────────────────────────

  router.get("/companies/:companyId/knowledge/search", async (req, res) => {
    const companyId = scope(req);
    const parsed = knowledgeSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid search query", parsed.error.flatten());

    const citations = await knowledge.retrieve({
      companyId,
      agentId: parsed.data.agentId,
      query: parsed.data.query,
      topK: parsed.data.topK,
      douyinAccountId: parsed.data.douyinAccountId ?? null,
    });
    res.json({
      query: parsed.data.query,
      agentId: parsed.data.agentId,
      embeddingModel: knowledge.provider.model,
      citations,
    });
  });

  router.post(
    "/companies/:companyId/knowledge/items/:itemId/index",
    validate(reindexItemSchema),
    async (req, res) => {
      const companyId = scope(req);
      const result = await knowledge.indexItem(companyId, req.params.itemId as string, {
        force: req.body.force === true,
      });
      // 索引失败要让调用方看见,不能 200 了事 —— 否则用户以为资料已经入库了。
      res.status(result.status === "failed" ? 502 : 200).json(result);
    },
  );

  router.post(
    "/companies/:companyId/knowledge/reindex",
    validate(reindexItemSchema),
    async (req, res) => {
      const companyId = scope(req);
      const results = await knowledge.reindexCompany(companyId, { force: req.body.force === true });
      res.json({
        total: results.length,
        indexed: results.filter((row) => row.status === "indexed").length,
        skipped: results.filter((row) => row.status === "skipped").length,
        failed: results.filter((row) => row.status === "failed").length,
        results,
      });
    },
  );

  router.get("/companies/:companyId/knowledge/items/:itemId/grants", async (req, res) => {
    const companyId = scope(req);
    const grants = await knowledge.listCitationGrants(companyId, req.params.itemId as string);
    if (!grants) throw notFound("Collection item not found");
    res.json(grants);
  });

  router.put(
    "/companies/:companyId/knowledge/items/:itemId/grants/:agentId",
    validate(setCitationGrantSchema),
    async (req, res) => {
      const companyId = scope(req);
      const result = await knowledge.setCitationGrant({
        companyId,
        itemId: req.params.itemId as string,
        agentId: req.params.agentId as string,
        allowed: req.body.allowed,
        grantedByUserId: actorUserId(req),
      });
      res.json({
        itemId: req.params.itemId,
        agentId: req.params.agentId,
        explicit: req.body.allowed,
        effective: result.effective,
      });
    },
  );

  // ── 方法包 ────────────────────────────────────────────────────────────────

  router.get("/companies/:companyId/method-packs", async (req, res) => {
    const companyId = scope(req);
    const parsed = listMethodPacksQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest("Invalid method pack query", parsed.error.flatten());
    res.json(await methodPacks.list(companyId, parsed.data));
  });

  router.post(
    "/companies/:companyId/method-packs",
    validate(createMethodPackSchema),
    async (req, res) => {
      const companyId = scope(req);
      const actor = getActorInfo(req);
      const created = await methodPacks.create(
        companyId,
        req.body,
        actor.actorType === "agent" && actor.agentId
          ? { type: "agent", agentId: actor.agentId }
          : actor.actorId
            ? { type: "user", userId: actor.actorId }
            : null,
      );
      res.status(201).json(created);
    },
  );

  router.get("/companies/:companyId/method-packs/:id/versions", async (req, res) => {
    const companyId = scope(req);
    res.json(await methodPacks.listVersions(companyId, req.params.id as string));
  });

  router.post(
    "/companies/:companyId/method-packs/:id/versions",
    validate(publishMethodPackVersionSchema),
    async (req, res) => {
      const companyId = scope(req);
      const actor = getActorInfo(req);
      const version = await methodPacks.publishVersion(
        companyId,
        req.params.id as string,
        req.body,
        actor.actorType === "agent" && actor.agentId
          ? { type: "agent", agentId: actor.agentId }
          : actor.actorId
            ? { type: "user", userId: actor.actorId }
            : null,
      );
      res.status(201).json(version);
    },
  );

  /** PUT = 绑定(versionId 不传 = 跟随最新版);解绑走下面的 DELETE。 */
  router.put(
    "/companies/:companyId/method-packs/:id/bindings",
    validate(bindMethodPackSchema),
    async (req, res) => {
      const companyId = scope(req);
      res.json(
        await methodPacks.setBinding({
          companyId,
          agentId: req.body.agentId,
          skillId: req.params.id as string,
          bound: true,
          versionId: req.body.versionId ?? null,
        }),
      );
    },
  );

  router.delete("/companies/:companyId/method-packs/:id/bindings/:agentId", async (req, res) => {
    const companyId = scope(req);
    res.json(
      await methodPacks.setBinding({
        companyId,
        agentId: req.params.agentId as string,
        skillId: req.params.id as string,
        bound: false,
      }),
    );
  });

  return router;
}
