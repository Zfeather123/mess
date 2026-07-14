import { describe, expect, it } from "vitest";
import type { DouyinUserProfile, DouyinVideo } from "@jin/tikhub";
import { deriveFacts } from "./douyin-sync.js";

function profile(overrides: Partial<DouyinUserProfile> = {}): DouyinUserProfile {
  return {
    secUid: "MS4wLjABAAAA",
    nickname: "张律师",
    followerCount: 12000,
    followingCount: 100,
    awemeCount: 42,
    totalFavorited: 90000,
    raw: {},
    ...overrides,
  };
}

function video(hashtags: string[], awemeId = "1"): DouyinVideo {
  return {
    awemeId,
    hashtags,
    stats: {
      diggCount: 0,
      commentCount: 0,
      shareCount: 0,
      collectCount: 0,
      playCount: null,
      playCountSource: null,
    },
    raw: {},
  };
}

describe("deriveFacts", () => {
  it("从 custom_verify(抖音认证过的字段)提取律所,置信度高", () => {
    const facts = deriveFacts(profile({ customVerify: "北京德恒律师事务所律师" }), []);
    const firm = facts.find((f) => f.fieldKey === "law_firm");

    expect(firm?.value).toBe("北京德恒律师事务所");
    expect(firm?.source).toBe("tikhub");
    // 认证字段比签名自述可信得多
    expect(firm?.confidence).toBe(90);
    // 证据链:凭什么说他是德恒的
    expect(firm?.evidenceRef).toMatchObject({ field: "custom_verify" });
  });

  it("认不出律所时不硬猜", () => {
    const facts = deriveFacts(profile({ customVerify: "情感博主" }), []);
    expect(facts.find((f) => f.fieldKey === "law_firm")).toBeUndefined();
  });

  it("IP 属地只作弱信号 —— 用户可能在外地刷手机", () => {
    const facts = deriveFacts(profile({ ipLocation: "IP属地:浙江" }), []);
    const city = facts.find((f) => f.fieldKey === "city");

    expect(city?.value).toBe("浙江");
    expect(city?.confidence).toBe(50);
  });

  it("业务领域取 hashtag 词频 Top3,来源标成 history_content 而不是 tikhub", () => {
    // 词频刻意不打平,断言的是「按出现次数取 Top3」,而不是并列时的排序规则
    const facts = deriveFacts(profile(), [
      video(["婚姻家事", "离婚", "财产分割"], "1"),
      video(["婚姻家事", "离婚", "财产分割"], "2"),
      video(["婚姻家事", "离婚"], "3"),
      video(["婚姻家事"], "4"),
      video(["股权纠纷"], "5"),
    ]);
    const areas = facts.find((f) => f.fieldKey === "practice_areas");

    // 婚姻家事 ×4 > 离婚 ×3 > 财产分割 ×2 > 股权纠纷 ×1(被 Top3 截掉)
    expect(areas?.value).toEqual(["婚姻家事", "离婚", "财产分割"]);
    // 这是我们**算**出来的,不是 TikHub **给**的 —— 来源标签必须诚实,
    // 否则以后没人搞得清这个值是抖音的事实还是我们的推断
    expect(areas?.source).toBe("history_content");
  });

  it("⚠️ 绝不凭规则臆造 positioning / target_audience —— 那是诊断师调模型的活", () => {
    // 如果在这里用规则硬猜一个定位,它会以 tikhub(优先级 60)的身份落库,
    // 把后续的模型推断(10)永久挡在门外,而用户根本不知道这个「定位」是猜的。
    const facts = deriveFacts(
      profile({ customVerify: "北京德恒律师事务所律师", signature: "专注离婚财产分割" }),
      [video(["离婚"])],
    );

    expect(facts.find((f) => f.fieldKey === "positioning")).toBeUndefined();
    expect(facts.find((f) => f.fieldKey === "target_audience")).toBeUndefined();
  });

  it("什么都没有时返回空数组,不写空事实", () => {
    expect(deriveFacts(profile(), [])).toEqual([]);
  });
});
