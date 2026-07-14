import { loadRates, type BillingRates } from './config.js';
import type { CreditLedger, Reservation } from './ledger.js';
import { DEFAULT_TTL_MS } from './sweeper.js';
import { estimateInputTokens, estimateWorstCasePoints, usageToPoints, type TokenUsage } from './pricing.js';

export interface ChargeContext {
  accountId: string;
  agentId: string | null;
  issueId: string | null;
  model: string;
  requestId: string;
}

/**
 * 计费服务 —— 网关的收口。
 *
 * 用法(网关里就这三步,顺序不能变):
 *
 * ```ts
 * const hold = await billing.reserveForRequest(ctx, body);  // ① 余额不够,这里就抛,请求根本不发出去
 * try {
 *   const res = await forwardToGlm(body);                    // ② 放行
 *   await billing.settleFromUsage(hold, ctx, res.usage);     // ③ 按真实 usage 回冲 + 落明细
 * } catch (e) {
 *   await billing.releaseOnFailure(hold);                    //    上游挂了,原样退还
 *   throw e;
 * }
 * ```
 */
export class BillingService {
  constructor(
    private readonly ledger: CreditLedger,
    private readonly rates: BillingRates = loadRates(),
    /** 预留的 TTL。超时未 settle 的冻结由 sweeper 回收(见 sweeper.ts)。 */
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** ① 按最坏情况冻结额度。余额不足抛 InsufficientCreditsError —— 网关据此 402,不转发。 */
  async reserveForRequest(ctx: ChargeContext, body: { max_tokens?: number }): Promise<Reservation> {
    const estInput = estimateInputTokens(body);
    // max_tokens 缺省时给一个保守上界,否则 output 就没有上界可冻结了
    const maxTokens = body.max_tokens ?? 4096;
    const worstCase = estimateWorstCasePoints(estInput, maxTokens, this.rates);
    return this.ledger.reserve(ctx.accountId, worstCase, ctx.requestId, this.ttlMs);
  }

  /** ③ 按上游返回的真实 usage 结算(多退少补),并写入用量明细。 */
  async settleFromUsage(hold: Reservation, ctx: ChargeContext, usage: TokenUsage): Promise<number> {
    const points = usageToPoints(usage, this.rates);
    await this.ledger.settle(hold.id, points, {
      accountId: ctx.accountId,
      agentId: ctx.agentId,
      issueId: ctx.issueId,
      model: ctx.model,
      usage,
      requestId: ctx.requestId,
      occurredAt: new Date(),
    });
    return points;
  }

  /**
   * 固定点数预留 —— 给**不按 token 计价**的能力用(如 CogView 出图:按张收费)。
   */
  async reserveFixed(ctx: ChargeContext, points: number): Promise<Reservation> {
    return this.ledger.reserve(ctx.accountId, points, ctx.requestId, this.ttlMs);
  }

  /** 固定点数结算。token 用量记 0(本来就不是 token 计价),点数记固定值。 */
  async settleFixed(hold: Reservation, ctx: ChargeContext, points: number): Promise<number> {
    await this.ledger.settle(hold.id, points, {
      accountId: ctx.accountId,
      agentId: ctx.agentId,
      issueId: ctx.issueId,
      model: ctx.model,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      requestId: ctx.requestId,
      occurredAt: new Date(),
    });
    return points;
  }

  /** 上游失败:原样退还冻结,不产生明细(用户没消费,不该付钱)。 */
  async releaseOnFailure(hold: Reservation): Promise<void> {
    await this.ledger.release(hold.id);
  }

  balance(accountId: string): Promise<number> {
    return this.ledger.balance(accountId);
  }
}
