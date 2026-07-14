import { describe, expect, it, vi } from "vitest";
import { createTikHubClient } from "./client.js";
import { TikHubError } from "./errors.js";
import type { TikHubConfig } from "./config.js";

/**
 * 全部用例都注入假 fetch —— 这个环境里**没有真的 TikHub key**,也不该联网。
 */

const CONFIG: Partial<TikHubConfig> = {
  apiKey: "test-key",
  baseUrl: "https://api.tikhub.io",
  maxAttempts: 3,
  maxQps: 10,
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: status, router: "/t", params: {}, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 记录每次调用的 url,依次返回预设响应。 */
function fakeFetch(responses: Array<Response | (() => Response)>) {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    inits.push(init ?? {});
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof r === "function" ? r() : r!;
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls, inits, raw: fn };
}

/** 假 sleep:不真的等,只记录退避时长。 */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("resolveSecUid", () => {
  it("把分享短链换成 sec_uid", async () => {
    const f = fakeFetch([jsonResponse([{ url: "https://v.douyin.com/idFqvUms/", sec_user_id: "MS4wLjABAAAA_short_link_uid" }])]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const secUid = await client.resolveSecUid("https://v.douyin.com/idFqvUms/");

    expect(secUid).toBe("MS4wLjABAAAA_short_link_uid");
    expect(f.calls[0]).toContain("/api/v1/douyin/web/get_all_sec_user_id");
  });

  it("把整段分享口令文案原样透传给上游,并解析出 sec_uid", async () => {
    const caption =
      "7.94 复制打开抖音,看看【某某律师的作品】劳动仲裁怎么打 https://v.douyin.com/iRNBho6/ 长按复制此条消息,打开抖音搜索,查看TA的更多作品";
    const f = fakeFetch([jsonResponse({ data: [{ sec_user_id: "MS4wLjABAAAA_caption_uid" }] })]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const secUid = await client.resolveSecUid(caption);

    expect(secUid).toBe("MS4wLjABAAAA_caption_uid");
    // 口令文案必须原样发出去 —— 不在本地做正则拆链接。
    const body = JSON.parse(String(f.inits[0]!.body));
    expect(body.url).toEqual([caption]);
  });

  it("输入已经是 sec_uid 时不浪费一次付费调用", async () => {
    const f = fakeFetch([jsonResponse({})]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const secUid = await client.resolveSecUid("MS4wLjABAAAAq1n2already_a_sec_uid");

    expect(secUid).toBe("MS4wLjABAAAAq1n2already_a_sec_uid");
    expect(f.raw).not.toHaveBeenCalled();
  });

  it("解析不出来时报 not_found,而不是崩", async () => {
    const f = fakeFetch([jsonResponse({ data: [] })]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    await expect(client.resolveSecUid("https://v.douyin.com/dead/")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("fetchUserProfile", () => {
  it("解析完整资料(走 APP 接口)", async () => {
    const f = fakeFetch([
      jsonResponse({
        user: {
          sec_uid: "MS4wLjABAAAAsec",
          uid: "123456",
          unique_id: "lawyer_zhang",
          nickname: "张律师",
          avatar_larger: { url_list: ["https://p3.douyinpic.com/a.jpeg"] },
          signature: "专注劳动争议",
          follower_count: 12345,
          following_count: 42,
          aweme_count: 88,
          total_favorited: "998877", // 抖音常以字符串返回
          ip_location: "广东",
          custom_verify: "广东XX律师事务所律师",
          enterprise_verify_reason: "",
        },
      }),
    ]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const p = await client.fetchUserProfile("MS4wLjABAAAAsec");

    expect(f.calls[0]).toContain("/api/v1/douyin/app/v3/handler_user_profile");
    expect(f.calls[0]).toContain("sec_user_id=MS4wLjABAAAAsec");
    expect(p.nickname).toBe("张律师");
    expect(p.followerCount).toBe(12345);
    expect(p.totalFavorited).toBe(998877);
    expect(p.avatarUrl).toBe("https://p3.douyinpic.com/a.jpeg");
    expect(p.ipLocation).toBe("广东");
    expect(p.customVerify).toBe("广东XX律师事务所律师");
    expect(p.raw).toBeTruthy();
  });

  it("缺一堆可选字段也不抛错", async () => {
    const f = fakeFetch([jsonResponse({ user: { sec_uid: "MS4wLjABAAAAsec", nickname: "极简号" } })]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const p = await client.fetchUserProfile("MS4wLjABAAAAsec");

    expect(p.nickname).toBe("极简号");
    // 计数字段缺失 → 0;可选字符串缺失 → undefined。都不能崩。
    expect(p.followerCount).toBe(0);
    expect(p.awemeCount).toBe(0);
    expect(p.avatarUrl).toBeUndefined();
    expect(p.ipLocation).toBeUndefined();
    expect(p.customVerify).toBeUndefined();
  });

  it("账号被过滤/注销 → not_found,不崩", async () => {
    const f = fakeFetch([jsonResponse({ user: {} })]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    await expect(client.fetchUserProfile("MS4wLjABAAAAgone")).rejects.toBeInstanceOf(TikHubError);
  });
});

describe("fetchUserVideos", () => {
  const aweme = (id: string) => ({
    aweme_id: id,
    desc: `作品 ${id}`,
    create_time: 1_700_000_000,
    video: { duration: 61_000, cover: { url_list: ["https://p3.douyinpic.com/c.jpeg"] } },
    share_info: { share_url: `https://www.douyin.com/video/${id}` },
    text_extra: [{ hashtag_name: "劳动仲裁" }, { hashtag_name: "普法" }],
    statistics: { digg_count: 10, comment_count: 2, share_count: 1, collect_count: 3 },
  });

  it("翻页,直到 has_more=false", async () => {
    const f = fakeFetch([
      jsonResponse({ aweme_list: [aweme("a1")], has_more: 1, max_cursor: 111 }),
      jsonResponse({ aweme_list: [aweme("a2")], has_more: 1, max_cursor: 222 }),
      jsonResponse({ aweme_list: [aweme("a3")], has_more: false, max_cursor: 0 }),
    ]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const videos = await client.fetchUserVideos("MS4wLjABAAAAsec");

    expect(videos.map((v) => v.awemeId)).toEqual(["a1", "a2", "a3"]);
    expect(f.raw).toHaveBeenCalledTimes(3);
    // count 不得超过 20(官方警告)
    expect(f.calls[0]).toContain("count=20");
    expect(f.calls[1]).toContain("max_cursor=111");
  });

  it("尊重 maxPages,即使上游还说 has_more", async () => {
    const f = fakeFetch([
      () => jsonResponse({ aweme_list: [aweme(`p${Math.random()}`)], has_more: 1, max_cursor: Date.now() + Math.random() }),
    ]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    await client.fetchUserVideos("MS4wLjABAAAAsec", { maxPages: 2 });

    expect(f.raw).toHaveBeenCalledTimes(2);
  });

  it("pageSize 被夹到 20 以内", async () => {
    const f = fakeFetch([jsonResponse({ aweme_list: [], has_more: false })]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    await client.fetchUserVideos("MS4wLjABAAAAsec", { pageSize: 50 });

    expect(f.calls[0]).toContain("count=20");
    expect(f.calls[0]).not.toContain("count=50");
  });

  it("解析话题/时长/封面", async () => {
    const f = fakeFetch([jsonResponse({ aweme_list: [aweme("a1")], has_more: false })]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const [v] = await client.fetchUserVideos("MS4wLjABAAAAsec");

    expect(v!.hashtags).toEqual(["劳动仲裁", "普法"]);
    expect(v!.durationMs).toBe(61_000);
    expect(v!.coverUrl).toBe("https://p3.douyinpic.com/c.jpeg");
    expect(v!.createTime).toBe(1_700_000_000);
    expect(v!.stats.diggCount).toBe(10);
  });

  it("⚠️ 列表里没有可信播放量时 playCount 是 null —— 绝不是 0", async () => {
    const f = fakeFetch([
      jsonResponse({
        aweme_list: [
          // 情形 1:压根没有 play_count 字段
          aweme("no_field"),
          // 情形 2:上游回了 0 —— 这是「没数据」的伪装,不可信
          { ...aweme("zero"), statistics: { digg_count: 5, comment_count: 0, share_count: 0, collect_count: 0, play_count: 0 } },
        ],
        has_more: false,
      }),
    ]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const videos = await client.fetchUserVideos("MS4wLjABAAAAsec");

    for (const v of videos) {
      expect(v.stats.playCount).toBeNull();
      expect(v.stats.playCount).not.toBe(0);
      expect(v.stats.playCountSource).toBeNull();
    }
  });

  it("列表确实带回非 0 播放量时,标记来源为 aweme_payload", async () => {
    const f = fakeFetch([
      jsonResponse({
        aweme_list: [{ ...aweme("has_play"), statistics: { digg_count: 5, play_count: 66_666 } }],
        has_more: false,
      }),
    ]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const [v] = await client.fetchUserVideos("MS4wLjABAAAAsec");

    expect(v!.stats.playCount).toBe(66_666);
    expect(v!.stats.playCountSource).toBe("aweme_payload");
  });

  it("私密账号 → private_account,不崩", async () => {
    const f = fakeFetch([jsonResponse({ aweme_list: [], has_more: false, user: { secret: 1 } })]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    await expect(client.fetchUserVideos("MS4wLjABAAAApriv")).rejects.toMatchObject({
      code: "private_account",
    });
  });
});

describe("fetchVideoStatistics", () => {
  it("⚠️ 按每批 2 个 aweme_id 切分:5 个 id → 3 次请求", async () => {
    const f = fakeFetch([
      () => jsonResponse({ statistics_list: [] }),
    ]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    await client.fetchVideoStatistics(["1", "2", "3", "4", "5"]);

    expect(f.raw).toHaveBeenCalledTimes(3);
    expect(f.calls[0]).toContain("/api/v1/douyin/app/v3/fetch_video_statistics");
    // 每次最多 2 个,逗号分隔
    expect(decodeURIComponent(f.calls[0]!)).toContain("aweme_ids=1,2");
    expect(decodeURIComponent(f.calls[1]!)).toContain("aweme_ids=3,4");
    expect(decodeURIComponent(f.calls[2]!)).toContain("aweme_ids=5");
  });

  it("统计接口的播放量标记为 statistics_api(可信),包括真实的 0", async () => {
    const f = fakeFetch([
      jsonResponse({
        statistics_list: [
          { aweme_id: "1", digg_count: 100, play_count: 50_000, share_count: 7 },
          { aweme_id: "2", digg_count: 0, play_count: 0, share_count: 0 },
        ],
      }),
    ]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const map = await client.fetchVideoStatistics(["1", "2"]);

    expect(map.get("1")!.playCount).toBe(50_000);
    expect(map.get("1")!.playCountSource).toBe("statistics_api");
    // 专用接口回的 0 是**真实的 0 播放**,与「没拉到」不同 —— 必须保留。
    expect(map.get("2")!.playCount).toBe(0);
    expect(map.get("2")!.playCountSource).toBe("statistics_api");
  });

  it("空输入不发请求", async () => {
    const f = fakeFetch([jsonResponse({})]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    const map = await client.fetchVideoStatistics([]);

    expect(map.size).toBe(0);
    expect(f.raw).not.toHaveBeenCalled();
  });

  it("去重后再分批", async () => {
    const f = fakeFetch([() => jsonResponse({ statistics_list: [] })]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    await client.fetchVideoStatistics(["1", "1", "2", "2"]);

    expect(f.raw).toHaveBeenCalledTimes(1);
  });
});

describe("重试策略", () => {
  it("429 用退避重试,最终成功", async () => {
    const s = fakeSleep();
    const f = fakeFetch([
      jsonResponse({}, 429),
      jsonResponse({}, 429),
      jsonResponse({ user: { sec_uid: "s", nickname: "ok" } }),
    ]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn, sleep: s.sleep });

    const p = await client.fetchUserProfile("MS4wLjABAAAAsec");

    expect(p.nickname).toBe("ok");
    expect(f.raw).toHaveBeenCalledTimes(3);
    // 退避了两次(第 1、2 次失败后)
    expect(s.delays.length).toBe(2);
    for (const d of s.delays) expect(d).toBeGreaterThanOrEqual(0);
  });

  it("401 绝不重试", async () => {
    const s = fakeSleep();
    const f = fakeFetch([jsonResponse({ detail: "unauthorized" }, 401)]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn, sleep: s.sleep });

    await expect(client.fetchUserProfile("MS4wLjABAAAAsec")).rejects.toMatchObject({
      code: "unauthorized",
      retryable: false,
    });
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(s.delays).toEqual([]);
  });

  it("402 余额不足绝不重试 —— 重试只会继续烧钱", async () => {
    const s = fakeSleep();
    const f = fakeFetch([jsonResponse({ detail: "insufficient balance" }, 402)]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn, sleep: s.sleep });

    await expect(client.fetchUserProfile("MS4wLjABAAAAsec")).rejects.toMatchObject({
      code: "insufficient_balance",
      retryable: false,
    });
    expect(f.raw).toHaveBeenCalledTimes(1);
  });

  it("重试耗尽后抛出最后一个错误", async () => {
    const s = fakeSleep();
    const f = fakeFetch([() => jsonResponse({}, 500)]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn, sleep: s.sleep });

    await expect(client.fetchUserProfile("MS4wLjABAAAAsec")).rejects.toMatchObject({
      code: "upstream_error",
    });
    expect(f.raw).toHaveBeenCalledTimes(3); // maxAttempts
  });

  it("网络错误可重试", async () => {
    const s = fakeSleep();
    let n = 0;
    const fn = vi.fn(async () => {
      if (n++ === 0) throw new TypeError("fetch failed");
      return jsonResponse({ user: { sec_uid: "s", nickname: "recovered" } });
    });
    const client = createTikHubClient(CONFIG, {
      fetch: fn as unknown as typeof globalThis.fetch,
      sleep: s.sleep,
    });

    const p = await client.fetchUserProfile("MS4wLjABAAAAsec");

    expect(p.nickname).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("认证头", () => {
  it("带 Bearer token", async () => {
    const f = fakeFetch([jsonResponse({ user: { sec_uid: "s", nickname: "n" } })]);
    const client = createTikHubClient(CONFIG, { fetch: f.fn });

    await client.fetchUserProfile("MS4wLjABAAAAsec");

    const headers = f.inits[0]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });
});
