// Wire contract for the collaboration layer (JIN-53). Kept in its own module so
// the demo store in `lib/collab-mock` can share it with `api/collab` without a
// runtime import cycle.

export type FeedbackNoteKind = "correction" | "reminder" | "preference";
export type FeedbackNoteScopeType = "global" | "douyin_account" | "project";
export type FeedbackNoteSourceType =
  | "user_message"
  | "approval_rejection"
  | "review"
  | "self_reflection"
  | "manual";
export type FeedbackNoteStatus = "active" | "archived" | "superseded";

export interface FeedbackNote {
  id: string;
  agentId: string;
  kind: FeedbackNoteKind;
  content: string;
  scopeType: FeedbackNoteScopeType;
  douyinAccountId: string | null;
  projectId: string | null;
  sourceType: FeedbackNoteSourceType;
  sourceMessageId: string | null;
  sourceIssueId: string | null;
  status: FeedbackNoteStatus;
  weight: number;
  timesApplied: number;
  lastAppliedAt: string | null;
  createdAt: string;
  /** Display-only enrichment the server sends alongside the ids, when known. */
  scopeLabel?: string | null;
  sourceLabel?: string | null;
}

export interface CreateFeedbackNoteInput {
  kind: FeedbackNoteKind;
  content: string;
  scopeType?: FeedbackNoteScopeType;
  douyinAccountId?: string | null;
  projectId?: string | null;
  weight?: number;
}

export interface SquadMemberAgentRef {
  id: string;
  name: string;
  urlKey: string;
  title: string | null;
  icon: string | null;
  status: string;
}

export interface SquadMemberUserRef {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface SquadMember {
  id: string;
  squadId: string;
  memberType: "agent" | "user";
  role: "leader" | "member";
  position: number;
  agentId: string | null;
  userId: string | null;
  agent: SquadMemberAgentRef | null;
  user: SquadMemberUserRef | null;
}

export interface Squad {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  leaderAgentId: string | null;
  douyinAccountId: string | null;
  status: "active" | "archived";
}
