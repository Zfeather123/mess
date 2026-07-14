import type { EmployeeCard, EmployeeMarketCategory } from "@paperclipai/shared";

/**
 * 市场的分类导航。「已招募」不是一个真分类 —— 它横切所有分类,是按 `hired` 过滤
 * 出来的一格(API_JIN67.md 也是这么说的)。`uncategorized` 收留 category 为空的卡,
 * 免得一位没归类的员工在市场里彻底消失。
 */
export type MarketTab = "all" | EmployeeMarketCategory | "uncategorized" | "hired";

export const MARKET_CATEGORY_LABELS: Record<EmployeeMarketCategory, string> = {
  content: "内容生产",
  operations: "账号经营",
  compliance: "合规审稿",
};

const TAB_ORDER: MarketTab[] = [
  "all",
  "content",
  "operations",
  "compliance",
  "uncategorized",
  "hired",
];

const TAB_LABELS: Record<MarketTab, string> = {
  all: "全部",
  ...MARKET_CATEGORY_LABELS,
  uncategorized: "未归类",
  hired: "已招募",
};

/** A card's identity: the server sends no id, and `refId` is only unique within a source. */
export function cardKey(card: EmployeeCard): string {
  return `${card.source}:${card.refId}`;
}

function matchesTab(card: EmployeeCard, tab: MarketTab): boolean {
  if (tab === "all") return true;
  if (tab === "hired") return card.hired;
  if (tab === "uncategorized") return card.category === null;
  return card.category === tab;
}

export interface MarketTabItem {
  value: MarketTab;
  label: string;
  count: number;
}

/**
 * Tabs with live counts. A category nobody is in gets dropped — an empty
 * 「合规审稿」tab is a dead end, not a category. 「全部」and「已招募」always stay:
 * they are the two the user navigates back to.
 */
export function buildMarketTabs(cards: readonly EmployeeCard[]): MarketTabItem[] {
  return TAB_ORDER.map((value) => ({
    value,
    label: TAB_LABELS[value],
    count: cards.filter((card) => matchesTab(card, value)).length,
  })).filter((tab) => tab.count > 0 || tab.value === "all" || tab.value === "hired");
}

export interface MarketFilter {
  tab?: MarketTab;
  query?: string;
}

/** 逛市场:先按分类,再按名字 / 职责 / 方法包搜。 */
export function filterMarketCards(
  cards: readonly EmployeeCard[],
  { tab = "all", query = "" }: MarketFilter = {},
): EmployeeCard[] {
  const needle = query.trim().toLowerCase();
  return cards.filter((card) => {
    if (!matchesTab(card, tab)) return false;
    if (!needle) return true;
    const haystack = [
      card.name,
      card.role,
      card.title,
      card.description,
      ...card.methodTags.map((tag) => tag.name),
    ];
    return haystack
      .filter((field): field is string => Boolean(field))
      .some((field) => field.toLowerCase().includes(needle));
  });
}
