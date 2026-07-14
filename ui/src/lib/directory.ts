import type { Agent } from "@paperclipai/shared";
import type { CompanyMember } from "@/api/access";
import type { SquadMember } from "@/api/collab-types";

/** One row in the 通讯录 — an AI teammate or a human one, deliberately alike. */
export interface DirectoryEntry {
  key: string;
  kind: "agent" | "user";
  id: string;
  name: string;
  title: string | null;
  /** Agent lifecycle status, or the human's membership status. */
  status: string;
  icon: string | null;
  imageUrl: string | null;
  email: string | null;
  /** Where the row navigates: an agent homepage, or the human's profile. */
  href: string;
  squadRole: "leader" | "member" | null;
}

export type DirectoryKindFilter = "all" | "agent" | "user";

function humanName(member: CompanyMember): string {
  return member.user?.name?.trim() || member.user?.email?.trim() || "未命名成员";
}

function agentEntry(agent: Agent): DirectoryEntry {
  return {
    key: `agent:${agent.id}`,
    kind: "agent",
    id: agent.id,
    name: agent.name,
    title: agent.title,
    status: agent.status,
    icon: agent.icon,
    imageUrl: null,
    email: null,
    href: `/directory/${encodeURIComponent(agent.urlKey || agent.id)}`,
    squadRole: null,
  };
}

function userEntry(member: CompanyMember): DirectoryEntry {
  const userId = member.user?.id ?? member.principalId;
  return {
    key: `user:${userId}`,
    kind: "user",
    id: userId,
    name: humanName(member),
    title: member.membershipRole,
    status: member.status,
    icon: null,
    imageUrl: member.user?.image ?? null,
    email: member.user?.email ?? null,
    href: `/u/${encodeURIComponent(userId)}`,
    squadRole: null,
  };
}

/** Terminated agents and archived humans are history, not colleagues. */
function isVisible(entry: DirectoryEntry): boolean {
  if (entry.kind === "agent") return entry.status !== "terminated";
  return entry.status !== "archived";
}

export interface BuildDirectoryInput {
  agents: readonly Agent[];
  members: readonly CompanyMember[];
  /**
   * When a squad is selected, only its roster shows — and squad leaders get
   * their badge. Omit (or pass null) for the whole-company directory. An empty
   * roster means an empty squad, NOT "no filter": falling back to the whole
   * company there would quietly answer a question nobody asked.
   */
  squadMembers?: readonly SquadMember[] | null;
}

/**
 * The union of human and AI teammates, in one list. Leaders first, then agents
 * before humans is deliberately NOT done — everyone sorts together by name, so
 * the directory reads as one team rather than "people, and also some bots".
 */
export function buildDirectoryEntries({
  agents,
  members,
  squadMembers,
}: BuildDirectoryInput): DirectoryEntry[] {
  const entries = [...agents.map(agentEntry), ...members.map(userEntry)].filter(isVisible);

  if (squadMembers) {
    // A squad member is an id and a role — the person behind it comes from the
    // company roster already loaded above.
    const roleByKey = new Map<string, "leader" | "member">();
    for (const member of squadMembers) {
      const key =
        member.memberType === "agent" ? `agent:${member.agentId}` : `user:${member.userId}`;
      roleByKey.set(key, member.role);
    }
    return entries
      .filter((entry) => roleByKey.has(entry.key))
      .map((entry) => ({ ...entry, squadRole: roleByKey.get(entry.key) ?? null }))
      .sort(compareEntries);
  }

  return entries.sort(compareEntries);
}

function compareEntries(a: DirectoryEntry, b: DirectoryEntry): number {
  if (a.squadRole === "leader" && b.squadRole !== "leader") return -1;
  if (b.squadRole === "leader" && a.squadRole !== "leader") return 1;
  return a.name.localeCompare(b.name, "zh-Hans-CN");
}

export interface DirectoryFilter {
  query?: string;
  kind?: DirectoryKindFilter;
}

export function filterDirectoryEntries(
  entries: readonly DirectoryEntry[],
  { query = "", kind = "all" }: DirectoryFilter = {},
): DirectoryEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (kind !== "all" && entry.kind !== kind) return false;
    if (!needle) return true;
    return [entry.name, entry.title, entry.email]
      .filter((field): field is string => Boolean(field))
      .some((field) => field.toLowerCase().includes(needle));
  });
}
