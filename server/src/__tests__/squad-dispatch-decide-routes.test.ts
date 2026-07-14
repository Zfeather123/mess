import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  squadDispatches,
  squadMembers,
  squads,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { squadRoutes } from "../routes/squads.js";
import { syncSquadDispatchForIssue } from "../services/squads.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Squad decide test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres squad decide route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * JIN-78 / P0-2 + P1-4:队长决策 → 被指派人真的开工;而且只有队长能决策。
 *
 * ⚠️ 这个套件**不 stub heartbeat** —— 走的是 `squadRoutes(db)` 里那个真的 `heartbeatService(db)`。
 * 现有两个 squad 套件之所以 18/18 全绿却没发现这个 bug,就是因为它们 seed 的 issue 是 `todo`
 * (绕开了 backlog 这条真实路径)、并且把 heartbeat 换成了假的(于是「有没有真的排出 run」根本没被看)。
 *
 * 断言口径因此定死在**最终产物**上:被指派人有没有 `heartbeat_runs` 行。
 */
describeEmbeddedPostgres("squad dispatch decide routes (派单最后一跳:被指派人必须真的开工)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-squad-decide-routes-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    runningProcesses.clear();
    // run 是异步跑起来的,等它落到终态再清表,否则 FK 会被半路的 insert 撞上
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(squadDispatches);
        await db.delete(squadMembers);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(squads);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** 真实路由 + 真实 heartbeat(squadRoutes 内部自己 new 一个 heartbeatService(db)) */
  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", squadRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /**
   * ⚠️ 必须显式绑 `127.0.0.1`。
   * supertest 默认让 express 自己 listen,主机名会解析到 `::1` —— WSL 沙箱没有 IPv6 回环,
   * 于是整套路由测试直接 `EADDRNOTAVAIL ::1`。这是**环境问题,不是代码问题**,
   * 绕开它的正确姿势是绑 IPv4 回环(#40 也是这么收口的),而不是去改被测代码迁就它。
   */
  async function callApi(
    actor: Record<string, unknown>,
    buildRequest: (baseUrl: string) => request.Test,
  ) {
    const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
    const server = createServer(createApp(actor));
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected HTTP server to listen on a TCP port");
      }
      return await buildRequest(`http://127.0.0.1:${address.port}`);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  }

  const agentActor = (companyId: string, agentId: string) => ({
    type: "agent" as const,
    agentId,
    companyId,
    source: "agent_key" as const,
  });

  const boardActor = (companyId: string) => ({
    type: "board" as const,
    userId: "local-board",
    companyIds: [companyId],
    source: "local_implicit" as const,
    isInstanceAdmin: false,
  });

  /**
   * ⚠️ issue 必须 seed 成 **backlog** —— 这正是生产里的形态:
   * 派给小队的 issue 没有 assignee → validator(issue.ts:359)默认落 backlog。
   * seed 成 todo 就把这个 bug 整个绕过去了。
   */
  async function seedBacklogSquadIssue() {
    const company = await db
      .insert(companies)
      .values({
        name: `Jin ${randomUUID().slice(0, 8)}`,
        issuePrefix: `SD${randomUUID().slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "responsible-user",
      })
      .returning()
      .then((rows) => rows[0]!);

    const makeAgent = (name: string, role: string) =>
      db
        .insert(agents)
        .values({
          companyId: company.id,
          name,
          role,
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
          permissions: {},
        })
        .returning()
        .then((rows) => rows[0]!);

    const leader = await makeAgent("账号主理人", "leader");
    const writer = await makeAgent("文案编导", "content_writer");
    const outsider = await makeAgent("隔壁组的人", "engineer");

    const squad = await db
      .insert(squads)
      .values({ companyId: company.id, name: "抖音一队", leaderAgentId: leader.id })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(squadMembers).values([
      {
        companyId: company.id,
        squadId: squad.id,
        memberType: "agent",
        agentId: leader.id,
        role: "leader",
        position: 0,
      },
      {
        companyId: company.id,
        squadId: squad.id,
        memberType: "agent",
        agentId: writer.id,
        role: "member",
        position: 1,
      },
    ]);

    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "SD-1",
        issueNumber: 1,
        title: "本周离婚财产分割选题",
        description: "做一条讲婚前财产认定的口播视频。",
        status: "backlog", // ⚠️ 见上面那段注释:这是生产里的真实形态
        priority: "high",
        ownerSquadId: squad.id,
        responsibleUserId: "responsible-user",
      })
      .returning()
      .then((rows) => rows[0]!);

    const dispatch = (await syncSquadDispatchForIssue(db, issue, {
      requestedByType: "agent",
      requestedByAgentId: leader.id,
    }))!;

    return { company, leader, writer, outsider, squad, issue, dispatch };
  }

  const readIssue = (id: string) =>
    db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0]!);

  const runsFor = (agentId: string) =>
    db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

  it("队长决策后,被指派人真的有 heartbeat_runs 行(issue 从 backlog 提成 todo)", async () => {
    const { company, leader, writer, issue, dispatch } = await seedBacklogSquadIssue();

    // 前置:issue 确实躺在 backlog,被指派人一个 run 都没有
    expect((await readIssue(issue.id)).status).toBe("backlog");
    expect(await runsFor(writer.id)).toHaveLength(0);

    const res = await callApi(agentActor(company.id, leader.id), (baseUrl) =>
      request(baseUrl)
        .post(`/api/squad-dispatches/${dispatch.id}/decide`)
        .send({ assignedAgentId: writer.id, decisionReason: "他最近的口播脚本转化最好" }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "dispatched", assignedAgentId: writer.id });

    // 派单链的三跳都要落地:assignee 写了、状态提了、run 排了。
    const decided = await readIssue(issue.id);
    expect(decided.assigneeAgentId).toBe(writer.id);
    // 🔴 修复前:还是 backlog → wakeup 直接 return → 下面的 run 断言必然为 0
    expect(decided.status).toBe("todo");

    // 🔴 核心验收:被指派人**真的**有 run(不是「接口 200」,不是「wakeup 被调用了」)
    const runs = await runsFor(writer.id);
    expect(runs.length).toBeGreaterThan(0);

    // 队长只派活不占活:队长自己不该因为这次决策被排 run
    expect(await runsFor(leader.id)).toHaveLength(0);
  }, 60_000);

  it("已经在跑的活不会被决策打回起点(只提 backlog,不动 in_progress)", async () => {
    const { company, leader, writer, issue, dispatch } = await seedBacklogSquadIssue();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issue.id));

    const res = await callApi(agentActor(company.id, leader.id), (baseUrl) =>
      request(baseUrl)
        .post(`/api/squad-dispatches/${dispatch.id}/decide`)
        .send({ assignedAgentId: writer.id, decisionReason: "他来接手" }));

    expect(res.status).toBe(200);
    expect((await readIssue(issue.id)).status).toBe("in_progress");
  }, 60_000);

  it("非队长的 agent 不能替队长决策(403,冒名要挡住)", async () => {
    const { company, outsider, writer, issue, dispatch } = await seedBacklogSquadIssue();

    const res = await callApi(agentActor(company.id, outsider.id), (baseUrl) =>
      request(baseUrl)
        .post(`/api/squad-dispatches/${dispatch.id}/decide`)
        .send({ assignedAgentId: writer.id, decisionReason: "我说了算" }));

    // 🔴 修复前:200 —— 公司里任何 agent 都能替队长决策,decidedByAgentId 还记成调用者
    expect(res.status).toBe(403);

    // 冒名被挡住 → 什么都不许发生:没派单、没提状态、没 run
    const untouched = await readIssue(issue.id);
    expect(untouched.assigneeAgentId).toBeNull();
    expect(untouched.status).toBe("backlog");
    expect(await runsFor(writer.id)).toHaveLength(0);

    const stored = await db
      .select({ state: squadDispatches.state })
      .from(squadDispatches)
      .where(eq(squadDispatches.id, dispatch.id))
      .then((rows) => rows[0]!);
    expect(stored.state).toBe("pending");
  }, 60_000);

  it("非队长的 agent 也不能替队长 decline(403)", async () => {
    const { company, outsider, dispatch } = await seedBacklogSquadIssue();

    const res = await callApi(agentActor(company.id, outsider.id), (baseUrl) =>
      request(baseUrl)
        .post(`/api/squad-dispatches/${dispatch.id}/decline`)
        .send({ failureReason: "不想干" }));

    expect(res.status).toBe(403);

    const stored = await db
      .select({ state: squadDispatches.state })
      .from(squadDispatches)
      .where(eq(squadDispatches.id, dispatch.id))
      .then((rows) => rows[0]!);
    expect(stored.state).toBe("pending");
  }, 60_000);

  it("人类(操盘手 / 管理员)可以替队长兜底决策", async () => {
    const { company, writer, issue, dispatch } = await seedBacklogSquadIssue();

    const res = await callApi(boardActor(company.id), (baseUrl) =>
      request(baseUrl)
        .post(`/api/squad-dispatches/${dispatch.id}/decide`)
        .send({ assignedAgentId: writer.id, decisionReason: "队长掉线了,我先派" }));

    expect(res.status).toBe(200);
    const decided = await readIssue(issue.id);
    expect(decided.assigneeAgentId).toBe(writer.id);
    expect(decided.status).toBe("todo");
    expect((await runsFor(writer.id)).length).toBeGreaterThan(0);
  }, 60_000);
});
