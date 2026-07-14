/**
 * 「我的」协议层 —— 算力钱包 / 绑定操盘手 / 通知设置 / 本周概览。
 *
 * 算力这块对着 JIN-51 的两阶段扣费:reserve(冻结)→ settle(结算)/ release(退还)。
 * UI 必须理解「冻结」这个中间态,否则用户会看到「余额没变但钱少了」——
 * 所以 balancePoints / frozenPoints / availablePoints 三个数都要露出来,不能只给一个。
 *
 * 单位约定(与 packages/db/src/schema/compute.ts、packages/billing 同一份):
 *   1 点 = 1 分人民币。1M token = 5 元 = 500 点。
 */

/** 1 元 = 100 点。UI 上「充 50 元 = 5000 点」的换算只认这个常量。 */
export const POINTS_PER_YUAN = 100;

export function pointsToYuan(points: number): number {
  return points / POINTS_PER_YUAN;
}

// ---------------------------------------------------------------------------
// 算力钱包
// ---------------------------------------------------------------------------

export interface ComputeBalance {
  accountId: string;
  /** 账面余额(已结算)。 */
  balancePoints: number;
  /** 已冻结未结算 —— 正在跑的 agent 占着的额度。 */
  frozenPoints: number;
  /** 真正能用的 = balance - frozen。UI 上「剩余算力」显示的是这个。 */
  availablePoints: number;
  /** 本月已用 / 额度。额度为 null = 不限(没配 budget_policy)。 */
  monthlyUsedPoints: number;
  monthlyQuotaPoints: number | null;
  /** 低于这个值弹「余额不足」横幅。 */
  lowBalanceThreshold: number;
  status: 'active' | 'suspended';
}

export type ComputeTxDirection = 'credit' | 'debit';

export type ComputeTxReason =
  | 'recharge'
  | 'consume'
  | 'refund'
  | 'adjust'
  | 'gift'
  | 'freeze'
  | 'unfreeze';

/** 用量明细的一行:哪个员工、哪个任务、花了多少。 */
export interface ComputeTransaction {
  id: string;
  direction: ComputeTxDirection;
  points: number;
  balanceAfter: number;
  reason: ComputeTxReason;
  agentId?: string | null;
  /** 服务端 join 出来的员工名,UI 不再为每行发一次请求。 */
  agentName?: string | null;
  issueId?: string | null;
  issueTitle?: string | null;
  memo?: string | null;
  createdAt: string;
}

export interface ComputeUsageQuery {
  cursor?: string;
  limit?: number;
}

export interface ComputeUsagePage {
  transactions: ComputeTransaction[];
  nextCursor: string | null;
}

export type RechargeChannel = 'wechat' | 'alipay' | 'manual' | 'gift';
export type RechargeStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface RechargeOrder {
  id: string;
  points: number;
  amountCents: number;
  channel: RechargeChannel;
  status: RechargeStatus;
  /** 收银台跳转地址。MVP 下 manual 渠道为 null(线下打款,人工确认)。 */
  payUrl?: string | null;
  createdAt: string;
  paidAt?: string | null;
}

export interface CreateRechargeInput {
  points: number;
  channel: RechargeChannel;
}

/** 充值面额 —— 原型上的四个档。金额由服务端按 POINTS_PER_YUAN 复算,不信前端传的价。 */
export const RECHARGE_PRESETS: Array<{ points: number; label: string }> = [
  { points: 5_000, label: '50 元' },
  { points: 10_000, label: '100 元' },
  { points: 50_000, label: '500 元' },
  { points: 100_000, label: '1000 元' },
];

// ---------------------------------------------------------------------------
// 绑定操盘手(真人)
// ---------------------------------------------------------------------------

/** 操盘手 = 能造 agent 卖给用户的供给方,是真人,不是 AI 员工。 */
export interface Coach {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  /** 「资深抖音法律内容操盘手」 */
  title?: string | null;
  bio?: string | null;
  /** 私聊入口:和这个操盘手的 direct 会话。没有就是还没聊过,点「私聊」时服务端现建。 */
  conversationId?: string | null;
}

export interface CoachBinding {
  /** null = 还没绑定。 */
  coach: Coach | null;
  boundAt?: string | null;
}

// ---------------------------------------------------------------------------
// 设置 / 概览
// ---------------------------------------------------------------------------

export interface NotificationPrefs {
  /** 今日任务提醒 */
  dailyTasks: boolean;
  /** 员工工作小结 */
  agentSummary: boolean;
  /** 合规风险提醒 */
  complianceRisk: boolean;
}

export interface WeeklyOverview {
  /** 本周起始日(周一,ISO 日期)。 */
  weekStart: string;
  /** 完成任务 */
  tasksCompleted: number;
  /** 生成文案 */
  draftsProduced: number;
  pointsUsed: number;
  /** 员工工作小结:每位员工这周干了多少 */
  perAgent: Array<{ agentId: string; agentName: string; points: number; tasks: number }>;
}
