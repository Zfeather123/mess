import {
  BillingService,
  PgCreditLedger,
  loadRates,
  loadReservationTtlMs,
  sweepExpiredReservations,
  startSweeper,
} from '@jin/billing';
import { createDb, type Db } from '@paperclipai/db';

/**
 * 网关的计费运行时 —— 账本 + 崩溃恢复,一起交付。
 *
 * ## 为什么账本必须是 Postgres 的
 *
 * 在这之前网关构造的是 `new BillingService(new InMemoryCreditLedger())`:余额活在进程堆里。
 * 部署、OOM、宿主机重启 —— 任何一次进程重启,**所有用户的余额归零、所有冻结凭空消失**。
 * 三张计费表建好了却没有任何生产代码读写。`InMemoryCreditLedger` 从此只给测试用。
 *
 * ## 光换账本还不够:reserve 之后、settle 之前挂掉,那笔冻结谁来收?
 *
 * 落库把「余额丢失」换成了一个**更隐蔽**的失效模式:进程猝死时,那笔 `held` 会**原样躺在库里**
 * —— 余额没丢,但用户的可用额度被永久冻死,而且账上查不出原因。所以这个运行时把回收也一起兜住,
 * 两条腿缺一不可:
 *
 *   ① **启动时对账**(`sweepExpiredReservations`):上一次进程是被 kill 的,它留下的孤儿冻结
 *      在它死的那一刻就没人管了 —— 只靠定时器的话,要等下一个 interval 才回收。
 *      重启本来就是最容易产生孤儿冻结的时刻,启动即扫一遍是最便宜的止血。
 *   ② **常驻 sweeper**(`startSweeper`):进程活着时超时未 settle 的(上游卡死、请求被中断)。
 *
 * 回收靠 `release` 的 held-only 原子推进,天然幂等:sweeper 和 settle 撞车时谁先推离 `held`
 * 谁生效,另一边 no-op —— 不会「既退又扣」。
 */
export interface BillingRuntime {
  billing: BillingService;
  ledger: PgCreditLedger;
  /**
   * 这一份连接池 —— 会话解析(`PgSessionResolver`)复用它,不再另开一个池。
   * 网关每个请求都要查 session,给它单开一个池 = 同一个进程对同一个库开两份连接,
   * 白白吃掉 Postgres 的连接上限。
   */
  db: Db;
  /** 优雅停机:停掉 sweeper 并断开连接池。 */
  stop: () => Promise<void>;
}

export interface BillingRuntimeOptions {
  /** 已有的连接(测试注入)。给了它就不再按 url 新建连接池。 */
  db?: Db;
  databaseUrl?: string;
  /** 冻结的存活时间;超过它还挂在 held 就认为发起方已经死了。默认读 `BILLING_RESERVATION_TTL_MS`。 */
  ttlMs?: number;
  /** sweeper 的轮询间隔。 */
  sweepIntervalMs?: number;
}

export async function createBillingRuntime(options: BillingRuntimeOptions = {}): Promise<BillingRuntime> {
  const ownsDb = options.db === undefined;
  const db =
    options.db ??
    createDb(
      options.databaseUrl ??
        (() => {
          throw new Error('[gateway] createBillingRuntime 需要 db 或 databaseUrl');
        })(),
    );

  const ttlMs = options.ttlMs ?? loadReservationTtlMs();
  const ledger = new PgCreditLedger(db);
  // TTL 一处配置、两处使用:BillingService 拿它写 expiresAt,sweeper 拿它算回收 cutoff。
  const billing = new BillingService(ledger, loadRates(), ttlMs);

  // ① 启动即对账 —— 回收上一次进程猝死时留下的孤儿冻结
  const recovered = await sweepExpiredReservations(ledger, { ttlMs });
  if (recovered > 0) {
    console.warn(`[billing] 启动对账:回收了 ${recovered} 笔超时冻结(上次进程未正常结算)`);
  }

  // ② 常驻回收
  const stopSweeper = startSweeper(ledger, options.sweepIntervalMs ?? 60_000, { ttlMs });

  return {
    billing,
    ledger,
    db,
    async stop() {
      stopSweeper();
      if (ownsDb) await db.$client.end();
    },
  };
}
