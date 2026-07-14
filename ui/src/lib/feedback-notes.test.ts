import { describe, expect, it } from "vitest";
import type { FeedbackNote } from "@/api/collab-types";
import {
  feedbackNoteEffect,
  feedbackNoteSavedToast,
  feedbackScopeLabel,
  feedbackSourceLabel,
  groupFeedbackNotes,
} from "./feedback-notes";

function note(overrides: Partial<FeedbackNote> & Pick<FeedbackNote, "id" | "kind">): FeedbackNote {
  return {
    companyId: "c1",
    agentId: "a1",
    content: "内容",
    scopeType: "global",
    douyinAccountId: null,
    projectId: null,
    sourceType: "manual",
    sourceMessageId: null,
    sourceIssueId: null,
    sourceApprovalId: null,
    createdByUserId: null,
    createdByAgentId: null,
    status: "active",
    weight: 100,
    timesApplied: 0,
    lastAppliedAt: null,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    injection: "injected",
    injectLimit: 10,
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
  it("names the scope when the caller supplies the names", () => {
    expect(
      feedbackScopeLabel(
        note({ id: "1", kind: "reminder", scopeType: "project", projectId: "p1" }),
        new Map([["p1", "小镜说法"]]),
      ),
    ).toBe("项目 · 小镜说法");
  });

  it("falls back to the scope type plus a short id — the server only sends ids", () => {
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

  it("translates the source type", () => {
    expect(
      feedbackSourceLabel(note({ id: "1", kind: "correction", sourceType: "approval_rejection" })),
    ).toBe("审批被拒");
  });
});

// JIN-80:主页列 100 条、prompt 只吃前 10 条。一条「看得见但不会生效」的笔记如果
// 长得和生效的一模一样,用户就以为自己教会了员工 —— 实际什么都没发生。
describe("feedbackNoteEffect", () => {
  it("只有真的会进 prompt 的笔记才算生效", () => {
    expect(feedbackNoteEffect(note({ id: "1", kind: "correction" }))).toEqual({
      effective: true,
      label: null,
      hint: null,
    });
  });

  it("超出注入 limit 的笔记明确标出「未生效」,并说清超出的是前几条", () => {
    const effect = feedbackNoteEffect(note({ id: "1", kind: "correction", injection: "over_limit" }));

    expect(effect.effective).toBe(false);
    expect(effect.label).toBe("未生效 · 超出前 10 条");
    expect(effect.hint).toContain("调高权重");
  });

  it("注入被关掉时,不能谎称是「超出前 0 条」", () => {
    const effect = feedbackNoteEffect(
      note({ id: "1", kind: "correction", injection: "over_limit", injectLimit: 0 }),
    );

    expect(effect.effective).toBe(false);
    expect(effect.label).toBe("未生效 · 注入已关闭");
  });

  it("过期笔记标成「已过期 · 不再生效」—— 它会永远挂在主页上,但早就不注入了", () => {
    const effect = feedbackNoteEffect(
      note({ id: "1", kind: "reminder", injection: "expired", expiresAt: "2026-01-02T00:00:00Z" }),
    );

    expect(effect.effective).toBe(false);
    expect(effect.label).toBe("已过期 · 不再生效");
  });
});

describe("feedbackNoteSavedToast", () => {
  it("只有会进 prompt 的笔记才敢承诺「下次会照做」", () => {
    expect(feedbackNoteSavedToast(note({ id: "1", kind: "correction" }), "小镜")).toEqual({
      title: "已记下,小镜 下次会照做",
      tone: "success",
    });
  });

  it("不会生效的笔记,toast 不许再承诺「下次会照做」", () => {
    const toast = feedbackNoteSavedToast(
      note({ id: "1", kind: "correction", injection: "over_limit" }),
      "小镜",
    );

    expect(toast.title).not.toContain("下次会照做");
    expect(toast.title).toContain("暂时不会照做");
    expect(toast.body).toContain("前 10 条");
    expect(toast.tone).toBe("warn");
  });
});
