import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issues } from "@paperclipai/db";
import {
  TODAY_TASK_BUCKETS,
  TODAY_TASK_EXCLUDED_ISSUE_STATUSES,
  TODAY_TASK_OPEN_APPROVAL_STATUSES,
  type TodayTaskBucket,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";

/**
 * 今日任务 (Today's Tasks) — JIN-51.
 *
 * 今日任务 IS the issue system: one issue = one task. This module is a pure
 * READ / MAPPING layer on top of `issues` + `approvals` — no new table, no
 * new column, no migration.
 */

/** Issue statuses that can appear in 今日任务 (everything except backlog / cancelled). */
export const TODAY_TASK_ISSUE_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
] as const;

export type TodayTaskProgress = {
  completed: number;
  total: number;
  /** Pre-rendered "2/5" — the caller decides how to prefix it. */
  label: string;
};

export type TodayTaskOpenApproval = {
  id: string;
  type: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TodayTaskFilters = {
  assigneeAgentId?: string;
  assigneeUserId?: string;
  squadId?: string;
  buckets?: TodayTaskBucket[];
  limit?: number;
  cursor?: string;
};

export const TODAY_TASK_DEFAULT_LIMIT = 50;
export const TODAY_TASK_MAX_LIMIT = 200;

export function clampTodayTaskLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return TODAY_TASK_DEFAULT_LIMIT;
  return Math.min(TODAY_TASK_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * The core of 今日任务: 7 issue statuses + approvals → 4 product buckets.
 *
 * Pure and DB-free on purpose so the bucket semantics are unit-testable.
 *
 * Precedence: an OPEN approval (pending | revision_requested) beats the issue's
 * own status. An `in_progress` issue with a pending approval is 待确认, because
 * the thing blocking the task is a human decision, not the agent's work.
 * (Only a human resolves an approval — there is no `decidedByAgentId`.)
 *
 * Returns `null` for issues that are not part of 今日任务 at all
 * (`backlog`, `cancelled`) — the caller drops them.
 */
export function deriveTaskBucket(input: {
  status: string;
  openApprovalCount: number;
}): TodayTaskBucket | null {
  const { status, openApprovalCount } = input;

  // Not 今日任务 at all — excluded even if an approval is dangling on them.
  if ((TODAY_TASK_EXCLUDED_ISSUE_STATUSES as readonly string[]).includes(status)) return null;

  // 已完成是终态:干完的活不会因为挂着一个没人去点的审批就跳回「待确认」。
  // 审批**先于**完成发生 —— 一个 done 的任务还挂着 pending 审批,说明审批没被清理,
  // 而不是说明这活还要人确认。把它塞回 待确认 会让「今日任务」永远清不空,
  // 用户每天打开都看到一堆早就做完的事在等他点确认 —— 那个列表很快就没人看了。
  if (status === "done") return "done";

  // 除此之外,待确认压过任务自身状态:堵在这儿的是人,不是 AI。
  if (openApprovalCount > 0) return "needs_confirmation";

  switch (status) {
    case "in_progress":
    case "in_review":
      return "in_progress";
    case "done":
      return "done";
    case "todo":
    case "blocked":
      return "todo";
    default:
      // Unknown / future status: not renderable in the 4-bucket UI.
      return null;
  }
}

/**
 * There is no progress column on `issues`. Progress is derived from sub-issues
 * (`issues.parentId`) — a real denominator or none at all.
 *
 * A `cancelled` child is counted as resolved: it will never complete, so leaving
 * it in the denominator would strand the parent at 4/5 forever.
 */
export function deriveTaskProgress(input: {
  completed: number;
  total: number;
}): TodayTaskProgress | null {
  const total = Math.max(0, Math.floor(input.total));
  if (total === 0) return null; // childless issue → no progress. Never invent a denominator.
  const completed = Math.min(total, Math.max(0, Math.floor(input.completed)));
  return { completed, total, label: `${completed}/${total}` };
}

function encodeCursor(row: { updatedAt: Date; id: string }): string {
  return Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = raw.indexOf("|");
  if (separator <= 0) throw badRequest("Invalid today-tasks cursor");
  const updatedAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (Number.isNaN(updatedAt.getTime()) || !id) throw badRequest("Invalid today-tasks cursor");
  return { updatedAt, id };
}

export function todayTasksService(db: Db) {
  function baseConditions(companyId: string, filters: TodayTaskFilters): SQL[] {
    const conditions: SQL[] = [
      eq(issues.companyId, companyId),
      isNull(issues.hiddenAt),
      inArray(issues.status, [...TODAY_TASK_ISSUE_STATUSES]),
    ];
    if (filters.assigneeAgentId) conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
    if (filters.assigneeUserId) conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
    if (filters.squadId) conditions.push(eq(issues.ownerSquadId, filters.squadId));
    return conditions;
  }

  return {
    /**
     * One page of 今日任务, enriched with bucket + progress + open approvals.
     *
     * ⚠️ Bounded query count — 3 SELECTs regardless of page size (1 if the page is empty):
     *   1. the issue page itself (keyset paginated on (updatedAt, id));
     *   2. ONE batched open-approval fetch for the whole page (inArray(issueId, ids) ⋈ approvals);
     *   3. ONE grouped child-count query keyed by parentId (inArray(parentId, ids)).
     * Everything is stitched in memory afterwards. Querying approvals or children
     * per issue inside a loop would be an N+1 and would make a 50-task page cost
     * 101 round trips — do not "simplify" this back into a loop.
     */
    listForCompany: async (companyId: string, filters: TodayTaskFilters = {}) => {
      const limit = clampTodayTaskLimit(filters.limit);
      const conditions = baseConditions(companyId, filters);

      if (filters.cursor) {
        const { updatedAt, id } = decodeCursor(filters.cursor);
        // Keyset pagination: strictly "older" than the cursor in (updatedAt desc, id desc) order.
        conditions.push(
          sql`(${issues.updatedAt}, ${issues.id}) < (${updatedAt}::timestamptz, ${id}::uuid)`,
        );
      }

      // Query 1/3 — the issue page. limit + 1 to detect hasMore without a count query.
      const rows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          ownerSquadId: issues.ownerSquadId,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(...conditions))
        .orderBy(desc(issues.updatedAt), desc(issues.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const ids = page.map((row) => row.id);

      if (ids.length === 0) {
        return { tasks: [], nextCursor: null as string | null, hasMore: false };
      }

      // Query 2/3 — ALL open approvals for the whole page in one shot.
      const approvalRows = await db
        .select({
          issueId: issueApprovals.issueId,
          id: approvals.id,
          type: approvals.type,
          status: approvals.status,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            inArray(issueApprovals.issueId, ids),
            inArray(approvals.status, [...TODAY_TASK_OPEN_APPROVAL_STATUSES]),
          ),
        )
        .orderBy(desc(approvals.createdAt));

      const openApprovalsByIssue = new Map<string, TodayTaskOpenApproval[]>();
      for (const row of approvalRows) {
        const list = openApprovalsByIssue.get(row.issueId) ?? [];
        list.push({
          id: row.id,
          type: row.type,
          status: row.status,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
        openApprovalsByIssue.set(row.issueId, list);
      }

      // Query 3/3 — ONE grouped child count for the whole page, keyed by parentId.
      const childRows = await db
        .select({
          parentId: issues.parentId,
          total: sql<number>`count(*)::int`,
          completed: sql<number>`sum(case when ${issues.status} in ('done', 'cancelled') then 1 else 0 end)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            isNull(issues.hiddenAt),
            inArray(issues.parentId, ids),
          ),
        )
        .groupBy(issues.parentId);

      const childCountsByParent = new Map<string, { total: number; completed: number }>();
      for (const row of childRows) {
        if (!row.parentId) continue;
        childCountsByParent.set(row.parentId, {
          total: Number(row.total ?? 0),
          completed: Number(row.completed ?? 0),
        });
      }

      // Stitch in memory. No further queries.
      const bucketFilter = filters.buckets && filters.buckets.length > 0
        ? new Set<TodayTaskBucket>(filters.buckets)
        : null;

      const tasks = page
        .map((issue) => {
          const openApprovals = openApprovalsByIssue.get(issue.id) ?? [];
          const bucket = deriveTaskBucket({
            status: issue.status,
            openApprovalCount: openApprovals.length,
          });
          if (!bucket) return null;
          const children = childCountsByParent.get(issue.id);
          const progress = children
            ? deriveTaskProgress({ completed: children.completed, total: children.total })
            : null;
          return { issue, bucket, progress, openApprovals };
        })
        .filter((task): task is NonNullable<typeof task> => task !== null)
        // Bucket filtering happens after enrichment because 待确认 is not an issue
        // status — it only exists once approvals are joined in. A filtered page can
        // therefore be shorter than `limit`; pagination stays correct because the
        // cursor is taken from the last SCANNED row, not the last returned task.
        .filter((task) => (bucketFilter ? bucketFilter.has(task.bucket) : true));

      const lastScanned = page[page.length - 1];
      return {
        tasks,
        hasMore,
        nextCursor: hasMore && lastScanned ? encodeCursor(lastScanned) : null,
      };
    },

    /**
     * Bucket counts for the tab badges. ONE grouped query — not 4.
     *
     * The open-approval test is an EXISTS subquery so it stays a single grouped
     * scan; a plain join to issue_approvals would fan rows out and inflate counts.
     */
    getSummary: async (companyId: string, filters: TodayTaskFilters = {}) => {
      const conditions = baseConditions(companyId, filters);
      const hasOpenApproval = sql<boolean>`exists (
        select 1
        from ${issueApprovals} ia
        join ${approvals} a on a.id = ia.approval_id
        where ia.issue_id = ${issues.id}
          and a.status in ('pending', 'revision_requested')
      )`;

      const rows = await db
        .select({
          status: issues.status,
          hasOpenApproval,
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(and(...conditions))
        .groupBy(issues.status, hasOpenApproval);

      const counts: Record<TodayTaskBucket, number> = {
        in_progress: 0,
        done: 0,
        needs_confirmation: 0,
        todo: 0,
      };
      let total = 0;
      for (const row of rows) {
        const bucket = deriveTaskBucket({
          status: row.status,
          openApprovalCount: row.hasOpenApproval ? 1 : 0,
        });
        if (!bucket) continue;
        const count = Number(row.count ?? 0);
        counts[bucket] += count;
        total += count;
      }

      return {
        total,
        buckets: TODAY_TASK_BUCKETS.map((bucket) => ({ bucket, count: counts[bucket] })),
        counts,
      };
    },
  };
}
