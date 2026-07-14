import { InsufficientCreditsError, type CostEvent, type CreditLedger, type Reservation } from './ledger.js';

/**
 * 内存账本 —— 用于单测和本地开发。生产用 SQL 实现(见 schema.ts)。
 *
 * Node 是单线程事件循环,所以「读余额 → 判断 → 扣减」这一段只要**不 await**,
 * 就天然是原子的。这里刻意把整个 reserve 写成同步代码块,语义上对齐 SQL 实现里
 * 那条 `UPDATE ... WHERE balance >= x` 的原子性。
 *
 * ⚠️ 改这个文件时不要在扣减中间插 await —— 一插,超卖窗口就回来了,
 * 而且单测里那个并发用例会立刻挂。
 */
export class InMemoryCreditLedger implements CreditLedger {
  private balances = new Map<string, number>();
  private reservations = new Map<string, Reservation>();
  private byRequestId = new Map<string, string>();
  private creditedRequests = new Set<string>();
  private events: CostEvent[] = [];
  private seq = 0;

  constructor(initial: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(initial)) this.balances.set(k, v);
  }

  async reserve(accountId: string, points: number, requestId: string): Promise<Reservation> {
    if (points < 0) throw new Error('reserve 点数不能为负');

    // 幂等:同一 requestId 重放(客户端重试)不重复冻结
    const existingId = this.byRequestId.get(requestId);
    if (existingId) {
      const existing = this.reservations.get(existingId);
      if (existing) return existing;
    }

    const balance = this.balances.get(accountId) ?? 0;
    if (balance < points) {
      throw new InsufficientCreditsError(accountId, points, balance);
    }
    this.balances.set(accountId, balance - points); // ← 与判断之间无 await,原子

    const reservation: Reservation = {
      id: `res_${++this.seq}`,
      accountId,
      reservedPoints: points,
      requestId,
      state: 'held',
    };
    this.reservations.set(reservation.id, reservation);
    this.byRequestId.set(requestId, reservation.id);
    return reservation;
  }

  async settle(reservationId: string, actualPoints: number, event: Omit<CostEvent, 'points'>): Promise<void> {
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error(`预留不存在:${reservationId}`);
    if (r.state !== 'held') return; // 幂等:重复结算是 no-op

    // 多退少补。真实用量理论上不会超过预留上界(output 受 max_tokens 约束),
    // 但如果上游返回了超出上界的用量,我们照实收 —— 账要对得上,不能凭空少收。
    const delta = r.reservedPoints - actualPoints;
    this.balances.set(r.accountId, (this.balances.get(r.accountId) ?? 0) + delta);

    r.state = 'settled';
    this.events.push({ ...event, points: actualPoints });
  }

  async release(reservationId: string): Promise<void> {
    const r = this.reservations.get(reservationId);
    if (!r || r.state !== 'held') return;
    this.balances.set(r.accountId, (this.balances.get(r.accountId) ?? 0) + r.reservedPoints);
    r.state = 'released';
  }

  async balance(accountId: string): Promise<number> {
    return this.balances.get(accountId) ?? 0;
  }

  async credit(accountId: string, points: number, requestId: string): Promise<void> {
    if (this.creditedRequests.has(requestId)) return; // 幂等:充值回调重复投递不重复加钱
    this.creditedRequests.add(requestId);
    this.balances.set(accountId, (this.balances.get(accountId) ?? 0) + points);
  }

  async listCostEvents(accountId: string): Promise<CostEvent[]> {
    return this.events.filter((e) => e.accountId === accountId);
  }
}
