import { describe, expect, it } from "vitest";
import { buildAgentParams, buildWakeText, resolveSessionKey } from "./execute.js";

describe("buildWakeText", () => {
  const payload = {
    runId: "run-123",
    agentId: "agent-1",
    companyId: "company-1",
    taskId: "issue-9",
    issueId: "issue-9",
    wakeReason: "assigned",
    wakeCommentId: null,
    approvalId: null,
    approvalStatus: null,
    issueIds: [],
  };
  const env = { PAPERCLIP_RUN_ID: "run-123", PAPERCLIP_AGENT_ID: "agent-1" };

  // JIN-80:这个 adapter 不拼 prompt,但**照样得把 task context 发出去**。
  // 它当初只把 ctx.context 喂给 onMeta 遥测,跑在网关上的员工一条反馈笔记都收不到,
  // 而且不报错 —— 只是默默变笨。
  it("把 task context(含反馈笔记)拼进发给网关的消息", () => {
    const taskContext = [
      "## Task JIN-61: 写一条「租房押金不退」的短视频脚本",
      "",
      "Your feedback notes (learned from past work on this company — apply them to this task):",
      "",
      "Recently corrected (do not repeat these mistakes):",
      "- 标题别再用「震惊」体",
    ].join("\n");

    const text = buildWakeText(payload, env, "structured wake prompt", taskContext);

    expect(text).toContain("标题别再用「震惊」体");
    expect(text).toContain("写一条「租房押金不退」的短视频脚本");
    // 上下文要排在收尾指令之前,别被截断在最后一行之后
    expect(text.indexOf(taskContext)).toBeLessThan(text.indexOf("Complete the workflow in this run."));
  });

  it("没有 task context 时不留空段落", () => {
    const text = buildWakeText(payload, env, "structured wake prompt", "");

    expect(text).toContain("structured wake prompt");
    expect(text).not.toMatch(/\n\n\n/);
  });
});

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip:run:run-123");
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "meridian",
        runId: "run-123",
        issueId: "issue-456",
      }),
    ).toBe("agent:meridian:paperclip:issue:issue-456");
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(
      resolveSessionKey({
        strategy: "fixed",
        configuredSessionKey: "agent:meridian:paperclip",
        agentId: "meridian",
        runId: "run-123",
        issueId: null,
      }),
    ).toBe("agent:meridian:paperclip");
  });
});

describe("buildAgentParams", () => {
  it("strips root-level paperclip fields from gateway agent params", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          text: "old text",
          paperclip: { stale: true },
          keep: "value",
        },
        message: "wake text",
        sessionKey: "agent:meridian:paperclip:issue:issue-456",
        runId: "run-123",
        configuredAgentId: "meridian",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      keep: "value",
      message: "wake text",
      sessionKey: "agent:meridian:paperclip:issue:issue-456",
      idempotencyKey: "run-123",
      agentId: "meridian",
      timeout: 30_000,
    });
  });

  it("preserves an explicit agentId and timeout from the payload template", () => {
    expect(
      buildAgentParams({
        payloadTemplate: {
          agentId: "template-agent",
          timeout: 5_000,
        },
        message: "wake text",
        sessionKey: "paperclip",
        runId: "run-123",
        configuredAgentId: "configured-agent",
        waitTimeoutMs: 30_000,
      }),
    ).toEqual({
      agentId: "template-agent",
      timeout: 5_000,
      message: "wake text",
      sessionKey: "paperclip",
      idempotencyKey: "run-123",
    });
  });
});
