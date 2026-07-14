import { describe, expect, it } from "vitest";
import {
  PROFILE_FIELD_SPEC_V1,
  PROFILE_SOURCE_PRIORITY,
  buildProfileGuidance,
  computeProfileCompleteness,
  isProfileValueFilled,
} from "./account-profile-spec.js";

describe("PROFILE_FIELD_SPEC_V1", () => {
  it("字段 key 唯一", () => {
    const keys = PROFILE_FIELD_SPEC_V1.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("来源优先级严格递减:user > resume > tikhub > history_content > agent_inference", () => {
    // 这个顺序是冲突消解的全部依据 —— 一旦被人手滑改乱,用户手填就会被模型推断覆盖
    const { user, resume, tikhub, history_content, agent_inference } = PROFILE_SOURCE_PRIORITY;
    expect(user).toBeGreaterThan(resume);
    expect(resume).toBeGreaterThan(tikhub);
    expect(tikhub).toBeGreaterThan(history_content);
    expect(history_content).toBeGreaterThan(agent_inference);
  });

  it("禁用表达只能由用户填 —— 模型不得代律师承诺「不说什么」", () => {
    const banned = PROFILE_FIELD_SPEC_V1.find((f) => f.key === "banned_expressions");
    expect(banned?.autoFillableFrom).toEqual(["user"]);
    expect(banned?.required).toBe(true);
  });
});

describe("isProfileValueFilled", () => {
  it("空值一律不算「填了」", () => {
    // 「同步跑过但什么都没拉到」不能把完整度刷成 100% —— 这是最容易骗过自己的一种 bug
    expect(isProfileValueFilled(null)).toBe(false);
    expect(isProfileValueFilled(undefined)).toBe(false);
    expect(isProfileValueFilled("")).toBe(false);
    expect(isProfileValueFilled("   ")).toBe(false);
    expect(isProfileValueFilled([])).toBe(false);
    expect(isProfileValueFilled([""])).toBe(false);
    expect(isProfileValueFilled([" ", ""])).toBe(false);
    expect(isProfileValueFilled({})).toBe(false);
  });

  it("有内容才算", () => {
    expect(isProfileValueFilled("离婚律师")).toBe(true);
    expect(isProfileValueFilled(["公司老板"])).toBe(true);
    expect(isProfileValueFilled(0)).toBe(true);
    expect(isProfileValueFilled([{ method: "开头给身份" }])).toBe(true);
  });
});

describe("computeProfileCompleteness", () => {
  it("空档案 = 0%,所有字段都缺", () => {
    const result = computeProfileCompleteness({});
    expect(result.completenessPct).toBe(0);
    expect(result.missingFields).toHaveLength(PROFILE_FIELD_SPEC_V1.length);
    expect(result.filledFields).toEqual([]);
  });

  it("全填 = 100%", () => {
    const values: Record<string, unknown> = {};
    for (const field of PROFILE_FIELD_SPEC_V1) {
      values[field.key] = field.valueType === "number" ? 8 : field.valueType === "string" ? "x" : [{ a: 1 }];
    }
    const result = computeProfileCompleteness(values);
    expect(result.completenessPct).toBe(100);
    expect(result.missingFields).toEqual([]);
  });

  it("完整度是按权重加权的,不是按字段个数", () => {
    // positioning 权重 20;city 权重 5。只填 city ≠ 只填 positioning
    const onlyPositioning = computeProfileCompleteness({ positioning: "高净值离婚律师" });
    const onlyCity = computeProfileCompleteness({ city: "杭州" });
    expect(onlyPositioning.completenessPct).toBe(20);
    expect(onlyCity.completenessPct).toBe(5);
    expect(onlyPositioning.completenessPct).toBeGreaterThan(onlyCity.completenessPct);
  });

  it("空值不计入完整度 —— 存在一条空事实不等于这个字段填了", () => {
    const result = computeProfileCompleteness({ positioning: "", target_audience: [], city: "   " });
    expect(result.completenessPct).toBe(0);
    expect(result.missingFields).toContain("positioning");
    expect(result.missingFields).toContain("city");
  });

  it("缺失项按权重降序 —— 引导补全先问最要紧的", () => {
    const result = computeProfileCompleteness({});
    // positioning / target_audience 权重最高(各 20),必须排在最前
    expect(result.missingFields.slice(0, 2).sort()).toEqual(["positioning", "target_audience"]);
    // effective_methods 非必填,不该进必答项
    expect(result.missingRequiredFields).not.toContain("effective_methods");
  });
});

describe("buildProfileGuidance", () => {
  it("把缺失字段分成「能自动同步补」和「必须问用户」两栏", () => {
    const { missingFields } = computeProfileCompleteness({});
    const guidance = buildProfileGuidance(missingFields);

    const banned = guidance.find((g) => g.fieldKey === "banned_expressions");
    const city = guidance.find((g) => g.fieldKey === "city");

    // 禁用表达:无论怎么同步都补不上,只能问用户(合规红线)
    expect(banned?.canAutoFill).toBe(false);
    // 执业城市:TikHub 的 ip_location 能给弱信号
    expect(city?.canAutoFill).toBe(true);

    expect(guidance.every((g) => g.question.trim().length > 0)).toBe(true);
  });

  it("未知字段被忽略,不会炸", () => {
    expect(buildProfileGuidance(["not_a_real_field"])).toEqual([]);
  });
});
