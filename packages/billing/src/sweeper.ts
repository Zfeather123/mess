import type { CreditLedger } from './ledger.js';

/**
 * 超时预留回收(sweeper)。
 *
 * ## 这是两阶段扣费自带的失效模式,不是"增强"
 *
 * 网关的正常流程是 reserve → forward → settle。但如果进程在 reserve 之后、settle 之前
 * **被 kill**(部署、OOM、宿主机重启),那笔冻结就永远挂在 `held`:
 *
 *   - 用户的点数被扣走了(balance 减了)
 *   - 但没有任何用量明细(settle 没跑到)
 *   - 也没人会去退还它
 *
 * → **用户的算力凭空消失,而且账上查不出原因。** 这是 P0 级信任问题,
 *   引入两阶段扣费就必须同时把它闭环。
 *
 * ## 幂等:sweeper 和 settle 会撞车
 *
 * sweeper 扫到一笔超时 held 的**同一时刻**,那个"卡住"的请求可能刚好活过来要 settle。
 * 两边都去动余额 = **双花**(退一次 + 结算一次回冲,钱凭空多出来)。
 *
 * 靠状态机兜住:`held` 是唯一可变更的状态,`settle`/`release` 都必须以
 * "仅当当前是 held 才生效"的方式原子推进(SQL 里就是
 * `UPDATE ... SET state='released' WHERE id=$1 AND state='held'`,靠受影响行数判断)。
 * 谁先抢到谁生效,另一边变成 no-op。
 */
export interface SweeperOptions {
  /** 预留的存活时间。超过就认为发起方已经死了。 */
  ttlMs?: number;
  /** 每轮最多回收多少笔,避免一次扫爆。 */
  batchSize?: number;
}

export const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 分钟

/**
 * 预留 TTL 的唯一来源。
 *
 * 必须唯一 —— 冻结的 `expiresAt` 由 `BillingService` 写入,回收的 cutoff 由 sweeper 算,
 * 两边各读各的默认值 = 「按 15 分钟冻结、按 5 分钟回收」这类错位,会把还在飞的请求的钱退掉。
 */
export function loadReservationTtlMs(): number {
  const raw = process.env.BILLING_RESERVATION_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`[billing] BILLING_RESERVATION_TTL_MS 必须是正数,收到:${raw}`);
  }
  return v;
}

/**
 * 回收所有超时的 held 预留。返回实际回收的笔数。
 *
 * 设计成**可重复调用且无副作用累积** —— 定时任务每分钟跑一次即可,
 * 跑重了、并发跑了都不会多退钱(靠 release 的 held-only 状态机)。
 */
export async function sweepExpiredReservations(
  ledger: CreditLedger,
  options: SweeperOptions = {},
): Promise<number> {
  const ttlMs = options.ttlMs ?? loadReservationTtlMs();
  const batchSize = options.batchSize ?? 100;
  const cutoff = new Date(Date.now() - ttlMs);

  const expired = await ledger.findExpiredHolds(cutoff, batchSize);

  let recovered = 0;
  for (const reservation of expired) {
    // release 内部是 held-only 的原子推进:如果这一刻请求活过来 settle 了,
    // 这里就是 no-op,不会双花
    const released = await ledger.release(reservation.id);
    if (released) recovered += 1;
  }
  return recovered;
}

/** 起一个定时 sweeper。返回停止函数。 */
export function startSweeper(
  ledger: CreditLedger,
  intervalMs = 60_000,
  options: SweeperOptions = {},
): () => void {
  const timer = setInterval(() => {
    void sweepExpiredReservations(ledger, options).catch((err) => {
      // sweeper 挂了不能把进程带走,但必须吵 —— 它静默失效 = 用户点数持续泄漏
      console.error('[billing] sweeper 回收失败:', err);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
