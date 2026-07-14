import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues, squadDispatches, squadMembers, squads } from "@paperclipai/db";
import { buildAgentMentionHref } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * 队长唤醒 —— Option B「派单即评论」。
 *
 * ## 为什么不能直接 wake 队长
 *
 * heartbeat 的 claim 阶段(`evaluateQueuedRunStaleness`)有一条硬断言:
 *
 *   if (issue.assigneeAgentId !== run.agentId && !isInteractionWake) → stale: issue_assignee_changed
 *
 * 派单那一刻 issue 的 assignee **正好是 NULL**(在等队长指派),run.agentId 是队长
 * → `null !== leaderId` → run 在 claim 阶段被静默取消。更坑的是 enqueue 阶段**不校验 assignee**,
 * 所以「派单看起来成功了」,然后无声无息地没了。
 *
 * 唯一的绕过口是 `allowsIssueInteractionWake`:wakeReason 必须 ∈
 * {issue_commented, issue_reopened_via_comment, issue_comment_mentioned},**且**上下文里
 * 带一个能解析出来的真实 comment id。自造一个中性 wakeReason 不管用。
 *
 * ## 这条路怎么走通
 *
 * 派单时由派单服务在 issue 上发一条**真实评论**并 @ 队长,复用线上唯一一条会唤醒
 * 「非 assignee」agent 的生产路径 `issue_comment_mentioned`:
 *   - 唤醒资格只看「这个 agent 属不属于本 company」,不看 assignee → 队长能被唤醒;
 *   - 天然带真实 comment id → 过得了 claim 阶段的交互唤醒放行口;
 *   - 顺带绕过 dependency-blocked 门与 subtree pause-hold 门;
 *   - **heartbeat 一行都不用改**(纯加法,不碰 upstream 冲突面)。
 *
 * ## ⚠️ 两条踩了就静默失效的硬约束
 *
 * 1. **评论作者必须等于发起 wake 的 actor。** pause-hold 会回库校验这一点
 *    (`issue-tree-control.ts` 的 `actorMatchesComment`)。所以这里的评论和 wake 共用
 *    同一个 `actor` 对象 —— 别用系统身份发评论、却用另一个身份触发 wake。
 * 2. **contextSnapshot 的 `source` 必须是 `comment.mention`。**
 *    `ISSUE_TREE_CONTROL_INTERACTION_WAKE_SOURCES` 是按 wakeReason 白名单校验 source 的,
 *    对不上就当作「未经验证的唤醒」处理。
 *
 * 队长被唤醒时 **不会**把 issue 自动签给自己 —— `shouldAutoCheckoutIssueForWake` 在
 * `issueAssigneeAgentId !== agentId` 时返回 false。这正是我们要的:队长只派活,不占活。
 */

/** 唯一能唤醒「非 assignee」agent 的生产 wakeReason */
export const SQUAD_DISPATCH_WAKE_REASON = "issue_comment_mentioned";
/** 与 wakeReason 配套的 source 白名单值,写错 = pause-hold 校验不过 */
export const SQUAD_DISPATCH_WAKE_SOURCE = "comment.mention";

/** 候选成员卡片里带几条「最近被纠正 / 下次注意」—— 队长要的是判断依据,不是全部历史 */
const CANDIDATE_FEEDBACK_NOTE_LIMIT = 3;
const DISPATCH_DESCRIPTION_EXCERPT_LIMIT = 400;

export type SquadDispatchActor = {
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
};

export interface SquadDispatchWakeDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export type SquadDispatchAnnouncement =
  | { status: "announced"; dispatchId: string; commentId: string; leaderAgentId: string }
  | {
    status: "skipped";
    reason: "no_pending_dispatch" | "already_announced" | "no_leader";
    dispatchId?: string;
  };

type DispatchCandidate = {
  agentId: string;
  name: string;
  role: string;
  notes: Array<{ kind: string; content: string }>;
};

function excerpt(text: string | null | undefined, limit: number) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

/**
 * 派单评论的正文。队长读完这一条就该能决策:任务是什么、候选有谁、各自擅长什么、
 * 之前在哪里栽过跟头、以及怎么把决策写回去。
 *
 * 只 @ 队长一个人:@ 谁就唤醒谁,把候选也 @ 一遍等于把整个小队都叫起来。
 */
export function buildSquadDispatchCommentBody(input: {
  issue: { identifier: string | null; title: string; description: string | null };
  squad: { id: string; name: string };
  dispatch: { id: string };
  leader: { agentId: string; name: string };
  candidates: DispatchCandidate[];
}): string {
  const { issue, squad, dispatch, leader, candidates } = input;
  const issueLabel = issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
  const lines: string[] = [
    `## 派单请求:${issueLabel}`,
    "",
    `[@${leader.name}](${buildAgentMentionHref(leader.agentId)}) 这条任务派给了小队 **${squad.name}**,`
    + `现在还没有负责人。**请你决定分给谁,并说明为什么是这个人。**`,
    "",
    "### 任务",
    `- **${issueLabel}**`,
  ];

  const description = excerpt(issue.description, DISPATCH_DESCRIPTION_EXCERPT_LIMIT);
  if (description) {
    lines.push("", description);
  }

  lines.push("", "### 候选成员");
  if (candidates.length === 0) {
    lines.push("", "⚠️ 小队里除了你没有别的 agent 成员。要么先补人,要么 decline 这条派单。");
  } else {
    for (const candidate of candidates) {
      lines.push("", `**${candidate.name}** — ${candidate.role}`, `- \`agentId\`: \`${candidate.agentId}\``);
      const corrections = candidate.notes.filter((note) => note.kind === "correction");
      const reminders = candidate.notes.filter((note) => note.kind !== "correction");
      if (corrections.length > 0) {
        lines.push(`- 最近被纠正:${corrections.map((note) => note.content).join(";")}`);
      }
      if (reminders.length > 0) {
        lines.push(`- 下次注意:${reminders.map((note) => note.content).join(";")}`);
      }
      if (corrections.length === 0 && reminders.length === 0) {
        lines.push("- 暂无反馈记录");
      }
    }
  }

  lines.push(
    "",
    "### 怎么把决策写回去",
    `- 待办队列:\`GET /api/squads/${squad.id}/dispatches?state=pending\``,
    `- 派活:\`POST /api/squad-dispatches/${dispatch.id}/decide\``
    + ` — body \`{ "assignedAgentId": "<候选的 agentId>", "decisionReason": "为什么是他" }\``,
    `- 派不出去:\`POST /api/squad-dispatches/${dispatch.id}/decline\``
    + ` — body \`{ "failureReason": "..." }\``,
    "",
    "`decisionReason` 必填 —— 「为什么派给他而不是别人」是这个产品要展示的核心价值,别写「合适」。",
    "被指派人会在你写回决策后自动开工,你不需要自己动手做这条任务,也不要把它签给自己。",
  );

  return lines.join("\n");
}

/**
 * 候选成员的「能力 + 最近被纠正」一次查完。
 *
 * ⚠️ 别写成「循环里按 agent 查笔记」—— 那是教科书级 N+1。
 * 这里用 `row_number() OVER (PARTITION BY agent_id ...)` 一条查询把每个候选的 top-N 笔记切出来,
 * 排序键 (weight DESC, created_at DESC) 与 `agent_feedback_notes_inject_idx` 对齐。
 */
async function loadCandidates(
  db: Db,
  input: { squadId: string; leaderAgentId: string },
): Promise<DispatchCandidate[]> {
  const members = await db
    .select({
      agentId: squadMembers.agentId,
      name: agents.name,
      role: agents.role,
      position: squadMembers.position,
    })
    .from(squadMembers)
    .innerJoin(agents, eq(agents.id, squadMembers.agentId))
    .where(and(eq(squadMembers.squadId, input.squadId), eq(squadMembers.memberType, "agent")))
    .orderBy(asc(squadMembers.position), asc(squadMembers.createdAt));

  const candidates = members
    .filter((member): member is typeof member & { agentId: string } =>
      Boolean(member.agentId) && member.agentId !== input.leaderAgentId)
    .map((member) => ({
      agentId: member.agentId,
      name: member.name,
      role: member.role,
      notes: [] as Array<{ kind: string; content: string }>,
    }));
  if (candidates.length === 0) return candidates;

  const agentIdList = sql.join(
    candidates.map((candidate) => sql`${candidate.agentId}::uuid`),
    sql`, `,
  );
  const noteRows = await db.execute(sql`
    select agent_id, kind, content
    from (
      select
        agent_id,
        kind,
        content,
        row_number() over (partition by agent_id order by weight desc, created_at desc) as rn
      from agent_feedback_notes
      where agent_id in (${agentIdList})
        and status = 'active'
        and kind in ('correction', 'reminder')
        and (expires_at is null or expires_at > now())
    ) ranked
    where rn <= ${CANDIDATE_FEEDBACK_NOTE_LIMIT}
  `);

  const byAgent = new Map(candidates.map((candidate) => [candidate.agentId, candidate]));
  for (const row of noteRows as unknown as Array<{ agent_id: string; kind: string; content: string }>) {
    byAgent.get(row.agent_id)?.notes.push({ kind: row.kind, content: row.content });
  }
  return candidates;
}

async function resolveLeaderAgentId(db: Db, squadId: string, squadLeaderAgentId: string | null) {
  const membership = await db
    .select({ agentId: squadMembers.agentId })
    .from(squadMembers)
    .where(and(eq(squadMembers.squadId, squadId), eq(squadMembers.role, "leader")))
    .then((rows) => rows[0] ?? null);
  return membership?.agentId ?? squadLeaderAgentId ?? null;
}

/**
 * 一条 issue 上「还没公告的 pending 派单」→ 发评论 @ 队长 + 唤醒队长。
 *
 * 幂等:公告用 `UPDATE ... WHERE notified_at IS NULL` 原子认领,抢不到就跳过。
 * issue 的 create 和 update 都会调派单钩子,并发下没有这层认领会重复唤醒队长。
 *
 * 没有队长时**不认领**(notified_at 留空):等队长配上后,下一次 issue 写入会自动补公告。
 */
export async function announcePendingSquadDispatchForIssue(
  db: Db,
  heartbeat: SquadDispatchWakeDeps,
  input: { issueId: string; actor: SquadDispatchActor },
): Promise<SquadDispatchAnnouncement> {
  const row = await db
    .select({
      dispatchId: squadDispatches.id,
      companyId: squadDispatches.companyId,
      squadId: squadDispatches.squadId,
      squadName: squads.name,
      squadLeaderAgentId: squads.leaderAgentId,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      issueDescription: issues.description,
    })
    .from(squadDispatches)
    .innerJoin(squads, eq(squads.id, squadDispatches.squadId))
    .innerJoin(issues, eq(issues.id, squadDispatches.issueId))
    .where(
      and(
        eq(squadDispatches.issueId, input.issueId),
        eq(squadDispatches.state, "pending"),
        isNull(squadDispatches.notifiedAt),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!row) return { status: "skipped", reason: "no_pending_dispatch" };

  const leaderAgentId = await resolveLeaderAgentId(db, row.squadId, row.squadLeaderAgentId);
  if (!leaderAgentId) {
    logger.warn(
      { issueId: input.issueId, squadId: row.squadId, dispatchId: row.dispatchId },
      "squad dispatch has no leader to wake; leaving it unannounced for a later retry",
    );
    return { status: "skipped", reason: "no_leader", dispatchId: row.dispatchId };
  }

  const leader = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, leaderAgentId))
    .then((rows) => rows[0] ?? null);
  if (!leader) return { status: "skipped", reason: "no_leader", dispatchId: row.dispatchId };

  const candidates = await loadCandidates(db, { squadId: row.squadId, leaderAgentId });

  const body = buildSquadDispatchCommentBody({
    issue: {
      identifier: row.issueIdentifier,
      title: row.issueTitle,
      description: row.issueDescription,
    },
    squad: { id: row.squadId, name: row.squadName },
    dispatch: { id: row.dispatchId },
    leader: { agentId: leaderAgentId, name: leader.name },
    candidates,
  });

  // 评论作者 = 发起 wake 的 actor。这个等式是 pause-hold 的回库校验条件,拆开就静默失效。
  const authorAgentId = input.actor.actorType === "agent" ? input.actor.actorId ?? null : null;
  const authorUserId = input.actor.actorType === "user" ? input.actor.actorId ?? null : null;
  const authorType = authorAgentId ? "agent" : authorUserId ? "user" : "system";

  const commentId = await db.transaction(async (tx) => {
    // 原子认领:并发的第二个派单钩子在这里拿不到行,直接放弃,不会发出第二条评论。
    const claimed = await tx
      .update(squadDispatches)
      .set({ notifiedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(squadDispatches.id, row.dispatchId), isNull(squadDispatches.notifiedAt)))
      .returning({ id: squadDispatches.id })
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    const comment = await tx
      .insert(issueComments)
      .values({
        companyId: row.companyId,
        issueId: input.issueId,
        authorAgentId,
        authorUserId,
        authorType,
        body,
        presentation: { kind: "system_notice", tone: "info", title: "派单请求", detailsDefaultOpen: true },
      })
      .returning({ id: issueComments.id })
      .then((rows) => rows[0]!);

    await tx
      .update(squadDispatches)
      .set({ dispatchCommentId: comment.id, updatedAt: new Date() })
      .where(eq(squadDispatches.id, row.dispatchId));

    return comment.id;
  });

  if (!commentId) return { status: "skipped", reason: "already_announced", dispatchId: row.dispatchId };

  await heartbeat
    .wakeup(leaderAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: SQUAD_DISPATCH_WAKE_REASON,
      payload: {
        issueId: input.issueId,
        commentId,
        squadId: row.squadId,
        squadDispatchId: row.dispatchId,
        mutation: "squad_dispatch",
      },
      idempotencyKey: `squad_dispatch_announced:${row.dispatchId}`,
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
      },
    })
    .catch((err) => {
      // 评论已经落库了,队长下次被任何理由唤醒时还能从待办队列里捞到这条派单。
      logger.warn(
        { err, issueId: input.issueId, dispatchId: row.dispatchId, leaderAgentId },
        "failed to wake squad leader for pending dispatch",
      );
      return null;
    });

  return { status: "announced", dispatchId: row.dispatchId, commentId, leaderAgentId };
}

/** 路由里的调用口:派单公告是增强项,不该把 issue 的创建/更新拖挂。 */
export async function announcePendingSquadDispatchSafely(
  db: Db,
  heartbeat: SquadDispatchWakeDeps,
  input: { issueId: string; actor: SquadDispatchActor },
) {
  try {
    return await announcePendingSquadDispatchForIssue(db, heartbeat, input);
  } catch (err) {
    logger.warn({ err, issueId: input.issueId }, "failed to announce pending squad dispatch");
    return null;
  }
}
