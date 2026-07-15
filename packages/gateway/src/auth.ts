/**
 * 会话鉴权:sessionToken → principal。
 *
 * 客户端把 sessionToken 塞在 `x-api-key`(因为 Agent SDK 是拿它当 ANTHROPIC_API_KEY 用的)。
 * **这不是模型 key** —— 它只代表「哪个用户的哪个 AI 员工在说话」,决定这笔算力扣谁的账。
 */
export interface Principal {
  accountId: string;
  agentId: string | null;
  issueId: string | null;
}

export interface SessionResolver {
  resolve(sessionToken: string): Promise<Principal | null>;
}

/**
 * ⚠️ **测试专用,生产路径不可达。** 生产走 `PgSessionResolver`(Paperclip 的 session 表)。
 *
 * 这个类曾经**就是**生产实现:`src/index.ts` 里 `new InMemorySessionResolver()` 构造了一个
 * 空 map,于是每一个真实用户都被 401 挡在门外,而本地/CI 里塞了假 session 的测试全绿 ——
 * 这个洞不会自己暴露,只在接真实用户的那一刻炸。
 *
 * 所以它现在有两道锁:
 *   ① 生产入口(`src/index.ts`)只准构造 `PgSessionResolver` —— 由 `session-guard.test.ts` 看源码守着;
 *   ② 鉴权**永远不许**「起不来就回落内存」:内存账本回落 = 无声丢钱,内存会话回落 = **无声放行**。
 */
export class InMemorySessionResolver implements SessionResolver {
  constructor(private readonly sessions: Record<string, Principal> = {}) {}
  async resolve(token: string): Promise<Principal | null> {
    return this.sessions[token] ?? null;
  }
}

/**
 * 从请求头取 sessionToken。
 *
 * ⚠️ 取到之后**绝不能原样转发给上游** —— 上游要的是 GLM key,由网关注入。
 * 把客户端的头透传出去 = 把用户的 token 泄露给第三方,而且上游也认不了。
 */
export function extractSessionToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['x-api-key'] ?? headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return value.startsWith('Bearer ') ? value.slice(7).trim() : value.trim();
}
