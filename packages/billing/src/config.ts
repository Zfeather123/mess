/**
 * 算力计费配置 —— 全部走环境变量,不硬编码。
 *
 * ## 为什么不能「1M token = 5 元」一口价
 *
 * 实测(JIN-51):同一个带 cache_control 断点的 system,第 2 次调用
 * input 3448 → 120,cache_read_input_tokens = 3328,**省 97%**。
 *
 * 缓存读取的 token 在上游本来就按 ~1/10 计价。如果我们对 cached_input 和
 * 新 input 收一样的钱:用户白白替缓存买单;反过来如果按缓存价收全部,我们亏。
 * 所以三档费率必须分开配。
 *
 * ⚠️ 具体倍率等 GLM 官方计价确认,先按下面的默认值跑。改这里不需要改代码。
 */

/** 每 100 万 token 的价格(元)+ 点数换算。 */
export interface BillingRates {
  yuanPer1mInput: number;
  yuanPer1mCachedInput: number;
  yuanPer1mOutput: number;
  pointsPerYuan: number;
}

export const DEFAULT_RATES: BillingRates = {
  yuanPer1mInput: 5.0,
  yuanPer1mCachedInput: 0.5, // 实测省 97%,按 1/10 计
  yuanPer1mOutput: 5.0,
  pointsPerYuan: 100,
};

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`[billing] ${name} 必须是非负数,收到:${raw}`);
  }
  return v;
}

export function loadRates(): BillingRates {
  return {
    yuanPer1mInput: num('BILLING_YUAN_PER_1M_INPUT', DEFAULT_RATES.yuanPer1mInput),
    yuanPer1mCachedInput: num('BILLING_YUAN_PER_1M_CACHED_INPUT', DEFAULT_RATES.yuanPer1mCachedInput),
    yuanPer1mOutput: num('BILLING_YUAN_PER_1M_OUTPUT', DEFAULT_RATES.yuanPer1mOutput),
    pointsPerYuan: num('BILLING_POINTS_PER_YUAN', DEFAULT_RATES.pointsPerYuan),
  };
}
