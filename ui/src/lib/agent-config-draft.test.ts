import { describe, expect, it } from "vitest";
import { buildAgentConfigPatch, readAgentConfigDraft } from "./agent-config-draft";

describe("readAgentConfigDraft", () => {
  it("reads model and effort, ignoring an unknown effort value", () => {
    expect(readAgentConfigDraft({ model: "claude-opus-4-8", effort: "high" })).toEqual({
      model: "claude-opus-4-8",
      effort: "high",
    });
    expect(readAgentConfigDraft({ effort: "ludicrous" })).toEqual({ model: "", effort: "" });
    expect(readAgentConfigDraft(null)).toEqual({ model: "", effort: "" });
  });
});

describe("buildAgentConfigPatch", () => {
  it("returns null when nothing changed, so no config revision is written", () => {
    expect(
      buildAgentConfigPatch({ model: "m1", effort: "low" }, { model: "m1", effort: "low" }),
    ).toBeNull();
  });

  it("preserves unrelated adapterConfig keys and replaces the whole object", () => {
    const patch = buildAgentConfigPatch(
      { model: "m1", effort: "low", apiKeyRef: "secret://k" },
      { model: "m2", effort: "high" },
    );

    expect(patch).toEqual({
      adapterConfig: { model: "m2", effort: "high", apiKeyRef: "secret://k" },
      replaceAdapterConfig: true,
    });
  });

  it("clears effort when the user picks the adapter default — a merge patch could not", () => {
    const patch = buildAgentConfigPatch({ model: "m1", effort: "high" }, { model: "m1", effort: "" });

    expect(patch?.adapterConfig).toEqual({ model: "m1" });
    expect(patch?.adapterConfig).not.toHaveProperty("effort");
    expect(patch?.replaceAdapterConfig).toBe(true);
  });

  it("trims the model and clears it when blank", () => {
    expect(
      buildAgentConfigPatch({ model: "m1" }, { model: "  m2  ", effort: "" })?.adapterConfig,
    ).toEqual({ model: "m2" });
    expect(buildAgentConfigPatch({ model: "m1" }, { model: "", effort: "" })?.adapterConfig).toEqual(
      {},
    );
  });
});
