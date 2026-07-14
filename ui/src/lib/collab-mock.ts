import type {
  CreateFeedbackNoteInput,
  FeedbackNote,
  FeedbackNoteStatus,
  Squad,
  SquadMember,
} from "@/api/collab-types";

// Demo store standing in for the not-yet-mounted collab routes (JIN-53).
// Delete this whole module — and the `withMockFallback` wrapper in
// `api/collab` — the day the server ships `/agents/:id/feedback-notes`.
//
// Only feedback notes are seeded: they are the flagship surface and an empty
// page would show nothing at all. Squads seed to empty on purpose, so the
// directory falls back to the real company roster instead of inventing people.

const notesByAgent = new Map<string, FeedbackNote[]>();

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mock-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function seedNotes(agentId: string): FeedbackNote[] {
  const base = {
    agentId,
    douyinAccountId: null,
    projectId: null,
    sourceMessageId: null,
    sourceIssueId: null,
    status: "active" as const,
  };

  return [
    {
      ...base,
      id: newId(),
      kind: "correction",
      content: "标题不要写成「震惊体」。上一条《月薪三千也能……》被退回,改回克制、把结论前置。",
      scopeType: "douyin_account",
      douyinAccountId: "demo-account-law",
      sourceType: "approval_rejection",
      sourceLabel: "审批被拒 · 内容初审",
      scopeLabel: "小镜说法(抖音)",
      weight: 140,
      timesApplied: 6,
      lastAppliedAt: daysAgo(1),
      createdAt: daysAgo(3),
    },
    {
      ...base,
      id: newId(),
      kind: "correction",
      content: "法条一律标注生效版本与条款号,别只写「根据民法典」。",
      scopeType: "global",
      sourceType: "review",
      sourceLabel: "复盘 · JIN-41",
      scopeLabel: "全局",
      weight: 120,
      timesApplied: 11,
      lastAppliedAt: daysAgo(2),
      createdAt: daysAgo(9),
    },
    {
      ...base,
      id: newId(),
      kind: "reminder",
      content: "发布前把口播稿念一遍,超过 90 秒就砍,平均完播率掉在第 80 秒。",
      scopeType: "douyin_account",
      douyinAccountId: "demo-account-law",
      sourceType: "user_message",
      sourceLabel: "群消息 · 主理人",
      scopeLabel: "小镜说法(抖音)",
      weight: 110,
      timesApplied: 3,
      lastAppliedAt: daysAgo(1),
      createdAt: daysAgo(4),
    },
    {
      ...base,
      id: newId(),
      kind: "reminder",
      content: "涉及个案的选题先确认当事人已脱敏,人名、单位、金额都要改。",
      scopeType: "global",
      sourceType: "self_reflection",
      sourceLabel: "自我复盘",
      scopeLabel: "全局",
      weight: 100,
      timesApplied: 0,
      lastAppliedAt: null,
      createdAt: daysAgo(12),
    },
  ];
}

function notesFor(agentId: string): FeedbackNote[] {
  let notes = notesByAgent.get(agentId);
  if (!notes) {
    notes = seedNotes(agentId);
    notesByAgent.set(agentId, notes);
  }
  return notes;
}

export function mockListFeedbackNotes(
  agentId: string,
  status: FeedbackNoteStatus,
): FeedbackNote[] {
  return notesFor(agentId).filter((note) => note.status === status);
}

export function mockCreateFeedbackNote(
  agentId: string,
  input: CreateFeedbackNoteInput,
): FeedbackNote {
  const note: FeedbackNote = {
    id: newId(),
    agentId,
    kind: input.kind,
    content: input.content,
    scopeType: input.scopeType ?? "global",
    douyinAccountId: input.douyinAccountId ?? null,
    projectId: input.projectId ?? null,
    sourceType: "manual",
    sourceMessageId: null,
    sourceIssueId: null,
    status: "active",
    weight: input.weight ?? 100,
    timesApplied: 0,
    lastAppliedAt: null,
    createdAt: new Date().toISOString(),
    sourceLabel: "人工添加",
    scopeLabel: input.scopeType === "global" || !input.scopeType ? "全局" : null,
  };
  notesFor(agentId).unshift(note);
  return note;
}

export function mockArchiveFeedbackNote(noteId: string): FeedbackNote {
  for (const notes of notesByAgent.values()) {
    const note = notes.find((candidate) => candidate.id === noteId);
    if (note) {
      note.status = "archived";
      return note;
    }
  }
  throw new Error(`Unknown feedback note: ${noteId}`);
}

export function mockListSquads(): Squad[] {
  return [];
}

export function mockListSquadMembers(): SquadMember[] {
  return [];
}
