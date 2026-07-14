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

/** What the note was learned from. */
export function feedbackSourceLabel(note: FeedbackNote): string {
  return FEEDBACK_SOURCE_LABELS[note.sourceType];
}

/**
 * Where the note applies. The server sends scope ids, never names — hand over the
 * names the page already holds and a project-scoped note reads as「项目 · 小镜说法」
 * rather than a uuid fragment.
 */
export function feedbackScopeLabel(
  note: FeedbackNote,
  scopeNames?: ReadonlyMap<string, string>,
): string {
  if (note.scopeType === "global") return SCOPE_LABELS.global;
  const id = note.scopeType === "douyin_account" ? note.douyinAccountId : note.projectId;
  const name = id ? scopeNames?.get(id) : undefined;
  const suffix = name ? ` · ${name}` : id ? ` · ${id.slice(0, 8)}` : "";
  return `${SCOPE_LABELS[note.scopeType]}${suffix}`;
}

/**
 * What the user is actually being promised by a note on screen.
 *
 * A note that is listed but never injected (expired, or ranked past the inject limit) looks
 * exactly like a live one — the user thinks they taught the agent something and they didn't.
 * Every non-`injected` note gets a label saying so, plus what to do about it.
 */
export interface FeedbackNoteEffect {
  /** True only when the next run really will carry this note into the prompt. */
  effective: boolean;
  /** Short badge text — `null` when the note is live and needs no caveat. */
  label: string | null;
  /** Why it does not apply, and how to make it apply. */
  hint: string | null;
}

export function feedbackNoteEffect(note: FeedbackNote): FeedbackNoteEffect {
  const injectLimit = note.injectLimit;
  switch (note.injection) {
    case "injected":
      return { effective: true, label: null, hint: null };
    case "expired":
      return {
        effective: false,
        label: "已过期 · 不再生效",
        hint: "过期的笔记不会进入提示词。需要它继续生效,就重新写一条。",
      };
    case "over_limit":
      return injectLimit === 0
        ? {
            effective: false,
            label: "未生效 · 注入已关闭",
            hint: "当前配置关闭了笔记注入(inject limit = 0),任何笔记都不会进入提示词。",
          }
        : {
            effective: false,
            label: `未生效 · 超出前 ${injectLimit} 条`,
            hint: `每次派单只注入权重最高的前 ${injectLimit} 条。想让它生效:调高权重,或归档几条旧笔记。`,
          };
    case "inactive":
    default:
      return {
        effective: false,
        label: "已归档 · 不再生效",
        hint: "归档的笔记不会进入提示词。",
      };
  }
}

/**
 * The toast after「记下」. Only a note that really reaches the prompt may promise
 * 「下次会照做」—— anything else says plainly that it is not in effect yet.
 */
export function feedbackNoteSavedToast(
  note: FeedbackNote,
  agentName: string,
): { title: string; body?: string; tone: "success" | "warn" } {
  const effect = feedbackNoteEffect(note);
  if (effect.effective) {
    return { title: `已记下,${agentName} 下次会照做`, tone: "success" };
  }
  return {
    title: `已记下,但${agentName}暂时不会照做`,
    body: effect.hint ?? undefined,
    tone: "warn",
  };
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
