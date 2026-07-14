import type { BillingRates } from './config.js';

/**
 * 一次模型调用的 token 用量。
 *
 * ⚠️ `inputTokens` 与 `cachedInputTokens` **互不重叠**:
 * Anthropic 协议里 `usage.input_tokens` 已经**不含**命中缓存的部分,
 * 命中的那部分单独放在 `cache_read_input_tokens`。所以两者直接相加即为总输入,
 * 不要去重(实测:input 3448 → 120 + cache_read 3328)。
 */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

/**
 * 用量 → 点数。
 *
 * 计费一律**向上取整**:宁可多收 1 个点,也不能出现「花了 0.4 点收 0 点」
 * 的免费调用 —— 那是可以被无限刷的。
 */
export function usageToPoints(usage: TokenUsage, rates: BillingRates): number {
  const yuan =
    (usage.inputTokens * rates.yuanPer1mInput +
      usage.cachedInputTokens * rates.yuanPer1mCachedInput +
      usage.outputTokens * rates.yuanPer1mOutput) /
    1_000_000;
  return Math.ceil(yuan * rates.pointsPerYuan);
}

/**
 * 预留额度的估算(reserve 阶段用)。
 *
 * ## 为什么必须按「最坏情况」估
 *
 * 发请求前我们**不知道**会花多少 output token。如果低估,请求跑完发现钱不够 ——
 * 钱已经花出去了,拦不住了,只能让用户欠费。所以预留必须取**上界**:
 *
 *   - output 上界 = `max_tokens`(模型协议保证不会超)
 *   - input 上界 = 请求体里的 token 估算,且**按未命中缓存**算(最贵的那档)
 *
 * 真实用量在 settle 阶段回冲,多退。宁可预留多了暂时冻结,不能预留少了超卖。
 */
export function estimateWorstCasePoints(
  estimatedInputTokens: number,
  maxTokens: number,
  rates: BillingRates,
): number {
  return usageToPoints(
    {
      inputTokens: estimatedInputTokens, // 悲观:全部按新 input 计价,不假设命中缓存
      cachedInputTokens: 0,
      outputTokens: maxTokens,
    },
    rates,
  );
}

/**
 * 从请求体粗估 input token 数。
 *
 * 只用于**预留上界**,不用于计费(计费一律以上游返回的 `usage` 为准)。
 * 中文 ~1.5 char/token,英文 ~4 char/token;取保守的 1.5 保证是上界。
 */
export function estimateInputTokens(body: unknown): number {
  const chars = JSON.stringify(body ?? '').length;
  return Math.ceil(chars / 1.5);
}
