/**
 * @jin/tikhub — TikHub 抖音数据客户端。
 *
 * 能力边界(能拉到 / 拉不到)见 docs/jin/TIKHUB_CAPABILITIES.md。
 * 一句话:公开数据能拉;完播率/观众画像/涨粉净值这些**只存在于创作者后台**,
 * 需要账号主本人的 Cookie,MVP 不做。
 */
export type {
  DouyinUserProfile,
  DouyinVideo,
  DouyinVideoStats,
  PlayCountSource,
  TikHubClient,
  TikHubErrorCode,
} from "./types.js";

export { TikHubError } from "./errors.js";

export {
  TIKHUB_CN_BASE_URL,
  TIKHUB_DEFAULT_BASE_URL,
  loadTikhubConfig,
  type TikHubConfig,
} from "./config.js";

export { createTikHubClient, type TikHubClientDeps } from "./client.js";

// 解析器单独导出:同步任务需要用它们把库里存的 raw_aweme 重新解一遍(字段漂移排查)。
export {
  parseHashtags,
  parseStatisticsRow,
  parseUserProfile,
  parseVideo,
  parseVideoStats,
} from "./parse.js";
