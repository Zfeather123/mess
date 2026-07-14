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
 * 算力账本。
 *
 * ## 为什么是两阶段(reserve → settle),而不是事后 sum()
 *
 * 事后统计(`sum(cost_events) > 余额` 才拦)在并发下**必然超卖**:
 * 10 个请求同时进来,每个都看到「余额还够」,于是 10 个全放行 —— 但其实只够 1 个。
 * token 花出去了就要不回来,这不是加个事务能救的,是**时序**问题:
 * 上游扣的钱发生在我们知道用量**之前**。
 *
 * 所以必须先冻结(reserve)、再放行、最后按真实用量回冲(settle)。
 *
 * ## 实现方必须保证的原子性
 *
 * `reserve` **必须**是单条原子语句,SQL 实现长这样:
 *
 * ```sql
 * UPDATE credit_accounts
 *    SET balance_points = balance_points - $1
 *  WHERE id = $2 AND balance_points >= $1
 * RETURNING balance_points;
 * ```
 *
 * 靠 `WHERE balance_points >= $1` + 受影响行数判断成败 —— 0 行 = 余额不足。
 * ❌ 绝不能写成「先 SELECT 查余额,再 UPDATE 扣减」:两条语句之间就是超卖窗口。
 */
export interface CreditLedger {
  /** 冻结额度。余额不足抛 `InsufficientCreditsError`。同一 requestId 重复调用返回同一预留(幂等)。 */
  reserve(accountId: string, points: number, requestId: string): Promise<Reservation>;

  /** 按真实用量结算:实收 actualPoints,冻结的余额多退少补,并写一条用量明细。 */
  settle(reservationId: string, actualPoints: number, event: Omit<CostEvent, 'points'>): Promise<void>;

  /** 请求失败(上游报错),原样退回冻结额度,不产生用量明细。 */
  release(reservationId: string): Promise<void>;

  balance(accountId: string): Promise<number>;
  credit(accountId: string, points: number, requestId: string): Promise<void>;
  listCostEvents(accountId: string): Promise<CostEvent[]>;
}
