import { describe, expect, it } from "vitest";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  formatAssigneeUserLabel,
  formatUserLabel,
  parseAssigneeValue,
  parseAssignmentValue,
  squadAssignmentValue,
  suggestedCommentAssigneeValue,
} from "./assignees";

describe("assignee selection helpers", () => {
  it("encodes and parses agent assignees", () => {
    const value = assigneeValueFromSelection({ assigneeAgentId: "agent-123" });

    expect(value).toBe("agent:agent-123");
    expect(parseAssigneeValue(value)).toEqual({
      assigneeAgentId: "agent-123",
      assigneeUserId: null,
    });
  });

  it("encodes and parses current-user assignees", () => {
    const [option] = currentUserAssigneeOption("local-board");

    expect(option).toEqual({
      id: "user:local-board",
      label: "Me",
      searchText: "me board human local-board",
    });
    expect(parseAssigneeValue(option.id)).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
    });
  });

  it("treats an empty selection as no assignee", () => {
    expect(parseAssigneeValue("")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("keeps backward compatibility for raw agent ids in saved drafts", () => {
    expect(parseAssigneeValue("legacy-agent-id")).toEqual({
      assigneeAgentId: "legacy-agent-id",
      assigneeUserId: null,
    });
  });

  it("reads a squad value as nobody, so it cannot leak into a people-only picker", () => {
    expect(parseAssigneeValue("squad:squad-1")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });
});

describe("assignment selection helpers (agent / user / squad)", () => {
  it("encodes and parses a squad assignment", () => {
    const value = squadAssignmentValue("squad-1");

    expect(value).toBe("squad:squad-1");
    expect(parseAssignmentValue(value)).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
      ownerSquadId: "squad-1",
    });
  });

  it("leaves the assignee empty when a squad takes the task — the leader picks who works it", () => {
    const selection = parseAssignmentValue(squadAssignmentValue("squad-1"));

    expect(selection.assigneeAgentId).toBeNull();
    expect(selection.assigneeUserId).toBeNull();
  });

  it("clears the squad when a person takes the task", () => {
    expect(parseAssignmentValue("agent:agent-1")).toEqual({
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      ownerSquadId: null,
    });
    expect(parseAssignmentValue("user:user-1")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "user-1",
      ownerSquadId: null,
    });
  });

  it("treats an empty assignment as unassigned and unowned", () => {
    expect(parseAssignmentValue("")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
      ownerSquadId: null,
    });
  });

  it("formats current and board user labels consistently", () => {
    expect(formatAssigneeUserLabel("user-1", "user-1")).toBe("You");
    expect(formatAssigneeUserLabel("local-board", "someone-else")).toBe("Board");
    expect(formatAssigneeUserLabel("user-abcdef", "someone-else")).toBe("user-");
  });

  it("formats actual user labels without current-user substitution", () => {
    expect(formatUserLabel("user-1", new Map([["user-1", "Dotta"]]))).toBe("Dotta");
    expect(formatUserLabel("user-1", new Map([["user-2", "Someone Else"]]))).toBe("user-");
    expect(formatUserLabel("local-board")).toBe("Board");
  });

  it("suggests the last non-me commenter without changing the actual assignee encoding", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [
          { authorUserId: "board-user" },
          { authorAgentId: "agent-123" },
        ],
        "board-user",
      ),
    ).toBe("agent:agent-123");
  });

  it("falls back to the actual assignee when there is no better commenter hint", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [{ authorUserId: "board-user" }],
        "board-user",
      ),
    ).toBe("user:board-user");
  });

  it("skips the current agent when choosing a suggested commenter assignee", () => {
    expect(
      suggestedCommentAssigneeValue(
        { assigneeUserId: "board-user" },
        [
          { authorUserId: "board-user" },
          { authorAgentId: "agent-self" },
          { authorAgentId: "agent-123" },
        ],
        null,
        "agent-self",
      ),
    ).toBe("agent:agent-123");
  });
});
