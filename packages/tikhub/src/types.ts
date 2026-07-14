/**
 * TikHub 抖音数据客户端的对外类型。
 *
 * ⚠️ 上游契约的根本性质:TikHub 的响应信封是 `{ code, router, params, data }`,
 * 其中 `data` 是**抖音原始对象的透传**,openapi.json(V5.3.2)把它声明为无类型。
 * 也就是说:下面每一个字段名都是「最佳猜测 + 防御式解析」,不是 spec 保证的。
 * 上游抖音改版会直接改变字段 → 见 docs/jin/TIKHUB_CAPABILITIES.md §6「必做实测清单」。
 *
 * 因此本包的解析器**永不因缺字段而抛错**:缺了就是 undefined,不是崩溃。
 */

/**
 * 播放量的来源 —— 决定这个数可不可信。
 *
 * - `statistics_api`:走专用统计接口 fetch_video_statistics 拿到的,可信。
 * - `aweme_payload`:作品列表里自带的,**大多数情况下是 0/缺失**,只有在确实
 *   带回了非 0 值时才会标成这个来源。
 *
 * 取值与 DB 侧 CHECK 约束对齐:
 * douyin_video_metrics.play_count_source IN ('statistics_api','aweme_payload')
 * (packages/db/src/migrations/0150_douyin_sync_and_profile_sources.sql)
 */
export type PlayCountSource = "statistics_api" | "aweme_payload";

/** 抖音账号的公开资料。 */
export interface DouyinUserProfile {
  secUid: string;
  uid?: string;
  uniqueId?: string;
  nickname: string;
  avatarUrl?: string;
  signature?: string;
  followerCount: number;
  followingCount: number;
  awemeCount: number;
  totalFavorited: number;
  /** 省份 / IP 属地 → 用来推 city。 */
  ipLocation?: string;
  /** 个人认证,如 "XX律所律师" → 高价值,用来推 law_firm。 */
  customVerify?: string;
  enterpriseVerifyReason?: string;
  /** 原始透传对象,留档用于字段漂移排查。 */
  raw: Record<string, unknown>;
}

/** 单条作品的互动指标。 */
export interface DouyinVideoStats {
  diggCount: number;
  commentCount: number;
  shareCount: number;
  collectCount: number;
  /**
   * ⚠️ `null` = **没拉到**,不等于 0 播放。
   *
   * 抖音大多数接口已不再返回播放数。把「没拉到」写成 0 会让爆款识别
   * 把未同步的作品误判成扑街 —— 所以这里绝不伪造 0。
   */
  playCount: number | null;
  /** playCount 为 null 时必然为 null。 */
  playCountSource: PlayCountSource | null;
}

/** 单条作品。 */
export interface DouyinVideo {
  awemeId: string;
  description?: string;
  /** 抖音返回的秒级 unix 时间戳。 */
  createTime?: number;
  durationMs?: number;
  coverUrl?: string;
  shareUrl?: string;
  /** 从 text_extra[] 提取的话题标签(不含 #)。 */
  hashtags: string[];
  stats: DouyinVideoStats;
  raw: Record<string, unknown>;
}

export type TikHubErrorCode =
  | "unauthorized"
  | "insufficient_balance"
  | "rate_limited"
  | "not_found"
  | "private_account"
  | "upstream_error"
  | "network_error"
  | "invalid_input";

export interface TikHubClient {
  /**
   * 接受:分享短链 v.douyin.com/xxx、整段分享口令文案(「长按复制此条消息…」)、
   * 长链、或直接就是 sec_uid。原样透传给上游,不在本地做正则拆解。
   */
  resolveSecUid(input: string): Promise<string>;
  fetchUserProfile(secUid: string): Promise<DouyinUserProfile>;
  fetchUserVideos(
    secUid: string,
    opts?: { maxPages?: number; pageSize?: number },
  ): Promise<DouyinVideo[]>;
  /**
   * ⚠️ 上游接口一次**最多 2 个 aweme_id**,本方法内部自动分批。
   * 返回的 Map 只包含上游确实回了数据的 aweme_id。
   */
  fetchVideoStatistics(awemeIds: string[]): Promise<Map<string, DouyinVideoStats>>;
}
