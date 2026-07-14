import type { Agent } from "@paperclipai/shared";
import type { CompanyMember } from "@/api/access";
import type { SquadDispatch, SquadDispatchState, SquadMember } from "@/api/collab-types";

export const DISPATCH_STATE_LABELS: Record<SquadDispatchState, string> = {
  pending: "等队长决策",
  dispatched: "已派出",
  reassigned: "已改派",
  declined: "队长退回",
  failed: "派单失败",
};

/**
 * A name for an agent or a human, from the ids the collab rows carry. The server
 * sends bare ids — `squad_members` and `squad_dispatches` are raw rows with no
 * joins — so every display name in the squad UI is resolved here.
 */
export class PrincipalNames {
  private readonly agents = new Map<string, string>();
  private readonly users = new Map<string, string>();

  constructor({
    agents = [],
    members = [],
  }: {
    agents?: readonly Agent[];
    members?: readonly CompanyMember[];
  }) {
    for (const agent of agents) this.agents.set(agent.id, agent.name);
    for (const member of members) {
      const id = member.user?.id ?? member.principalId;
      const name = member.user?.name?.trim() || member.user?.email?.trim();
      if (id && name) this.users.set(id, name);
    }
  }

  /** Falls back to a short id — an unknown teammate is still a teammate, not a blank. */
  agent(id: string | null | undefined): string {
    if (!id) return "未指派";
    return this.agents.get(id) ?? `AI 员工 · ${id.slice(0, 8)}`;
  }

  user(id: string | null | undefined): string {
    if (!id) return "未指派";
    return this.users.get(id) ?? `成员 · ${id.slice(0, 8)}`;
  }

  member(member: Pick<SquadMember, "memberType" | "agentId" | "userId">): string {
    return member.memberType === "agent" ? this.agent(member.agentId) : this.user(member.userId);
  }

  /** Who the task ended up with. */
  assignee(dispatch: Pick<SquadDispatch, "assignedAgentId" | "assignedUserId">): string | null {
    if (dispatch.assignedAgentId) return this.agent(dispatch.assignedAgentId);
    if (dispatch.assignedUserId) return this.user(dispatch.assignedUserId);
    return null;
  }
}

/**
 * The decision, as one sentence a user reads — not a field dump.
 * 「队长为什么派给文案编导而不是选题策划师」is the product; it does not belong
 * behind a details toggle.
 */
export function describeDecision(dispatch: SquadDispatch, names: PrincipalNames): string | null {
  const assignee = names.assignee(dispatch);
  const leader = dispatch.decidedByAgentId ? names.agent(dispatch.decidedByAgentId) : "队长";

  if (dispatch.state === "declined") {
    return dispatch.failureReason
      ? `${leader}退回了这条任务 —— ${dispatch.failureReason}`
      : `${leader}退回了这条任务。`;
  }
  if (!assignee) return null;

  const verb = dispatch.state === "reassigned" ? "改派给" : "派给";
  return dispatch.decisionReason
    ? `${leader}把这条任务${verb}${assignee} —— ${dispatch.decisionReason}`
    : `${leader}把这条任务${verb}${assignee}。`;
}

export interface DispatchThread {
  issueId: string;
  /** Oldest first: a reassignment appends a new dispatch instead of overwriting the old one. */
  dispatches: SquadDispatch[];
  /** The dispatch that currently speaks for this issue. */
  latest: SquadDispatch;
}

const time = (value: string) => new Date(value).getTime();

/**
 * One thread per issue, so a reassignment reads as a chain rather than as two
 * unrelated rows. Threads sort by most recent activity; the chain inside each
 * thread stays chronological.
 */
export function buildDispatchThreads(dispatches: readonly SquadDispatch[]): DispatchThread[] {
  const byIssue = new Map<string, SquadDispatch[]>();
  for (const dispatch of dispatches) {
    const thread = byIssue.get(dispatch.issueId);
    if (thread) thread.push(dispatch);
    else byIssue.set(dispatch.issueId, [dispatch]);
  }

  return [...byIssue.entries()]
    .map(([issueId, list]) => {
      const ordered = [...list].sort((a, b) => time(a.createdAt) - time(b.createdAt));
      return { issueId, dispatches: ordered, latest: ordered[ordered.length - 1]! };
    })
    .sort((a, b) => time(b.latest.createdAt) - time(a.latest.createdAt));
}

/** 队长的待办队列:等着被决策的那些。 */
export function pendingDispatches(dispatches: readonly SquadDispatch[]): SquadDispatch[] {
  return dispatches
    .filter((dispatch) => dispatch.state === "pending")
    .sort((a, b) => time(a.createdAt) - time(b.createdAt));
}
