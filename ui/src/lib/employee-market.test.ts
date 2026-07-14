import { describe, expect, it } from "vitest";
import type { EmployeeCard } from "@paperclipai/shared";
import { buildMarketTabs, cardKey, filterMarketCards } from "./employee-market";

function card(overrides: Partial<EmployeeCard> & Pick<EmployeeCard, "refId">): EmployeeCard {
  return {
    source: "preset",
    name: "文案编导",
    role: "content",
    title: null,
    avatarUrl: null,
    description: null,
    category: "content",
    methodTags: [],
    contentHash: "sha256:abc",
    version: null,
    hired: false,
    hiredAgentIds: [],
    outOfDate: false,
    visibility: "company",
    updatedAt: null,
    ...overrides,
  };
}

describe("cardKey", () => {
  it("keys on source + refId — refId is only unique within a source", () => {
    expect(cardKey(card({ refId: "x", source: "preset" }))).not.toBe(
      cardKey(card({ refId: "x", source: "custom" })),
    );
  });
});

describe("buildMarketTabs", () => {
  it("counts each bucket and drops categories nobody is in", () => {
    const tabs = buildMarketTabs([
      card({ refId: "a", category: "content" }),
      card({ refId: "b", category: "content", hired: true }),
      card({ refId: "c", category: "operations" }),
    ]);

    expect(tabs.map((tab) => [tab.value, tab.count])).toEqual([
      ["all", 3],
      ["content", 2],
      ["operations", 1],
      ["hired", 1],
    ]);
  });

  it("keeps 全部 and 已招募 even when empty — they are where the user navigates back to", () => {
    expect(buildMarketTabs([]).map((tab) => tab.value)).toEqual(["all", "hired"]);
  });
});

describe("filterMarketCards", () => {
  it("treats 已招募 as a cross-cutting filter, not a category", () => {
    const cards = [
      card({ refId: "a", category: "content", hired: true }),
      card({ refId: "b", category: "compliance", hired: true }),
      card({ refId: "c", category: "content" }),
    ];

    expect(filterMarketCards(cards, { tab: "hired" }).map((c) => c.refId)).toEqual(["a", "b"]);
  });

  it("surfaces uncategorised cards instead of hiding them", () => {
    const cards = [card({ refId: "a", category: null }), card({ refId: "b", category: "content" })];

    expect(filterMarketCards(cards, { tab: "uncategorized" }).map((c) => c.refId)).toEqual(["a"]);
  });

  it("searches name, title and method packs", () => {
    const cards = [
      card({ refId: "a", name: "选题策划师" }),
      card({
        refId: "b",
        name: "文案编导",
        methodTags: [{ key: "xhs-note", name: "小红书笔记", kind: "platform" }],
      }),
    ];

    expect(filterMarketCards(cards, { query: "小红书" }).map((c) => c.refId)).toEqual(["b"]);
    expect(filterMarketCards(cards, { query: "选题" }).map((c) => c.refId)).toEqual(["a"]);
  });
});
