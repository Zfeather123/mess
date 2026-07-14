export const THINKING_EFFORTS = ["low", "medium", "high"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

export const THINKING_EFFORT_LABELS: Record<ThinkingEffort, string> = {
  low: "轻量",
  medium: "标准",
  high: "深思",
};

export const THINKING_EFFORT_HINTS: Record<ThinkingEffort, string> = {
  low: "快、便宜,适合机械改稿和格式化任务",
  medium: "默认档,日常选题与撰稿",
  high: "慢、贵,留给复杂法律推理和方案权衡",
};

/** The model + effort slice of `adapterConfig` that the config page owns. */
export interface AgentConfigDraft {
  model: string;
  /** Empty string = "follow the adapter default", i.e. unset the key. */
  effort: ThinkingEffort | "";
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === "string" && (THINKING_EFFORTS as readonly string[]).includes(value);
}

export function readAgentConfigDraft(
  adapterConfig: Record<string, unknown> | null | undefined,
): AgentConfigDraft {
  const config = adapterConfig ?? {};
  const model = typeof config.model === "string" ? config.model : "";
  return { model, effort: isThinkingEffort(config.effort) ? config.effort : "" };
}

export interface AgentConfigPatch extends Record<string, unknown> {
  adapterConfig: Record<string, unknown>;
  /**
   * PATCH /agents/:id MERGES adapterConfig by default, so a merge patch can
   * never clear a key — leaving `effort` stuck at its old value when the user
   * picks "adapter default". We always send the fully-resolved object with
   * `replaceAdapterConfig: true` so the saved config is exactly what the form
   * shows.
   */
  replaceAdapterConfig: true;
}

/**
 * Builds the PATCH body for a model/effort change, preserving every other
 * adapterConfig key. Returns null when nothing changed — a no-op save would
 * otherwise write a config revision for free.
 */
export function buildAgentConfigPatch(
  adapterConfig: Record<string, unknown> | null | undefined,
  draft: AgentConfigDraft,
): AgentConfigPatch | null {
  const current = readAgentConfigDraft(adapterConfig);
  const model = draft.model.trim();
  if (current.model === model && current.effort === draft.effort) return null;

  const next: Record<string, unknown> = { ...(adapterConfig ?? {}) };

  if (model) next.model = model;
  else delete next.model;

  if (draft.effort) next.effort = draft.effort;
  else delete next.effort;

  return { adapterConfig: next, replaceAdapterConfig: true };
}
