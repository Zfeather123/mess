import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  authSessions,
  authUsers,
  companies,
  companyMemberships,
  computeAccounts,
  computeReservations,
  computeTransactions,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from '@paperclipai/db';
import { createBillingRuntime, type BillingRuntime } from '../src/billing.js';
import { PgSessionResolver } from '../src/pg-session-resolver.js';
import type { GatewayConfig } from '../src/config.js';
import { createGateway } from '../src/server.js';

/**
 * 网关会话鉴权的真机测试(JIN-84)。
 *
 * 这里验的是**鉴权 ↔ 计费的接缝**,而且必须对着真 Postgres 的 `session` 表验 ——
 * 用 `InMemorySessionResolver` 塞假 session 的测试能写得一片绿,却把「生产上没人能打进来」
 * 这个洞原样放过去(JIN-84 的起因),也验不出「被拒的请求有没有偷偷冻结一笔钱」。
 *
 * 三条主张:
 *   ① **合法 session 打得进来**:真 session 行 → 200 → reserve/settle 正常落库。
 *   ② **非法 session 打不进来**:伪造 / 过期 / 已登出 / 不在活跃公司 / 跨公司歧义 → 401。
 *   ③ **被拒 = 零账本副作用**:reservations / transactions **一行都不许有**,余额和冻结原样。
 *      先 reserve 再失败会把额度冻死 —— 那正是 JIN-73 刚修掉的失效模式,不许从鉴权这边漏回来。
 */
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`跳过网关会话鉴权测试(本机不支持 embedded Postgres):${support.reason ?? 'unsupported'}`);
}

describeDb('网关会话鉴权:真 session 表 → Principal', () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let connectionString: string;
  let db: ReturnType<typeof createDb>;

  let upstream: Server;
  let upstreamUrl: string;
  let upstreamHits = 0;
  /** 上游看到的 x-api-key —— 用来确认客户端 token 没被透传出去。 */
  let seenAuth: string | undefined;

  let runtime: BillingRuntime;
  let gateway: Server;
  let gatewayUrl: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase('jin-gateway-session-');
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);

    upstream = createServer((req, res) => {
      upstreamHits += 1;
      seenAuth = req.headers['x-api-key'] as string | undefined;
      void (async () => {
        for await (const _chunk of req) {
          // 读完请求体再答
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

    const config: GatewayConfig = {
      port: 0,
      databaseUrl: connectionString,
      anthropicBaseUrl: upstreamUrl,
      anthropicApiKey: 'SERVER-SIDE-GLM-KEY',
      glmNativeBaseUrl: upstreamUrl,
      glmApiKey: 'SERVER-SIDE-GLM-KEY',
      models: { vision: 'glm-4.6v', image: 'cogview-4' },
      coverFontPath: '/nonexistent',
    };

    runtime = await createBillingRuntime({
      databaseUrl: connectionString,
      ttlMs: 60_000,
      sweepIntervalMs: 3_600_000,
    });
    // ← 生产入口(src/index.ts)构造的就是这个,连的是同一个连接池。测试不塞任何假 session。
    const sessions = new PgSessionResolver(runtime.db);
    gateway = createGateway({ config, billing: runtime.billing, sessions });
    await new Promise<void>((r) => gateway.listen(0, r));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  }, 180_000);

  afterAll(async () => {
    gateway?.closeAllConnections?.();
    gateway?.close();
    upstream?.close();
    await runtime?.stop();
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    upstreamHits = 0;
    seenAuth = undefined;
  });

  // -------------------------------------------------------------------------
  // 装置:全部走真表 —— company / user / company_memberships / session / compute_accounts
  // -------------------------------------------------------------------------

  async function createCompany(): Promise<string> {
    const [row] = await db
      .insert(companies)
      .values({
        name: `Session ${randomUUID()}`,
        issuePrefix: `SS${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    return row!.id;
  }

  async function createAccount(companyId: string, balancePoints: number): Promise<string> {
    const [row] = await db
      .insert(computeAccounts)
      .values({ companyId, ownerType: 'company', balancePoints })
      .returning();
    return row!.id;
  }

  /** 建一个真用户 + 真 membership + 真 session 行,返回**真 session token**。 */
  async function createSession(options: {
    companyIds: string[];
    /** membership 状态 —— 'archived' 用来验「已被移出公司的人打不进来」。 */
    membershipStatus?: string;
    expiresAt?: Date;
  }): Promise<{ token: string; userId: string }> {
    const now = new Date();
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      name: 'Session Tester',
      email: `${userId}@example.com`,
      createdAt: now,
      updatedAt: now,
    });

    for (const companyId of options.companyIds) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: 'user',
        principalId: userId,
        status: options.membershipStatus ?? 'active',
        membershipRole: 'member',
      });
    }

    const token = `sess_${randomUUID()}`;
    await db.insert(authSessions).values({
      id: `sid-${randomUUID()}`,
      token,
      userId,
      // 默认给一个未来的过期时间;过期用例显式传一个过去的时间。
      expiresAt: options.expiresAt ?? new Date(now.getTime() + 3_600_000),
      createdAt: now,
      updatedAt: now,
    });

    return { token, userId };
  }

  function send(token: string | null, requestId = `req-${randomUUID()}`) {
    return fetch(`${gatewayUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        ...(token === null ? {} : { 'x-api-key': token }),
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ model: 'glm-4.6', max_tokens: 1024 }),
    });
  }

  /** 这家公司在账本上留下的**全部**痕迹 —— 冻结、流水、余额。断言「零副作用」靠它。 */
  async function ledgerFootprint(companyId: string) {
    const [reservations, transactions, accounts] = await Promise.all([
      db.select().from(computeReservations).where(eq(computeReservations.companyId, companyId)),
      db.select().from(computeTransactions).where(eq(computeTransactions.companyId, companyId)),
      db
        .select()
        .from(computeAccounts)
        .where(and(eq(computeAccounts.companyId, companyId), eq(computeAccounts.ownerType, 'company'))),
    ]);
    return {
      reservations: reservations.length,
      transactions: transactions.length,
      balancePoints: Number(accounts[0]?.balancePoints ?? 0),
      frozenPoints: Number(accounts[0]?.frozenPoints ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // ① 合法 session 打得进来,且计费照常
  // -------------------------------------------------------------------------

  it('① 真 session 表里的合法会话 → 200,reserve/settle 正常落库,冻结收干净', async () => {
    const companyId = await createCompany();
    const accountId = await createAccount(companyId, 100_000);
    const { token } = await createSession({ companyIds: [companyId] });

    const res = await send(token);
    expect(res.status).toBe(200);

    const after = await ledgerFootprint(companyId);
    expect(after.balancePoints).toBeLessThan(100_000); // 真扣了钱
    expect(after.frozenPoints).toBe(0); // 两阶段走完,冻结不残留
    expect(after.reservations).toBe(1);
    expect(after.transactions).toBe(1); // 一次请求一条扣费明细

    const events = await runtime.ledger.listCostEvents(accountId);
    expect(events).toHaveLength(1);
    expect(events[0]!.usage).toEqual({ inputTokens: 120, cachedInputTokens: 3328, outputTokens: 50 });

    // 网关铁律:上游只该看到服务端的 GLM key,永远看不到用户的 session token
    expect(seenAuth).toBe('SERVER-SIDE-GLM-KEY');
    expect(seenAuth).not.toBe(token);
  });

  it('② 账户还没建(没充过值的公司)→ 402 余额不足,而不是 401;且不留下冻结', async () => {
    // 鉴权 ≠ 计费:「你还没充钱」必须长得像 402,不能长得像「你的 token 无效」——
    // 客户端对两者的处理完全不同(一个去充值,一个去重新登录)。
    const companyId = await createCompany();
    const { token } = await createSession({ companyIds: [companyId] });

    const res = await send(token);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('insufficient_credits');
    expect(upstreamHits).toBe(0); // 上游一个 token 都没花

    const after = await ledgerFootprint(companyId);
    expect(after.balancePoints).toBe(0); // 现建的 0 点账户
    expect(after.frozenPoints).toBe(0);
    expect(after.reservations).toBe(0); // 余额不足的 reserve 不该留下冻结
    expect(after.transactions).toBe(0);
  });

  // -------------------------------------------------------------------------
  // ② 非法 session 打不进来 —— 且**零账本副作用**
  // -------------------------------------------------------------------------

  const rejected: Array<{
    name: string;
    make: (companyId: string) => Promise<string | null>;
  }> = [
    {
      name: '伪造的 token(库里根本没有这一行)',
      make: async () => `sess_${randomUUID()}`,
    },
    {
      name: '过期的 session(行还在,expires_at 已过)',
      make: async (companyId) =>
        (await createSession({ companyIds: [companyId], expiresAt: new Date(Date.now() - 1_000) })).token,
    },
    {
      name: '已登出的 session(行被删掉)',
      make: async (companyId) => {
        const { token } = await createSession({ companyIds: [companyId] });
        await db.delete(authSessions).where(eq(authSessions.token, token)); // better-auth 登出就是删行
        return token;
      },
    },
    {
      name: '已被移出公司的人(membership archived)',
      make: async (companyId) =>
        (await createSession({ companyIds: [companyId], membershipStatus: 'archived' })).token,
    },
    {
      name: '完全不带 token',
      make: async () => null,
    },
  ];

  for (const { name, make } of rejected) {
    it(`③ 拒绝:${name} → 401,且账本零写入`, async () => {
      const companyId = await createCompany();
      await createAccount(companyId, 100_000);
      const token = await make(companyId);

      const res = await send(token);
      expect(res.status).toBe(401);
      expect(upstreamHits).toBe(0); // 没转发 = 没花上游的钱

      // 关键断言:被拒的请求**一行账本都不许写**。
      // 「先 reserve 再鉴权失败」= 冻结一笔永远不会被 settle 的钱 → 用户额度被冻死。
      const after = await ledgerFootprint(companyId);
      expect(after.reservations).toBe(0);
      expect(after.transactions).toBe(0);
      expect(after.balancePoints).toBe(100_000); // 余额原样
      expect(after.frozenPoints).toBe(0); // 冻结原样
    });
  }

  it('④ 跨公司的会话不猜扣谁的账 → 401,零账本写入', async () => {
    // 一个用户同时活跃在两家公司:「这笔算力扣谁的账」没有唯一答案。
    // 猜错 = 拿 A 公司的钱付 B 公司的账。宁可拒绝。
    const companyA = await createCompany();
    const companyB = await createCompany();
    await createAccount(companyA, 100_000);
    await createAccount(companyB, 100_000);
    const { token } = await createSession({ companyIds: [companyA, companyB] });

    const res = await send(token);
    expect(res.status).toBe(401);
    expect(upstreamHits).toBe(0);

    for (const companyId of [companyA, companyB]) {
      const after = await ledgerFootprint(companyId);
      expect(after.reservations).toBe(0);
      expect(after.transactions).toBe(0);
      expect(after.balancePoints).toBe(100_000);
      expect(after.frozenPoints).toBe(0);
    }
  });

  it('⑤ 一个用户的 session 扣不到另一个用户公司的账(不越界)', async () => {
    const mine = await createCompany();
    const theirs = await createCompany();
    await createAccount(mine, 100_000);
    await createAccount(theirs, 100_000);
    const { token } = await createSession({ companyIds: [mine] });

    expect((await send(token)).status).toBe(200);

    const theirLedger = await ledgerFootprint(theirs);
    expect(theirLedger.balancePoints).toBe(100_000); // 别人的钱一分没动
    expect(theirLedger.reservations).toBe(0);
    expect(theirLedger.transactions).toBe(0);
  });

  it('⑥ 会话解析直接测:PgSessionResolver 只认活的 session', async () => {
    const companyId = await createCompany();
    const accountId = await createAccount(companyId, 100_000);
    const resolver = new PgSessionResolver(runtime.db);

    const { token } = await createSession({ companyIds: [companyId] });
    expect(await resolver.resolve(token)).toEqual({ accountId, agentId: null, issueId: null });

    expect(await resolver.resolve(`sess_${randomUUID()}`)).toBeNull(); // 伪造
    expect(await resolver.resolve('')).toBeNull(); // 空
    expect(await resolver.resolve('   ')).toBeNull(); // 空白
    expect(await resolver.resolve(`${token}x`)).toBeNull(); // 前缀匹配不算数
  });
});
