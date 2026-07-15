import { and, eq, gt } from 'drizzle-orm';
import {
  authSessions,
  companyMemberships,
  computeAccounts,
  type Db,
} from '@paperclipai/db';
import type { Principal, SessionResolver } from './auth.js';

/**
 * 生产的会话解析:Paperclip 的 `session` 表(better-auth 建的那张)→ Principal。
 *
 * ## 为什么必须是它
 *
 * 在这之前网关构造的是 `new InMemorySessionResolver()` —— 一个**空的** map。
 * 空 map 的 `resolve()` 对任何 token 都返回 null,于是**每一个真实用户都是 401**:
 * 计费算得再准,也没人能合法地打进来。`InMemorySessionResolver` 从此只给测试用。
 *
 * ## 「起不来」是这里的正确行为,不是故障
 *
 * 计费上「优雅降级到内存账本」= 无声丢钱;鉴权上「优雅降级到内存」= **无声放行**。
 * 所以这条路径上没有任何 try/catch 回落:库连不上就让进程起不来 / 让请求 503,
 * 绝不把「我查不到」翻译成「那就放行吧」。
 *
 * ## token → 扣谁的账
 *
 *   session(token 未过期) → user_id
 *   → company_memberships(principal_type='user', status='active') → company_id
 *   → compute_accounts(owner_type='company') → account_id
 *
 * 一条 JOIN 走完,不做「先查 session 再查 membership 再查 account」的 N 连查。
 *
 * ⚠️ **跨公司的会话不猜**:一个用户属于多家公司时,「这笔算力扣谁的账」没有唯一答案。
 * 猜错 = 拿 A 公司的钱付 B 公司的账。这里直接拒绝(401),等客户端把公司维度带上来
 * 再放行 —— 宁可拒绝,绝不乱扣。
 *
 * ⚠️ `agentId` / `issueId` 恒为 null:session 表只知道「哪个用户」,不知道「哪个员工在跑哪个任务」。
 * 客户端自称的 agent/issue 是**不可信输入**(它能把消费栽给别的员工),要落这两个维度必须先有
 * 一条可信通道(服务端签发的、把 agent/issue 绑进去的短期凭证)。在那之前:宁可少一列归因,
 * 不可多一列假数据。扣费本身不受影响 —— account 才是钱的主体。
 */
export class PgSessionResolver implements SessionResolver {
  constructor(private readonly db: Db) {}

  async resolve(sessionToken: string): Promise<Principal | null> {
    const token = sessionToken.trim();
    if (!token) return null;

    // 过期判定放在 SQL 里,和取行是同一次判断 —— 应用层「取出来再比时间」会给出
    // 一个可被时钟漂移/忘记比较绕过的窗口。
    const rows = await this.db
      .select({
        companyId: companyMemberships.companyId,
        accountId: computeAccounts.id,
        accountStatus: computeAccounts.status,
      })
      .from(authSessions)
      .innerJoin(
        companyMemberships,
        and(
          eq(companyMemberships.principalType, 'user'),
          eq(companyMemberships.principalId, authSessions.userId),
          eq(companyMemberships.status, 'active'),
        ),
      )
      .leftJoin(
        computeAccounts,
        and(
          eq(computeAccounts.companyId, companyMemberships.companyId),
          eq(computeAccounts.ownerType, 'company'),
        ),
      )
      .where(and(eq(authSessions.token, token), gt(authSessions.expiresAt, new Date())))
      // 只要 2 行就够判「有没有歧义」—— 不必把用户的全部公司都拉回来
      .limit(2);

    // 没有行 = token 不存在 / 已过期 / 用户不在任何活跃公司里。三种都只有一个回答:401。
    // 不区分原因,也不在响应里透露是哪一种(枚举 token 的人不该拿到线索)。
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      console.warn('[gateway] 会话横跨多家公司,无法确定扣谁的账 —— 拒绝(不猜)');
      return null;
    }

    const row = rows[0]!;
    // 账户还没建 = 「这个用户还没充过值」,不是「这个用户非法」。
    // 鉴权 ≠ 计费:这里现建一个 0 点账户放行,让后面的 reserve 给出 402(余额不足),
    // 而不是让它长得像 401(无效 token)—— 两种错客户端的处理方式完全不同。
    const accountId = row.accountId ?? (await this.ensureCompanyAccount(row.companyId));
    return { accountId, agentId: null, issueId: null };
  }

  /** 取公司账户,没有就现建(并发首访靠唯一索引 `compute_accounts_company_owner_uq` 兜住)。 */
  private async ensureCompanyAccount(companyId: string): Promise<string> {
    await this.db
      .insert(computeAccounts)
      .values({ companyId, ownerType: 'company' })
      .onConflictDoNothing();

    const [row] = await this.db
      .select({ id: computeAccounts.id })
      .from(computeAccounts)
      .where(and(eq(computeAccounts.companyId, companyId), eq(computeAccounts.ownerType, 'company')))
      .limit(1);
    if (!row) throw new Error(`[gateway] 算力账户创建失败:company ${companyId}`);
    return row.id;
  }
}
