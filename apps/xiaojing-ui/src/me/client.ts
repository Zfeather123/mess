import type {
  CoachBinding,
  ComputeBalance,
  ComputeUsagePage,
  CreateRechargeInput,
  NotificationPrefs,
  RechargeOrder,
  WeeklyOverview,
} from '@xiaojing/protocol';

/** 「我的」的数据面:算力钱包 / 绑定操盘手 / 通知设置 / 本周概览 / 数据导出。 */
export interface MeClient {
  balance(companyId: string): Promise<ComputeBalance>;
  usage(companyId: string, opts?: { cursor?: string; limit?: number }): Promise<ComputeUsagePage>;
  recharge(companyId: string, input: CreateRechargeInput): Promise<RechargeOrder>;
  coach(companyId: string): Promise<CoachBinding>;
  openCoachDm(companyId: string): Promise<{ conversationId: string }>;
  notifications(companyId: string): Promise<NotificationPrefs>;
  updateNotifications(companyId: string, patch: Partial<NotificationPrefs>): Promise<NotificationPrefs>;
  overview(companyId: string): Promise<WeeklyOverview>;
  /** 数据导出:返回下载地址,由浏览器/桌面壳自己去下(不把整包 JSON 读进内存)。 */
  exportUrl(companyId: string): string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${detail ? `:${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function createHttpMeClient(baseUrl = '/api'): MeClient {
  return {
    async balance(companyId) {
      return json<ComputeBalance>(await fetch(`${baseUrl}/companies/${companyId}/compute/balance`));
    },

    async usage(companyId, opts = {}) {
      const qs = new URLSearchParams();
      if (opts.cursor) qs.set('cursor', opts.cursor);
      if (opts.limit) qs.set('limit', String(opts.limit));
      const suffix = qs.toString() ? `?${qs}` : '';
      return json<ComputeUsagePage>(
        await fetch(`${baseUrl}/companies/${companyId}/compute/usage${suffix}`),
      );
    },

    async recharge(companyId, input) {
      // ⚠️ 只传 points + channel。金额由服务端按 POINTS_PER_YUAN 复算 ——
      // 前端连传价格的字段都没有,也就没有「1 分钱买 5 万点」这条路。
      return json<RechargeOrder>(
        await fetch(`${baseUrl}/companies/${companyId}/compute/recharge`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ points: input.points, channel: input.channel }),
        }),
      );
    },

    async coach(companyId) {
      return json<CoachBinding>(await fetch(`${baseUrl}/companies/${companyId}/me/coach`));
    },

    async openCoachDm(companyId) {
      return json<{ conversationId: string }>(
        await fetch(`${baseUrl}/companies/${companyId}/me/coach/dm`, { method: 'POST' }),
      );
    },

    async notifications(companyId) {
      return json<NotificationPrefs>(
        await fetch(`${baseUrl}/companies/${companyId}/me/notifications`),
      );
    },

    async updateNotifications(companyId, patch) {
      return json<NotificationPrefs>(
        await fetch(`${baseUrl}/companies/${companyId}/me/notifications`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify(patch),
        }),
      );
    },

    async overview(companyId) {
      return json<WeeklyOverview>(await fetch(`${baseUrl}/companies/${companyId}/me/overview`));
    },

    exportUrl(companyId) {
      return `${baseUrl}/companies/${companyId}/me/export`;
    },
  };
}
