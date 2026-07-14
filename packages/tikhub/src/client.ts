import { TIKHUB_DEFAULT_BASE_URL, type TikHubConfig, loadTikhubConfig } from "./config.js";
import { TikHubError } from "./errors.js";
import { TikHubHttp, realClock, type Clock } from "./http.js";
import {
  extractAwemeList,
  extractSecUid,
  extractStatisticsList,
  hasMore,
  isPrivateProfile,
  isRecord,
  nextCursor,
  parseStatisticsRow,
  parseUserProfile,
  parseVideo,
} from "./parse.js";
import type { DouyinUserProfile, DouyinVideo, DouyinVideoStats, TikHubClient } from "./types.js";

/** 作品列表 count 官方警告不得超过 20。 */
const MAX_PAGE_SIZE = 20;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 10;

/**
 * ⚠️ 专用统计接口一次**最多 2 个 aweme_id**(官方限制)。
 * 这不是可调参数 —— 超了上游直接不回数据。
 */
const STATISTICS_BATCH_SIZE = 2;

/** sec_uid 长这样:一长串 base64url 风格的字符,没有 / 没有空格。 */
const SEC_UID_RE = /^[A-Za-z0-9_-]{20,}$/;

export interface TikHubClientDeps {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 创建 TikHub 客户端。
 *
 * `deps.fetch` 注入是**必须支持**的 —— 测试就是靠它在没有真 key、不联网的情况下跑起来。
 * 不传 config 时从环境变量加载(loadTikhubConfig 会在缺 key 时抛错)。
 */
export function createTikHubClient(
  config?: Partial<TikHubConfig>,
  deps?: TikHubClientDeps,
): TikHubClient {
  const resolved = resolveConfig(config);
  const clock: Clock = {
    now: () => Date.now(),
    sleep: deps?.sleep ?? realClock.sleep,
  };
  const http = new TikHubHttp({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    timeoutMs: resolved.timeoutMs,
    maxAttempts: resolved.maxAttempts,
    maxQps: resolved.maxQps,
    fetch: deps?.fetch ?? globalThis.fetch,
    clock,
  });
  return new HttpTikHubClient(http);
}

/**
 * 只在**确实需要**环境变量时才去读它 —— 调用方把完整 config 传进来时(测试就是这样),
 * 不应该因为进程里没有 TIKHUB_API_KEY 就炸掉。
 */
function resolveConfig(partial?: Partial<TikHubConfig>): TikHubConfig {
  if (partial?.apiKey) {
    return {
      apiKey: partial.apiKey,
      baseUrl: partial.baseUrl ?? TIKHUB_DEFAULT_BASE_URL,
      timeoutMs: partial.timeoutMs ?? 30_000,
      maxAttempts: partial.maxAttempts ?? 3,
      maxQps: partial.maxQps ?? 10,
    };
  }
  return { ...loadTikhubConfig(), ...partial };
}

class HttpTikHubClient implements TikHubClient {
  constructor(private readonly http: TikHubHttp) {}

  /**
   * 分享短链 / 分享口令文案 / 长链 / sec_uid → sec_uid。
   *
   * 输入**原样透传**给上游:spec 自己的示例里就同时包含 `https://v.douyin.com/idFqvUms/`
   * 和整段「长按复制此条消息…」口令文案,上游有能力自己拆。我们不在本地写正则拆 URL ——
   * 那是在跟抖音的分享文案格式赛跑,必输。
   */
  async resolveSecUid(input: string): Promise<string> {
    const raw = input?.trim();
    if (!raw) {
      throw new TikHubError("invalid_input", "[tikhub] resolveSecUid 需要非空输入");
    }
    // 已经是 sec_uid 了(不含 URL、不含空白)→ 不必浪费一次付费调用。
    if (!raw.includes("http") && !/\s/.test(raw) && SEC_UID_RE.test(raw)) {
      return raw;
    }

    // 批量接口(≤10 条),这里只发 1 条。
    const env = await this.http.post("/api/v1/douyin/web/get_all_sec_user_id", { url: [raw] });
    const secUid = extractSecUid(env.data);
    if (!secUid) {
      throw new TikHubError(
        "not_found",
        `[tikhub] 无法从输入解析出 sec_uid(链接可能已失效、或账号已注销): ${raw.slice(0, 80)}`,
      );
    }
    return secUid;
  }

  /**
   * 账号公开资料。走 **APP 接口** —— TikHub 官方文档明说「尽量用 APP 接口,
   * WEB 接口可能不稳定」。
   */
  async fetchUserProfile(secUid: string): Promise<DouyinUserProfile> {
    if (!secUid?.trim()) {
      throw new TikHubError("invalid_input", "[tikhub] fetchUserProfile 需要 sec_uid");
    }
    const env = await this.http.get("/api/v1/douyin/app/v3/handler_user_profile", {
      sec_user_id: secUid,
    });
    const profile = parseUserProfile(env.data);
    if (!profile) {
      // 私密 / 已注销账号会返回被过滤的空数据 —— 明确报出去,不要崩。
      throw new TikHubError(
        "not_found",
        `[tikhub] 未拿到账号资料(可能已注销或被过滤): ${secUid.slice(0, 24)}…`,
      );
    }
    return profile;
  }

  /**
   * 作品列表。max_cursor 翻页,count 不得超过 20(官方警告)。
   *
   * ⚠️ 这里拿到的 stats.playCount **基本都是 null** —— 播放量必须另走
   * fetchVideoStatistics。这是设计,不是 bug。
   */
  async fetchUserVideos(
    secUid: string,
    opts?: { maxPages?: number; pageSize?: number },
  ): Promise<DouyinVideo[]> {
    if (!secUid?.trim()) {
      throw new TikHubError("invalid_input", "[tikhub] fetchUserVideos 需要 sec_uid");
    }
    const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_MAX_PAGES);
    const pageSize = Math.min(Math.max(1, opts?.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

    const out: DouyinVideo[] = [];
    const seen = new Set<string>();
    let cursor = 0;

    for (let page = 0; page < maxPages; page++) {
      const env = await this.http.get("/api/v1/douyin/app/v3/fetch_user_post_videos", {
        sec_user_id: secUid,
        max_cursor: cursor,
        count: pageSize,
        sort_type: 0,
      });

      const list = extractAwemeList(env.data);
      if (page === 0 && list.length === 0 && isPrivateProfile(env.data)) {
        throw new TikHubError("private_account", `[tikhub] 账号为私密,拉不到作品: ${secUid.slice(0, 24)}…`);
      }

      for (const item of list) {
        const video = parseVideo(item);
        // 解析不出 aweme_id 的条目直接跳过,不因为一条脏数据把整页搞崩。
        if (video && !seen.has(video.awemeId)) {
          seen.add(video.awemeId);
          out.push(video);
        }
      }

      if (!hasMore(env.data)) break;
      const next = nextCursor(env.data);
      // 游标没前进 → 上游在原地打转,停下,否则会无限翻页。
      if (next === undefined || next === cursor) break;
      cursor = next;
    }

    return out;
  }

  /**
   * 真实播放量 —— **唯一可信来源**。
   *
   * 上游一次最多 2 个 aweme_id,所以这里强制按 2 个一批切分。
   * 返回的 Map 只包含上游确实回了数据的 id(删除/私密作品不会出现在结果里)。
   */
  async fetchVideoStatistics(awemeIds: string[]): Promise<Map<string, DouyinVideoStats>> {
    const out = new Map<string, DouyinVideoStats>();
    const ids = [...new Set((awemeIds ?? []).map((id) => id?.trim()).filter(Boolean))] as string[];
    if (ids.length === 0) return out;

    for (let i = 0; i < ids.length; i += STATISTICS_BATCH_SIZE) {
      const batch = ids.slice(i, i + STATISTICS_BATCH_SIZE);
      const env = await this.http.get("/api/v1/douyin/app/v3/fetch_video_statistics", {
        aweme_ids: batch.join(","),
      });
      for (const row of extractStatisticsList(env.data)) {
        const parsed = parseStatisticsRow(row);
        if (parsed) out.set(parsed.awemeId, parsed.stats);
      }
    }
    return out;
  }
}

/** 内部导出,便于测试断言形状。 */
export const _internals = { STATISTICS_BATCH_SIZE, MAX_PAGE_SIZE, isRecord };
