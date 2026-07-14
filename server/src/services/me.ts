import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  agents,
  coachBindings,
  computeAccounts,
  computeTransactions,
  conversationMembers,
  conversations,
  documents,
  issues,
  moments,
  userNotificationPrefs,
  type Db,
} from "@paperclipai/db";
import type { CoachBinding, NotificationPrefs, WeeklyOverview } from "@xiaojing/protocol";
import type { BindCoach, UpdateNotificationPrefs } from "@paperclipai/shared/validators/me";
import { notFound } from "../errors.js";

/**
 * 「我的」服务(JIN-56):绑定操盘手 / 通知设置 / 本周概览 / 数据导出。
 *
 * 操盘手是**真人**(供给方:造 agent 卖给用户 + 提供真人点评),不是 AI 员工。
 * 所以私聊会话是 user ↔ user 的 direct 会话 —— imService.createConversation 的
 * direct 分支硬性要求「必须且只能有 1 个 AI 员工」,这里绑的是人,进不去那条路径,
 * 于是直接落 conversations / conversation_members 两张表(同一份 schema,同一套语义:
 * kind='direct',两个 user 成员,lastSeq 从 0 起)。
 */

/** 本周起始日(周一 00:00 UTC)。ISO-8601 的周从周一起,产品文案也是「本周」。 */
export function startOfWeek(now: Date = new Date()): Date {
  const day = now.getUTCDay(); // 0 = 周日
  const daysSinceMonday = (day + 6) % 7;
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday),
  );
  return monday;
}

/** 没设置过 = 全开。新用户不该因为「没点过设置」就静默收不到合规风险提醒。 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  dailyTasks: true,
  agentSummary: true,
  complianceRisk: true,
};

function toCoachBinding(row: typeof coachBindings.$inferSelect | null): CoachBinding {
  if (!row) return { coach: null, boundAt: null };
  return {
    coach: {
      userId: row.coachUserId,
      name: row.coachName,
      avatarUrl: row.coachAvatarUrl,
      title: row.coachTitle,
      bio: row.coachBio,
      conversationId: row.conversationId,
    },
    boundAt: row.boundAt.toISOString(),
  };
}

export function meService(db: Db) {
  function activeBindingRow(companyId: string, userId: string) {
    return db
      .select()
      .from(coachBindings)
      .where(
        and(
          eq(coachBindings.companyId, companyId),
          eq(coachBindings.userId, userId),
          eq(coachBindings.status, "active"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  return {
    // -----------------------------------------------------------------------
    // 绑定操盘手
    // -----------------------------------------------------------------------

    async getCoach(companyId: string, userId: string): Promise<CoachBinding> {
      return toCoachBinding(await activeBindingRow(companyId, userId));
    },

    /**
     * 绑定 / 更换操盘手。
     *
     * 更换 = 旧行置 ended + 插新行(历史留痕,换过谁查得到)。
     * 「当前操盘手只有一个」由部分唯一索引 `coach_bindings_active_uq` 保证 ——
     * 不是靠应用层记得先 end 再 insert,那在并发下会插出两行 active。
     */
    async bindCoach(companyId: string, userId: string, input: BindCoach): Promise<CoachBinding> {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(coachBindings)
          .where(
            and(
              eq(coachBindings.companyId, companyId),
              eq(coachBindings.userId, userId),
              eq(coachBindings.status, "active"),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);

        // 绑的还是同一个人:只刷新展示信息,别把会话 id 洗掉
        if (existing && existing.coachUserId === input.coachUserId) {
          const [refreshed] = await tx
            .update(coachBindings)
            .set({
              coachName: input.name,
              coachTitle: input.title ?? null,
              coachAvatarUrl: input.avatarUrl ?? null,
              coachBio: input.bio ?? null,
              updatedAt: new Date(),
            })
            .where(eq(coachBindings.id, existing.id))
            .returning();
          return refreshed!;
        }

        if (existing) {
          await tx
            .update(coachBindings)
            .set({ status: "ended", updatedAt: new Date() })
            .where(eq(coachBindings.id, existing.id));
        }

        const [created] = await tx
          .insert(coachBindings)
          .values({
            companyId,
            userId,
            coachUserId: input.coachUserId,
            coachName: input.name,
            coachTitle: input.title ?? null,
            coachAvatarUrl: input.avatarUrl ?? null,
            coachBio: input.bio ?? null,
            status: "active",
          })
          .returning();
        if (!created) throw new Error("coach_bindings insert returned no row");
        return created;
      });

      return toCoachBinding(row);
    },

    /**
     * 打开与操盘手的私聊 —— 没有会话就现建,并把 conversation_id 回填到绑定行。
     * 幂等:再点一次「私聊」返回同一个会话,不会每点一次多建一个空会话。
     */
    async openCoachDm(companyId: string, userId: string): Promise<{ conversationId: string }> {
      const binding = await activeBindingRow(companyId, userId);
      if (!binding) throw notFound("还没有绑定操盘手");
      if (binding.conversationId) return { conversationId: binding.conversationId };

      const conversationId = await db.transaction(async (tx) => {
        // 行锁 + 复查:两个标签页同时点「私聊」时只建一个
        const locked = await tx
          .select()
          .from(coachBindings)
          .where(eq(coachBindings.id, binding.id))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (locked?.conversationId) return locked.conversationId;

        const [conversation] = await tx
          .insert(conversations)
          .values({
            companyId,
            kind: "direct",
            title: binding.coachName,
            createdByType: "user",
            createdByUserId: userId,
          })
          .returning();
        if (!conversation) throw new Error("conversations insert returned no row");

        await tx.insert(conversationMembers).values([
          {
            companyId,
            conversationId: conversation.id,
            memberType: "user",
            userId,
            role: "owner",
          },
          {
            companyId,
            conversationId: conversation.id,
            memberType: "user",
            userId: binding.coachUserId,
            role: "member",
          },
        ]);

        await tx
          .update(coachBindings)
          .set({ conversationId: conversation.id, updatedAt: new Date() })
          .where(eq(coachBindings.id, binding.id));

        return conversation.id;
      });

      return { conversationId };
    },

    // -----------------------------------------------------------------------
    // 通知设置
    // -----------------------------------------------------------------------

    /** 没有行 = 默认全开。读的时候**不写库** —— 「看一眼设置页」不该产生一行数据。 */
    async getNotificationPrefs(companyId: string, userId: string): Promise<NotificationPrefs> {
      const [row] = await db
        .select()
        .from(userNotificationPrefs)
        .where(
          and(eq(userNotificationPrefs.companyId, companyId), eq(userNotificationPrefs.userId, userId)),
        )
        .limit(1);
      if (!row) return { ...DEFAULT_NOTIFICATION_PREFS };
      return {
        dailyTasks: row.notifyDailyTasks,
        agentSummary: row.notifyAgentSummary,
        complianceRisk: row.notifyComplianceRisk,
      };
    },

    async updateNotificationPrefs(
      companyId: string,
      userId: string,
      input: UpdateNotificationPrefs,
    ): Promise<NotificationPrefs> {
      const merged: NotificationPrefs = {
        ...(await this.getNotificationPrefs(companyId, userId)),
        ...(input.dailyTasks === undefined ? {} : { dailyTasks: input.dailyTasks }),
        ...(input.agentSummary === undefined ? {} : { agentSummary: input.agentSummary }),
        ...(input.complianceRisk === undefined ? {} : { complianceRisk: input.complianceRisk }),
      };

      await db
        .insert(userNotificationPrefs)
        .values({
          companyId,
          userId,
          notifyDailyTasks: merged.dailyTasks,
          notifyAgentSummary: merged.agentSummary,
          notifyComplianceRisk: merged.complianceRisk,
        })
        .onConflictDoUpdate({
          target: [userNotificationPrefs.companyId, userNotificationPrefs.userId],
          set: {
            notifyDailyTasks: merged.dailyTasks,
            notifyAgentSummary: merged.agentSummary,
            notifyComplianceRisk: merged.complianceRisk,
            updatedAt: new Date(),
          },
        });

      return merged;
    },

    // -----------------------------------------------------------------------
    // 本周概览
    // -----------------------------------------------------------------------

    /**
     * 本周概览:完成任务 / 生成文案 / 用掉的点数 + 每位员工的小结。
     * 四个聚合并发发出去(互不依赖),不要串成四个 await 的瀑布。
     */
    async getWeeklyOverview(companyId: string, now: Date = new Date()): Promise<WeeklyOverview> {
      const weekStart = startOfWeek(now);

      const account = await db
        .select({ id: computeAccounts.id })
        .from(computeAccounts)
        .where(and(eq(computeAccounts.companyId, companyId), eq(computeAccounts.ownerType, "company")))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      const debitThisWeek = and(
        eq(computeTransactions.companyId, companyId),
        eq(computeTransactions.direction, "debit"),
        gte(computeTransactions.createdAt, weekStart),
      );

      const [completed, drafts, used, perAgentPoints, perAgentTasks] = await Promise.all([
        db
          .select({ value: count() })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.status, "done"),
              gte(issues.completedAt, weekStart),
            ),
          )
          .then((rows) => Number(rows[0]?.value ?? 0)),
        db
          .select({ value: count() })
          .from(documents)
          .where(and(eq(documents.companyId, companyId), gte(documents.createdAt, weekStart)))
          .then((rows) => Number(rows[0]?.value ?? 0)),
        account
          ? db
              .select({ points: sql<string | null>`sum(${computeTransactions.points})` })
              .from(computeTransactions)
              .where(debitThisWeek)
              .then((rows) => Number(rows[0]?.points ?? 0))
          : Promise.resolve(0),
        db
          .select({
            agentId: computeTransactions.agentId,
            agentName: agents.name,
            points: sql<string | null>`sum(${computeTransactions.points})`,
          })
          .from(computeTransactions)
          .innerJoin(agents, eq(agents.id, computeTransactions.agentId))
          .where(debitThisWeek)
          .groupBy(computeTransactions.agentId, agents.name),
        db
          .select({ agentId: issues.assigneeAgentId, tasks: count() })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.status, "done"),
              gte(issues.completedAt, weekStart),
            ),
          )
          .groupBy(issues.assigneeAgentId),
      ]);

      const tasksByAgent = new Map(
        perAgentTasks
          .filter((row) => row.agentId)
          .map((row) => [row.agentId as string, Number(row.tasks)]),
      );

      const perAgent: WeeklyOverview["perAgent"] = perAgentPoints
        .filter((row): row is typeof row & { agentId: string } => Boolean(row.agentId))
        .map((row) => ({
          agentId: row.agentId,
          agentName: row.agentName ?? "AI 员工",
          points: Number(row.points ?? 0),
          tasks: tasksByAgent.get(row.agentId) ?? 0,
        }));

      // 干了活但没烧点数的员工(比如任务是人工确认的)也要出现在小结里
      const missingAgentIds = [...tasksByAgent.keys()].filter(
        (agentId) => !perAgent.some((entry) => entry.agentId === agentId),
      );
      if (missingAgentIds.length > 0) {
        const rows = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, missingAgentIds));
        for (const row of rows) {
          perAgent.push({
            agentId: row.id,
            agentName: row.name,
            points: 0,
            tasks: tasksByAgent.get(row.id) ?? 0,
          });
        }
      }

      perAgent.sort((a, b) => b.points - a.points || b.tasks - a.tasks);

      return {
        weekStart: weekStart.toISOString().slice(0, 10),
        tasksCompleted: completed,
        draftsProduced: drafts,
        pointsUsed: used,
        perAgent,
      };
    },

    // -----------------------------------------------------------------------
    // 数据导出
    // -----------------------------------------------------------------------

    /**
     * 数据导出:**只导调用者自己的数据**。
     * 朋友圈只取本人发的(author_user_id = 自己),不是全公司的信息流;
     * 通知设置 / 操盘手绑定同理。算力流水是公司账户级的 —— 调用者本来就能在
     * 「我的 → 算力」看到同一份,导出不新增可见面。
     */
    async exportData(
      companyId: string,
      userId: string,
      profile: { userId: string; name?: string | null; email?: string | null },
    ) {
      const [prefs, coach, myMoments, account] = await Promise.all([
        this.getNotificationPrefs(companyId, userId),
        this.getCoach(companyId, userId),
        db
          .select({
            id: moments.id,
            content: moments.content,
            category: moments.category,
            tags: moments.tags,
            likeCount: moments.likeCount,
            commentCount: moments.commentCount,
            createdAt: moments.createdAt,
          })
          .from(moments)
          .where(
            and(
              eq(moments.companyId, companyId),
              eq(moments.authorUserId, userId),
              isNull(moments.deletedAt),
            ),
          )
          .orderBy(desc(moments.createdAt))
          .limit(1000),
        db
          .select({ id: computeAccounts.id })
          .from(computeAccounts)
          .where(
            and(eq(computeAccounts.companyId, companyId), eq(computeAccounts.ownerType, "company")),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ]);

      const transactions = account
        ? await db
            .select({
              id: computeTransactions.id,
              direction: computeTransactions.direction,
              points: computeTransactions.points,
              balanceAfter: computeTransactions.balanceAfter,
              reason: computeTransactions.reason,
              memo: computeTransactions.memo,
              createdAt: computeTransactions.createdAt,
            })
            .from(computeTransactions)
            .where(eq(computeTransactions.accountId, account.id))
            .orderBy(desc(computeTransactions.createdAt))
            .limit(5000)
        : [];

      return {
        exportedAt: new Date().toISOString(),
        companyId,
        profile: {
          userId: profile.userId,
          name: profile.name ?? null,
          email: profile.email ?? null,
        },
        notifications: prefs,
        coach: coach.coach,
        moments: myMoments.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
        computeTransactions: transactions.map((row) => ({
          id: row.id,
          direction: row.direction,
          points: Number(row.points),
          balanceAfter: Number(row.balanceAfter),
          reason: row.reason,
          memo: row.memo,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  };
}
