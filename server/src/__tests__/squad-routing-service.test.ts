import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  squadDispatches,
  squadMembers,
  squads,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ensurePendingDispatchForIssue, squadService, syncSquadDispatchForIssue } from "../services/squads.js";
import { HttpError } from "../errors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("squad routing service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof squadService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-squad-routing-");
    db = createDb(tempDb.connectionString);
    svc = squadService(db);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(squadDispatches);
    await db.delete(squadMembers);
    await db.delete(issues);
    await db.delete(squads);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedCompany() {
    const company = await db
      .insert(companies)
      .values({
        name: `Squad ${randomUUID()}`,
        issuePrefix: `SQ${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);

    const makeAgent = async (name: string) =>
      db
        .insert(agents)
        .values({ companyId: company.id, name, role: name })
        .returning()
        .then((rows) => rows[0]!);

    const leader = await makeAgent("账号主理人");
    const writer = await makeAgent("文案编导");
    const planner = await makeAgent("选题策划师");
    return { company, leader, writer, planner };
  }

  async function seedIssue(companyId: string, squadId: string | null) {
    return db
      .insert(issues)
      .values({
        companyId,
        title: "拍一条普法短视频",
        status: "todo",
        ownerSquadId: squadId,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("creating a squad with a leader also writes the leader membership row", async () => {
    const { company, leader } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });

    const members = await svc.listMembers(squad.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ agentId: leader.id, memberType: "agent", role: "leader" });
  });

  it("a squad can hold at most one leader — the DB unique index is what enforces it", async () => {
    const { company, leader, writer } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });

    // 直接插第二个队长(绕过 service)必须被 squad_members_single_leader_uq 挡住
    const secondLeader = await db
      .insert(squadMembers)
      .values({
        companyId: company.id,
        squadId: squad.id,
        memberType: "agent",
        agentId: writer.id,
        role: "leader",
      })
      .then(() => null)
      .catch((error: unknown) => error);
    // drizzle 把驱动错误包了一层,唯一键冲突码在 cause 上
    expect((secondLeader as { cause?: { code?: string } } | null)?.cause?.code).toBe("23505");

    // 走 service 换队长:老队长降级为普通成员,不是被删掉
    await svc.update(squad.id, { leaderAgentId: writer.id });
    const members = await svc.listMembers(squad.id);
    expect(members.filter((m) => m.role === "leader")).toHaveLength(1);
    expect(members.find((m) => m.role === "leader")?.agentId).toBe(writer.id);
    expect(members.find((m) => m.agentId === leader.id)?.role).toBe("member");
  });

  it("adding the same member twice is a 409, not a 500", async () => {
    const { company, leader, writer } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });
    await svc.addMember(squad.id, { memberType: "agent", agentId: writer.id, role: "member" });

    await expect(
      svc.addMember(squad.id, { memberType: "agent", agentId: writer.id, role: "member" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("user members are stored as bare text ids — no FK into the auth user table", async () => {
    const { company, leader } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });

    const member = await svc.addMember(squad.id, {
      memberType: "user",
      userId: "user_not_in_any_fk_table",
      role: "member",
    });
    expect(member).toMatchObject({ memberType: "user", userId: "user_not_in_any_fk_table", agentId: null });

    // agent + user 并集,队长排最前
    const members = await svc.listMembers(squad.id);
    expect(members.map((m) => m.role)).toEqual(["leader", "member"]);
  });

  it("an issue owned by a squad with no assignee produces exactly one pending dispatch", async () => {
    const { company, leader } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });
    const issue = await seedIssue(company.id, squad.id);

    const dispatch = await syncSquadDispatchForIssue(db, issue);
    expect(dispatch).toMatchObject({ state: "pending", issueId: issue.id, squadId: squad.id });

    const queue = await svc.listDispatches(squad.id, { state: "pending" });
    expect(queue).toHaveLength(1);
  });

  it("an issue that already has an assignee produces no dispatch — no leader decision needed", async () => {
    const { company, leader, writer } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "已经指派好的活",
        status: "todo",
        ownerSquadId: squad.id,
        assigneeAgentId: writer.id,
      })
      .returning()
      .then((rows) => rows[0]!);

    expect(await syncSquadDispatchForIssue(db, issue)).toBeNull();
    expect(await svc.listDispatches(squad.id)).toHaveLength(0);
  });

  it("concurrent duplicate dispatch is absorbed by the partial unique index — one row, no 500", async () => {
    const { company, leader } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });
    const issue = await seedIssue(company.id, squad.id);

    // 8 路并发派单(模拟重试 / 双写):不许抛,不许出现两条 pending
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensurePendingDispatchForIssue(db, {
          companyId: company.id,
          issueId: issue.id,
          squadId: squad.id,
        }),
      ),
    );

    expect(results.every((row) => row !== null)).toBe(true);
    const ids = new Set(results.map((row) => row!.id));
    expect(ids.size).toBe(1);

    const rows = await db
      .select()
      .from(squadDispatches)
      .where(and(eq(squadDispatches.issueId, issue.id), eq(squadDispatches.state, "pending")));
    expect(rows).toHaveLength(1);
  });

  it("decide writes the assignee, the dispatch state and the audit trail in one transaction", async () => {
    const { company, leader, writer } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });
    const issue = await seedIssue(company.id, squad.id);
    const pending = (await syncSquadDispatchForIssue(db, issue))!;

    const decided = await svc.decide(pending.id, {
      assignedAgentId: writer.id,
      decisionReason: "这条是脚本改写,文案编导比选题策划师更对口",
      decidedByAgentId: leader.id,
    });

    expect(decided).toMatchObject({
      state: "dispatched",
      assignedAgentId: writer.id,
      decidedByAgentId: leader.id,
      decisionReason: "这条是脚本改写,文案编导比选题策划师更对口",
    });
    expect(decided.decidedAt).toBeInstanceOf(Date);

    const updatedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0]!);
    expect(updatedIssue.assigneeAgentId).toBe(writer.id);
  });

  it("decide rolls back all three writes when the assignee is not in the company", async () => {
    const { company, leader } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });
    const issue = await seedIssue(company.id, squad.id);
    const pending = (await syncSquadDispatchForIssue(db, issue))!;

    const otherCompany = await seedCompany();

    await expect(
      svc.decide(pending.id, {
        assignedAgentId: otherCompany.writer.id,
        decisionReason: "跨公司乱派",
        decidedByAgentId: leader.id,
      }),
    ).rejects.toBeInstanceOf(HttpError);

    // 三处写要么全成要么全不成:issue 没被改,dispatch 还在 pending
    const untouchedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0]!);
    expect(untouchedIssue.assigneeAgentId).toBeNull();

    const untouchedDispatch = await db
      .select()
      .from(squadDispatches)
      .where(eq(squadDispatches.id, pending.id))
      .then((rows) => rows[0]!);
    expect(untouchedDispatch.state).toBe("pending");
    expect(untouchedDispatch.decisionReason).toBeNull();
    expect(untouchedDispatch.decidedAt).toBeNull();
  });

  it("reassign opens a new dispatch and marks the old one reassigned — the audit chain survives", async () => {
    const { company, leader, writer, planner } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });
    const issue = await seedIssue(company.id, squad.id);
    const pending = (await syncSquadDispatchForIssue(db, issue))!;

    const first = await svc.decide(pending.id, {
      assignedAgentId: writer.id,
      decisionReason: "先给文案编导",
      decidedByAgentId: leader.id,
    });

    const second = await svc.reassign(first.id, {
      assignedAgentId: planner.id,
      decisionReason: "选题方向要重定,改派选题策划师",
      decidedByAgentId: leader.id,
    });

    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({
      state: "dispatched",
      assignedAgentId: planner.id,
      decisionReason: "选题方向要重定,改派选题策划师",
    });

    const old = await db
      .select()
      .from(squadDispatches)
      .where(eq(squadDispatches.id, first.id))
      .then((rows) => rows[0]!);
    // 老 dispatch 不被原地覆盖:理由和被派人都留着,只是状态变了
    expect(old.state).toBe("reassigned");
    expect(old.assignedAgentId).toBe(writer.id);
    expect(old.decisionReason).toBe("先给文案编导");

    const updatedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0]!);
    expect(updatedIssue.assigneeAgentId).toBe(planner.id);

    const all = await svc.listDispatches(squad.id);
    expect(all).toHaveLength(2);
  });

  it("decline closes the dispatch with a failure reason and leaves the issue unassigned", async () => {
    const { company, leader } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });
    const issue = await seedIssue(company.id, squad.id);
    const pending = (await syncSquadDispatchForIssue(db, issue))!;

    const declined = await svc.decline(pending.id, {
      failureReason: "队里没人有出镜资质,退回",
      decidedByAgentId: leader.id,
    });
    expect(declined).toMatchObject({ state: "declined", failureReason: "队里没人有出镜资质,退回" });

    const updatedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0]!);
    expect(updatedIssue.assigneeAgentId).toBeNull();

    // 已决派单不能再决策一次
    await expect(
      svc.decide(pending.id, { assignedAgentId: leader.id, decisionReason: "反悔" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("declining frees the pending slot so the issue can be dispatched again", async () => {
    const { company, leader } = await seedCompany();
    const squad = await svc.create(company.id, { name: "民法小队", leaderAgentId: leader.id });
    const issue = await seedIssue(company.id, squad.id);
    const first = (await syncSquadDispatchForIssue(db, issue))!;
    await svc.decline(first.id, { failureReason: "先退回" });

    // 部分唯一索引只覆盖 pending,所以 declined 之后可以重新派单
    const second = await syncSquadDispatchForIssue(db, issue);
    expect(second?.id).not.toBe(first.id);
    expect(second?.state).toBe("pending");
  });
});
