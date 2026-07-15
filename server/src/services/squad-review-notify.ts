import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues, squadDispatches, squads } from "@paperclipai/db";
import { buildAgentMentionHref } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import {
  SQUAD_DISPATCH_WAKE_REASON,
  SQUAD_DISPATCH_WAKE_SOURCE,
  resolveSquadLeaderAgentId,
  type SquadDispatchActor,
  type SquadDispatchWakeDeps,
} from "./squad-dispatch-notify.js";

/**
 * 派单链的第三跳 —— 队长「评审产出」。
 *
 * ## 链条全貌
 *
 *   1. 任务派给小队        → `syncSquadDispatchForIssue` 开一条 pending 派单
 *   2. 队长决定分给谁      → `announcePendingSquadDispatchForIssue` 叫醒队长;`decide` 写回决策 + 把
 *                            issue 从 backlog 提成 todo(被指派人这才真的开工)
 *   3. **队长评审产出**    → 本文件:被指派人把 issue 做完(in_review / done)时,派单落终态
 *                            `completed`,并把队长叫回来看产出
 *
 * 第三跳缺位时的症状很安静:队长把活派出去之后就「失联」—— dispatch 永远停在 `dispatched`
 * (状态机里根本没有终态可落),被指派人干完了也没人叫队长。接口全 200,库里查不出「这次派单结束了」。
 *
 * ## 为什么还是走「发评论 @ 队长」这条路
 *
 * 和第二跳同一个约束:**队长不是 issue 的 assignee**(assignee 是被指派人),而 heartbeat 的
 * claim 阶段会断言 `issue.assigneeAgentId === run.agentId`,只对「带真实 comment 的交互唤醒」
 * (`issue_comment_mentioned` + `source: comment.mention`)放行。所以照抄 `squad-dispatch-notify.ts`
 * 的写法:发一条真实评论 @ 队长,用同一个 actor 触发 wake。heartbeat 一行不改。
 *
 * ⚠️ **评论作者必须等于触发 wake 的 actor** —— pause-hold 会回库校验这一点
 * (`issue-tree-control.ts` 的 `actorMatchesComment`)。拆开就静默失效。
 *
 * ## 「完成」和「已通知队长」是两件事,分两个字段
 *
 * - `state='completed'` + `completed_at`:**事实**。活做完了,派单结束了。不依赖队长存不存在、
 *   唤醒排没排上 run —— 否则一次唤醒失败就能把「活做完了」这条事实抹掉。
 * - `review_notified_at`:**公告认领标记**。原子认领(`UPDATE ... WHERE review_notified_at IS NULL`),
 *   保证同一条派单只刷一条「请评审」评论、只唤醒队长一次。issue 的每一次写入都会过这个钩子,
 *   没有这层认领就会重复公告。wake 落空(enqueueWakeup 返回 null)时**退掉认领**,让下一次
 *   issue 写入能把它重新公告出去(评论复用,不刷第二条)。
 *
 * ## 打回怎么走
 *
 * 队长评审不满意 → 复用现有改派语义:`POST /squad-dispatches/:id/decide`(老的置 `reassigned`,
 * 另开一条新 dispatch,issue 从完成态被拉回 todo,被指派人重新开工)。**不原地改状态**,审计链不断。
 */

/** 被指派人「把活干完了」的信号:转 in_review(交产出待评审)或 done(自认完成) */
export const SQUAD_REVIEW_TRIGGER_ISSUE_STATUSES = ["in_review", "done"] as const;

export function isSquadReviewTriggerIssueStatus(status: string | null | undefined) {
  return SQUAD_REVIEW_TRIGGER_ISSUE_STATUSES.includes(
    status as (typeof SQUAD_REVIEW_TRIGGER_ISSUE_STATUSES)[number],
  );
}

export type SquadDispatchReviewAnnouncement =
  | { status: "announced"; dispatchId: string; commentId: string; leaderAgentId: string }
  | {
    status: "skipped";
    reason:
      | "issue_not_completed"
      | "no_open_dispatch"
      | "already_announced"
      | "no_leader"
      | "leader_is_assignee"
      | "wake_not_scheduled";
    dispatchId?: string;
  };

/**
 * 「请评审」评论的正文。队长读完这一条就该能决策:谁做的、做的是哪条任务、产出在哪、
 * 以及不满意时怎么打回。
 *
 * 只 @ 队长一个人:@ 谁就唤醒谁。
 */
export function buildSquadReviewCommentBody(input: {
  issue: { identifier: string | null; title: string; status: string };
  squad: { id: string; name: string };
  dispatch: { id: string; decisionReason: string | null };
  leader: { agentId: string; name: string };
  assignee: { name: string } | null;
}): string {
  const { issue, squad, dispatch, leader, assignee } = input;
  const issueLabel = issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
  const doer = assignee?.name ?? "被指派人";
  const statusLabel = issue.status === "done" ? "已完成(done)" : "已交付待评审(in_review)";

  return [
    `## 产出待评审:${issueLabel}`,
    "",
    `[@${leader.name}](${buildAgentMentionHref(leader.agentId)}) **${doer}** 把你派的这条活做完了(${statusLabel})。`
    + `**请评审产出**:去 issue 里看他交的东西,认可就收下,不认可就打回。`,
    "",
    "### 这次派单",
    `- 任务:**${issueLabel}**`,
    `- 负责人:**${doer}**`,
    `- 你当初派给他的理由:${dispatch.decisionReason?.trim() || "(未记录)"}`,
    "",
    "### 打回怎么做",
    `- 打回重做 / 换人:\`POST /api/squad-dispatches/${dispatch.id}/decide\``
    + ` — body \`{ "assignedAgentId": "<谁来返工>", "decisionReason": "哪里不行、要怎么改" }\``,
    "  这会**另开一条新派单**(老的置 `reassigned`,审计链保留),并把 issue 从完成态拉回 `todo`,"
    + "被指派人会自动重新开工。",
    `- 小队成员名单:\`GET /api/squads/${squad.id}/members\`(**${squad.name}**)`,
    "",
    "认可产出就**什么都不用做** —— 这条派单已经落终态 `completed`。",
    "打回时 `decisionReason` 必填:写清「哪里不行」,这是返工的人唯一能拿到的指令。",
  ].join("\n");
}

/**
 * 被指派人做完 issue → 派单落终态 + 叫队长来评审。
 *
 * 两步都幂等,可以在 issue 的**每一次**写入上安全地重复调用:
 *   1. 终态回写:`state: dispatched → completed`(WHERE state='dispatched',并发安全)
 *   2. 评审公告:原子认领 `review_notified_at` → 发评论 @ 队长 → 唤醒队长
 */
export async function announceSquadDispatchReviewForIssue(
  db: Db,
  heartbeat: SquadDispatchWakeDeps,
  input: { issueId: string; actor: SquadDispatchActor },
): Promise<SquadDispatchReviewAnnouncement> {
  const row = await db
    .select({
      dispatchId: squadDispatches.id,
      companyId: squadDispatches.companyId,
      squadId: squadDispatches.squadId,
      state: squadDispatches.state,
      decisionReason: squadDispatches.decisionReason,
      assignedAgentId: squadDispatches.assignedAgentId,
      reviewCommentId: squadDispatches.reviewCommentId,
      squadName: squads.name,
      squadLeaderAgentId: squads.leaderAgentId,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      issueStatus: issues.status,
    })
    .from(squadDispatches)
    .innerJoin(squads, eq(squads.id, squadDispatches.squadId))
    .innerJoin(issues, eq(issues.id, squadDispatches.issueId))
    .where(
      and(
        eq(squadDispatches.issueId, input.issueId),
        // dispatched = 还没回写终态;completed = 终态已回写但公告还没成(上一轮 wake 落空,退了认领)。
        inArray(squadDispatches.state, ["dispatched", "completed"]),
        isNull(squadDispatches.reviewNotifiedAt),
      ),
    )
    .orderBy(desc(squadDispatches.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return { status: "skipped", reason: "no_open_dispatch" };

  // 调用方已经判过一次,这里再判一次:唯一的真相是库里的 issue 状态,不是调用方传来的内存对象。
  if (!isSquadReviewTriggerIssueStatus(row.issueStatus)) {
    return { status: "skipped", reason: "issue_not_completed", dispatchId: row.dispatchId };
  }

  const now = new Date();

  /**
   * 第一步:终态。**先于**队长唤醒,且不依赖它 ——
   * 队长可能还没配、唤醒可能排不上 run,但「这活做完了」是既成事实,不该被这些牵连。
   */
  if (row.state === "dispatched") {
    await db
      .update(squadDispatches)
      .set({ state: "completed", completedAt: now, updatedAt: now })
      .where(and(eq(squadDispatches.id, row.dispatchId), eq(squadDispatches.state, "dispatched")));
  }

  const leaderAgentId = await resolveSquadLeaderAgentId(db, row.squadId, row.squadLeaderAgentId);
  if (!leaderAgentId) {
    logger.warn(
      { issueId: input.issueId, squadId: row.squadId, dispatchId: row.dispatchId },
      "completed squad dispatch has no leader to wake for review; leaving it unannounced for a later retry",
    );
    return { status: "skipped", reason: "no_leader", dispatchId: row.dispatchId };
  }

  /**
   * 队长把活派给了自己 → 没有「第三方评审」可言,叫醒他去评审他自己刚交的东西只会绕圈。
   * 终态照落(上面已经写了),公告跳过。
   */
  if (leaderAgentId === row.assignedAgentId) {
    return { status: "skipped", reason: "leader_is_assignee", dispatchId: row.dispatchId };
  }

  const [leader, assignee] = await Promise.all([
    db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, leaderAgentId))
      .then((rows) => rows[0] ?? null),
    row.assignedAgentId
      ? db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, row.assignedAgentId))
        .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  if (!leader) return { status: "skipped", reason: "no_leader", dispatchId: row.dispatchId };

  const body = buildSquadReviewCommentBody({
    issue: { identifier: row.issueIdentifier, title: row.issueTitle, status: row.issueStatus },
    squad: { id: row.squadId, name: row.squadName },
    dispatch: { id: row.dispatchId, decisionReason: row.decisionReason },
    leader: { agentId: leaderAgentId, name: leader.name },
    assignee,
  });

  // 评论作者 = 发起 wake 的 actor。这个等式是 pause-hold 的回库校验条件,拆开就静默失效。
  const authorAgentId = input.actor.actorType === "agent" ? input.actor.actorId ?? null : null;
  const authorUserId = input.actor.actorType === "user" ? input.actor.actorId ?? null : null;
  const authorType = authorAgentId ? "agent" : authorUserId ? "user" : "system";

  const commentId = await db.transaction(async (tx) => {
    // 原子认领:并发的第二个钩子在这里拿不到行,直接放弃,不会发出第二条「请评审」。
    const claimed = await tx
      .update(squadDispatches)
      .set({ reviewNotifiedAt: now, updatedAt: now })
      .where(and(eq(squadDispatches.id, row.dispatchId), isNull(squadDispatches.reviewNotifiedAt)))
      .returning({ id: squadDispatches.id })
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    // 重播:上一轮评论已经发出去了,只是 wake 没排上 run。复用那条评论,别再刷一条。
    if (row.reviewCommentId) return row.reviewCommentId;

    const comment = await tx
      .insert(issueComments)
      .values({
        companyId: row.companyId,
        issueId: input.issueId,
        authorAgentId,
        authorUserId,
        authorType,
        body,
        presentation: { kind: "system_notice", tone: "info", title: "产出待评审", detailsDefaultOpen: true },
      })
      .returning({ id: issueComments.id })
      .then((rows) => rows[0]!);

    await tx
      .update(squadDispatches)
      .set({ reviewCommentId: comment.id, updatedAt: now })
      .where(eq(squadDispatches.id, row.dispatchId));

    return comment.id;
  });

  if (!commentId) return { status: "skipped", reason: "already_announced", dispatchId: row.dispatchId };

  const wake = await heartbeat
    .wakeup(leaderAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: SQUAD_DISPATCH_WAKE_REASON,
      payload: {
        issueId: input.issueId,
        commentId,
        squadId: row.squadId,
        squadDispatchId: row.dispatchId,
        mutation: "squad_dispatch_review",
      },
      idempotencyKey: `squad_dispatch_review:${row.dispatchId}`,
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        commentId,
        // claim 阶段的 `deriveCommentId` 先看 wakeCommentId —— 两个键都带上,别赌它的取值顺序。
        wakeCommentId: commentId,
        wakeReason: SQUAD_DISPATCH_WAKE_REASON,
        source: SQUAD_DISPATCH_WAKE_SOURCE,
        squadId: row.squadId,
        squadDispatchId: row.dispatchId,
        squadDispatchReview: true,
      },
    })
    .catch((err) => {
      logger.warn(
        { err, issueId: input.issueId, dispatchId: row.dispatchId, leaderAgentId },
        "failed to wake squad leader for dispatch review",
      );
      return null;
    });

  /**
   * 认领的语义是「队长**已经被叫起来评审了**」,不是「我们尝试过了」。
   * `enqueueWakeup` 在 scheduling_suppressed / company.inactive / wakeOnDemand.disabled 等分支
   * **返回 null**(写一行 skipped 的 wakeup_request,不产出 run)。认领不退 = 队长永远不知道活干完了。
   *
   * 所以 wake 落空就退掉认领(`review_notified_at → null`),下一次 issue 写入会重新公告。
   * 终态(state=completed)**不退** —— 活确实做完了,这条事实与唤醒成败无关;上面的取数条件
   * 因此把 `completed` 也算作「还能公告」的状态。
   */
  if (!wake) {
    await db
      .update(squadDispatches)
      .set({ reviewNotifiedAt: null, updatedAt: new Date() })
      .where(and(eq(squadDispatches.id, row.dispatchId), eq(squadDispatches.state, "completed")));
    logger.warn(
      { issueId: input.issueId, dispatchId: row.dispatchId, leaderAgentId },
      "squad leader review wake produced no run; releasing the review claim so it can be re-announced",
    );
    return { status: "skipped", reason: "wake_not_scheduled", dispatchId: row.dispatchId };
  }

  return { status: "announced", dispatchId: row.dispatchId, commentId, leaderAgentId };
}

/** 路由里的调用口:评审公告是增强项,不该把 issue 的更新拖挂。 */
export async function announceSquadDispatchReviewSafely(
  db: Db,
  heartbeat: SquadDispatchWakeDeps,
  input: { issueId: string; actor: SquadDispatchActor },
) {
  try {
    return await announceSquadDispatchReviewForIssue(db, heartbeat, input);
  } catch (err) {
    logger.warn({ err, issueId: input.issueId }, "failed to announce squad dispatch review");
    return null;
  }
}
