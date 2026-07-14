import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  coachBindings,
  companies,
  computeAccounts,
  computeTransactions,
  conversationMembers,
  conversations,
  createDb,
  issues,
  moments,
  userNotificationPrefs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { meRoutes } from "../routes/me.js";
import { startOfWeek } from "../services/me.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`跳过「我的」路由测试(本机不支持 embedded Postgres):${support.reason ?? "unsupported"}`);
}

describeDb("me routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let actor: Record<string, unknown>;

  const userId = "user-1";

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
    app.use("/api", meRoutes(db));
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

  function asUser() {
    actor = {
      type: "board",
      source: "board_key",
      userId,
      userName: "王律师",
      userEmail: "wang@example.com",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-me-routes-");
    db = createDb(tempDb.connectionString);
    await startServer();

    const company = await db
      .insert(companies)
      .values({
        name: `Me ${randomUUID()}`,
        issuePrefix: `ME${randomUUID().slice(0, 6).toUpperCase()}`,
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
    await db.delete(computeAccounts);
    await db.delete(moments);
    await db.delete(issues);
    await db.delete(coachBindings);
    await db.delete(conversationMembers);
    await db.delete(conversations);
    await db.delete(userNotificationPrefs);
    asUser();
  });

  const coach = {
    coachUserId: "coach-9",
    name: "李操盘",
    title: "资深抖音法律内容操盘手",
    bio: "带过 30 个法律号",
  };

  it("没绑操盘手时返回 coach: null,不是 404", async () => {
    const res = await request(buildApp()).get(`/api/companies/${companyId}/me/coach`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ coach: null, boundAt: null });
  });

  it("绑定 → 更换:同一时刻只有一个 active 绑定,旧的留痕为 ended", async () => {
    const app = buildApp();
    const first = await request(app).put(`/api/companies/${companyId}/me/coach`).send(coach);
    expect(first.status).toBe(200);
    expect(first.body.coach.userId).toBe("coach-9");
    expect(first.body.boundAt).toBeTruthy();

    const changed = await request(app)
      .put(`/api/companies/${companyId}/me/coach`)
      .send({ coachUserId: "coach-7", name: "张操盘" });
    expect(changed.status).toBe(200);
    expect(changed.body.coach.userId).toBe("coach-7");

    const rows = await db.select().from(coachBindings);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "ended")).toHaveLength(1);
  });

  it("私聊:第一次现建 direct 会话并回填 conversation_id,再点返回同一个", async () => {
    const app = buildApp();
    await request(app).put(`/api/companies/${companyId}/me/coach`).send(coach);

    const first = await request(app).post(`/api/companies/${companyId}/me/coach/dm`);
    expect(first.status).toBe(200);
    expect(first.body.conversationId).toBeTruthy();

    const second = await request(app).post(`/api/companies/${companyId}/me/coach/dm`);
    expect(second.body.conversationId).toBe(first.body.conversationId);

    const convs = await db.select().from(conversations);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.kind).toBe("direct");

    // 会话里坐着两个真人:我 + 操盘手(不是 AI 员工)
    const members = await db.select().from(conversationMembers);
    expect(members).toHaveLength(2);
    expect(members.every((m) => m.memberType === "user")).toBe(true);
    expect(members.map((m) => m.userId).sort()).toEqual(["coach-9", "user-1"]);

    const binding = await request(app).get(`/api/companies/${companyId}/me/coach`);
    expect(binding.body.coach.conversationId).toBe(first.body.conversationId);
  });

  it("没绑操盘手就点私聊 → 404", async () => {
    const res = await request(buildApp()).post(`/api/companies/${companyId}/me/coach/dm`);
    expect(res.status).toBe(404);
  });

  it("通知设置:没设置过 = 全开;PUT 是 upsert,只改传进来的那个", async () => {
    const app = buildApp();
    const initial = await request(app).get(`/api/companies/${companyId}/me/notifications`);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ dailyTasks: true, agentSummary: true, complianceRisk: true });
    // 读不写库 —— 看一眼设置页不该产生一行数据
    expect(await db.select().from(userNotificationPrefs)).toHaveLength(0);

    const updated = await request(app)
      .put(`/api/companies/${companyId}/me/notifications`)
      .send({ dailyTasks: false });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ dailyTasks: false, agentSummary: true, complianceRisk: true });

    const again = await request(app)
      .put(`/api/companies/${companyId}/me/notifications`)
      .send({ agentSummary: false });
    expect(again.body).toEqual({ dailyTasks: false, agentSummary: false, complianceRisk: true });

    expect(await db.select().from(userNotificationPrefs)).toHaveLength(1);
  });

  it("本周概览:完成任务 / 点数 / 每位员工的小结", async () => {
    const weekStart = startOfWeek();
    const inWeek = new Date(weekStart.getTime() + 60 * 60 * 1000);
    const lastWeek = new Date(weekStart.getTime() - 24 * 60 * 60 * 1000);

    await db.insert(issues).values([
      {
        companyId,
        identifier: "ME-1",
        title: "本周完成的任务",
        status: "done",
        assigneeAgentId: agentId,
        completedAt: inWeek,
      },
      {
        companyId,
        identifier: "ME-2",
        title: "上周完成的,不算本周",
        status: "done",
        assigneeAgentId: agentId,
        completedAt: lastWeek,
      },
      { companyId, identifier: "ME-3", title: "还没完成", status: "in_progress" },
    ]);

    const account = await db
      .insert(computeAccounts)
      .values({ companyId, ownerType: "company", balancePoints: 10_000 })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(computeTransactions).values([
      {
        companyId,
        accountId: account.id,
        direction: "debit",
        points: 250,
        balanceAfter: 9_750,
        reason: "consume",
        agentId,
        idempotencyKey: `k-${randomUUID()}`,
        createdAt: inWeek,
      },
      {
        companyId,
        accountId: account.id,
        direction: "debit",
        points: 900,
        balanceAfter: 9_000,
        reason: "consume",
        agentId,
        idempotencyKey: `k-${randomUUID()}`,
        createdAt: lastWeek,
      },
    ]);

    const res = await request(buildApp()).get(`/api/companies/${companyId}/me/overview`);
    expect(res.status).toBe(200);
    expect(res.body.weekStart).toBe(weekStart.toISOString().slice(0, 10));
    expect(res.body.tasksCompleted).toBe(1);
    expect(res.body.pointsUsed).toBe(250);
    expect(res.body.perAgent).toEqual([
      { agentId, agentName: "文案编导", points: 250, tasks: 1 },
    ]);
  });

  it("导出:只导自己的朋友圈,别人的一个字节都不带;带 attachment 头", async () => {
    await db.insert(moments).values([
      { companyId, authorType: "user", authorUserId: userId, content: "我发的" },
      { companyId, authorType: "user", authorUserId: "someone-else", content: "别人发的" },
      { companyId, authorType: "agent", authorAgentId: agentId, content: "AI 员工发的" },
    ]);
    await request(buildApp()).put(`/api/companies/${companyId}/me/coach`).send(coach);

    const res = await request(buildApp()).get(`/api/companies/${companyId}/me/export`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");

    const body = JSON.parse(res.text) as {
      profile: { userId: string; email: string | null };
      moments: Array<{ content: string }>;
      coach: { userId: string } | null;
      notifications: Record<string, boolean>;
    };
    expect(body.profile.userId).toBe(userId);
    expect(body.profile.email).toBe("wang@example.com");
    expect(body.moments.map((m) => m.content)).toEqual(["我发的"]);
    expect(body.coach?.userId).toBe("coach-9");
    expect(body.notifications).toEqual({ dailyTasks: true, agentSummary: true, complianceRisk: true });
  });

  it("agent key 打进来 403 —— agent 没有「我」这个主体", async () => {
    actor = { type: "agent", source: "agent_key", agentId, companyId };
    const res = await request(buildApp()).get(`/api/companies/${companyId}/me/coach`);
    expect(res.status).toBe(403);
  });

  it("别的公司的「我的」看不到", async () => {
    const res = await request(buildApp()).get(`/api/companies/${randomUUID()}/me/coach`);
    expect(res.status).toBe(403);
  });
});
