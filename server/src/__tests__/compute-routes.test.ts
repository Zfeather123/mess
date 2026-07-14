import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  computeAccounts,
  computeRechargeOrders,
  computeTransactions,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { computeRoutes } from "../routes/compute.js";
import { computeService } from "../services/compute.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`跳过算力路由测试(本机不支持 embedded Postgres):${support.reason ?? "unsupported"}`);
}

describeDb("compute routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof computeService>;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  /** actor 由中间件注入 —— 测试里直接塞,不走真实鉴权链路。 */
  let actor: Record<string, unknown>;

  let server: Server | null = null;
  let baseUrl = "";

  /**
   * 显式绑 127.0.0.1 —— supertest 默认让 Node 挑地址,这台机器上会挑到 ::1 而 IPv6
   * loopback 不可用(EADDRNOTAVAIL)。仓库里既有的路由测试也是这么绕的。
   */
  async function startServer() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", computeRoutes(db));
    app.use(errorHandler);

    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  /** 每个用例都拿同一个 server;actor 是可变量,中间件在请求时才读。 */
  function buildApp() {
    return baseUrl;
  }

  function asMember() {
    actor = {
      type: "board",
      source: "board_key",
      userId: "user-1",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
    };
  }

  function asInstanceAdmin() {
    actor = {
      type: "board",
      source: "board_key",
      userId: "admin-1",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: true,
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-compute-routes-");
    db = createDb(tempDb.connectionString);
    await startServer();
    svc = computeService(db);

    const company = await db
      .insert(companies)
      .values({
        name: `Compute ${randomUUID()}`,
        issuePrefix: `CP${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;

    const agent = await db
      .insert(agents)
      .values({ companyId, name: "文案编导", role: "文案编导" })
      .returning()
      .then((rows) => rows[0]!);
    agentId = agent.id;

    const issue = await db
      .insert(issues)
      .values({ companyId, identifier: "CP-1", title: "写一条普法短视频脚本", status: "done" })
      .returning()
      .then((rows) => rows[0]!);
    issueId = issue.id;
  }, 180_000);

  afterAll(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(computeTransactions);
    await db.delete(computeRechargeOrders);
    await db.delete(computeAccounts);
    asMember();
  });

  it("从没充过值也能看到 0 余额 —— 首次读自动建账户,不是 404", async () => {
    const res = await request(buildApp()).get(`/api/companies/${companyId}/compute/balance`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      balancePoints: 0,
      frozenPoints: 0,
      availablePoints: 0,
      monthlyUsedPoints: 0,
      monthlyQuotaPoints: null,
      status: "active",
    });
    expect(res.body.accountId).toBeTruthy();

    const accountRows = await db.select().from(computeAccounts);
    expect(accountRows).toHaveLength(1);
  });

  it("availablePoints = 余额 - 冻结,本月已用只算本月的 debit", async () => {
    const account = await svc.ensureAccount(companyId);
    await db
      .update(computeAccounts)
      .set({ balancePoints: 10_000, frozenPoints: 1_500 })
      .where(eq(computeAccounts.id, account.id));

    await db.insert(computeTransactions).values([
      {
        companyId,
        accountId: account.id,
        direction: "debit",
        points: 300,
        balanceAfter: 9_700,
        reason: "consume",
        idempotencyKey: `k-${randomUUID()}`,
      },
      {
        companyId,
        accountId: account.id,
        direction: "debit",
        points: 999,
        balanceAfter: 9_000,
        reason: "consume",
        idempotencyKey: `k-${randomUUID()}`,
        // 上个月的消费不该计进「本月已用」
        createdAt: new Date("2020-01-05T00:00:00.000Z"),
      },
    ]);

    const res = await request(buildApp()).get(`/api/companies/${companyId}/compute/balance`);
    expect(res.status).toBe(200);
    expect(res.body.balancePoints).toBe(10_000);
    expect(res.body.frozenPoints).toBe(1_500);
    expect(res.body.availablePoints).toBe(8_500);
    expect(res.body.monthlyUsedPoints).toBe(300);
  });

  it("用量明细带出员工名和任务标题,keyset 游标翻页不重不漏", async () => {
    const account = await svc.ensureAccount(companyId);
    for (let i = 0; i < 5; i += 1) {
      await db.insert(computeTransactions).values({
        companyId,
        accountId: account.id,
        direction: "debit",
        points: 10 + i,
        balanceAfter: 1_000 - i,
        reason: "consume",
        agentId,
        issueId,
        idempotencyKey: `k-${randomUUID()}`,
        createdAt: new Date(Date.now() - i * 1_000),
      });
    }

    const app = buildApp();
    const first = await request(app).get(`/api/companies/${companyId}/compute/usage?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.transactions).toHaveLength(2);
    expect(first.body.transactions[0].agentName).toBe("文案编导");
    expect(first.body.transactions[0].issueTitle).toBe("写一条普法短视频脚本");
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app).get(
      `/api/companies/${companyId}/compute/usage?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.transactions).toHaveLength(2);

    const firstIds = first.body.transactions.map((t: { id: string }) => t.id);
    const secondIds = second.body.transactions.map((t: { id: string }) => t.id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);

    const third = await request(app).get(
      `/api/companies/${companyId}/compute/usage?limit=2&cursor=${encodeURIComponent(second.body.nextCursor)}`,
    );
    expect(third.body.transactions).toHaveLength(1);
    expect(third.body.nextCursor).toBeNull();
  });

  it("充值金额由服务端复算 —— 客户端传的价一律不认", async () => {
    const res = await request(buildApp())
      .post(`/api/companies/${companyId}/compute/recharge`)
      // amountCents 是伪造的「1 分钱买 5000 点」,schema 里根本没这个字段
      .send({ points: 5_000, channel: "manual", amountCents: 1 });

    expect(res.status).toBe(201);
    expect(res.body.points).toBe(5_000);
    expect(res.body.amountCents).toBe(5_000); // 5000 点 = 50 元 = 5000 分
    expect(res.body.status).toBe("pending");
    expect(res.body.payUrl).toBeNull();
  });

  it("非法面额 / 非法渠道被拦下", async () => {
    const app = buildApp();
    const negative = await request(app)
      .post(`/api/companies/${companyId}/compute/recharge`)
      .send({ points: -100, channel: "manual" });
    expect(negative.status).toBe(400);

    const badChannel = await request(app)
      .post(`/api/companies/${companyId}/compute/recharge`)
      .send({ points: 5_000, channel: "bitcoin" });
    expect(badChannel.status).toBe(400);
  });

  it("人工确认到账:管理员限定 + 幂等 + 真的加到余额上", async () => {
    const created = await request(buildApp())
      .post(`/api/companies/${companyId}/compute/recharge`)
      .send({ points: 5_000, channel: "manual" });
    const orderId = created.body.id as string;

    // 普通成员点不亮这个接口 —— 它凭空造钱
    const denied = await request(buildApp())
      .post(`/api/companies/${companyId}/compute/recharge/${orderId}/settle`)
      .send({});
    expect(denied.status).toBe(403);

    asInstanceAdmin();
    const settled = await request(buildApp())
      .post(`/api/companies/${companyId}/compute/recharge/${orderId}/settle`)
      .send({ externalOrderId: "bank-流水-001" });
    expect(settled.status).toBe(200);
    expect(settled.body.status).toBe("paid");
    expect(settled.body.paidAt).toBeTruthy();

    const balance = await request(buildApp()).get(`/api/companies/${companyId}/compute/balance`);
    expect(balance.body.balancePoints).toBe(5_000);
    expect(balance.body.availablePoints).toBe(5_000);

    // 重复确认:409,且余额不变(钱不会加两次)
    const again = await request(buildApp())
      .post(`/api/companies/${companyId}/compute/recharge/${orderId}/settle`)
      .send({});
    expect(again.status).toBe(409);

    const after = await request(buildApp()).get(`/api/companies/${companyId}/compute/balance`);
    expect(after.body.balancePoints).toBe(5_000);
  });

  it("wechat / alipay 的单不能人工点亮 —— 没接支付 provider,那等于没收到钱就发货", async () => {
    const created = await request(buildApp())
      .post(`/api/companies/${companyId}/compute/recharge`)
      .send({ points: 10_000, channel: "wechat" });
    expect(created.status).toBe(201);
    expect(created.body.payUrl).toBeNull();

    asInstanceAdmin();
    const settled = await request(buildApp())
      .post(`/api/companies/${companyId}/compute/recharge/${created.body.id}/settle`)
      .send({});
    expect(settled.status).toBe(422);

    const balance = await request(buildApp()).get(`/api/companies/${companyId}/compute/balance`);
    expect(balance.body.balancePoints).toBe(0);
  });

  it("别的公司的算力看不到", async () => {
    const other = randomUUID();
    const res = await request(buildApp()).get(`/api/companies/${other}/compute/balance`);
    expect(res.status).toBe(403);
  });
});
