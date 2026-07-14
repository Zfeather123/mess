import type {
  CreateMomentInput,
  Moment,
  MomentComment,
  MomentFeedPage,
  MomentFeedQuery,
  MomentSidebar,
} from '@xiaojing/protocol';

/**
 * 朋友圈的数据面 —— 和 ImClient 同一个形状:一个接口 + 一个 HTTP 实现。
 *
 * 为什么不走 XiaojingBridge:桥回答的是「agent loop 在哪跑」,朋友圈的读写永远在
 * 我们的服务器上(桌面版也一样)。把它塞进桥,桌面和 Web 就得各实现一遍同样的 fetch。
 *
 * 组件只依赖这个接口,测试注入假实现 —— 不 mock 模块、不打桩 fetch。
 */
export interface MomentsClient {
  listFeed(companyId: string, query?: MomentFeedQuery): Promise<MomentFeedPage>;
  createMoment(companyId: string, input: CreateMomentInput): Promise<Moment>;
  sidebar(companyId: string): Promise<MomentSidebar>;
  like(momentId: string): Promise<void>;
  unlike(momentId: string): Promise<void>;
  favorite(momentId: string): Promise<void>;
  unfavorite(momentId: string): Promise<void>;
  listComments(momentId: string): Promise<MomentComment[]>;
  addComment(momentId: string, body: string, parentCommentId?: string): Promise<MomentComment>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${detail ? `:${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

async function ok(res: Response): Promise<void> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${detail ? `:${detail}` : ''}`);
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function createHttpMomentsClient(baseUrl = '/api'): MomentsClient {
  return {
    async listFeed(companyId, query = {}) {
      const qs = new URLSearchParams();
      if (query.category) qs.set('category', query.category);
      if (query.cursor) qs.set('cursor', query.cursor);
      if (query.limit) qs.set('limit', String(query.limit));
      const suffix = qs.toString() ? `?${qs}` : '';
      return json<MomentFeedPage>(await fetch(`${baseUrl}/companies/${companyId}/moments${suffix}`));
    },

    async createMoment(companyId, input) {
      return json<Moment>(
        await fetch(`${baseUrl}/companies/${companyId}/moments`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(input),
        }),
      );
    },

    async sidebar(companyId) {
      return json<MomentSidebar>(await fetch(`${baseUrl}/companies/${companyId}/moments/sidebar`));
    },

    async like(momentId) {
      await ok(await fetch(`${baseUrl}/moments/${momentId}/like`, { method: 'POST' }));
    },

    async unlike(momentId) {
      await ok(await fetch(`${baseUrl}/moments/${momentId}/like`, { method: 'DELETE' }));
    },

    async favorite(momentId) {
      await ok(
        await fetch(`${baseUrl}/moments/${momentId}/favorite`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({}),
        }),
      );
    },

    async unfavorite(momentId) {
      await ok(await fetch(`${baseUrl}/moments/${momentId}/favorite`, { method: 'DELETE' }));
    },

    async listComments(momentId) {
      return json<MomentComment[]>(await fetch(`${baseUrl}/moments/${momentId}/comments`));
    },

    async addComment(momentId, body, parentCommentId) {
      return json<MomentComment>(
        await fetch(`${baseUrl}/moments/${momentId}/comments`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(parentCommentId ? { body, parentCommentId } : { body }),
        }),
      );
    },
  };
}
