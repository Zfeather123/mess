import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
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
import { buildAgentMentionHref } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { waitForHeartbeatQuiescence } from "./helpers/heartbeat-quiescence.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { squadRoutes } from "../routes/squads.js";
import { employeeMarketRoutes } from "../routes/employee-market.js";
import { boardAuthService } from "../services/board-auth.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Multi-human collaboration test run.",
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
    `Skipping embedded Postgres multi-human collaboration tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * JIN-83 / 验收 5「多真人协作」—— server 层真覆盖。
 *
 * ## 这个套件在守什么
 *
 * 「多真人协作」此前**在 CI 里零覆盖**:唯二相关的 Playwright spec
 * (`multi-user.spec.ts` / `multi-user-authenticated.spec.ts`)被 `playwright.config.ts:24`
 * 的 `testIgnore` 挡在门外,而 `e2e.yml` 又是 `workflow_dispatch` only —— 它们**在任何
 * workflow、任何触发条件下都从没跑过**。而且那两条 spec 验的是上游 Paperclip 的**浏览器
 * 多用户登录**,不是我们的真实风险。
 *
 * 真实风险在**服务端协作层**,三条:
 *   ① 同公司两个真人,能不能看到 / 操作同一批 issue 与小队;
 *   ② 🔴 **跨公司能不能读到不该读的东西** —— 坏了就是数据泄漏;
 *   ③ 小队派单的通知,有没有落到**正确的那一个人**。
 *
 * ## ⚠️ 真人 actor 必须是 `source: "session"`,不能用 `local_implicit`
 *
 * `routes/authz.ts:assertCompanyAccess` 的公司边界校验整段挂在
 * `req.actor.source !== "local_implicit"` 下面 —— `local_implicit`(本地可信部署的隐式 board)
 * **直接跳过所有跨公司检查**。现有 squad 套件里的 `boardActor` helper 用的正是它,
 * 所以拿它来写隔离测试会**恒绿**,一个字节的隔离都没验到。
 *
 * ## 口径:actor 由真 DB 行经生产代码推导,不是手搓的
 *
 * 两个真人 = `user` 表真行 + `company_memberships` 真行,actor 的 `companyIds` / `memberships`
 * 走 **`boardAuthService.resolveBoardAccess()`**(`middleware/auth.ts:203` 线上用的同一个函数)
 * 现算出来。手搓 actor 的话,测的就只是「我自己填的那个数组」;走生产推导,membership
 * 解析被改坏时这里会跟着红。
 *
 * 断言一律定在**最终产物**上:真的 403 / 真的没有那行 / 真的有 run —— 不是「接口返回 200」。
 */
describeEmbeddedPostgres("多真人协作(验收 5):同公司共事 + 跨公司隔离 + 派单通知落对人", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let boardAuth!: ReturnType<typeof boardAuthService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-multi-human-collab-");
    db = createDb(tempDb.connectionString);
    boardAuth = boardAuthService(db);
  }, 120_000);

  afterEach(async () => {
    runningProcesses.clear();
    // run 是异步跑起来的(executeRun 是 fire-and-forget),等它真的静默下来再清表 —— 见 helper 顶注
    await waitForHeartbeatQuiescence(db);
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
        await db.delete(companyMemberships);
        await db.delete(companies);
        await db.delete(authUsers);
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

  /** 真实路由三件套。issueRoutes 内部自己 new 一个真的 heartbeatService(db) —— 不 stub。 */
  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use("/api", squadRoutes(db));
    app.use("/api", employeeMarketRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /**
   * ⚠️ 必须显式绑 `127.0.0.1`(与 squad-dispatch-decide-routes 同因):supertest 默认让
   * express 自己 listen,主机名解析到 `::1`,而 WSL 沙箱没有 IPv6 回环 → `EADDRNOTAVAIL ::1`。
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

  async function seedCompany(prefix: string) {
    return db
      .insert(companies)
      .values({
        name: `Jin ${prefix} ${randomUUID().slice(0, 8)}`,
        issuePrefix: `${prefix}${randomUUID().slice(0, 5).toUpperCase()}`,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** 一个**真人**:user 表真行 + company_memberships 真行。 */
  async function seedHuman(input: { name: string; companyId: string; membershipRole: string }) {
    const now = new Date();
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      name: input.name,
      email: `${userId}@jin.test`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: input.companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: input.membershipRole,
    });
    return { userId, name: input.name };
  }

  /**
   * 真人 actor —— 形状与 `middleware/auth.ts:203`(session 登录那条真路)逐字段对齐,
   * `companyIds` / `memberships` 由 `resolveBoardAccess` 从真 DB 行现算。
   */
  async function humanActor(human: { userId: string; name: string }) {
    const access = await boardAuth.resolveBoardAccess(human.userId);
    return {
      type: "board" as const,
      userId: human.userId,
      userName: access.user?.name ?? null,
      userEmail: access.user?.email ?? null,
      companyIds: access.companyIds,
      memberships: access.memberships,
      isInstanceAdmin: access.isInstanceAdmin,
      source: "session" as const,
    };
  }

  function makeAgent(companyId: string, name: string, role: string) {
    return db
      .insert(agents)
      .values({
        companyId,
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
  }

  const runsFor = (agentId: string) =>
    db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

  const readIssue = (id: string) =>
    db
      .select({
        title: issues.title,
        status: issues.status,
        companyId: issues.companyId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0] ?? null);

  // ---------------------------------------------------------------------------
  // ① 同公司两个真人:甲建的单,乙读得到、改得动
  // ---------------------------------------------------------------------------

  it("同公司两个真人:甲建的 issue,乙看得到、读得到、改得动(改动真的落库)", async () => {
    const company = await seedCompany("MH");
    const jia = await seedHuman({ name: "甲(操盘手)", companyId: company.id, membershipRole: "admin" });
    const yi = await seedHuman({ name: "乙(合伙人)", companyId: company.id, membershipRole: "member" });

    // 前置:两个真人各自都解析出了这家公司(不然下面测的就不是「协作」)
    const jiaActor = await humanActor(jia);
    const yiActor = await humanActor(yi);
    expect(jiaActor.companyIds).toEqual([company.id]);
    expect(yiActor.companyIds).toEqual([company.id]);

    // 甲建单
    const created = await callApi(jiaActor, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/issues`)
        .send({ title: "本周离婚财产分割选题", description: "口播视频一条。", priority: "high" }));
    expect(created.status).toBe(201);
    const issueId = created.body.id as string;
    expect(issueId).toBeTruthy();

    // 乙在列表里看得到甲的单
    const list = await callApi(yiActor, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/issues`));
    expect(list.status).toBe(200);
    const listed = (list.body.items ?? list.body) as Array<{ id: string }>;
    expect(listed.map((row) => row.id)).toContain(issueId);

    // 乙读得到详情
    const detail = await callApi(yiActor, (baseUrl) => request(baseUrl).get(`/api/issues/${issueId}`));
    expect(detail.status).toBe(200);
    expect(detail.body.title).toBe("本周离婚财产分割选题");

    // 乙改得动,而且**真的接手**了甲的活(assigneeUserId = 乙 → 状态才能进 in_progress:
    // `issues.ts:6010` 的不变量 —— in_progress 必须有负责人)。
    // 断言定在**库里真的变了**,不是「PATCH 返回 200」。
    const patched = await callApi(yiActor, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/issues/${issueId}`)
        .send({
          title: "本周离婚财产分割选题(乙改)",
          assigneeUserId: yi.userId,
          status: "in_progress",
        }));
    expect(patched.status).toBe(200);

    const stored = await readIssue(issueId);
    expect(stored).toMatchObject({
      title: "本周离婚财产分割选题(乙改)",
      status: "in_progress",
      assigneeUserId: yi.userId,
      companyId: company.id,
    });
  }, 60_000);

  it("同公司两个真人:甲建的小队,乙看得到、并且能往里加人", async () => {
    const company = await seedCompany("MS");
    const jia = await seedHuman({ name: "甲(操盘手)", companyId: company.id, membershipRole: "admin" });
    const yi = await seedHuman({ name: "乙(合伙人)", companyId: company.id, membershipRole: "member" });
    const leader = await makeAgent(company.id, "账号主理人", "lead");
    const writer = await makeAgent(company.id, "文案编导", "writer");

    const createdSquad = await callApi(await humanActor(jia), (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/squads`)
        .send({ name: "抖音一队", leaderAgentId: leader.id }));
    expect(createdSquad.status).toBe(201);
    const squadId = createdSquad.body.id as string;

    const yiActor = await humanActor(yi);

    // 乙看得到甲建的队
    const squadList = await callApi(yiActor, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/squads`));
    expect(squadList.status).toBe(200);
    expect((squadList.body as Array<{ id: string }>).map((row) => row.id)).toContain(squadId);

    // 乙能操作它 —— 往队里加人
    const added = await callApi(yiActor, (baseUrl) =>
      request(baseUrl)
        .post(`/api/squads/${squadId}/members`)
        .send({ memberType: "agent", agentId: writer.id, role: "member" }));
    expect(added.status).toBe(201);

    // 落库了才算数
    const members = await db
      .select({ agentId: squadMembers.agentId })
      .from(squadMembers)
      .where(eq(squadMembers.squadId, squadId));
    expect(members.map((row) => row.agentId)).toContain(writer.id);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // ② 🔴 跨公司隔离 —— 坏了就是数据泄漏
  // ---------------------------------------------------------------------------

  it("🔴 跨公司隔离:B 公司的真人读不到 / 改不动 A 公司的 issue、小队、员工市场", async () => {
    const companyA = await seedCompany("AA");
    const companyB = await seedCompany("BB");
    const alice = await seedHuman({ name: "A 公司的人", companyId: companyA.id, membershipRole: "admin" });
    const mallory = await seedHuman({ name: "B 公司的人", companyId: companyB.id, membershipRole: "admin" });

    const aliceActor = await humanActor(alice);
    const malloryActor = await humanActor(mallory);
    // 前置:B 公司的人身上**没有** A 公司(不然这条测试自己就是假的)
    expect(malloryActor.companyIds).toEqual([companyB.id]);
    expect(malloryActor.companyIds).not.toContain(companyA.id);

    const leaderA = await makeAgent(companyA.id, "A 队长", "lead");

    // A 公司的真实资产
    const createdIssue = await callApi(aliceActor, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${companyA.id}/issues`)
        .send({ title: "A 公司的商业机密选题", description: "不该被 B 公司看到。" }));
    expect(createdIssue.status).toBe(201);
    const aIssueId = createdIssue.body.id as string;

    const createdSquad = await callApi(aliceActor, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${companyA.id}/squads`)
        .send({ name: "A 公司一队", leaderAgentId: leaderA.id }));
    expect(createdSquad.status).toBe(201);
    const aSquadId = createdSquad.body.id as string;

    // ---- 读:一条都不许漏 ----
    const reads: Array<[string, request.Test | ((baseUrl: string) => request.Test)]> = [
      [`GET /companies/A/issues`, (baseUrl: string) => request(baseUrl).get(`/api/companies/${companyA.id}/issues`)],
      [`GET /companies/A/issues/count`, (baseUrl: string) => request(baseUrl).get(`/api/companies/${companyA.id}/issues/count`)],
      [`GET /issues/:aIssue`, (baseUrl: string) => request(baseUrl).get(`/api/issues/${aIssueId}`)],
      [`GET /companies/A/squads`, (baseUrl: string) => request(baseUrl).get(`/api/companies/${companyA.id}/squads`)],
      [`GET /squads/:aSquad`, (baseUrl: string) => request(baseUrl).get(`/api/squads/${aSquadId}`)],
      [`GET /squads/:aSquad/members`, (baseUrl: string) => request(baseUrl).get(`/api/squads/${aSquadId}/members`)],
      [`GET /squads/:aSquad/dispatches`, (baseUrl: string) => request(baseUrl).get(`/api/squads/${aSquadId}/dispatches`)],
      [`GET /companies/A/employee-market`, (baseUrl: string) => request(baseUrl).get(`/api/companies/${companyA.id}/employee-market`)],
      [`GET /companies/A/agent-templates`, (baseUrl: string) => request(baseUrl).get(`/api/companies/${companyA.id}/agent-templates`)],
    ];
    for (const [label, build] of reads) {
      const res = await callApi(malloryActor, build as (baseUrl: string) => request.Test);
      // 403(挡在公司边界)或 404(压根不告诉你存在)都算隔离住;200 = 泄漏
      expect(
        [403, 404],
        `${label} 必须挡住 B 公司的人,实际 ${res.status} —— 200 就是跨租户数据泄漏`,
      ).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain("A 公司的商业机密选题");
    }

    // ---- 写:挡住之后**什么都不许发生** ----
    const patchAttempt = await callApi(malloryActor, (baseUrl) =>
      request(baseUrl).patch(`/api/issues/${aIssueId}`).send({ title: "被 B 公司改掉了", status: "cancelled" }));
    expect([403, 404]).toContain(patchAttempt.status);

    const createAttempt = await callApi(malloryActor, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${companyA.id}/issues`).send({ title: "B 公司往 A 公司塞的单" }));
    expect([403, 404]).toContain(createAttempt.status);

    const hireAttempt = await callApi(malloryActor, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${companyA.id}/employee-hires`)
        .send({ source: "preset", refId: "jin:account-director" }));
    expect([403, 404]).toContain(hireAttempt.status);

    // 反向的一跳:A 公司的人也不能把自己的活**指派给 B 公司的人**
    //(`issues.ts:4049 assertAssignableUser` 要求 assignee 在本公司有 active membership)
    const crossAssign = await callApi(aliceActor, (baseUrl) =>
      request(baseUrl).patch(`/api/issues/${aIssueId}`).send({ assigneeUserId: mallory.userId }));
    expect(
      [403, 404, 422],
      `把 A 公司的 issue 指派给 B 公司的人必须被挡住,实际 ${crossAssign.status}`,
    ).toContain(crossAssign.status);

    // 库里必须原封不动
    const untouched = await readIssue(aIssueId);
    expect(untouched?.assigneeUserId).toBeNull();
    expect(untouched).toMatchObject({ title: "A 公司的商业机密选题", companyId: companyA.id });
    expect(untouched?.status).not.toBe("cancelled");

    const aIssues = await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyA.id));
    expect(aIssues).toHaveLength(1); // B 公司没能往 A 公司塞进单子

    const aAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyA.id));
    expect(aAgents.map((row) => row.id)).toEqual([leaderA.id]); // 也没能往 A 公司招人
  }, 90_000);

  it("🔴 跨公司隔离:B 公司的人列自己公司的 issue,列表里不许混进 A 公司的行", async () => {
    const companyA = await seedCompany("AL");
    const companyB = await seedCompany("BL");
    const alice = await seedHuman({ name: "A 公司的人", companyId: companyA.id, membershipRole: "admin" });
    const bob = await seedHuman({ name: "B 公司的人", companyId: companyB.id, membershipRole: "admin" });

    const aCreated = await callApi(await humanActor(alice), (baseUrl) =>
      request(baseUrl).post(`/api/companies/${companyA.id}/issues`).send({ title: "A 公司的单" }));
    expect(aCreated.status).toBe(201);

    const bobActor = await humanActor(bob);
    const bCreated = await callApi(bobActor, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${companyB.id}/issues`).send({ title: "B 公司的单" }));
    expect(bCreated.status).toBe(201);

    const list = await callApi(bobActor, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyB.id}/issues`));
    expect(list.status).toBe(200);
    const rows = (list.body.items ?? list.body) as Array<{ id: string; title: string; companyId?: string }>;

    expect(rows.map((row) => row.title)).toEqual(["B 公司的单"]);
    expect(rows.map((row) => row.id)).not.toContain(aCreated.body.id);
    expect(JSON.stringify(rows)).not.toContain("A 公司的单");
  }, 60_000);

  // ---------------------------------------------------------------------------
  // ③ 派单通知落到正确的人
  // ---------------------------------------------------------------------------

  it("小队派单:通知只 @ 本公司队长 —— 不漏发(队长真有 run),不错发(别的公司/别的成员一个 run 都没有)", async () => {
    const companyA = await seedCompany("DA");
    const companyB = await seedCompany("DB");
    const alice = await seedHuman({ name: "A 公司操盘手", companyId: companyA.id, membershipRole: "admin" });

    const leaderA = await makeAgent(companyA.id, "A 队长", "lead");
    const writerA = await makeAgent(companyA.id, "A 文案编导", "writer");
    // B 公司也有一个同名同角色的队长 —— 错发的话最可能错发到他身上
    const leaderB = await makeAgent(companyB.id, "B 队长", "lead");

    const squadA = await db
      .insert(squads)
      .values({ companyId: companyA.id, name: "A 抖音一队", leaderAgentId: leaderA.id })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(squadMembers).values([
      { companyId: companyA.id, squadId: squadA.id, memberType: "agent", agentId: leaderA.id, role: "leader", position: 0 },
      { companyId: companyA.id, squadId: squadA.id, memberType: "agent", agentId: writerA.id, role: "member", position: 1 },
    ]);

    // 真人把任务派给小队(不指定负责人)→ 触发派单公告
    const created = await callApi(await humanActor(alice), (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${companyA.id}/issues`)
        .send({ title: "本周离婚财产分割选题", description: "做一条口播。", ownerSquadId: squadA.id }));
    expect(created.status).toBe(201);
    const issueId = created.body.id as string;

    // 派单行落在 A 公司
    const dispatch = await db
      .select({ companyId: squadDispatches.companyId, squadId: squadDispatches.squadId, state: squadDispatches.state })
      .from(squadDispatches)
      .where(eq(squadDispatches.issueId, issueId))
      .then((rows) => rows[0]!);
    expect(dispatch).toMatchObject({ companyId: companyA.id, squadId: squadA.id, state: "pending" });

    // 公告评论:落在 A 公司,且**只 @ 了 A 队长**
    const comments = await db
      .select({ companyId: issueComments.companyId, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    const announcement = comments[0]!;
    expect(announcement.companyId).toBe(companyA.id);
    expect(announcement.body).toContain(buildAgentMentionHref(leaderA.id));

    // 🔴 不错发:别的公司的队长、以及同队的候选成员,都不该被 @
    //(@ 谁就唤醒谁 —— 把候选也 @ 一遍等于把整个小队都叫起来)
    expect(announcement.body).not.toContain(buildAgentMentionHref(leaderB.id));
    expect(announcement.body).not.toContain(buildAgentMentionHref(writerA.id));

    // 🔴 不漏发:A 队长**真的**有 heartbeat_runs 行(不是「wakeup 被调用了」)
    expect((await runsFor(leaderA.id)).length).toBeGreaterThan(0);

    // 🔴 不错发:B 公司队长零 run;候选成员也零 run(队长只派活,派给谁还没定)
    expect(await runsFor(leaderB.id)).toHaveLength(0);
    expect(await runsFor(writerA.id)).toHaveLength(0);

    // B 公司一条评论都不该有
    const bComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.companyId, companyB.id));
    expect(bComments).toHaveLength(0);
  }, 90_000);

  it("小队派单:队长不在本公司的队里就不会被叫醒(跨公司的 agent 不该成为候选)", async () => {
    const companyA = await seedCompany("DX");
    const companyB = await seedCompany("DY");
    const alice = await seedHuman({ name: "A 公司操盘手", companyId: companyA.id, membershipRole: "admin" });

    const leaderA = await makeAgent(companyA.id, "A 队长", "lead");
    const outsiderB = await makeAgent(companyB.id, "B 公司的文案", "writer");

    const squadA = await db
      .insert(squads)
      .values({ companyId: companyA.id, name: "A 抖音一队", leaderAgentId: leaderA.id })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(squadMembers).values({
      companyId: companyA.id,
      squadId: squadA.id,
      memberType: "agent",
      agentId: leaderA.id,
      role: "leader",
      position: 0,
    });

    const created = await callApi(await humanActor(alice), (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${companyA.id}/issues`)
        .send({ title: "只有队长的队", ownerSquadId: squadA.id }));
    expect(created.status).toBe(201);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, created.body.id as string));
    expect(comments).toHaveLength(1);

    // B 公司的 agent 既不在候选名单里,也不该被 @,更不该有 run
    expect(comments[0]!.body).not.toContain(buildAgentMentionHref(outsiderB.id));
    expect(comments[0]!.body).not.toContain("B 公司的文案");
    expect(await runsFor(outsiderB.id)).toHaveLength(0);

    // 队长本人照常被叫醒
    expect((await runsFor(leaderA.id)).length).toBeGreaterThan(0);
  }, 90_000);

  it("小队派单不会把公告评论重复刷两遍(issue 再次写入时幂等)", async () => {
    const company = await seedCompany("ID");
    const alice = await seedHuman({ name: "操盘手", companyId: company.id, membershipRole: "admin" });
    const actor = await humanActor(alice);
    const leader = await makeAgent(company.id, "队长", "lead");

    const squad = await db
      .insert(squads)
      .values({ companyId: company.id, name: "一队", leaderAgentId: leader.id })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(squadMembers).values({
      companyId: company.id,
      squadId: squad.id,
      memberType: "agent",
      agentId: leader.id,
      role: "leader",
      position: 0,
    });

    const created = await callApi(actor, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/issues`)
        .send({ title: "幂等测试", ownerSquadId: squad.id }));
    expect(created.status).toBe(201);
    const issueId = created.body.id as string;

    // 同一条 issue 再被写一次(真人改个标题)—— 派单钩子会再跑一遍
    const patched = await callApi(actor, (baseUrl) =>
      request(baseUrl).patch(`/api/issues/${issueId}`).send({ title: "幂等测试(改过标题)" }));
    expect(patched.status).toBe(200);

    const announcements = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "user")));
    // 派单公告只该有一条 —— notified_at 的原子认领兜住重复公告
    expect(announcements).toHaveLength(1);
  }, 90_000);
});
