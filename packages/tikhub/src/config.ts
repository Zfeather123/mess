/**
 * TikHub 配置。
 *
 * token 只在服务端 —— TikHub 的定位是「我们用**自己的**服务端 token 拉抖音公开数据」,
 * 不碰用户的抖音登录态(见 docs/jin/TIKHUB_CAPABILITIES.md §5)。
 *
 * 环境变量沿用仓库 `.env.example` 里已经声明好的两个(第 28-29 行),不另起一套:
 *   TIKHUB_API_KEY=
 *   TIKHUB_BASE_URL=https://api.tikhub.io
 *
 * ⚠️ 大陆网络环境必须换域名:`https://api.tikhub.dev`(路径完全相同,只是可达性不同)。
 * 部署在国内节点却用 api.tikhub.io 会直接连不上。
 */
export interface TikHubConfig {
  apiKey: string;
  /** 默认 https://api.tikhub.io;大陆用 https://api.tikhub.dev。 */
  baseUrl: string;
  /** 单请求超时,默认 30s。 */
  timeoutMs: number;
  /** 单请求最大尝试次数(含首次),默认 3。 */
  maxAttempts: number;
  /** 客户端侧限流上限。TikHub 官方限制 10 QPS。 */
  maxQps: number;
}

export const TIKHUB_DEFAULT_BASE_URL = "https://api.tikhub.io";
/** 大陆可达域名 —— 路径与 .io 完全一致。 */
export const TIKHUB_CN_BASE_URL = "https://api.tikhub.dev";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`[tikhub] 缺少环境变量 ${name}`);
  return v;
}

export function loadTikhubConfig(): TikHubConfig {
  return {
    apiKey: required("TIKHUB_API_KEY"),
    baseUrl: process.env.TIKHUB_BASE_URL?.trim() || TIKHUB_DEFAULT_BASE_URL,
    timeoutMs: Number(process.env.TIKHUB_TIMEOUT_MS ?? 30_000),
    maxAttempts: Number(process.env.TIKHUB_MAX_ATTEMPTS ?? 3),
    maxQps: Number(process.env.TIKHUB_MAX_QPS ?? 10),
  };
}
