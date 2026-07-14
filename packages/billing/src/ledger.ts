import type { TokenUsage } from './pricing.js';

/** 余额不足 —— 网关据此直接拒绝请求(不发给上游)。 */
export class InsufficientCreditsError extends Error {
  readonly code = 'insufficient_credits';
  constructor(
    readonly accountId: string,
    readonly requiredPoints: number,
    readonly balancePoints: number,
  ) {
    super(`算力不足:需要 ${requiredPoints} 点,余额 ${balancePoints} 点`);
    this.name = 'InsufficientCreditsError';
  }
}

export interface Reservation {
  id: string;
  accountId: string;
  /** 预留(冻结)的点数 —— 最坏情况上界。 */
  reservedPoints: number;
  requestId: string;
  state: 'held' | 'settled' | 'released';
  /** 超过这个时间还挂在 held,sweeper 会回收它。 */
  expiresAt: Date;
}

/** 结算后落到用量明细里的一条记录(对应 Paperclip 现成的 `cost_events` 表)。 */
export interface CostEvent {
  accountId: string;
  agentId: string | null;
  issueId: string | null;
  model: string;
  usage: TokenUsage;
  points: number;
  requestId: string;
  occurredAt: Date;
}

/**
 * 算力账本。落库对应 0148 的 `compute_accounts` / `compute_transactions`
 * + 0149 的 `compute_reservations`。
 *
 * ## 为什么是两阶段(reserve → settle),而不是事后 sum()
 *
 * 事后统计(`sum(cost_events) > 余额` 才拦)在并发下**必然超卖**:
 * 10 个请求同时进来,每个都看到「余额还够」,于是 10 个全放行 —— 但其实只够 1 个。
 * token 花出去了就要不回来,这不是加个事务能救的,是**时序**问题:
 * 上游扣的钱发生在我们知道用量**之前**。
 *
 * ## 实现方必须保证的两条原子性
 *
 * **1. reserve 必须是单条原子语句:**
 *
 * ```sql
 * UPDATE compute_accounts
 *    SET balance_points = balance_points - $1,
 *        frozen_points  = frozen_points  + $1
 *  WHERE id = $2 AND balance_points >= $1;   -- 受影响行数 = 是否成功
 * ```
 * ❌ 绝不能「先 SELECT 查余额,再 UPDATE 扣减」:两条语句之间就是超卖窗口。
 *
 * **2. settle / release 必须是 held-only 的原子推进:**
 *
 * ```sql
 * UPDATE compute_reservations SET state = 'released'
 *  WHERE id = $1 AND state = 'held';   -- 受影响行数 = 是否抢到
 * ```
 * 因为 **sweeper 和 settle 会撞车**:sweeper 扫到超时 held 的同一刻,
 * 那个卡住的请求可能刚好活过来要 settle。两边都动余额 = **双花**。
 * 谁先把状态推离 `held` 谁生效,另一边变 no-op。
 */
export interface CreditLedger {
  /** 冻结额度。余额不足抛 `InsufficientCreditsError`。同一 requestId 重复调用返回同一预留(幂等)。 */
  reserve(accountId: string, points: number, requestId: string, ttlMs: number): Promise<Reservation>;

  /**
   * 按真实用量结算:实收 actualPoints,冻结的余额多退少补,并写一条用量明细。
   * @returns 是否真的由本次调用完成结算(false = 已被 settle/release 抢先,no-op)
   */
  settle(reservationId: string, actualPoints: number, event: Omit<CostEvent, 'points'>): Promise<boolean>;

  /**
   * 退还冻结额度,不产生用量明细(用户没消费,不该付钱)。
   * 上游失败时由网关调用;进程猝死时由 sweeper 调用。
   * @returns 是否真的由本次调用完成退还(false = 已被抢先,no-op)
   */
  release(reservationId: string): Promise<boolean>;

  /** sweeper 用:找出创建时间早于 cutoff 且仍挂在 held 的预留。 */
  findExpiredHolds(cutoff: Date, limit: number): Promise<Reservation[]>;

  balance(accountId: string): Promise<number>;
  credit(accountId: string, points: number, requestId: string): Promise<void>;
  listCostEvents(accountId: string): Promise<CostEvent[]>;
}
