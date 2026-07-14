import { describe, expect, it } from "vitest";
import type { FeedbackNote } from "@/api/collab-types";
import { feedbackScopeLabel, feedbackSourceLabel, groupFeedbackNotes } from "./feedback-notes";

function note(overrides: Partial<FeedbackNote> & Pick<FeedbackNote, "id" | "kind">): FeedbackNote {
  return {
    agentId: "a1",
    content: "内容",
    scopeType: "global",
    douyinAccountId: null,
    projectId: null,
    sourceType: "manual",
    sourceMessageId: null,
    sourceIssueId: null,
    status: "active",
    weight: 100,
    timesApplied: 0,
    lastAppliedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("groupFeedbackNotes", () => {
  it("keeps corrections and reminders in separate buckets", () => {
    const grouped = groupFeedbackNotes([
      note({ id: "1", kind: "correction" }),
      note({ id: "2", kind: "reminder" }),
      note({ id: "3", kind: "preference" }),
    ]);

    expect(grouped.corrections.map((n) => n.id)).toEqual(["1"]);
    expect(grouped.reminders.map((n) => n.id)).toEqual(["2"]);
    expect(grouped.preferences.map((n) => n.id)).toEqual(["3"]);
  });

  it("orders by weight, then recency — the same order the prompt injector uses", () => {
    const grouped = groupFeedbackNotes([
      note({ id: "old-heavy", kind: "correction", weight: 140, createdAt: "2026-01-01T00:00:00Z" }),
      note({ id: "new-light", kind: "correction", weight: 100, createdAt: "2026-06-01T00:00:00Z" }),
      note({ id: "new-heavy", kind: "correction", weight: 140, createdAt: "2026-06-02T00:00:00Z" }),
    ]);

    expect(grouped.corrections.map((n) => n.id)).toEqual(["new-heavy", "old-heavy", "new-light"]);
  });
});

describe("labels", () => {
  it("prefers the server-rendered scope label", () => {
    expect(
      feedbackScopeLabel(
        note({ id: "1", kind: "reminder", scopeType: "douyin_account", scopeLabel: "小镜说法" }),
      ),
    ).toBe("小镜说法");
  });

  it("falls back to the scope type plus a short id", () => {
    expect(
      feedbackScopeLabel(
        note({
          id: "1",
          kind: "reminder",
          scopeType: "douyin_account",
          douyinAccountId: "abcdef12-3456",
        }),
      ),
    ).toBe("抖音账号 · abcdef12");
    expect(feedbackScopeLabel(note({ id: "2", kind: "reminder" }))).toBe("全局");
  });

  it("translates the source type when the server sends no label", () => {
    expect(
      feedbackSourceLabel(note({ id: "1", kind: "correction", sourceType: "approval_rejection" })),
    ).toBe("审批被拒");
  });
});
