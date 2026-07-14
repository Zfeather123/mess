import type { DouyinUserProfile, DouyinVideo, DouyinVideoStats } from "./types.js";

/**
 * 防御式解析层。
 *
 * TikHub 把 `data` 声明为**无类型透传**(openapi.json V5.3.2),所以下面每个字段名
 * 都是最佳猜测。铁律:
 *   - 缺字段 → undefined,**绝不抛错**
 *   - 数字可能是 string(抖音的 total_favorited 常见返回字符串)→ 统一强转
 *   - 播放量拿不到 → null,**绝不伪造 0**
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 读嵌套路径,任一层缺失都返回 undefined。 */
function dig(root: unknown, ...path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** number | 数字字符串 → number;其余 → undefined(注意:0 是合法值,不能被吞掉)。 */
export function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 计数字段:拿不到就 0(互动数缺失按 0 处理是安全的 —— 播放量除外,见下)。 */
function count(v: unknown): number {
  return toNum(v) ?? 0;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** 抖音把图片嵌套成 { url_list: [...] } —— 取第一个可用的。 */
function urlFrom(v: unknown): string | undefined {
  if (typeof v === "string") return str(v);
  const list = dig(v, "url_list");
  if (Array.isArray(list)) {
    for (const item of list) {
      const s = str(item);
      if (s) return s;
    }
  }
  return undefined;
}

/** 从多个候选里取第一个非空 —— 上游字段名在 app / web 接口之间不一致。 */
function firstUrl(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    const u = urlFrom(c);
    if (u) return u;
  }
  return undefined;
}

/**
 * profile 的 data 形状:app/v3/handler_user_profile 返回 `data.user`,
 * 但 web 接口有时直接把 user 摊平在 data 上 → 两种都认。
 * 【待实测】确切嵌套层级需要用真 key 打一次快照确认。
 */
export function parseUserProfile(raw: unknown): DouyinUserProfile | null {
  const root = isRecord(raw) ? raw : {};
  const u = isRecord(root.user) ? root.user : root;

  const secUid = str(u.sec_uid) ?? str(u.sec_user_id);
  // 连 sec_uid 和 nickname 都没有 → 这不是一个用户对象(私密/已注销账号会返回被过滤的空壳)。
  if (!secUid && str(u.nickname) === undefined) return null;

  return {
    secUid: secUid ?? "",
    uid: str(u.uid) ?? (toNum(u.uid) !== undefined ? String(u.uid) : undefined),
    uniqueId: str(u.unique_id) ?? str(u.short_id),
    nickname: str(u.nickname) ?? "",
    avatarUrl: firstUrl(u.avatar_larger, u.avatar_medium, u.avatar_168x168, u.avatar_thumb),
    signature: str(u.signature),
    followerCount: count(u.follower_count),
    followingCount: count(u.following_count),
    awemeCount: count(u.aweme_count),
    // 抖音这个字段常以字符串返回。
    totalFavorited: count(u.total_favorited),
    ipLocation: str(u.ip_location) ?? str(u.province),
    customVerify: str(u.custom_verify),
    enterpriseVerifyReason: str(u.enterprise_verify_reason),
    raw: isRecord(raw) ? raw : {},
  };
}

/** 账号是否私密 —— 私密号能拿到资料但拉不到作品。【待实测】字段名。 */
export function isPrivateProfile(raw: unknown): boolean {
  const root = isRecord(raw) ? raw : {};
  const u = isRecord(root.user) ? root.user : root;
  return toNum(u.secret) === 1 || u.private_account === true || toNum(u.private_account) === 1;
}

/**
 * 作品列表里的 stats。
 *
 * ⚠️ 核心陷阱:抖音大多数接口**已不再返回播放数**,列表里的 play_count 基本是 0/缺失。
 * 所以这里只在它确实带回**非 0**值时才认(标 aweme_payload),否则一律 null。
 * 「没拉到」(null)必须能和「真的 0 播放」(0)区分开 —— 否则爆款识别会把
 * 没同步到数据的作品误判成扑街。**绝不伪造 0。**
 */
export function parseVideoStats(rawAweme: unknown): DouyinVideoStats {
  const root = isRecord(rawAweme) ? rawAweme : {};
  // 优先 statistics.*,退化到顶层扁平形状。
  const s = isRecord(root.statistics) ? root.statistics : root;

  const rawPlay = toNum(s.play_count);
  const trustworthy = rawPlay !== undefined && rawPlay > 0;

  return {
    diggCount: count(s.digg_count),
    commentCount: count(s.comment_count),
    shareCount: count(s.share_count),
    collectCount: count(s.collect_count),
    playCount: trustworthy ? rawPlay : null,
    playCountSource: trustworthy ? "aweme_payload" : null,
  };
}

/**
 * 专用统计接口 fetch_video_statistics 的一行。
 * 该接口只回 digg_count / download_count / play_count / share_count ——
 * **没有 comment/collect**,所以那两个在这里是 0,调用方应与列表 stats 合并使用。
 * 播放量来源标为 statistics_api(可信)。
 */
export function parseStatisticsRow(row: unknown): { awemeId: string; stats: DouyinVideoStats } | null {
  if (!isRecord(row)) return null;
  const awemeId = str(row.aweme_id) ?? (toNum(row.aweme_id) !== undefined ? String(row.aweme_id) : undefined);
  if (!awemeId) return null;

  const play = toNum(row.play_count);
  return {
    awemeId,
    stats: {
      diggCount: count(row.digg_count),
      commentCount: count(row.comment_count),
      shareCount: count(row.share_count),
      collectCount: count(row.collect_count),
      // 专用接口回了就认(包括真实的 0);没回就是 null。
      playCount: play ?? null,
      playCountSource: play === undefined ? null : "statistics_api",
    },
  };
}

/** 从 text_extra[] 提取话题。抖音在 hashtag_name 里放不带 # 的纯文本。 */
export function parseHashtags(rawAweme: unknown): string[] {
  const root = isRecord(rawAweme) ? rawAweme : {};
  const list = root.text_extra;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const tag = str(item.hashtag_name);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export function parseVideo(rawAweme: unknown): DouyinVideo | null {
  if (!isRecord(rawAweme)) return null;
  const awemeId =
    str(rawAweme.aweme_id) ??
    (toNum(rawAweme.aweme_id) !== undefined ? String(rawAweme.aweme_id) : undefined);
  // 没有 aweme_id 的条目无法入库(DB 侧 company_id+aweme_id 是唯一键)→ 丢弃而不是抛错。
  if (!awemeId) return null;

  // video.duration 是毫秒;顶层 duration 在部分接口里也是毫秒。【待实测】
  const durationMs = toNum(dig(rawAweme, "video", "duration")) ?? toNum(rawAweme.duration);

  return {
    awemeId,
    description: str(rawAweme.desc),
    createTime: toNum(rawAweme.create_time),
    durationMs,
    coverUrl: firstUrl(
      dig(rawAweme, "video", "cover"),
      dig(rawAweme, "video", "origin_cover"),
      dig(rawAweme, "video", "dynamic_cover"),
      rawAweme.cover,
    ),
    shareUrl: str(dig(rawAweme, "share_info", "share_url")) ?? str(rawAweme.share_url),
    hashtags: parseHashtags(rawAweme),
    stats: parseVideoStats(rawAweme),
    raw: rawAweme,
  };
}

/**
 * 从任意形状的响应里挖出 sec_uid。
 *
 * 为什么用递归搜索而不是写死路径:get_all_sec_user_id 是批量接口,spec 没有给出
 * data 的类型,实际形状可能是 [{url, sec_user_id}] / {sec_user_id} / {data:[...]}。
 * 递归找第一个 sec_user_id|sec_uid 键,对形状漂移免疫。【待实测】确切形状。
 */
export function extractSecUid(data: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = extractSecUid(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(data)) return undefined;

  for (const key of ["sec_user_id", "sec_uid"]) {
    const v = str(data[key]);
    if (v) return v;
  }
  for (const v of Object.values(data)) {
    const found = extractSecUid(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** 从列表响应里找 aweme 数组 —— app / web 接口的键名不完全一致。 */
export function extractAwemeList(data: unknown): unknown[] {
  const root = isRecord(data) ? data : {};
  for (const key of ["aweme_list", "awemeList", "videos", "data"]) {
    const v = root[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** 从统计接口响应里找结果数组。【待实测】键名。 */
export function extractStatisticsList(data: unknown): unknown[] {
  const root = isRecord(data) ? data : {};
  for (const key of ["statistics_list", "statistics", "aweme_statistics", "data"]) {
    const v = root[key];
    if (Array.isArray(v)) return v;
  }
  return Array.isArray(data) ? data : [];
}

/** has_more 可能是 boolean、1/0、"1"。 */
export function hasMore(data: unknown): boolean {
  const root = isRecord(data) ? data : {};
  const v = root.has_more;
  if (typeof v === "boolean") return v;
  return toNum(v) === 1;
}

/** max_cursor 用于翻页。 */
export function nextCursor(data: unknown): number | undefined {
  const root = isRecord(data) ? data : {};
  return toNum(root.max_cursor);
}
