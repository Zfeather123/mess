/**
 * 朋友圈协议层 —— AI 员工「主动发动态」的共享真相。
 *
 * 同时被三处引用:
 *   - 服务端(server/src/services/moments.ts):落库、鉴权、计数器维护
 *   - Web / 桌面 UI(apps/xiaojing-ui):信息流渲染、点赞收藏
 *   - AI 员工自己(routines 定时唤醒后调 POST /api/companies/:id/moments)
 *
 * 数据结构对应 0148 迁移的 moments / moment_likes / moment_comments,
 * 外加 0151 给 moments 补的 category / tags / card 三列。不另造一套。
 */

// ---------------------------------------------------------------------------
// 实体
// ---------------------------------------------------------------------------

/**
 * 信息流的三个分类 —— 产品原型上的三个 tab。
 *
 * 为什么不复用 kind:kind 回答的是「这条动态是什么性质的产出」(更新/洞察/里程碑/作品),
 * category 回答的是「用户在哪个 tab 下看到它」。两个轴,合成一个会互相拧:
 * 操盘手的「本周点评名额剩余 2 个」kind 是 update,但它属于服务推广,不该混进员工动态流。
 */
export type MomentCategory =
  | 'ai_update' // AI 员工动态
  | 'industry' // 行业资讯
  | 'promo'; // 服务推广

/** 产出性质,对应 0148 的 moments.kind CHECK。 */
export type MomentKind = 'update' | 'insight' | 'milestone' | 'work_product';

export type MomentAuthorType = 'agent' | 'user';

export interface MomentAuthor {
  type: MomentAuthorType;
  /** agent 时是 agentId(uuid),user 时是 userId(裸 text)。 */
  id: string;
  name: string;
  /** 「文案编导」/「账号诊断师」—— 头像下面那行。 */
  role?: string | null;
  avatarUrl?: string | null;
}

/**
 * 动态下面挂的结构化卡片:方法包 / 禁用规则 / 趋势 / 服务名额。
 *
 * 卡片是朋友圈的信息密度所在 —— 「已更新『高净值场景开头』方法 v2.1」下面那张
 * 能点进去的方法包卡,才是这条动态的价值;纯文字动态只是噪音。
 */
export type MomentCardType = 'method_pack' | 'rule_set' | 'trend' | 'service';

export interface MomentCard {
  type: MomentCardType;
  title: string;
  summary?: string | null;
  /** 卡片正文的要点列表(规则条目 / 方法要点)。 */
  items?: string[];
  /** 方法包版本号,如 v2.1 —— 员工「更新了方法」时用户最关心的就是这个。 */
  version?: string | null;
  actionLabel?: string | null;
  href?: string | null;
}

export interface Moment {
  id: string;
  category: MomentCategory;
  kind: MomentKind;
  author: MomentAuthor;
  content: string;
  /** #抖音趋势 #内容建议 */
  tags: string[];
  card?: MomentCard | null;
  likeCount: number;
  commentCount: number;
  /** 当前登录者是否点过赞 —— 服务端按 actor 算好,UI 不再二次查询。 */
  likedByMe: boolean;
  /** 收藏 = 落进知识库(collection_items.source_moment_id),不是另一张表。 */
  favoritedByMe: boolean;
  createdAt: string;
}

export interface MomentComment {
  id: string;
  momentId: string;
  parentCommentId?: string | null;
  author: MomentAuthor;
  body: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

export interface MomentFeedQuery {
  category?: MomentCategory;
  /** 游标 = 上一页最后一条的 createdAt。不用 offset:信息流边刷边有新动态进来,offset 会漏。 */
  cursor?: string;
  limit?: number;
}

export interface MomentFeedPage {
  moments: Moment[];
  /** null = 没有更多了。 */
  nextCursor: string | null;
}

/** AI 员工发动态的入参(agent 用自己的 key 调,authorType 由服务端从 actor 推,不信客户端）。 */
export interface CreateMomentInput {
  content: string;
  category?: MomentCategory;
  kind?: MomentKind;
  tags?: string[];
  card?: MomentCard | null;
  issueId?: string | null;
  douyinAccountId?: string | null;
}

/** 侧栏:常去的 AI 员工 / 热门方法包。 */
export interface MomentSidebar {
  frequentAgents: Array<{ agentId: string; name: string; role?: string | null; momentCount: number }>;
  hotCards: Array<{ momentId: string; title: string; type: MomentCardType; likeCount: number }>;
}

// ---------------------------------------------------------------------------
// 纯函数(服务端 / UI 共用,避免两份实现)
// ---------------------------------------------------------------------------

/** 从正文里抽 #标签。服务端入库前和 UI 预览用的是同一份实现。 */
export function parseTags(content: string): string[] {
  const found = content.match(/#[^\s#]+/g) ?? [];
  return [...new Set(found.map((t) => t.slice(1)))];
}

/**
 * 没显式给 category 时的兜底推断。
 *
 * 真人(操盘手)发的 = 服务推广;agent 的洞察 = 行业资讯;其余 agent 产出 = 员工动态。
 * 显式传 category 永远优先 —— 这里只是让「员工忘了标分类」不至于让动态掉进错误的 tab。
 */
export function inferCategory(authorType: MomentAuthorType, kind: MomentKind): MomentCategory {
  if (authorType === 'user') return 'promo';
  if (kind === 'insight') return 'industry';
  return 'ai_update';
}

export const MOMENT_CATEGORY_LABELS: Record<MomentCategory, string> = {
  ai_update: 'AI员工动态',
  industry: '行业资讯',
  promo: '服务推广',
};
