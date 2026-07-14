import { Router } from "express";
import type { Db } from "@paperclipai/db";
// 走子路径而不是桶导出:这三个 schema 是本 PR 新增的,桶(validators/index.ts)由
// 上游统一 wire。子路径("./*": "./src/*.ts")是仓库里既有的合法用法(见 shared/home-paths)。
import {
  createRechargeSchema,
  listComputeUsageQuerySchema,
  settleRechargeSchema,
} from "@paperclipai/shared/validators/compute";
import { validate } from "../middleware/validate.js";
import { computeService } from "../services/compute.js";
import { logActivity } from "../services/index.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

/**
 * 算力钱包路由(挂在 /api 下)。JIN-51 只交付了计费**库**,没有任何 HTTP 面 ——
 * 这是那个面。
 *
 *   GET  /companies/:companyId/compute/balance                   余额(账面 / 冻结 / 可用 + 本月用量)
 *   GET  /companies/:companyId/compute/usage                     用量明细(keyset 分页,含员工名 / 任务标题)
 *   POST /companies/:companyId/compute/recharge                  建充值单(金额服务端复算)
 *   POST /companies/:companyId/compute/recharge/:orderId/settle  人工确认到账 —— **实例管理员限定**
 */
export function computeRoutes(db: Db) {
  const router = Router();
  const svc = computeService(db);

  router.get("/companies/:companyId/compute/balance", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getBalance(companyId));
  });

  router.get("/companies/:companyId/compute/usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listComputeUsageQuerySchema.parse(req.query);
    res.json(await svc.listUsage(companyId, query));
  });

  router.post(
    "/companies/:companyId/compute/recharge",
    validate(createRechargeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const order = await svc.createRecharge(
        companyId,
        actor.actorType === "user" ? actor.actorId : null,
        req.body,
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "compute.recharge_order_created",
        entityType: "compute_recharge_order",
        entityId: order.id,
        details: { points: order.points, amountCents: order.amountCents, channel: order.channel },
      });

      res.status(201).json(order);
    },
  );

  /**
   * 人工确认到账(线下打款 → 管理员点亮)。**这个接口凭空造钱**,所以:
   *   - assertInstanceAdmin:不是公司成员就行,必须是实例管理员 / board
   *   - 只认 manual / gift 渠道:wechat / alipay 没接支付 provider,人工点亮 = 没收到钱也发货
   *   - 幂等:重复调用不会重复加点(ledger.credit 的幂等键 = recharge:<orderId>)
   */
  router.post(
    "/companies/:companyId/compute/recharge/:orderId/settle",
    validate(settleRechargeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertInstanceAdmin(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const order = await svc.settleRecharge(companyId, req.params.orderId as string, req.body);

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "compute.recharge_order_settled",
        entityType: "compute_recharge_order",
        entityId: order.id,
        details: { points: order.points, amountCents: order.amountCents, channel: order.channel },
      });

      res.json(order);
    },
  );

  return router;
}
