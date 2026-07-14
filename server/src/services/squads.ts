import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, squadDispatches, squadMembers, squads } from "@paperclipai/db";
import type {
  AddSquadMember,
  CreateSquad,
  DecideSquadDispatch,
  DeclineSquadDispatch,
  SquadDispatchRequestedByType,
  SquadDispatchState,
  UpdateSquad,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

/** Postgres 唯一键冲突 */
const UNIQUE_VIOLATION = "23505";

/**
 * 队长决策 = 这活现在开始 —— 把 issue 从 backlog 提成 todo。
 *
 * ## 为什么这一步非有不可(派单链的最后一跳)
 *
 * 1. 派给小队的 issue 没有 assignee → validator 默认落 `backlog`;
 * 2. `decide` 只写 assignee,不动 status;
 * 3. `queueIssueAssignmentWakeup` 见 `status === "backlog"` **直接 return,不唤醒**。
 *
 * 于是队长写回决策 → assignee 落库 → dispatch 翻 dispatched → 接口 200 → **被指派人一个 run 都没有**。
 * 全程无异常、无日志、UI 不报错。
 *
 * ## 为什么修在这里,而不是放宽 wakeup 的 backlog 判断
 *
 * 「backlog = 还没开工,谁也别叫醒」是一条**全局不变式**(`issue-assigned-backlog-contract` 套件在守它:
 * 显式建的 assigned backlog 就是要「停着不叫醒」)。为了派单这一个调用方去放宽它,等于削弱**所有**调用方的契约。
 * 而在 decide 里提状态是**小队局部**的改动,语义本来就成立。
 *
 * ⚠️ 必须跑在 decide/reassign **已有的那个事务里**,和 assignee 写入、dispatch 翻 dispatched 同生共死 ——
 * 拆出去单跑,中间挂掉就又回到「有 assignee 但状态还是 backlog、永远不开工」的静默态。
 *
 * 只在「当前确实是 backlog」时提(UPDATE ... WHERE status = 'backlog',并发安全);
 * 已经是 todo / in_progress 的不动 —— 决策不该把正在跑的活打回起点。
 */
async function promoteDecidedIssueOutOfBacklog(
  tx: Tx,
  input: { issueId: string; assigned: boolean; now: Date },
) {
  if (!input.assigned) return;
  await tx
    .update(issues)
    .set({ status: "todo", updatedAt: input.now })
    .where(and(eq(issues.id, input.issueId), eq(issues.status, "backlog")));
}

/** drizzle 会把驱动错误包一层(错误码落在 cause 上),所以要顺着 cause 链找 */
function isUniqueViolation(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 派单产生:issue 挂着 owner_squad_id 且还没有 assignee → 给队长开一条待办派单。
 *
 * 并发/重试的去重完全交给 `squad_dispatches_issue_pending_uq`(部分唯一索引,只覆盖 pending),
 * 应用层不自己写「先查再插」—— 那个检查在并发下本来就是错的。撞唯一键 = 已有待办派单,
 * 属于正常返回,不是 500。
 */
export async function ensurePendingDispatchForIssue(
  dbOrTx: DbOrTx,
  input: {
    companyId: string;
    issueId: string;
    squadId: string;
    requestedByType?: SquadDispatchRequestedByType;
    requestedByUserId?: string | null;
    requestedByAgentId?: string | null;
    sourceMessageId?: string | null;
  },
) {
  const inserted = await dbOrTx
    .insert(squadDispatches)
    .values({
      companyId: input.companyId,
      squadId: input.squadId,
      issueId: input.issueId,
      state: "pending",
      requestedByType: input.requestedByType ?? "system",
      requestedByUserId: input.requestedByUserId ?? null,
      requestedByAgentId: input.requestedByAgentId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
    })
    .onConflictDoNothing()
    .returning()
    .then((rows) => rows[0] ?? null);

  if (inserted) return inserted;

  // 唯一索引挡下了:已经有一条 pending,把它当成本次结果返回(幂等)。
  return dbOrTx
    .select()
    .from(squadDispatches)
    .where(and(eq(squadDispatches.issueId, input.issueId), eq(squadDispatches.state, "pending")))
    .then((rows) => rows[0] ?? null);
}

/**
 * issue 写入后的统一钩子:只有「挂了小队 + 没有 assignee」才派单。
 * 已经有 assignee 的 issue 不需要队长决策。
 */
export async function syncSquadDispatchForIssue(
  dbOrTx: DbOrTx,
  issue: {
    id: string;
    companyId: string;
    ownerSquadId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  },
  actor?: {
    requestedByType?: SquadDispatchRequestedByType;
    requestedByUserId?: string | null;
    requestedByAgentId?: string | null;
  },
) {
  if (!issue.ownerSquadId) return null;
  if (issue.assigneeAgentId || issue.assigneeUserId) return null;
  return ensurePendingDispatchForIssue(dbOrTx, {
    companyId: issue.companyId,
    issueId: issue.id,
    squadId: issue.ownerSquadId,
    requestedByType: actor?.requestedByType ?? "system",
    requestedByUserId: actor?.requestedByUserId ?? null,
    requestedByAgentId: actor?.requestedByAgentId ?? null,
  });
}

export function squadService(db: Db) {
  async function getSquadOrThrow(id: string) {
    const squad = await db
      .select()
      .from(squads)
      .where(eq(squads.id, id))
      .then((rows) => rows[0] ?? null);
    if (!squad) throw notFound("Squad not found");
    return squad;
  }

  async function assertAgentInCompany(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.companyId !== companyId) {
      throw unprocessable("Agent does not belong to this company");
    }
  }

  /**
   * 队长既是 squads.leader_agent_id(便于展示),也是 squad_members 里 role='leader' 的那条成员记录
   * (便于路由)。两处保持一致,单队长由 `squad_members_single_leader_uq` 兜底。
   */
  async function upsertLeaderMembership(
    tx: DbOrTx,
    input: { companyId: string; squadId: string; leaderAgentId: string },
  ) {
    // 老队长降级为普通成员,保留其成员身份(人没走,只是不当队长了)。
    await tx
      .update(squadMembers)
      .set({ role: "member", updatedAt: new Date() })
      .where(
        and(
          eq(squadMembers.squadId, input.squadId),
          eq(squadMembers.role, "leader"),
          sql`${squadMembers.agentId} is distinct from ${input.leaderAgentId}`,
        ),
      );
    await tx
      .insert(squadMembers)
      .values({
        companyId: input.companyId,
        squadId: input.squadId,
        memberType: "agent",
        agentId: input.leaderAgentId,
        role: "leader",
      })
      .onConflictDoUpdate({
        target: [squadMembers.squadId, squadMembers.agentId],
        // squad_members_squad_agent_uq 是部分唯一索引,ON CONFLICT 必须带上同样的谓词才能推断出它
        targetWhere: sql`${squadMembers.agentId} is not null`,
        set: { role: "leader", updatedAt: new Date() },
      });
  }

  return {
    list: (companyId: string) =>
      db
        .select()
        .from(squads)
        .where(eq(squads.companyId, companyId))
        .orderBy(asc(squads.createdAt)),

    getById: (id: string) =>
      db
        .select()
        .from(squads)
        .where(eq(squads.id, id))
        .then((rows) => rows[0] ?? null),

    create: async (companyId: string, data: CreateSquad) => {
      if (data.leaderAgentId) await assertAgentInCompany(companyId, data.leaderAgentId);
      return db.transaction(async (tx) => {
        const squad = await tx
          .insert(squads)
          .values({
            companyId,
            name: data.name,
            description: data.description ?? null,
            projectId: data.projectId ?? null,
            leaderAgentId: data.leaderAgentId ?? null,
            douyinAccountId: data.douyinAccountId ?? null,
            dispatchPolicy: data.dispatchPolicy ?? {},
          })
          .returning()
          .then((rows) => rows[0]!);
        if (squad.leaderAgentId) {
          await upsertLeaderMembership(tx, {
            companyId,
            squadId: squad.id,
            leaderAgentId: squad.leaderAgentId,
          });
        }
        return squad;
      });
    },

    update: async (id: string, data: UpdateSquad) => {
      const existing = await getSquadOrThrow(id);
      if (data.leaderAgentId) await assertAgentInCompany(existing.companyId, data.leaderAgentId);
      return db.transaction(async (tx) => {
        const patch: Partial<typeof squads.$inferInsert> = { updatedAt: new Date() };
        if (data.name !== undefined) patch.name = data.name;
        if (data.description !== undefined) patch.description = data.description ?? null;
        if (data.projectId !== undefined) patch.projectId = data.projectId ?? null;
        if (data.leaderAgentId !== undefined) patch.leaderAgentId = data.leaderAgentId ?? null;
        if (data.douyinAccountId !== undefined) patch.douyinAccountId = data.douyinAccountId ?? null;
        if (data.status !== undefined) patch.status = data.status;
        if (data.dispatchPolicy !== undefined) patch.dispatchPolicy = data.dispatchPolicy;

        const squad = await tx
          .update(squads)
          .set(patch)
          .where(eq(squads.id, id))
          .returning()
          .then((rows) => rows[0]!);

        if (data.leaderAgentId) {
          await upsertLeaderMembership(tx, {
            companyId: squad.companyId,
            squadId: squad.id,
            leaderAgentId: data.leaderAgentId,
          });
        } else if (data.leaderAgentId === null) {
          await tx
            .update(squadMembers)
            .set({ role: "member", updatedAt: new Date() })
            .where(and(eq(squadMembers.squadId, squad.id), eq(squadMembers.role, "leader")));
        }
        return squad;
      });
    },

    /** agent + user 成员并集,队长排在最前 */
    listMembers: (squadId: string) =>
      db
        .select()
        .from(squadMembers)
        .where(eq(squadMembers.squadId, squadId))
        .orderBy(
          desc(sql`(${squadMembers.role} = 'leader')`),
          asc(squadMembers.position),
          asc(squadMembers.createdAt),
        ),

    addMember: async (squadId: string, data: AddSquadMember) => {
      const squad = await getSquadOrThrow(squadId);
      if (data.memberType === "agent" && data.agentId) {
        await assertAgentInCompany(squad.companyId, data.agentId);
      }
      try {
        return await db.transaction(async (tx) => {
          if (data.role === "leader") {
            if (data.memberType !== "agent" || !data.agentId) {
              // 队长必须是 agent:leader_agent_id 是 uuid 外键,存不下裸 text 的真人 id。
              throw unprocessable("Squad leader must be an agent member");
            }
            await upsertLeaderMembership(tx, {
              companyId: squad.companyId,
              squadId,
              leaderAgentId: data.agentId,
            });
            await tx
              .update(squads)
              .set({ leaderAgentId: data.agentId, updatedAt: new Date() })
              .where(eq(squads.id, squadId));
            return await tx
              .select()
              .from(squadMembers)
              .where(and(eq(squadMembers.squadId, squadId), eq(squadMembers.agentId, data.agentId)))
              .then((rows) => rows[0]!);
          }
          return await tx
            .insert(squadMembers)
            .values({
              companyId: squad.companyId,
              squadId,
              memberType: data.memberType,
              agentId: data.agentId ?? null,
              userId: data.userId ?? null,
              role: "member",
              position: data.position ?? 0,
            })
            .returning()
            .then((rows) => rows[0]!);
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("Member already belongs to this squad");
        }
        throw error;
      }
    },

    removeMember: async (squadId: string, memberId: string) => {
      const removed = await db
        .delete(squadMembers)
        .where(and(eq(squadMembers.squadId, squadId), eq(squadMembers.id, memberId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!removed) throw notFound("Squad member not found");
      if (removed.role === "leader" && removed.agentId) {
        await db
          .update(squads)
          .set({ leaderAgentId: null, updatedAt: new Date() })
          .where(and(eq(squads.id, squadId), eq(squads.leaderAgentId, removed.agentId)));
      }
      return removed;
    },

    /** 队长的待办队列:走 squad_dispatches_pending_queue_idx(company, squad, created_at) WHERE pending */
    listDispatches: (squadId: string, opts: { state?: SquadDispatchState; limit?: number } = {}) =>
      db
        .select()
        .from(squadDispatches)
        .where(
          opts.state
            ? and(eq(squadDispatches.squadId, squadId), eq(squadDispatches.state, opts.state))
            : eq(squadDispatches.squadId, squadId),
        )
        .orderBy(asc(squadDispatches.createdAt))
        .limit(opts.limit ?? 50),

    getDispatchById: (id: string) =>
      db
        .select()
        .from(squadDispatches)
        .where(eq(squadDispatches.id, id))
        .then((rows) => rows[0] ?? null),

    ensureDispatchForIssue: (input: Parameters<typeof ensurePendingDispatchForIssue>[1]) =>
      ensurePendingDispatchForIssue(db, input),

    /**
     * 队长决策:一个事务里三件事要么全成、要么全不成 ——
     *   1) 写 issues.assignee_agent_id / assignee_user_id
     *   2) dispatch → dispatched
     *   3) 记 decided_by / decision_reason / decided_at(审计留痕,decisionReason 必填)
     */
    decide: async (
      dispatchId: string,
      data: DecideSquadDispatch & { decidedByAgentId?: string | null },
    ) => {
      return db.transaction(async (tx) => {
        const dispatch = await tx
          .select()
          .from(squadDispatches)
          .where(eq(squadDispatches.id, dispatchId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!dispatch) throw notFound("Dispatch not found");
        if (dispatch.state !== "pending") {
          throw conflict(`Dispatch is already ${dispatch.state}`);
        }
        if (data.assignedAgentId) {
          const agent = await tx
            .select({ id: agents.id, companyId: agents.companyId })
            .from(agents)
            .where(eq(agents.id, data.assignedAgentId))
            .then((rows) => rows[0] ?? null);
          if (!agent || agent.companyId !== dispatch.companyId) {
            throw unprocessable("Assignee agent does not belong to this company");
          }
        }

        const now = new Date();
        await tx
          .update(issues)
          .set({
            assigneeAgentId: data.assignedAgentId ?? null,
            assigneeUserId: data.assignedUserId ?? null,
            updatedAt: now,
          })
          .where(eq(issues.id, dispatch.issueId));

        // 派单链的最后一跳:不提状态,被指派人永远不会被唤醒(见 promoteDecidedIssueOutOfBacklog)。
        await promoteDecidedIssueOutOfBacklog(tx, {
          issueId: dispatch.issueId,
          assigned: Boolean(data.assignedAgentId ?? data.assignedUserId),
          now,
        });

        return await tx
          .update(squadDispatches)
          .set({
            state: "dispatched",
            assignedAgentId: data.assignedAgentId ?? null,
            assignedUserId: data.assignedUserId ?? null,
            decidedByAgentId: data.decidedByAgentId ?? null,
            decisionReason: data.decisionReason,
            decidedAt: now,
            attemptCount: dispatch.attemptCount + 1,
            updatedAt: now,
          })
          .where(eq(squadDispatches.id, dispatchId))
          .returning()
          .then((rows) => rows[0]!);
      });
    },

    /**
     * 改派:不原地改老 dispatch —— 老的置 reassigned,另开一条 pending。
     * 审计链保住:「先派给 A、后来改派给 B、各自的理由」都留得下来。
     */
    reassign: async (
      dispatchId: string,
      data: DecideSquadDispatch & { decidedByAgentId?: string | null },
    ) => {
      return db.transaction(async (tx) => {
        const previous = await tx
          .select()
          .from(squadDispatches)
          .where(eq(squadDispatches.id, dispatchId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!previous) throw notFound("Dispatch not found");
        if (previous.state !== "dispatched") {
          throw conflict(`Only dispatched dispatches can be reassigned (current: ${previous.state})`);
        }
        if (data.assignedAgentId) {
          const agent = await tx
            .select({ id: agents.id, companyId: agents.companyId })
            .from(agents)
            .where(eq(agents.id, data.assignedAgentId))
            .then((rows) => rows[0] ?? null);
          if (!agent || agent.companyId !== previous.companyId) {
            throw unprocessable("Assignee agent does not belong to this company");
          }
        }

        const now = new Date();
        await tx
          .update(squadDispatches)
          .set({ state: "reassigned", updatedAt: now })
          .where(eq(squadDispatches.id, dispatchId));

        await tx
          .update(issues)
          .set({
            assigneeAgentId: data.assignedAgentId ?? null,
            assigneeUserId: data.assignedUserId ?? null,
            updatedAt: now,
          })
          .where(eq(issues.id, previous.issueId));

        // 改派同样是「决策 = 开工」。老 dispatch 若是在这个修复之前 decided 的,issue 可能还躺在 backlog,
        // 改派后依旧唤不醒新的被指派人 —— 同一个静默失效,补在同一个事务里。
        await promoteDecidedIssueOutOfBacklog(tx, {
          issueId: previous.issueId,
          assigned: Boolean(data.assignedAgentId ?? data.assignedUserId),
          now,
        });

        return await tx
          .insert(squadDispatches)
          .values({
            companyId: previous.companyId,
            squadId: previous.squadId,
            issueId: previous.issueId,
            state: "dispatched",
            requestedByType: previous.requestedByType,
            requestedByUserId: previous.requestedByUserId,
            requestedByAgentId: previous.requestedByAgentId,
            sourceMessageId: previous.sourceMessageId,
            assignedAgentId: data.assignedAgentId ?? null,
            assignedUserId: data.assignedUserId ?? null,
            decidedByAgentId: data.decidedByAgentId ?? null,
            decisionReason: data.decisionReason,
            decidedAt: now,
            attemptCount: previous.attemptCount + 1,
          })
          .returning()
          .then((rows) => rows[0]!);
      });
    },

    decline: async (
      dispatchId: string,
      data: DeclineSquadDispatch & { decidedByAgentId?: string | null },
    ) => {
      return db.transaction(async (tx) => {
        const dispatch = await tx
          .select()
          .from(squadDispatches)
          .where(eq(squadDispatches.id, dispatchId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!dispatch) throw notFound("Dispatch not found");
        if (dispatch.state !== "pending") {
          throw conflict(`Dispatch is already ${dispatch.state}`);
        }
        const now = new Date();
        return await tx
          .update(squadDispatches)
          .set({
            state: "declined",
            failureReason: data.failureReason,
            decidedByAgentId: data.decidedByAgentId ?? null,
            decidedAt: now,
            attemptCount: dispatch.attemptCount + 1,
            updatedAt: now,
          })
          .where(eq(squadDispatches.id, dispatchId))
          .returning()
          .then((rows) => rows[0]!);
      });
    },
  };
}
