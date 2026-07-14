import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentRuntimeState,
  agentTemplates,
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
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { waitForHeartbeatQuiescence } from "./helpers/heartbeat-quiescence.js";
import { errorHandler } from "../middleware/index.js";
import { squadRoutes } from "../routes/squads.js";
import { employeeMarketService, type EmployeeMarketActor } from "../services/employee-market.js";
import { getPresetEmployee, presetEmployeeRefId } from "../services/employee-presets.js";
import { syncSquadDispatchForIssue } from "../services/squads.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Market-hired employee test run.",
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
    `Skipping embedded Postgres employee-market hire-to-run tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * JIN-83 / Y1 + Y2 —— 把 JIN-81 标成「未验证」的两处收掉。
 *
 * ## Y1:preset 招聘此前**一条断言都没有**
 *
 * `employee-market-template-skills.test.ts` 只测了 **custom**(用户自定义模板)那条供给路。
 * preset(操盘手预制)和 custom 确实收敛到**同一个** `materializeEmployee()`,所以它「大概率是好的」
 * —— 但**没测过就是没测过**。而且两条路**并不完全同形**:preset 的 instructions 是
 * `renderPresetEmployeeAgentsMarkdown()` 现渲染的,desiredSkills 是 `string[]` 现映射成
 * `{key, versionId}[]` 的(`employee-market.ts:161`),contentHash 也是另算的 —— 这几步
 * custom 那条路一步都不走。它们是 preset 独有的、无人看管的代码。
 *
 * ## Y2:验收 2 的后半段「**并真的跑起来**」此前无人断言
 *
 * 旧证据链是**断的**:招聘落地 ✅ + 方法包写入 ✅ + *某个 seed 出来的* agent 能出 run ✅,
 * 但「**市场招进来的那一个**」从没被证明跑得起来。这中间隔着一个真问题:
 * `materializeEmployee()` **从不写 `runtimeConfig`**(它只管 agents 行 / 人格 / 方法包 / 溯源);
 * `agents.create` 的 `normalizeRuntimeConfigForNewAgent`(agents.ts:192)也只补了
 * `heartbeat.maxConcurrentRuns` —— **`wakeOnDemand` 自始至终没人写**。
 * 于是「招进来的员工能不能被叫醒」完全押在 `heartbeat.ts:9753` 的 `wakeOnDemand ?? true`
 * 这个默认值上。已实测:把该默认值翻成 false,本套件的 Y2 立刻红(0 run)——
 * 也就是说,没有这条断言钉住的话,「招进来的员工永远不开工」会**静默**发生,接口全程 200。
 *
 * 所以这里把整条链串起来跑通:**从市场招 → 组队 → 派活 → 该员工产出真实 `heartbeat_runs` 行**。
 * 手法沿用 `squad-dispatch-decide-routes.test.ts` 已验证过的那套:真 heartbeatService、
 * 真 embedded postgres、只 mock adapter 的 `execute`。断言口径定在**最终产物**(真的有 run 行)。
 */
describeEmbeddedPostgres("员工市场:preset 招聘(Y1)+ 招进来的人真的跑得起来(Y2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof employeeMarketService>;
  const cleanupDirs = new Set<string>();
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  const actor: EmployeeMarketActor = { actorType: "user", actorId: "local-board" };

  /** 队长:preset 供给源。文案编导:preset 供给源。两个都带方法包(content-calendar)。 */
  const LEADER_SLUG = "account-director";
  const WRITER_SLUG = "script-writer";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-employee-hire-to-run-");
    db = createDb(tempDb.connectionString);
    svc = employeeMarketService(db);

    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hire-to-run-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
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
        await db.delete(agentConfigRevisions);
        await db.delete(agentTemplates);
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
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
    await Promise.all([...cleanupDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function seedCompany() {
    return db
      .insert(companies)
      .values({
        name: `Jin ${randomUUID().slice(0, 8)}`,
        issuePrefix: `HR${randomUUID().slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  const readAgent = (agentId: string) =>
    db
      .select({
        name: agents.name,
        role: agents.role,
        status: agents.status,
        adapterConfig: agents.adapterConfig,
        runtimeConfig: agents.runtimeConfig,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);

  /** 员工身上真正生效的方法包偏好(和 runtime 用的是同一个 reader) */
  async function readHiredAgentSkills(agentId: string) {
    const row = await readAgent(agentId);
    return readPaperclipSkillSyncPreference(
      (row.adapterConfig ?? {}) as Record<string, unknown>,
    ).desiredSkills;
  }

  const runsFor = (agentId: string) =>
    db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));

  // ---------------------------------------------------------------------------
  // Y1:preset 招聘
  // ---------------------------------------------------------------------------

  it("Y1:从 preset 招人 —— 人格 / 方法包 / 溯源 / 配置历史,四件事一件都不许缺", async () => {
    const company = await seedCompany();
    const preset = getPresetEmployee(LEADER_SLUG)!;
    expect(preset.desiredSkills.length).toBeGreaterThan(0); // 前置:这个 preset 确实带方法包

    const refId = presetEmployeeRefId(LEADER_SLUG);
    const hired = await svc.hireEmployee(company.id, { source: "preset", refId }, actor);

    const row = await readAgent(hired.agentId);

    // ① agents 行
    expect(row.name).toBe(preset.name);
    expect(row.role).toBe(preset.role);
    expect(row.status).toBe("idle"); // 公司没开审批 → 直接可用,不是 pending_approval

    // ② 人格:instructions 真的进了指令包(不是空壳员工)
    const adapterConfig = JSON.stringify(row.adapterConfig ?? {});
    expect(adapterConfig).toContain("AGENTS.md");

    // ③ 方法包:preset 的 desiredSkills(string[])必须映射进 skill sync preference
    const skills = await readHiredAgentSkills(hired.agentId);
    expect(skills).toEqual(expect.arrayContaining(preset.desiredSkills));

    // ④ 溯源:metadata.jin.employee 记住了他是从哪个 preset 招来的
    const metadata = (row.metadata ?? {}) as Record<string, any>;
    expect(metadata.jin?.employee).toMatchObject({ source: "preset", refId });
    expect(metadata.jin?.employee?.contentHash).toBeTruthy();

    // 配置历史:新员工必须有第一条 revision(不然前端「配置历史 / 回滚」对他是空的)
    const revisions = await db
      .select({ source: agentConfigRevisions.source })
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, hired.agentId));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.source).toBe("employee_hire:preset");
  }, 60_000);

  it("Y1:招过之后,市场卡片上这个 preset 必须标成「已招募」(不然用户会重复招)", async () => {
    const company = await seedCompany();
    const refId = presetEmployeeRefId(WRITER_SLUG);

    const before = await svc.listEmployeeMarket(company.id);
    const cardBefore = before.find((card) => card.refId === refId)!;
    expect(cardBefore).toBeTruthy();
    expect(cardBefore.hired).toBe(false);

    await svc.hireEmployee(company.id, { source: "preset", refId }, actor);

    const after = await svc.listEmployeeMarket(company.id);
    const cardAfter = after.find((card) => card.refId === refId)!;
    expect(cardAfter.hired).toBe(true);
    // 方法包标签也要在卡片上(空标签就是 JIN-78 那个 bug 的表征)
    expect(cardAfter.methodTags.map((tag) => tag.key)).toEqual(
      expect.arrayContaining(getPresetEmployee(WRITER_SLUG)!.desiredSkills),
    );
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Y2:市场招进来的人,真的跑得起来
  // ---------------------------------------------------------------------------

  /** 真实路由 + 真实 heartbeat(squadRoutes 内部自己 new 一个 heartbeatService(db)) */
  function createApp(reqActor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = reqActor;
      next();
    });
    app.use("/api", squadRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /** ⚠️ 必须绑 127.0.0.1(WSL 沙箱没有 IPv6 回环)—— 同 squad-dispatch-decide-routes。 */
  async function callApi(
    reqActor: Record<string, unknown>,
    buildRequest: (baseUrl: string) => request.Test,
  ) {
    const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
    const server = createServer(createApp(reqActor));
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

  it("Y2:自定义员工 从市场招 → 派活 → 他**真的**产出了一条 heartbeat_runs(验收 2 的「并真的跑起来」)", async () => {
    const company = await seedCompany();

    // ① 用户**自定义**一个员工(指令 / 模型 / 方法包)——(验收 2 的前半段)
    const template = await svc.createTemplate(
      company.id,
      {
        name: "我自己捏的文案编导",
        role: "content_writer",
        instructions: "# 文案编导\n\n只写婚姻家事口播脚本,开头三秒必须有钩子。\n",
        adapterType: "codex_local",
        adapterConfig: {},
        desiredSkills: [{ key: "legal/xhs-hook", versionId: null }],
        visibility: "company",
      },
      actor,
    );

    // ② 从市场把他招进团队
    const hiredWriter = await svc.hireEmployee(
      company.id,
      { source: "custom", refId: template.refId, adapterType: "codex_local" },
      actor,
    );
    // 队长也从市场招(preset 那条供给路)—— 整条链上没有一个 seed 出来的 agent
    const hiredLeader = await svc.hireEmployee(
      company.id,
      { source: "preset", refId: presetEmployeeRefId(LEADER_SLUG), adapterType: "codex_local" },
      actor,
    );

    // 前置:招进来的人身上确实带着方法包,而且**没有人给他配过 wakeOnDemand**。
    // `materializeEmployee()` 不写 runtimeConfig;`agents.create` 的
    // `normalizeRuntimeConfigForNewAgent`(agents.ts:192)只补了 maxConcurrentRuns,
    // **wakeOnDemand 一直是缺省的** → 他能不能被叫醒,整个押在 heartbeat.ts:9753 的
    // `wakeOnDemand ?? true` 上。这正是下面那条 run 断言真正在钉的东西:
    // 哪天这个默认值翻成 false,「招进来的员工永远不开工」会静默发生,而接口全程 200。
    expect(await readHiredAgentSkills(hiredWriter.agentId)).toContain("legal/xhs-hook");
    const hiredRuntimeConfig = (await readAgent(hiredWriter.agentId)).runtimeConfig as Record<string, any>;
    expect(hiredRuntimeConfig.heartbeat?.wakeOnDemand).toBeUndefined();
    expect(await runsFor(hiredWriter.agentId)).toHaveLength(0);

    // ③ 组队:队长 + 这个自定义员工
    const squad = await db
      .insert(squads)
      .values({ companyId: company.id, name: "抖音一队", leaderAgentId: hiredLeader.agentId })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(squadMembers).values([
      {
        companyId: company.id,
        squadId: squad.id,
        memberType: "agent",
        agentId: hiredLeader.agentId,
        role: "leader",
        position: 0,
      },
      {
        companyId: company.id,
        squadId: squad.id,
        memberType: "agent",
        agentId: hiredWriter.agentId,
        role: "member",
        position: 1,
      },
    ]);

    // ④ 派活给小队。⚠️ issue seed 成 **backlog** —— 这是生产里的真实形态
    //(派给小队的 issue 没有 assignee → validator 默认落 backlog),seed 成 todo 会绕过真实路径。
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "HR-1",
        issueNumber: 1,
        title: "本周离婚财产分割选题",
        description: "做一条讲婚前财产认定的口播视频。",
        status: "backlog",
        priority: "high",
        ownerSquadId: squad.id,
        responsibleUserId: "responsible-user",
      })
      .returning()
      .then((rows) => rows[0]!);

    const dispatch = (await syncSquadDispatchForIssue(db, issue, {
      requestedByType: "agent",
      requestedByAgentId: hiredLeader.agentId,
    }))!;

    // ⑤ 队长把活派给这个自定义员工(走真实路由 + 真实 heartbeat)
    const decided = await callApi(
      { type: "agent", agentId: hiredLeader.agentId, companyId: company.id, source: "agent_key" },
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/squad-dispatches/${dispatch.id}/decide`)
          .send({ assignedAgentId: hiredWriter.agentId, decisionReason: "他的钩子写得最好" }),
    );
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ state: "dispatched", assignedAgentId: hiredWriter.agentId });

    // 🔴 核心验收:**从市场招进来的那个员工**,真的有 heartbeat_runs 行。
    // 不是「接口 200」,不是「wakeup 被调用了」,不是「某个 seed 出来的 agent 能跑」。
    const runs = await runsFor(hiredWriter.agentId);
    expect(
      runs.length,
      "市场招进来的自定义员工被派了活却一条 run 都没有 —— 验收 2 的「并真的跑起来」不成立",
    ).toBeGreaterThan(0);

    // issue 也真的被提成了 todo 并签到了他名下(派单链三跳全落地)
    const storedIssue = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0]!);
    expect(storedIssue).toMatchObject({ status: "todo", assigneeAgentId: hiredWriter.agentId });

    // 队长只派活不占活
    expect(await runsFor(hiredLeader.agentId)).toHaveLength(0);
  }, 90_000);
});
