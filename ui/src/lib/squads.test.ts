import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { SquadDispatch } from "@/api/collab-types";
import { buildDispatchThreads, describeDecision, pendingDispatches, PrincipalNames } from "./squads";

function dispatch(
  overrides: Partial<SquadDispatch> & Pick<SquadDispatch, "id" | "issueId">,
): SquadDispatch {
  return {
    companyId: "c1",
    squadId: "s1",
    state: "pending",
    requestedByType: "system",
    requestedByUserId: null,
    requestedByAgentId: null,
    sourceMessageId: null,
    assignedAgentId: null,
    assignedUserId: null,
    decidedByAgentId: null,
    decisionReason: null,
    decidedAt: null,
    failureReason: null,
    attemptCount: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

const agent = (id: string, name: string) => ({ id, name }) as Agent;

const names = new PrincipalNames({
  agents: [agent("leader", "小镜"), agent("writer", "文案编导")],
  members: [],
});

describe("describeDecision", () => {
  it("reads as one sentence a user understands, with the reason in it", () => {
    const sentence = describeDecision(
      dispatch({
        id: "d1",
        issueId: "i1",
        state: "dispatched",
        assignedAgentId: "writer",
        decidedByAgentId: "leader",
        decisionReason: "这条是改写口播稿,选题策划师手上压着两条选题",
      }),
      names,
    );

    expect(sentence).toBe(
      "小镜把这条任务派给文案编导 —— 这条是改写口播稿,选题策划师手上压着两条选题",
    );
  });

  it("says who declined it and why", () => {
    const sentence = describeDecision(
      dispatch({
        id: "d1",
        issueId: "i1",
        state: "declined",
        decidedByAgentId: "leader",
        failureReason: "队里没人会剪辑",
      }),
      names,
    );

    expect(sentence).toBe("小镜退回了这条任务 —— 队里没人会剪辑");
  });
});

describe("buildDispatchThreads", () => {
  it("chains a reassignment onto the original instead of replacing it", () => {
    const threads = buildDispatchThreads([
      dispatch({
        id: "d2",
        issueId: "i1",
        state: "dispatched",
        createdAt: "2026-07-02T00:00:00Z",
        assignedAgentId: "writer",
      }),
      dispatch({
        id: "d1",
        issueId: "i1",
        state: "reassigned",
        createdAt: "2026-07-01T00:00:00Z",
      }),
    ]);

    expect(threads).toHaveLength(1);
    // Chronological inside the chain: the superseded decision stays readable.
    expect(threads[0]!.dispatches.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(threads[0]!.latest.id).toBe("d2");
  });

  it("sorts threads by most recent activity", () => {
    const threads = buildDispatchThreads([
      dispatch({ id: "old", issueId: "i1", createdAt: "2026-07-01T00:00:00Z" }),
      dispatch({ id: "new", issueId: "i2", createdAt: "2026-07-05T00:00:00Z" }),
    ]);

    expect(threads.map((thread) => thread.issueId)).toEqual(["i2", "i1"]);
  });
});

describe("pendingDispatches", () => {
  it("is the leader's queue: only pending, oldest first", () => {
    const queue = pendingDispatches([
      dispatch({ id: "b", issueId: "i2", createdAt: "2026-07-02T00:00:00Z" }),
      dispatch({ id: "done", issueId: "i3", state: "dispatched" }),
      dispatch({ id: "a", issueId: "i1", createdAt: "2026-07-01T00:00:00Z" }),
    ]);

    expect(queue.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
