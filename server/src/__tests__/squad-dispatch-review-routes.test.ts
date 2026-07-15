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
import { waitForHeartbeatQuiescence } from "./helpers/heartbeat-quiescence.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { squadRoutes } from "../routes/squads.js";
import { syncSquadDispatchForIssue } from "../services/squads.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Squad review test run.",
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
    `Skipping embedded Postgres squad review route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * JIN-85:派单链的第三跳 —— **队长评审产出**。
 *
 * 前两跳(派单唤醒队长、队长决策让被指派人开工)已有套件在守。这一套守的是最后一跳:
 * 被指派人把 issue 做完 → 派单落终态 `completed` → **队长真的被叫回来看产出** → 不满意可以打回。
 *
 * ⚠️ 口径和 JIN-78 那套一样,一个字都不放松:
 *   - **不 stub heartbeat**:走的是 `issueRoutes(db, ...)` / `squadRoutes(db)` 里真的 `heartbeatService(db)`;
 *   - **不 seed 成方便的状态去绕开真实路径**:issue 从 backlog 起步、经真实的 decide 路由派活、
 *     被指派人用**自己 run 的身份**(带 runId,过 issue 的 run-ownership 门)经真实 PATCH 收工;
 *   - 断言钉在**最终产物**:队长**真的有 `heartbeat_runs` 行**、dispatch **真的到达终态**、
 *     那条 @ 队长的评论**真的落库**。不看「接口返没返 200」,不看「wakeup 有没有被调用」。
 *
 * 关于「被指派人 run」的那一条 seed:
 * 生产里被指派人是**在自己的 run 里**把 issue 收尾的(它持有 issue 的 checkout 锁)。要经真实
 * PATCH 走完「agent 改 issue 状态」的 run-ownership 门(`services/issues.ts` 的 adopt/ownership),
 * 就必须有一条**非终态**的 run 让 actor.runId 指过去。这条 run 是**上游前置**,不是被测对象 ——
 * 它没有 stub 掉队长唤醒那条真实路径,核心断言(队长真的产生 run)一分没打折扣。
 */
describeEmbeddedPostgres("squad dispatch review (派单链最后一跳:队长必须被叫回来评审产出)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-squad-review-routes-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    runningProcesses.clear();
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

  /** 真实路由 + 真实 heartbeat(两个 router 内部各自 new 一个 heartbeatService(db)) */
  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use("/api", squadRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /** ⚠️ 必须显式绑 127.0.0.1:supertest 默认解析到 ::1,WSL 沙箱没有 IPv6 回环 → EADDRNOTAVAIL。 */
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

  const agentActor = (companyId: string, agentId: string, runId?: string) => ({
    type: "agent" as const,
    agentId,
    companyId,
    source: "agent_key" as const,
    ...(runId ? { runId } : {}),
  });

  async function seedBacklogSquadIssue(opts: { withLeader?: boolean } = {}) {
    const withLeader = opts.withLeader ?? true;
    const company = await db
      .insert(companies)
      .values({
        name: `Jin ${randomUUID().slice(0, 8)}`,
        issuePrefix: `SR${randomUUID().slice(0, 6).toUpperCase()}`,
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

    const squad = await db
      .insert(squads)
      .values({ companyId: company.id, name: "抖音一队", leaderAgentId: withLeader ? leader.id : null })
      .returning()
      .then((rows) => rows[0]!);

    await db.insert(squadMembers).values(
      [
        withLeader
          ? {
            companyId: company.id,
            squadId: squad.id,
            memberType: "agent" as const,
            agentId: leader.id,
            role: "leader" as const,
            position: 0,
          }
          : null,
        {
          companyId: company.id,
          squadId: squad.id,
          memberType: "agent" as const,
          agentId: writer.id,
          role: "member" as const,
          position: 1,
        },
      ].filter((row): row is NonNullable<typeof row> => row !== null),
    );

    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "SR-1",
        issueNumber: 1,
        title: "本周离婚财产分割选题",
        description: "做一条讲婚前财产认定的口播视频。",
        status: "backlog", // 生产里派给小队的 issue 就是这个形态(没 assignee → validator 落 backlog)
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

    return { company, leader, writer, squad, issue, dispatch };
  }

  const readIssue = (id: string) =>
    db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0]!);

  const readDispatch = (id: string) =>
    db
      .select({
        state: squadDispatches.state,
        completedAt: squadDispatches.completedAt,
        reviewNotifiedAt: squadDispatches.reviewNotifiedAt,
        reviewCommentId: squadDispatches.reviewCommentId,
      })
      .from(squadDispatches)
      .where(eq(squadDispatches.id, id))
      .then((rows) => rows[0]!);

  const dispatchesForIssue = (issueId: string) =>
    db
      .select({
        id: squadDispatches.id,
        state: squadDispatches.state,
        decisionReason: squadDispatches.decisionReason,
      })
      .from(squadDispatches)
      .where(eq(squadDispatches.issueId, issueId))
      .orderBy(squadDispatches.createdAt);

  const runsFor = (agentId: string) =>
    db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

  const reviewCommentsFor = (issueId: string) =>
    db
      .select({ id: issueComments.id, body: issueComments.body, authorAgentId: issueComments.authorAgentId })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows.filter((row) => row.body.includes("产出待评审")));

  /** 队长决策 → 被指派人开工。前两跳,这里当作前置条件跑通。 */
  async function decideTo(
    company: { id: string },
    leader: { id: string },
    dispatchId: string,
    assigneeId: string,
    reason: string,
  ) {
    const res = await callApi(agentActor(company.id, leader.id), (baseUrl) =>
      request(baseUrl)
        .post(`/api/squad-dispatches/${dispatchId}/decide`)
        .send({ assignedAgentId: assigneeId, decisionReason: reason }));
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`decide failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    await waitForHeartbeatQuiescence(db);
    return res;
  }

  /**
   * 被指派人在**自己的 run 里**把 issue 收尾(生产里就是这么收工的:agent 持有 checkout 锁、
   * 在同一条 run 里改 issue 状态)。这里显式造一条非终态 run 让 actor.runId 指过去,过 run-ownership 门;
   * PATCH 完成后把这条 run 落终态,免得 `waitForHeartbeatQuiescence` 把它当成「还在跑」。
   */
  async function completeIssueAsAssignee(
    company: { id: string },
    assignee: { id: string },
    issueId: string,
    status: "done" | "in_review",
  ) {
    const run = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: assignee.id, status: "running", startedAt: new Date() })
      .returning()
      .then((rows) => rows[0]!);
    try {
      return await callApi(agentActor(company.id, assignee.id, run.id), (baseUrl) =>
        request(baseUrl).patch(`/api/issues/${issueId}`).send({ status }));
    } finally {
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, run.id));
      await waitForHeartbeatQuiescence(db);
    }
  }

  it("被指派人做完 → dispatch 落终态 completed,且队长真的有 heartbeat_runs 行", async () => {
    const { company, leader, writer, issue, dispatch } = await seedBacklogSquadIssue();
    await decideTo(company, leader, dispatch.id, writer.id, "他最近的口播脚本转化最好");

    // 决策只给被指派人排 run;队长此刻**还没有**任何 run —— 这正是「派完就失联」的起点。
    expect(await runsFor(leader.id)).toHaveLength(0);
    expect((await readDispatch(dispatch.id)).state).toBe("dispatched");

    const res = await completeIssueAsAssignee(company, writer, issue.id, "done");
    expect(res.status).toBe(200);

    // 🔴 验收 1:派单到达终态(库里查得到「这次派单结束了」)
    const completed = await readDispatch(dispatch.id);
    expect(completed.state).toBe("completed");
    expect(completed.completedAt).not.toBeNull();

    // 🔴 验收 2:队长**真的**被唤醒且产生 run(不是「接口 200」,不是「wakeup 被调用了」)
    expect((await runsFor(leader.id)).length).toBeGreaterThan(0);

    // 唤醒走「发评论 @ 队长」这条唯一能唤醒非 assignee 的生产路径 —— 评论必须真的落库,
    // 且作者必须 == 触发 wake 的 actor(被指派人)。拆开这个等式,pause-hold 会静默拦掉唤醒。
    expect(completed.reviewCommentId).not.toBeNull();
    expect(completed.reviewNotifiedAt).not.toBeNull();
    const reviewComments = await reviewCommentsFor(issue.id);
    expect(reviewComments).toHaveLength(1);
    expect(reviewComments[0]!.body).toContain(leader.id); // @ 的是队长本人
    expect(reviewComments[0]!.authorAgentId).toBe(writer.id); // 作者 == wake actor
  }, 120_000);

  it("重复写 issue 不会重复公告:只有一条「请评审」评论、队长只被叫一次", async () => {
    const { company, leader, writer, issue, dispatch } = await seedBacklogSquadIssue();
    await decideTo(company, leader, dispatch.id, writer.id, "他最合适");

    await completeIssueAsAssignee(company, writer, issue.id, "done");
    const leaderRunsAfterFirst = (await runsFor(leader.id)).length;
    expect(leaderRunsAfterFirst).toBeGreaterThan(0);

    // 对已经 done 的 issue 再写一次(改标题)—— 幂等靠 review_notified_at 的原子认领兜底。
    // 用 board(人类)身份改,免得再造一条被指派人 run。
    await callApi(
      { type: "board", userId: "boss", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false },
      (baseUrl) => request(baseUrl).patch(`/api/issues/${issue.id}`).send({ title: "本周离婚财产分割选题(改)" }),
    );
    await waitForHeartbeatQuiescence(db);

    expect(await reviewCommentsFor(issue.id)).toHaveLength(1);
    expect((await runsFor(leader.id)).length).toBe(leaderRunsAfterFirst);
    expect((await readDispatch(dispatch.id)).state).toBe("completed");
  }, 120_000);

  it("队长可以打回:新开一条 dispatch、老的置 reassigned、issue 回到 todo、返工的人重新开工", async () => {
    const { company, leader, writer, issue, dispatch } = await seedBacklogSquadIssue();
    await decideTo(company, leader, dispatch.id, writer.id, "他口播最稳");
    await completeIssueAsAssignee(company, writer, issue.id, "done");
    expect((await readDispatch(dispatch.id)).state).toBe("completed");

    const runsBeforeRework = (await runsFor(writer.id)).length;
    expect(runsBeforeRework).toBeGreaterThan(0);

    // 打回 = 复用改派语义(同一个 decide 接口),不是原地改状态
    const res = await callApi(agentActor(company.id, leader.id), (baseUrl) =>
      request(baseUrl)
        .post(`/api/squad-dispatches/${dispatch.id}/decide`)
        .send({ assignedAgentId: writer.id, decisionReason: "开头钩子太弱,重写前 3 秒" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: "dispatched" });

    // 🔴 验收 3:审计链不断 —— 老的置 reassigned,新的另开一条,两条并存
    const all = await dispatchesForIssue(issue.id);
    expect(all).toHaveLength(2);
    expect(all[0]!.state).toBe("reassigned");
    expect(all[0]!.decisionReason).toBe("他口播最稳");
    expect(all[1]!.state).toBe("dispatched");
    expect(all[1]!.decisionReason).toBe("开头钩子太弱,重写前 3 秒");

    // 打回必须把 issue 从完成态拉回来,否则返工的人被叫醒也只会看到一条「已经做完的活」
    const reopened = await readIssue(issue.id);
    expect(reopened.status).toBe("todo");
    expect(reopened.assigneeAgentId).toBe(writer.id);

    // 🔴 返工的人真的重新开工(又多了 run)
    await vi.waitFor(async () => {
      expect((await runsFor(writer.id)).length).toBeGreaterThan(runsBeforeRework);
    }, { timeout: 15_000, interval: 200 });
  }, 150_000);

  it("打回后再次做完 → 新 dispatch 也走同一条评审路(队长又被叫回来一次)", async () => {
    const { company, leader, writer, issue, dispatch } = await seedBacklogSquadIssue();
    await decideTo(company, leader, dispatch.id, writer.id, "先给他");
    await completeIssueAsAssignee(company, writer, issue.id, "done");
    const leaderRunsAfterFirstReview = (await runsFor(leader.id)).length;
    expect(leaderRunsAfterFirstReview).toBeGreaterThan(0);

    await callApi(agentActor(company.id, leader.id), (baseUrl) =>
      request(baseUrl)
        .post(`/api/squad-dispatches/${dispatch.id}/decide`)
        .send({ assignedAgentId: writer.id, decisionReason: "重写钩子" }));
    await waitForHeartbeatQuiescence(db);

    const reworked = (await dispatchesForIssue(issue.id))[1]!;
    // 返工后再交一次(issue 此刻已回 todo,被指派人依旧是 writer)
    await completeIssueAsAssignee(company, writer, issue.id, "done");

    expect((await readDispatch(reworked.id)).state).toBe("completed"); // 新 dispatch 也落了终态
    await vi.waitFor(async () => {
      expect((await runsFor(leader.id)).length).toBeGreaterThan(leaderRunsAfterFirstReview);
    }, { timeout: 15_000, interval: 200 });
  }, 180_000);

  it("小队没配队长:派单照样落终态(「活做完了」是事实),但公告留空等队长补上后重播", async () => {
    const { company, leader, writer, squad, issue, dispatch } = await seedBacklogSquadIssue({ withLeader: false });

    // 没队长也能派活(人类/系统兜底决策);这里直接把 dispatch 决策掉、issue 提成 todo
    await db
      .update(squadDispatches)
      .set({ state: "dispatched", assignedAgentId: writer.id, decisionReason: "先干着", decidedAt: new Date() })
      .where(eq(squadDispatches.id, dispatch.id));
    await db.update(issues).set({ status: "todo", assigneeAgentId: writer.id }).where(eq(issues.id, issue.id));

    await completeIssueAsAssignee(company, writer, issue.id, "done");

    // 终态是事实,与「有没有人来评审」无关
    const completed = await readDispatch(dispatch.id);
    expect(completed.state).toBe("completed");
    expect(completed.completedAt).not.toBeNull();
    // 没队长 → 不认领公告,留着等队长配上后的下一次 issue 写入补发
    expect(completed.reviewNotifiedAt).toBeNull();
    expect(completed.reviewCommentId).toBeNull();

    // 队长配上,再写一次 issue → 公告补发,队长真的被叫起来
    await db.insert(squadMembers).values({
      companyId: company.id,
      squadId: squad.id,
      memberType: "agent",
      agentId: leader.id,
      role: "leader",
      position: 0,
    });
    await callApi(
      { type: "board", userId: "boss", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false },
      (baseUrl) => request(baseUrl).patch(`/api/issues/${issue.id}`).send({ title: "改个标题触发一次写入" }),
    );

    await vi.waitFor(async () => {
      expect((await readDispatch(dispatch.id)).reviewNotifiedAt).not.toBeNull();
      expect((await runsFor(leader.id)).length).toBeGreaterThan(0);
    }, { timeout: 15_000, interval: 200 });
  }, 150_000);
});
