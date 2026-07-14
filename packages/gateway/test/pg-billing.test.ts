import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  companies,
  computeAccounts,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from '@paperclipai/db';
import { createBillingRuntime, type BillingRuntime } from '../src/billing.js';
import { InMemorySessionResolver } from '../src/auth.js';
import type { GatewayConfig } from '../src/config.js';
import { createGateway } from '../src/server.js';

/**
 * 网关 + Postgres 账本的真机测试(JIN-73)。
 *
 * 这里验的**不是**账本自己的语义(那在 packages/billing/test/pg-ledger.test.ts),
 * 而是网关这条真实链路上、只有落库才成立的三件事:
 *
 *   ① **重启存活**:进程死一次再起来,余额不丢、**held 中的冻结也不丢**
 *      —— 内存账本这里必挂(它连「重启」这个概念都没有)。
 *   ② **崩溃恢复**:reserve 之后、settle 之前进程被 kill,那笔冻结不会永久冻死
 *      —— 新进程启动时对账把它收回来。
 *   ③ **两阶段扣费幂等**:同一 requestId 重放,不会扣两次。
 *
 * 「进程重启」的模拟方式:关掉 http server + 断开这一份连接池,再用**全新的** Db /
 * PgCreditLedger / BillingService 重建一遍。进程里所有跟计费有关的内存状态都换新了,
 * 唯一活下来的是 Postgres —— 这正是重启后的真实状态。
 */
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`跳过网关 Postgres 计费测试(本机不支持 embedded Postgres):${support.reason ?? 'unsupported'}`);
}

/** 假上游:normal = 正常返回 usage;hang = 收了请求就再也不答(模拟上游卡死 / 请求在飞行中)。 */
type UpstreamMode = 'normal' | 'hang';

describeDb('网关 → PgCreditLedger:重启存活 / 崩溃恢复 / 幂等', () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let connectionString: string;
  let setupDb: ReturnType<typeof createDb>;
  let companyId: string;
  let accountId: string;

  let upstream: Server;
  let upstreamUrl: string;
  let upstreamMode: UpstreamMode = 'normal';
  const hungResponses: ServerResponse[] = [];
  /** 上游真的收到请求了没 —— 用来确认「冻结已经发生、钱正在飞」。 */
  let upstreamHits = 0;

  const processes: Array<{ close: () => Promise<void> }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase('jin-gateway-billing-');
    connectionString = tempDb.connectionString;
    setupDb = createDb(connectionString);

    const company = await setupDb
      .insert(companies)
      .values({
        name: `Gateway ${randomUUID()}`,
        issuePrefix: `GW${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;

    upstream = createServer((req, res) => {
      upstreamHits += 1;
      if (upstreamMode === 'hang') {
        hungResponses.push(res); // 永不回应 —— 请求就卡在「已 reserve,未 settle」
        return;
      }
      void (async () => {
        for await (const _chunk of req) {
          // 读完请求体再答,否则 node 可能提前 destroy
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'message',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 120, cache_read_input_tokens: 3328, output_tokens: 50 },
          }),
        );
      })();
    });
    await new Promise<void>((r) => upstream.listen(0, r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  }, 180_000);

  afterAll(async () => {
    for (const res of hungResponses) res.destroy();
    upstream.close();
    await setupDb.$client.end();
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    upstreamMode = 'normal';
    upstreamHits = 0;
    const account = await setupDb
      .insert(computeAccounts)
      .values({
        companyId,
        ownerType: 'user',
        ownerId: randomUUID(),
        balancePoints: 100_000,
      })
      .returning()
      .then((rows) => rows[0]!);
    accountId = account.id;
  });

  afterEach(async () => {
    while (processes.length > 0) await processes.pop()!.close();
    for (const res of hungResponses.splice(0)) res.destroy();
  });

  function makeConfig(): GatewayConfig {
    return {
      port: 0,
      databaseUrl: connectionString,
      anthropicBaseUrl: upstreamUrl,
      anthropicApiKey: 'SERVER-SIDE-GLM-KEY',
      glmNativeBaseUrl: upstreamUrl,
      glmApiKey: 'SERVER-SIDE-GLM-KEY',
      models: { vision: 'glm-4.6v', image: 'cogview-4' },
      coverFontPath: '/nonexistent',
    };
  }

  /**
   * 起一个「网关进程」。每次调用都自建连接池 + 账本 + 计费服务 ——
   * 和真的换了个进程一样,除了 Postgres 什么都不共享。
   */
  async function bootGateway(options: { ttlMs?: number } = {}) {
    const runtime: BillingRuntime = await createBillingRuntime({
      databaseUrl: connectionString,
      ttlMs: options.ttlMs ?? 60_000,
      // sweeper 的定时器在测试里不参与判定 —— 我们要断言的是「启动对账」和显式调用,
      // 不是「等一个后台定时器碰巧跑到」。设得远远大于用例时长。
      sweepIntervalMs: 3_600_000,
    });
    const sessions = new InMemorySessionResolver({
      'session-abc': { accountId, agentId: null, issueId: null },
    });
    const server = createGateway({ config: makeConfig(), billing: runtime.billing, sessions });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const proc = {
      url,
      runtime,
      /** 模拟进程死亡:socket 全断、连接池关掉。活下来的只有 Postgres。 */
      close: async () => {
        server.closeAllConnections?.();
        server.close();
        await runtime.stop();
      },
    };
    processes.push(proc);
    return proc;
  }

  function send(url: string, requestId: string) {
    return fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': 'session-abc',
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ model: 'glm-4.6', max_tokens: 1024 }),
    });
  }

  async function snapshot(runtime: BillingRuntime) {
    const row = await runtime.ledger.snapshot(accountId);
    if (!row) throw new Error('账户不见了');
    return row;
  }

  /** 等到冻结真的落库(reserve 已发生),而不是靠 sleep 猜。 */
  async function waitForFrozen(runtime: BillingRuntime): Promise<number> {
    for (let i = 0; i < 200; i += 1) {
      const { frozenPoints } = await snapshot(runtime);
      if (frozenPoints > 0) return frozenPoints;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('冻结一直没出现');
  }

  it('① 重启后余额还在 —— 换进程重读,扣掉的还是扣掉的', async () => {
    const first = await bootGateway();
    const res = await send(first.url, `req-${randomUUID()}`);
    expect(res.status).toBe(200);

    const charged = 100_000 - (await snapshot(first.runtime)).balancePoints;
    expect(charged).toBeGreaterThan(0);
    const events = await first.runtime.ledger.listCostEvents(accountId);
    expect(events).toHaveLength(1);

    await first.close(); // ← 进程死

    const second = await bootGateway();
    const after = await snapshot(second.runtime);
    expect(after.balancePoints).toBe(100_000 - charged); // 余额不归零
    expect(after.frozenPoints).toBe(0);
    expect(await second.runtime.ledger.listCostEvents(accountId)).toHaveLength(1); // 明细还在
  });

  it('② 飞行中的请求:进程被 kill,冻结既不凭空消失、也不变成扣款', async () => {
    upstreamMode = 'hang';
    const first = await bootGateway();

    void send(first.url, `req-${randomUUID()}`).catch(() => {
      /* 进程被 kill,这个请求当然会断 —— 断了才对 */
    });
    const frozen = await waitForFrozen(first.runtime);
    expect(frozen).toBeGreaterThan(0);
    expect(upstreamHits).toBe(1); // 钱确实在飞:已冻结、已发出、未结算

    await first.close(); // ← reserve 之后、settle 之前进程死

    // TTL 还没到 → 新进程的启动对账**不能**碰它(请求可能还活着,收了就是双花)
    const second = await bootGateway({ ttlMs: 60_000 });
    const after = await snapshot(second.runtime);
    expect(after.frozenPoints).toBe(frozen); // 冻结原样躺在库里,没被"凭空释放"
    expect(after.balancePoints).toBe(100_000); // 也没被扣款(settle 从没跑到)
    expect(after.availablePoints).toBe(100_000 - frozen);
    expect(await second.runtime.ledger.listCostEvents(accountId)).toHaveLength(0);
  });

  it('③ 崩溃恢复:超时的孤儿冻结在新进程启动对账时被收回,钱不被永久冻死', async () => {
    upstreamMode = 'hang';
    const first = await bootGateway();

    void send(first.url, `req-${randomUUID()}`).catch(() => {});
    const frozen = await waitForFrozen(first.runtime);
    await first.close(); // ← 进程猝死,冻结成了孤儿

    // 新进程按 TTL=1ms 启动 —— 那笔孤儿冻结已经超时,createBillingRuntime 的启动对账应当收掉它
    await new Promise((r) => setTimeout(r, 10));
    const second = await bootGateway({ ttlMs: 1 });

    const after = await snapshot(second.runtime);
    expect(after.frozenPoints).toBe(0); // 冻结被回收
    expect(after.balancePoints).toBe(100_000); // 一分没扣(用户没拿到结果,不该付钱)
    expect(after.availablePoints).toBe(100_000);
    expect(await second.runtime.ledger.listCostEvents(accountId)).toHaveLength(0); // 回收 ≠ 消费
    expect(frozen).toBeGreaterThan(0);

    // 回收之后,这个账户能照常再发请求(不是"额度被吃掉了一块")
    upstreamMode = 'normal';
    const res = await send(second.url, `req-${randomUUID()}`);
    expect(res.status).toBe(200);
    expect((await snapshot(second.runtime)).balancePoints).toBeLessThan(100_000);
  });

  it('④ 同一 requestId 重放 —— 跨进程也只扣一次(两阶段扣费幂等)', async () => {
    const requestId = `req-${randomUUID()}`;
    const first = await bootGateway();
    expect((await send(first.url, requestId)).status).toBe(200);
    const afterFirst = await snapshot(first.runtime);

    // 同一进程内重放
    expect((await send(first.url, requestId)).status).toBe(200);
    expect((await snapshot(first.runtime)).balancePoints).toBe(afterFirst.balancePoints);

    await first.close();

    // 换进程重放 —— 幂等键在库里,不在内存里
    const second = await bootGateway();
    expect((await send(second.url, requestId)).status).toBe(200);

    const after = await snapshot(second.runtime);
    expect(after.balancePoints).toBe(afterFirst.balancePoints); // 没被扣第二、第三次
    expect(after.frozenPoints).toBe(0); // 重放也没留下新的冻结
    expect(await second.runtime.ledger.listCostEvents(accountId)).toHaveLength(1); // 一次请求一条明细
  });

  it('⑤ 可用额度 = 账面 - 冻结:冻结住的钱不能再被花第二次(402,请求不发上游)', async () => {
    const first = await bootGateway();

    // 账面还是 100_000,但全被在飞的请求冻住了。这里最容易出的错是「按账面余额放行」
    // —— 那就是同一笔钱被花两次。
    await first.runtime.ledger.reserve(accountId, 100_000, `hold-${randomUUID()}`, 60_000);
    const before = await snapshot(first.runtime);
    expect(before.balancePoints).toBe(100_000);
    expect(before.availablePoints).toBe(0);

    upstreamHits = 0;
    const res = await send(first.url, `req-${randomUUID()}`);
    expect(res.status).toBe(402);
    expect((await res.json()).error.type).toBe('insufficient_credits');
    expect(upstreamHits).toBe(0); // 上游一个 token 都没花
  });
});
