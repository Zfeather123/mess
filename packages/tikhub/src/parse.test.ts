import { describe, expect, it } from "vitest";
import {
  extractSecUid,
  parseHashtags,
  parseStatisticsRow,
  parseUserProfile,
  parseVideo,
  parseVideoStats,
} from "./parse.js";

/**
 * 解析层的铁律:`data` 是无类型透传,**缺字段永不抛错**。
 * 这些用例就是在拿垃圾数据往解析器上砸。
 */

describe("parseUserProfile 防御性", () => {
  it("空对象 / null / 数组 / 字符串都不抛错", () => {
    expect(() => parseUserProfile(null)).not.toThrow();
    expect(() => parseUserProfile(undefined)).not.toThrow();
    expect(() => parseUserProfile([])).not.toThrow();
    expect(() => parseUserProfile("nonsense")).not.toThrow();
    expect(parseUserProfile({})).toBeNull();
  });

  it("user 摊平在 data 顶层时也认(web 接口形状)", () => {
    const p = parseUserProfile({ sec_uid: "MS4wsec", nickname: "扁平号", follower_count: 7 });
    expect(p?.nickname).toBe("扁平号");
    expect(p?.followerCount).toBe(7);
  });

  it("数字字符串被强转", () => {
    const p = parseUserProfile({ user: { sec_uid: "s", nickname: "n", follower_count: "8800", total_favorited: "12" } });
    expect(p?.followerCount).toBe(8800);
    expect(p?.totalFavorited).toBe(12);
  });

  it("脏值不会变成 NaN", () => {
    const p = parseUserProfile({ user: { sec_uid: "s", nickname: "n", follower_count: "abc", aweme_count: null } });
    expect(p?.followerCount).toBe(0);
    expect(p?.awemeCount).toBe(0);
  });

  it("头像从 url_list[0] 取,并能退化到 avatar_thumb", () => {
    const p = parseUserProfile({ user: { sec_uid: "s", nickname: "n", avatar_thumb: { url_list: ["https://t.jpg"] } } });
    expect(p?.avatarUrl).toBe("https://t.jpg");
  });

  it("url_list 为空数组时返回 undefined 而不是崩", () => {
    const p = parseUserProfile({ user: { sec_uid: "s", nickname: "n", avatar_larger: { url_list: [] } } });
    expect(p?.avatarUrl).toBeUndefined();
  });
});

describe("parseVideoStats —— 播放量绝不伪造 0", () => {
  it("没有 play_count → null", () => {
    const s = parseVideoStats({ statistics: { digg_count: 3 } });
    expect(s.playCount).toBeNull();
    expect(s.playCountSource).toBeNull();
    expect(s.diggCount).toBe(3);
  });

  it("play_count=0 → 视为「没拉到」,仍是 null", () => {
    const s = parseVideoStats({ statistics: { play_count: 0 } });
    expect(s.playCount).toBeNull();
  });

  it("play_count 非 0 → 认,标 aweme_payload", () => {
    const s = parseVideoStats({ statistics: { play_count: 1234 } });
    expect(s.playCount).toBe(1234);
    expect(s.playCountSource).toBe("aweme_payload");
  });

  it("互动数缺失按 0 处理(这跟播放量不同,0 赞就是 0 赞)", () => {
    const s = parseVideoStats({});
    expect(s.diggCount).toBe(0);
    expect(s.commentCount).toBe(0);
    expect(s.shareCount).toBe(0);
    expect(s.collectCount).toBe(0);
  });
});

describe("parseStatisticsRow —— 专用接口的 0 是真的 0", () => {
  it("play_count=0 保留为 0,来源 statistics_api", () => {
    const r = parseStatisticsRow({ aweme_id: "1", play_count: 0 });
    expect(r?.stats.playCount).toBe(0);
    expect(r?.stats.playCountSource).toBe("statistics_api");
  });

  it("没有 play_count → null", () => {
    const r = parseStatisticsRow({ aweme_id: "1", digg_count: 5 });
    expect(r?.stats.playCount).toBeNull();
    expect(r?.stats.playCountSource).toBeNull();
  });

  it("没有 aweme_id 的行被丢弃", () => {
    expect(parseStatisticsRow({ play_count: 9 })).toBeNull();
    expect(parseStatisticsRow(null)).toBeNull();
  });
});

describe("parseVideo", () => {
  it("没有 aweme_id 的条目丢弃(DB 侧 aweme_id 是唯一键的一部分)", () => {
    expect(parseVideo({ desc: "孤儿作品" })).toBeNull();
    expect(parseVideo(null)).toBeNull();
  });

  it("数字型 aweme_id 转成字符串", () => {
    expect(parseVideo({ aweme_id: 7_300_000_000_000_000 })?.awemeId).toBe("7300000000000000");
  });

  it("最小载荷不抛错", () => {
    const v = parseVideo({ aweme_id: "a" });
    expect(v?.hashtags).toEqual([]);
    expect(v?.description).toBeUndefined();
    expect(v?.durationMs).toBeUndefined();
    expect(v?.stats.playCount).toBeNull();
  });
});

describe("parseHashtags", () => {
  it("从 text_extra[] 提取并去重", () => {
    expect(
      parseHashtags({
        text_extra: [
          { hashtag_name: "普法" },
          { hashtag_name: "普法" },
          { hashtag_name: "劳动仲裁" },
          { not_a_hashtag: true },
          null,
        ],
      }),
    ).toEqual(["普法", "劳动仲裁"]);
  });

  it("text_extra 缺失或不是数组 → []", () => {
    expect(parseHashtags({})).toEqual([]);
    expect(parseHashtags({ text_extra: "oops" })).toEqual([]);
  });
});

describe("extractSecUid(对形状漂移免疫)", () => {
  it("认数组形状", () => {
    expect(extractSecUid([{ url: "u", sec_user_id: "MS4w_a" }])).toBe("MS4w_a");
  });
  it("认嵌套形状", () => {
    expect(extractSecUid({ data: { list: [{ sec_uid: "MS4w_b" }] } })).toBe("MS4w_b");
  });
  it("找不到就 undefined", () => {
    expect(extractSecUid({ error: "no" })).toBeUndefined();
    expect(extractSecUid(null)).toBeUndefined();
  });
});
