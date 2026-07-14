import type {
  FeedbackNote,
  FeedbackNoteKind,
  FeedbackNoteScopeType,
  FeedbackNoteSourceType,
} from "@/api/collab-types";

export const FEEDBACK_KIND_LABELS: Record<FeedbackNoteKind, string> = {
  correction: "最近被纠正",
  reminder: "下次注意",
  preference: "个人偏好",
};

export const FEEDBACK_SOURCE_LABELS: Record<FeedbackNoteSourceType, string> = {
  user_message: "用户消息",
  approval_rejection: "审批被拒",
  review: "复盘",
  self_reflection: "自我复盘",
  manual: "人工添加",
};

const SCOPE_LABELS: Record<FeedbackNoteScopeType, string> = {
  global: "全局",
  douyin_account: "抖音账号",
  project: "项目",
};

/** What the note was learned from — the server may pre-render a richer label. */
export function feedbackSourceLabel(note: FeedbackNote): string {
  return note.sourceLabel?.trim() || FEEDBACK_SOURCE_LABELS[note.sourceType];
}

/** Where the note applies. Falls back to the scope type when no name is known. */
export function feedbackScopeLabel(note: FeedbackNote): string {
  const label = note.scopeLabel?.trim();
  if (label) return label;
  if (note.scopeType === "global") return SCOPE_LABELS.global;
  const id = note.scopeType === "douyin_account" ? note.douyinAccountId : note.projectId;
  const suffix = id ? ` · ${id.slice(0, 8)}` : "";
  return `${SCOPE_LABELS[note.scopeType]}${suffix}`;
}

/** Notes carry the same priority the prompt injector uses: weight, then recency. */
export function sortFeedbackNotes(notes: readonly FeedbackNote[]): FeedbackNote[] {
  return [...notes].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export interface GroupedFeedbackNotes {
  corrections: FeedbackNote[];
  reminders: FeedbackNote[];
  preferences: FeedbackNote[];
}

/**
 * 「最近被纠正」and「下次注意」are two different promises to the user and are
 * rendered as separate sections — never merged into one list.
 */
export function groupFeedbackNotes(notes: readonly FeedbackNote[]): GroupedFeedbackNotes {
  const sorted = sortFeedbackNotes(notes);
  return {
    corrections: sorted.filter((note) => note.kind === "correction"),
    reminders: sorted.filter((note) => note.kind === "reminder"),
    preferences: sorted.filter((note) => note.kind === "preference"),
  };
}
