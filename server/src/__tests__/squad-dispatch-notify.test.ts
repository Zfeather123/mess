import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentFeedbackNotes,
  agents,
  companies,
  createDb,
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
import {
  SQUAD_DISPATCH_WAKE_REASON,
  SQUAD_DISPATCH_WAKE_SOURCE,
  announcePendingSquadDispatchForIssue,
  type SquadDispatchWakeDeps,
} from "../services/squad-dispatch-notify.js";
import { syncSquadDispatchForIssue } from "../services/squads.js";
import {
  ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
  isVerifiedIssueTreeControlInteractionWake,
} from "../services/issue-tree-control.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres squad dispatch notify tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type CapturedWake = {
  agentId: string;
  opts: Parameters<SquadDispatchWakeDeps["wakeup"]>[1];
};

/**
 * ⚠️ 返回值必须模拟真实的 `enqueueWakeup`:
 *   - 排上了 run → 返回那行 run(**truthy**)
 *   - scheduling_suppressed / company.inactive / wakeOnDemand.disabled / issue_rewake_throttled
 *     等分支 → 返回 **null**(只写一行 skipped 的 wakeup_request,**没有 run**)
 *
 * 这个 stub 以前无脑返回 null —— 也就是「每次唤醒都没排上 run」,却还断言派单被认领(notified_at 非空)。
 * 于是「wake 落空仍然认领 → 派单永不重播」这个 bug 被 stub 本身盖住了,套件全绿。
 * 现在:默认返回一行 run;要测「wake 落空」的用例显式传 `{ wakeProducesRun: false }`。
 */
function capturingHeartbeat(opts: { wakeProducesRun?: boolean } = {}) {
  const wakeProducesRun = opts.wakeProducesRun ?? true;
  const calls: CapturedWake[] = [];
  const heartbeat: SquadDispatchWakeDeps = {
    wakeup: async (agentId, wakeOpts) => {
      calls.push({ agentId, opts: wakeOpts });
      return wakeProducesRun ? { id: randomUUID(), status: "queued" } : null;
    },
  };
  return { heartbeat, calls };
}

describeEmbeddedPostgres("squad dispatch announcement (leader wake via comment mention)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-squad-dispatch-notify-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(agentFeedbackNotes);
    await db.delete(squadDispatches);
    await db.delete(squadMembers);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(squads);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedSquadIssue(opts: { withLeader?: boolean } = {}) {
    const withLeader = opts.withLeader ?? true;
    const company = await db
      .insert(companies)
      .values({
        name: `Squad ${randomUUID()}`,
        issuePrefix: `SQ${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);

    const makeAgent = (name: string, role: string) =>
      db
        .insert(agents)
        .values({ companyId: company.id, name, role })
        .returning()
        .then((rows) => rows[0]!);

    const leader = await makeAgent("账号主理人", "leader");
    const writer = await makeAgent("文案编导", "content_writer");
    const planner = await makeAgent("选题策划师", "topic_planner");
    const requester = await makeAgent("操盘手助理", "assistant");

    const squad = await db
      .insert(squads)
      .values({
        companyId: company.id,
        name: "抖音一队",
        leaderAgentId: withLeader ? leader.id : null,
      })
      .returning()
      .then((rows) => rows[0]!);

    const memberRows = [
      { companyId: company.id, squadId: squad.id, memberType: "agent", agentId: writer.id, role: "member", position: 0 },
      { companyId: company.id, squadId: squad.id, memberType: "agent", agentId: planner.id, role: "member", position: 1 },
    ];
    if (withLeader) {
      memberRows.push({
        companyId: company.id,
        squadId: squad.id,
        memberType: "agent",
        agentId: leader.id,
        role: "leader",
        position: 0,
      });
    }
    await db.insert(squadMembers).values(memberRows);

    // 「最近被纠正 / 下次注意」要出现在派单评论里 —— 队长凭它决定派给谁。
    await db.insert(agentFeedbackNotes).values([
      {
        companyId: company.id,
        agentId: writer.id,
        kind: "correction",
        content: "标题别写成标题党",
        sourceType: "review",
        weight: 200,
      },
      {
        companyId: company.id,
        agentId: writer.id,
        kind: "reminder",
        content: "开头三秒要给结论",
        sourceType: "review",
        weight: 100,
      },
      {
        companyId: company.id,
        agentId: planner.id,
        kind: "correction",
        content: "选题要贴当周热点",
        sourceType: "review",
        weight: 150,
      },
    ]);

    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "SQ-1",
        issueNumber: 1,
        title: "本周离婚财产分割选题",
        description: "做一条讲婚前财产认定的口播视频。",
        status: "todo",
        priority: "high",
        ownerSquadId: squad.id,
      })
      .returning()
      .then((rows) => rows[0]!);

    const dispatch = (await syncSquadDispatchForIssue(db, issue, {
      requestedByType: "agent",
      requestedByAgentId: requester.id,
    }))!;

    return { company, leader, writer, planner, requester, squad, issue, dispatch };
  }

  it("posts an @leader comment and wakes the leader on a squad issue with no assignee", async () => {
    const { company, leader, writer, planner, requester, squad, issue, dispatch } = await seedSquadIssue();
    const { heartbeat, calls } = capturingHeartbeat();

    const result = await announcePendingSquadDispatchForIssue(db, heartbeat, {
      issueId: issue.id,
      actor: { actorType: "agent", actorId: requester.id },
    });

    expect(result).toMatchObject({ status: "announced", dispatchId: dispatch.id, leaderAgentId: leader.id });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    expect(comments).toHaveLength(1);
    const comment = comments[0]!;

    // @队长 —— 这是唯一能唤醒「非 assignee」agent 的钩子,mention 链接必须是可解析的 agent:// 形式。
    expect(comment.body).toContain(`(agent://${leader.id})`);
    // 候选成员及其 agentId、最近被纠正 —— 队长的决策依据
    expect(comment.body).toContain(writer.id);
    expect(comment.body).toContain(planner.id);
    expect(comment.body).toContain("标题别写成标题党");
    expect(comment.body).toContain("开头三秒要给结论");
    expect(comment.body).toContain("选题要贴当周热点");
    expect(comment.body).toContain(`/squad-dispatches/${dispatch.id}/decide`);
    // 队长只派活不占活:评论里不能出现「自己领走」的引导
    expect(comment.body).toContain("不要把它签给自己");
    // 只 @ 队长一个人:把候选也 @ 一遍等于把整个小队都叫起来
    expect(comment.body).not.toContain(`(agent://${writer.id})`);

    expect(calls).toHaveLength(1);
    const wake = calls[0]!;
    expect(wake.agentId).toBe(leader.id);
    expect(wake.opts?.reason).toBe(SQUAD_DISPATCH_WAKE_REASON);
    expect(wake.opts?.contextSnapshot).toMatchObject({
      issueId: issue.id,
      taskId: issue.id,
      commentId: comment.id,
      wakeCommentId: comment.id,
      wakeReason: SQUAD_DISPATCH_WAKE_REASON,
      source: SQUAD_DISPATCH_WAKE_SOURCE,
      squadId: squad.id,
      squadDispatchId: dispatch.id,
    });

    // ⚠️ 硬约束:评论作者 == 发起 wake 的 actor。拆开了 pause-hold 的回库校验就过不了,wake 静默失效。
    expect(comment.authorAgentId).toBe(requester.id);
    expect(wake.opts?.requestedByActorType).toBe("agent");
    expect(wake.opts?.requestedByActorId).toBe(comment.authorAgentId);

    // claim 阶段的放行口(heartbeat 的 allowsIssueInteractionWake):
    // wakeReason 必须在交互唤醒白名单里,且上下文能解析出真实 comment id。
    expect(ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(SQUAD_DISPATCH_WAKE_REASON)).toBe(true);

    // pause-hold 的回库校验(评论真实存在 + actor == 作者)—— 这条过了,唤醒才是「已验证的交互唤醒」。
    await expect(
      isVerifiedIssueTreeControlInteractionWake(db, {
        companyId: company.id,
        issueId: issue.id,
        agentId: leader.id,
        contextSnapshot: wake.opts?.contextSnapshot ?? null,
        requestedByActorType: wake.opts?.requestedByActorType ?? null,
        requestedByActorId: wake.opts?.requestedByActorId ?? null,
      }),
    ).resolves.toBe(true);

    const stored = await db
      .select()
      .from(squadDispatches)
      .where(eq(squadDispatches.id, dispatch.id))
      .then((rows) => rows[0]!);
    expect(stored.notifiedAt).not.toBeNull();
    expect(stored.dispatchCommentId).toBe(comment.id);
    expect(stored.state).toBe("pending");

    // 队长被唤醒 ≠ 队长接活:issue 仍然没有 assignee。
    const storedIssue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0]!);
    expect(storedIssue.assigneeAgentId).toBeNull();
  });

  it("announces a pending dispatch exactly once", async () => {
    const { requester, issue } = await seedSquadIssue();
    const { heartbeat, calls } = capturingHeartbeat();
    const actor = { actorType: "agent" as const, actorId: requester.id };

    const first = await announcePendingSquadDispatchForIssue(db, heartbeat, { issueId: issue.id, actor });
    const second = await announcePendingSquadDispatchForIssue(db, heartbeat, { issueId: issue.id, actor });

    expect(first.status).toBe("announced");
    // 第二次(issue update 又调了一遍派单钩子)必须是 no-op:一条派单只能唤醒队长一次。
    expect(second).toMatchObject({ status: "skipped", reason: "no_pending_dispatch" });
    expect(calls).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(1);
  });

  it("does not race itself: concurrent announcements post one comment and one wake", async () => {
    const { requester, issue } = await seedSquadIssue();
    const { heartbeat, calls } = capturingHeartbeat();
    const actor = { actorType: "agent" as const, actorId: requester.id };

    const results = await Promise.all([
      announcePendingSquadDispatchForIssue(db, heartbeat, { issueId: issue.id, actor }),
      announcePendingSquadDispatchForIssue(db, heartbeat, { issueId: issue.id, actor }),
    ]);

    expect(results.filter((result) => result.status === "announced")).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(1);
  });

  it("leaves a leaderless dispatch unannounced so it can be picked up once a leader exists", async () => {
    const { squad, leader, requester, issue, dispatch } = await seedSquadIssue({ withLeader: false });
    const { heartbeat, calls } = capturingHeartbeat();
    const actor = { actorType: "agent" as const, actorId: requester.id };

    const skipped = await announcePendingSquadDispatchForIssue(db, heartbeat, { issueId: issue.id, actor });
    expect(skipped).toMatchObject({ status: "skipped", reason: "no_leader" });
    expect(calls).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);

    const unannounced = await db
      .select({ notifiedAt: squadDispatches.notifiedAt })
      .from(squadDispatches)
      .where(eq(squadDispatches.id, dispatch.id))
      .then((rows) => rows[0]!);
    expect(unannounced.notifiedAt).toBeNull();

    // 队长配上之后,下一次 issue 写入会把这条派单补公告出去 —— 派单不会因为「当时没队长」永久卡死。
    await db.insert(squadMembers).values({
      companyId: squad.companyId,
      squadId: squad.id,
      memberType: "agent",
      agentId: leader.id,
      role: "leader",
    });
    const retried = await announcePendingSquadDispatchForIssue(db, heartbeat, { issueId: issue.id, actor });
    expect(retried).toMatchObject({ status: "announced", leaderAgentId: leader.id });
    expect(calls).toHaveLength(1);
  });

  /**
   * JIN-78 / P1-3:wake 没产出 run,就不许认领 notified_at。
   *
   * 旧代码在事务里先把 notified_at 写死,再把 wakeup() 的返回值直接扔掉(`.catch(() => null)`,
   * 返回 null 也不看)。`enqueueWakeup` 在 scheduling_suppressed / company.inactive /
   * wakeOnDemand.disabled / issue_rewake_throttled 等分支就是**返回 null 且不产出 run** ——
   * 于是:队长没被叫醒,派单却已被认领 → 永远躺在 pending,永不重播,接口还是 200。
   */
  it("does not claim a dispatch when the leader wake produced no run (so it can be replayed)", async () => {
    const { requester, issue, dispatch } = await seedSquadIssue();
    const actor = { actorType: "agent" as const, actorId: requester.id };

    // 唤醒被抑制(限流 / 公司停用 / wakeOnDemand 关闭…)—— 没有 run 产出。
    const suppressed = capturingHeartbeat({ wakeProducesRun: false });
    const result = await announcePendingSquadDispatchForIssue(db, suppressed.heartbeat, {
      issueId: issue.id,
      actor,
    });

    expect(suppressed.calls).toHaveLength(1);
    expect(result).toMatchObject({ status: "skipped", reason: "wake_not_scheduled", dispatchId: dispatch.id });

    // 核心断言:没排上 run → 认领必须被退回,派单还留在 pending 队列里等重播。
    const afterSuppressedWake = await db
      .select()
      .from(squadDispatches)
      .where(eq(squadDispatches.id, dispatch.id))
      .then((rows) => rows[0]!);
    expect(afterSuppressedWake.notifiedAt).toBeNull();
    expect(afterSuppressedWake.state).toBe("pending");

    // 下一轮(issue 又被写了一次)必须能真的重播出去,并且这次排上了 run → 认领生效。
    const retry = capturingHeartbeat();
    const replayed = await announcePendingSquadDispatchForIssue(db, retry.heartbeat, {
      issueId: issue.id,
      actor,
    });
    expect(replayed).toMatchObject({ status: "announced", dispatchId: dispatch.id });
    expect(retry.calls).toHaveLength(1);

    const afterReplay = await db
      .select()
      .from(squadDispatches)
      .where(eq(squadDispatches.id, dispatch.id))
      .then((rows) => rows[0]!);
    expect(afterReplay.notifiedAt).not.toBeNull();

    // 重播复用上一轮那条评论 —— 退认领不能变成「每轮刷一条派单评论」。
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    expect(comments).toHaveLength(1);
    expect(afterReplay.dispatchCommentId).toBe(comments[0]!.id);
  });

  it("skips issues that already have an assignee (no dispatch, no leader wake)", async () => {
    const { company, squad, writer } = await seedSquadIssue();
    const assigned = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier: "SQ-2",
        issueNumber: 2,
        title: "已经有负责人的任务",
        status: "todo",
        priority: "medium",
        ownerSquadId: squad.id,
        assigneeAgentId: writer.id,
      })
      .returning()
      .then((rows) => rows[0]!);

    expect(await syncSquadDispatchForIssue(db, assigned)).toBeNull();

    const { heartbeat, calls } = capturingHeartbeat();
    const result = await announcePendingSquadDispatchForIssue(db, heartbeat, {
      issueId: assigned.id,
      actor: { actorType: "system" },
    });

    expect(result).toMatchObject({ status: "skipped", reason: "no_pending_dispatch" });
    expect(calls).toHaveLength(0);
  });

  it("keeps the author/actor identity aligned for user-requested dispatches", async () => {
    const { company, issue } = await seedSquadIssue();
    const { heartbeat, calls } = capturingHeartbeat();

    await announcePendingSquadDispatchForIssue(db, heartbeat, {
      issueId: issue.id,
      actor: { actorType: "user", actorId: "user-42" },
    });

    const comment = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .then((rows) => rows[0]!);
    expect(comment.authorUserId).toBe("user-42");
    expect(comment.authorAgentId).toBeNull();
    expect(comment.authorType).toBe("user");

    await expect(
      isVerifiedIssueTreeControlInteractionWake(db, {
        companyId: company.id,
        issueId: issue.id,
        contextSnapshot: calls[0]?.opts?.contextSnapshot ?? null,
        requestedByActorType: calls[0]?.opts?.requestedByActorType ?? null,
        requestedByActorId: calls[0]?.opts?.requestedByActorId ?? null,
      }),
    ).resolves.toBe(true);
  });
});
