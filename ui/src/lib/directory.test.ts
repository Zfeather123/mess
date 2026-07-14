import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { CompanyMember } from "@/api/access";
import type { SquadMember } from "@/api/collab-types";
import { buildDirectoryEntries, filterDirectoryEntries } from "./directory";

function agent(overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    companyId: "c1",
    urlKey: overrides.name.toLowerCase(),
    role: "worker",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Agent;
}

function member(
  id: string,
  name: string,
  overrides: Partial<CompanyMember> = {},
): CompanyMember {
  return {
    id: `m-${id}`,
    companyId: "c1",
    principalType: "user",
    principalId: id,
    status: "active",
    membershipRole: "operator",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    user: { id, email: `${id}@example.com`, name, image: null },
    grants: [],
    ...overrides,
  } as CompanyMember;
}

/** The route sends bare `squad_members` rows — an id and a role, no joined person. */
function squadMember(
  overrides: Partial<SquadMember> & Pick<SquadMember, "id" | "memberType" | "role">,
): SquadMember {
  return {
    companyId: "c1",
    squadId: "s1",
    agentId: null,
    userId: null,
    position: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildDirectoryEntries", () => {
  it("returns humans and agents in one union", () => {
    const entries = buildDirectoryEntries({
      agents: [agent({ id: "a1", name: "Bella" })],
      members: [member("u1", "Ada")],
    });

    expect(entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ["user", "Ada"],
      ["agent", "Bella"],
    ]);
  });

  it("links agents to their homepage and humans to their profile", () => {
    const entries = buildDirectoryEntries({
      agents: [agent({ id: "a1", name: "Bella", urlKey: "bella" })],
      members: [member("u1", "Ada")],
    });

    expect(entries.find((entry) => entry.kind === "agent")?.href).toBe("/directory/bella");
    expect(entries.find((entry) => entry.kind === "user")?.href).toBe("/u/u1");
  });

  it("hides terminated agents and archived members", () => {
    const entries = buildDirectoryEntries({
      agents: [agent({ id: "a1", name: "Gone", status: "terminated" })],
      members: [member("u1", "Left", { status: "archived" })],
    });

    expect(entries).toEqual([]);
  });

  it("narrows to the squad roster and floats the leader when a squad is selected", () => {
    const squadMembers: SquadMember[] = [
      squadMember({ id: "sm1", memberType: "agent", role: "member", position: 1, agentId: "a1" }),
      squadMember({ id: "sm2", memberType: "user", role: "leader", position: 0, userId: "u1" }),
    ];

    const entries = buildDirectoryEntries({
      agents: [agent({ id: "a1", name: "Bella" }), agent({ id: "a2", name: "Outsider" })],
      members: [member("u1", "Zoe")],
      squadMembers,
    });

    expect(entries.map((entry) => entry.name)).toEqual(["Zoe", "Bella"]);
    expect(entries[0]?.squadRole).toBe("leader");
  });

  // An empty roster is an empty squad, not "no squad" — widening back to the whole
  // company would show colleagues who are not on the squad the user asked for.
  it("shows nobody for a squad with no members", () => {
    const entries = buildDirectoryEntries({
      agents: [agent({ id: "a1", name: "Bella" })],
      members: [member("u1", "Ada")],
      squadMembers: [],
    });

    expect(entries).toEqual([]);
  });
});

describe("filterDirectoryEntries", () => {
  const entries = buildDirectoryEntries({
    agents: [agent({ id: "a1", name: "Bella", title: "选题策划" })],
    members: [member("u1", "Ada")],
  });

  it("filters by kind", () => {
    expect(filterDirectoryEntries(entries, { kind: "agent" }).map((e) => e.name)).toEqual(["Bella"]);
    expect(filterDirectoryEntries(entries, { kind: "user" }).map((e) => e.name)).toEqual(["Ada"]);
  });

  it("matches name, title and email case-insensitively", () => {
    expect(filterDirectoryEntries(entries, { query: "bel" }).map((e) => e.name)).toEqual(["Bella"]);
    expect(filterDirectoryEntries(entries, { query: "选题" }).map((e) => e.name)).toEqual(["Bella"]);
    expect(filterDirectoryEntries(entries, { query: "u1@example" }).map((e) => e.name)).toEqual([
      "Ada",
    ]);
  });
});
