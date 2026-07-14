// Wire contract for the collaboration layer (JIN-53), calibrated against the
// routes that landed in JIN-61: `server/src/routes/agent-feedback-notes.ts` and
// `server/src/routes/squads.ts`. Both answer with plain table rows
// (`db.select()`, no joins), so what is declared here is exactly what the server
// sends — no display-only enrichment, no embedded relations.

export type FeedbackNoteKind = "correction" | "reminder" | "preference";
export type FeedbackNoteScopeType = "global" | "douyin_account" | "project";
export type FeedbackNoteSourceType =
  | "user_message"
  | "approval_rejection"
  | "review"
  | "self_reflection"
  | "manual";
export type FeedbackNoteStatus = "active" | "archived" | "superseded";

/** A row of `agent_feedback_notes`, as the feedback-note routes return it. */
export interface FeedbackNote {
  id: string;
  companyId: string;
  agentId: string;
  scopeType: FeedbackNoteScopeType;
  douyinAccountId: string | null;
  projectId: string | null;
  kind: FeedbackNoteKind;
  content: string;
  sourceType: FeedbackNoteSourceType;
  sourceMessageId: string | null;
  sourceIssueId: string | null;
  sourceApprovalId: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  status: FeedbackNoteStatus;
  /** Injection priority — notes enter the prompt by `weight desc, createdAt desc`. */
  weight: number;
  timesApplied: number;
  lastAppliedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `createAgentFeedbackNoteSchema`. `sourceType` is required. */
export interface CreateFeedbackNoteInput {
  kind: FeedbackNoteKind;
  content: string;
  sourceType: FeedbackNoteSourceType;
  scopeType?: FeedbackNoteScopeType;
  /** Required when `scopeType` is `douyin_account`, rejected when `global`. */
  douyinAccountId?: string | null;
  /** Required when `scopeType` is `project`, rejected when `global`. */
  projectId?: string | null;
  sourceMessageId?: string | null;
  sourceIssueId?: string | null;
  sourceApprovalId?: string | null;
  weight?: number;
  expiresAt?: string | null;
}

/** A row of `squads`. */
export interface Squad {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  leaderAgentId: string | null;
  douyinAccountId: string | null;
  status: "active" | "archived";
  dispatchPolicy: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A row of `squad_members`. The route joins neither the agent nor the user, so a
 * member arrives as an id plus a role — callers resolve the person against the
 * company roster they already hold.
 */
export interface SquadMember {
  id: string;
  companyId: string;
  squadId: string;
  memberType: "agent" | "user";
  agentId: string | null;
  userId: string | null;
  role: "leader" | "member";
  position: number;
  createdAt: string;
  updatedAt: string;
}
