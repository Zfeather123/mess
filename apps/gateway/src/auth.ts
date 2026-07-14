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

/** 开发/测试用。生产接 Paperclip 的 session 表。 */
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
