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
  memberType: SquadMemberType;
  agentId: string | null;
  userId: string | null;
  role: SquadMemberRole;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export type SquadMemberType = "agent" | "user";
export type SquadMemberRole = "leader" | "member";

/** Mirrors `createSquadSchema`. */
export interface CreateSquadInput {
  name: string;
  description?: string | null;
  projectId?: string | null;
  leaderAgentId?: string | null;
  douyinAccountId?: string | null;
  dispatchPolicy?: Record<string, unknown>;
}

export type UpdateSquadInput = Partial<CreateSquadInput> & { status?: Squad["status"] };

/**
 * Mirrors `addSquadMemberSchema`: membership is an XOR — an agent member carries
 * `agentId`, a human carries `userId`. Only an agent can lead, because
 * `squads.leader_agent_id` is a uuid FK and cannot hold a human's bare-text id.
 */
export interface AddSquadMemberInput {
  memberType: SquadMemberType;
  agentId?: string | null;
  userId?: string | null;
  role?: SquadMemberRole;
  position?: number;
}

export type SquadDispatchState = "pending" | "dispatched" | "reassigned" | "declined" | "failed";

/**
 * A row of `squad_dispatches` — one link in the routing chain: a task landed on
 * the squad, the leader decided who takes it, and `decisionReason` says why.
 * Re-deciding a dispatched item does not overwrite the row: the server marks it
 * `reassigned` and appends a new one, so the earlier decision stays on the chain.
 */
export interface SquadDispatch {
  id: string;
  companyId: string;
  squadId: string;
  issueId: string;
  state: SquadDispatchState;
  requestedByType: "user" | "agent" | "system";
  requestedByUserId: string | null;
  requestedByAgentId: string | null;
  sourceMessageId: string | null;
  assignedAgentId: string | null;
  assignedUserId: string | null;
  decidedByAgentId: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  failureReason: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListDispatchesQuery {
  state?: SquadDispatchState;
  limit?: number;
}

/**
 * Mirrors `decideSquadDispatchSchema`: exactly one assignee, and `decisionReason`
 * is required — 「为什么派给 TA」is what the product shows, not debug output.
 */
export interface DecideDispatchInput {
  assignedAgentId?: string | null;
  assignedUserId?: string | null;
  decisionReason: string;
}

export interface DeclineDispatchInput {
  failureReason: string;
}
