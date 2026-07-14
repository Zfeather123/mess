import type { ImConversation, ImEvent, ImMember, ImMessage, SendMessageInput } from '@xiaojing/protocol';

/**
 * IM 客户端 —— UI 只跟这个接口说话。
 *
 * 和 XiaojingBridge(agent 在哪跑)是**两件事**,刻意分开:
 *   - ImClient      :消息的持久化和分发,永远走我们的服务器
 *   - XiaojingBridge:agent loop 在哪执行(桌面=本地,浏览器=服务端)
 *
 * 混在一起的话,「桌面版 agent 在本地跑」这个架构决策就会渗进每个组件。
 * 现在组件只知道「发消息用 client,让员工干活用 bridge」。
 *
 * 测试里注入一个假的 ImClient 就能跑完整的 UI 用例,不需要起服务器。
 */
export interface ImClient {
  listConversations(companyId: string): Promise<ImConversation[]>;
  listMembers(conversationId: string): Promise<ImMember[]>;
  /** 首屏(不传游标)/ 上翻(beforeSeq)/ 断线补齐(afterSeq)。 */
  listMessages(
    conversationId: string,
    opts?: { beforeSeq?: number; afterSeq?: number; limit?: number },
  ): Promise<ImMessage[]>;
  sendMessage(conversationId: string, input: SendMessageInput): Promise<ImMessage>;
  markRead(conversationId: string, lastReadSeq: number): Promise<void>;
  /**
   * 订阅会话实时事件。sinceSeq 是客户端的水位线:
   * 服务端先重放这之后漏掉的消息,再转直播 —— 断线期间的消息一条都不会丢。
   */
  subscribe(
    conversationId: string,
    sinceSeq: number,
    onEvent: (event: ImEvent) => void,
  ): () => void;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${detail ? `:${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

export function createHttpImClient(baseUrl = '/api'): ImClient {
  return {
    async listConversations(companyId) {
      return json<ImConversation[]>(await fetch(`${baseUrl}/companies/${companyId}/conversations`));
    },

    async listMembers(conversationId) {
      return json<ImMember[]>(await fetch(`${baseUrl}/conversations/${conversationId}/members`));
    },

    async listMessages(conversationId, opts = {}) {
      const qs = new URLSearchParams();
      if (opts.beforeSeq != null) qs.set('beforeSeq', String(opts.beforeSeq));
      if (opts.afterSeq != null) qs.set('afterSeq', String(opts.afterSeq));
      if (opts.limit != null) qs.set('limit', String(opts.limit));
      const suffix = qs.size > 0 ? `?${qs}` : '';
      return json<ImMessage[]>(await fetch(`${baseUrl}/conversations/${conversationId}/messages${suffix}`));
    },

    async sendMessage(conversationId, input) {
      return json<ImMessage>(
        await fetch(`${baseUrl}/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
    },

    async markRead(conversationId, lastReadSeq) {
      await fetch(`${baseUrl}/conversations/${conversationId}/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastReadSeq }),
      });
    },

    subscribe(conversationId, sinceSeq, onEvent) {
      // EventSource 自带断线重连(浏览器实现的指数退避)。重连时 URL 里的 sinceSeq
      // 还是**建立连接那一刻**的水位线 —— 所以重连后可能重复收到已有消息。
      // 这是刻意的:MessageStore 按 id 幂等,宁可重发,不可漏发。
      const source = new EventSource(
        `${baseUrl}/conversations/${conversationId}/events?sinceSeq=${sinceSeq}`,
      );
      source.onmessage = (evt: MessageEvent<string>) => {
        try {
          onEvent(JSON.parse(evt.data) as ImEvent);
        } catch {
          // 单条坏帧不该拆掉整条连接
        }
      };
      return () => source.close();
    },
  };
}
