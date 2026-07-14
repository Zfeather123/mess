import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  deriveTaskBucket,
  deriveTaskProgress,
  todayTasksService,
} from "./today-tasks.js";

type Row = Record<string, unknown>;

/**
 * No real DB (same approach as issue-thread-interactions.test.ts): a chainable
 * fake that hands back a queued result set per `db.select()` call, and counts
 * how many selects the service issued — that count is the N+1 guard.
 */
function createFakeDb(resultSets: Row[][]) {
  let selectCalls = 0;

  const select = vi.fn(() => {
    const index = selectCalls;
    selectCalls += 1;
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "where", "groupBy", "orderBy", "limit", "offset"]) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: (rows: Row[]) => unknown, reject?: (err: unknown) => unknown) =>
      Promise.resolve(resultSets[index] ?? []).then(resolve, reject);
    return chain;
  });

  const db = { select } as unknown as Db;
  return { db, getSelectCalls: () => selectCalls };
}

function issueRow(overrides: Partial<Row> & { id: string; status: string }): Row {
  return {
    companyId: "company-1",
    projectId: null,
    parentId: null,
    identifier: "JIN-1",
    title: "补充关键信息",
    description: null,
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    ownerSquadId: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date("2026-07-14T00:00:00.000Z"),
    updatedAt: new Date("2026-07-14T01:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveTaskBucket", () => {
  it("maps in_progress and in_review (no open approval) to 进行中", () => {
    expect(deriveTaskBucket({ status: "in_progress", openApprovalCount: 0 })).toBe("in_progress");
    expect(deriveTaskBucket({ status: "in_review", openApprovalCount: 0 })).toBe("in_progress");
  });

  it("maps done to 已完成", () => {
    expect(deriveTaskBucket({ status: "done", openApprovalCount: 0 })).toBe("done");
  });

  it("maps todo and blocked to 待处理", () => {
    expect(deriveTaskBucket({ status: "todo", openApprovalCount: 0 })).toBe("todo");
    expect(deriveTaskBucket({ status: "blocked", openApprovalCount: 0 })).toBe("todo");
  });

  it("an OPEN approval beats the issue's own status → 待确认", () => {
    // The precedence rule: the human is what blocks the task.
    expect(deriveTaskBucket({ status: "in_progress", openApprovalCount: 1 })).toBe("needs_confirmation");
    expect(deriveTaskBucket({ status: "in_review", openApprovalCount: 1 })).toBe("needs_confirmation");
    expect(deriveTaskBucket({ status: "todo", openApprovalCount: 2 })).toBe("needs_confirmation");
    expect(deriveTaskBucket({ status: "blocked", openApprovalCount: 1 })).toBe("needs_confirmation");
  });

  it("keeps 已完成 terminal: a done issue with a dangling approval stays done, not 待确认", () => {
    // 否则「今日任务」永远清不空 —— 早就做完的活会因为一个没人清理的 pending 审批
    // 天天回到待确认列表里等用户点,那个列表很快就没人看了。
    expect(deriveTaskBucket({ status: "done", openApprovalCount: 1 })).toBe("done");
  });

  it("excludes backlog and cancelled from 今日任务 entirely, even with an open approval", () => {
    expect(deriveTaskBucket({ status: "backlog", openApprovalCount: 0 })).toBeNull();
    expect(deriveTaskBucket({ status: "cancelled", openApprovalCount: 0 })).toBeNull();
    expect(deriveTaskBucket({ status: "backlog", openApprovalCount: 1 })).toBeNull();
    expect(deriveTaskBucket({ status: "cancelled", openApprovalCount: 3 })).toBeNull();
  });
});

describe("deriveTaskProgress", () => {
  it("derives 2/5 from children", () => {
    expect(deriveTaskProgress({ completed: 2, total: 5 })).toEqual({
      completed: 2,
      total: 5,
      label: "2/5",
    });
  });

  it("returns null for a childless issue instead of faking a percentage", () => {
    expect(deriveTaskProgress({ completed: 0, total: 0 })).toBeNull();
  });
});

describe("todayTasksService.listForCompany", () => {
  it("puts an in_progress issue with a pending approval in 待确认, and one with an approved approval in 进行中", async () => {
    const { db } = createFakeDb([
      // 1: issue page
      [
        issueRow({ id: "issue-open", status: "in_progress" }),
        issueRow({ id: "issue-clean", status: "in_progress" }),
      ],
      // 2: open approvals (the query only returns pending / revision_requested rows;
      //    an `approved` approval on issue-clean is filtered out in SQL, so it is absent here)
      [
        {
          issueId: "issue-open",
          id: "approval-1",
          type: "approve_copy",
          status: "pending",
          createdAt: new Date("2026-07-14T00:30:00.000Z"),
          updatedAt: new Date("2026-07-14T00:30:00.000Z"),
        },
      ],
      // 3: child counts — none
      [],
    ]);

    const result = await todayTasksService(db).listForCompany("company-1");

    expect(result.tasks.map((task) => [task.issue.id, task.bucket])).toEqual([
      ["issue-open", "needs_confirmation"],
      ["issue-clean", "in_progress"],
    ]);
    expect(result.tasks[0]?.openApprovals).toHaveLength(1);
    expect(result.tasks[1]?.openApprovals).toEqual([]);
  });

  it("counts revision_requested as an open approval too", async () => {
    const { db } = createFakeDb([
      [issueRow({ id: "issue-1", status: "in_review" })],
      [
        {
          issueId: "issue-1",
          id: "approval-1",
          type: "approve_copy",
          status: "revision_requested",
          createdAt: new Date("2026-07-14T00:30:00.000Z"),
          updatedAt: new Date("2026-07-14T00:30:00.000Z"),
        },
      ],
      [],
    ]);

    const result = await todayTasksService(db).listForCompany("company-1");
    expect(result.tasks[0]?.bucket).toBe("needs_confirmation");
  });

  it("derives progress 2/5 from sub-issues and null when childless", async () => {
    const { db } = createFakeDb([
      [
        issueRow({ id: "parent-1", status: "in_progress" }),
        issueRow({ id: "leaf-1", status: "todo" }),
      ],
      [],
      // grouped child counts: 5 children, 2 of them done/cancelled
      [{ parentId: "parent-1", total: 5, completed: 2 }],
    ]);

    const result = await todayTasksService(db).listForCompany("company-1");

    expect(result.tasks[0]?.progress).toEqual({ completed: 2, total: 5, label: "2/5" });
    expect(result.tasks[1]?.progress).toBeNull();
  });

  it("drops cancelled and backlog issues from the page", async () => {
    const { db } = createFakeDb([
      [
        issueRow({ id: "issue-cancelled", status: "cancelled" }),
        issueRow({ id: "issue-backlog", status: "backlog" }),
        issueRow({ id: "issue-todo", status: "todo" }),
      ],
      [],
      [],
    ]);

    const result = await todayTasksService(db).listForCompany("company-1");
    expect(result.tasks.map((task) => task.issue.id)).toEqual(["issue-todo"]);
  });

  it("filters by bucket after enrichment", async () => {
    const { db } = createFakeDb([
      [
        issueRow({ id: "issue-open", status: "in_progress" }),
        issueRow({ id: "issue-clean", status: "in_progress" }),
      ],
      [
        {
          issueId: "issue-open",
          id: "approval-1",
          type: "approve_copy",
          status: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      [],
    ]);

    const result = await todayTasksService(db).listForCompany("company-1", {
      buckets: ["needs_confirmation"],
    });
    expect(result.tasks.map((task) => task.issue.id)).toEqual(["issue-open"]);
  });

  it("issues a BOUNDED number of queries — 3, not O(N) (no N+1)", async () => {
    const issueCount = 25;
    const page = Array.from({ length: issueCount }, (_, index) =>
      issueRow({ id: `issue-${index}`, status: "in_progress" }),
    );
    const { db, getSelectCalls } = createFakeDb([
      page,
      page.map((row, index) => ({
        issueId: row.id,
        id: `approval-${index}`,
        type: "approve_copy",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      page.map((row) => ({ parentId: row.id, total: 3, completed: 1 })),
    ]);

    const result = await todayTasksService(db).listForCompany("company-1", { limit: 50 });

    expect(result.tasks).toHaveLength(issueCount);
    // 1 issue page + 1 batched approvals + 1 grouped child count. Never 1 + N.
    expect(getSelectCalls()).toBe(3);
  });

  it("skips the batch queries entirely when the page is empty", async () => {
    const { db, getSelectCalls } = createFakeDb([[]]);
    const result = await todayTasksService(db).listForCompany("company-1");
    expect(result).toEqual({ tasks: [], nextCursor: null, hasMore: false });
    expect(getSelectCalls()).toBe(1);
  });

  it("returns a cursor when more rows exist", async () => {
    const page = Array.from({ length: 3 }, (_, index) =>
      issueRow({ id: `issue-${index}`, status: "todo" }),
    );
    const { db } = createFakeDb([page, [], []]);

    const result = await todayTasksService(db).listForCompany("company-1", { limit: 2 });

    expect(result.hasMore).toBe(true);
    expect(result.tasks).toHaveLength(2);
    expect(result.nextCursor).toBeTypeOf("string");
  });
});

describe("todayTasksService.getSummary", () => {
  it("counts every bucket from a SINGLE grouped query", async () => {
    const { db, getSelectCalls } = createFakeDb([
      [
        { status: "in_progress", hasOpenApproval: false, count: 4 },
        { status: "in_progress", hasOpenApproval: true, count: 2 }, // approval wins → 待确认
        { status: "in_review", hasOpenApproval: false, count: 1 },
        { status: "done", hasOpenApproval: false, count: 3 },
        { status: "todo", hasOpenApproval: false, count: 5 },
        { status: "blocked", hasOpenApproval: false, count: 1 },
      ],
    ]);

    const summary = await todayTasksService(db).getSummary("company-1");

    expect(summary.counts).toEqual({
      in_progress: 5, // 4 in_progress + 1 in_review
      needs_confirmation: 2,
      done: 3,
      todo: 6, // 5 todo + 1 blocked
    });
    expect(summary.total).toBe(16);
    expect(getSelectCalls()).toBe(1);
  });
});
