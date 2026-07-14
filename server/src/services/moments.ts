import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  agents,
  collectionItems,
  momentComments,
  momentLikes,
  moments,
  type Db,
} from "@paperclipai/db";
import {
  inferCategory,
  parseTags,
  type CreateMomentInput,
  type Moment,
  type MomentAuthor,
  type MomentCard,
  type MomentCategory,
  type MomentComment,
  type MomentFeedPage,
  type MomentKind,
  type MomentSidebar,
} from "@xiaojing/protocol";
import { badRequest, forbidden, notFound } from "../errors.js";

/**
 * 朋友圈服务(JIN-56)—— AI 员工「主动发动态」的服务端真相。
 *
 * 三条不变量:
 *
 * 1. **作者身份只能由服务端推**。所有写接口的 author/actor 都来自 `getActorInfo(req)`,
 *    入参 schema 里根本没有 authorType 字段 —— 客户端没有机会冒充别的员工发言。
 *
 * 2. **计数器与关系行同生共死**。like / comment 的插入(删除)和 moments.like_count
 *    (comment_count)的加减在**同一个事务**里,且增量**由 insert 的实际返回行数推出**:
 *    双击点赞时 onConflictDoNothing 返回空数组 → 一次都不加。
 *    「先查有没有点过、再决定加不加」是 TOCTOU:两个并发请求都会读到「没点过」,
 *    然后一个被唯一索引挡下、另一个成功,但计数器被加了两次 —— 永久性膨胀,没法自愈。
 *
 * 3. **收藏没有第二张表**。收藏 = 往知识库(collection_items.source_moment_id)插一行,
 *    取消收藏 = 软删同一行。另建 moment_favorites 会立刻产生双真相:用户在收藏模块里
 *    删掉了,朋友圈里那颗星还亮着。
 */

const DEFAULT_FEED_LIMIT = 20;
const MAX_FEED_LIMIT = 50;
const SIDEBAR_LIMIT = 5;

/** 写操作的行为主体:真人(userId)或 AI 员工(agentId),二选一。 */
export interface MomentActor {
  userId: string | null;
  agentId: string | null;
}

export interface MomentFeedFilters {
  category?: MomentCategory;
  /** 上一页最后一条的 createdAt(ISO)。keyset 分页,不是 offset。 */
  cursor?: string;
  limit?: number;
}

type MomentRow = typeof moments.$inferSelect;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_FEED_LIMIT;
  return Math.max(1, Math.min(MAX_FEED_LIMIT, Math.floor(limit ?? DEFAULT_FEED_LIMIT)));
}

function assertActor(actor: MomentActor): void {
  if (!actor.agentId && !actor.userId) {
    throw forbidden("Moment actions require an authenticated actor");
  }
}

function toAuthor(
  row: Pick<MomentRow, "authorType" | "authorAgentId" | "authorUserId">,
  agent?: { name: string | null; role: string | null; icon: string | null } | null,
): MomentAuthor {
  if (row.authorType === "agent") {
    return {
      type: "agent",
      id: row.authorAgentId ?? "",
      name: agent?.name ?? "AI 员工",
      role: agent?.role ?? null,
      avatarUrl: agent?.icon ?? null,
    };
  }
  return {
    type: "user",
    id: row.authorUserId ?? "",
    name: row.authorUserId ?? "操盘手",
    role: null,
    avatarUrl: null,
  };
}

function toMoment(
  row: MomentRow,
  agent: { name: string | null; role: string | null; icon: string | null } | null,
  flags: { likedByMe: boolean; favoritedByMe: boolean },
): Moment {
  return {
    id: row.id,
    category: row.category as MomentCategory,
    kind: row.kind as MomentKind,
    author: toAuthor(row, agent),
    content: row.content,
    tags: row.tags ?? [],
    card: (row.card as MomentCard | null) ?? null,
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    likedByMe: flags.likedByMe,
    favoritedByMe: flags.favoritedByMe,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 「当前登录者点过赞了吗」的相关子查询。
 *
 * 为什么不另发一条 `select moment_id from moment_likes where actor = ? and moment_id in (...)`:
 * 那是第二次往返,而信息流是全产品最热的读。子查询走 moment_likes 的部分唯一索引,
 * 和主查询一起在一次 round-trip 里算完 —— 20 条动态 = 1 条 SQL,不是 1 + 2 条。
 */
function likedByMeSql(actor: MomentActor) {
  if (actor.agentId) {
    return sql<boolean>`exists (
      select 1 from ${momentLikes}
      where ${momentLikes.momentId} = ${moments.id}
        and ${momentLikes.actorAgentId} = ${actor.agentId}
    )`;
  }
  if (actor.userId) {
    return sql<boolean>`exists (
      select 1 from ${momentLikes}
      where ${momentLikes.momentId} = ${moments.id}
        and ${momentLikes.actorUserId} = ${actor.userId}
    )`;
  }
  return sql<boolean>`false`;
}

/** 收藏 = 知识库里有一条指向这条动态、且没被软删的 collection_items。 */
function favoritedByMeSql(actor: MomentActor) {
  const creatorMatch = actor.agentId
    ? sql`${collectionItems.createdByAgentId} = ${actor.agentId}`
    : actor.userId
      ? sql`${collectionItems.createdByUserId} = ${actor.userId}`
      : null;
  if (!creatorMatch) return sql<boolean>`false`;
  return sql<boolean>`exists (
    select 1 from ${collectionItems}
    where ${collectionItems.sourceMomentId} = ${moments.id}
      and ${collectionItems.deletedAt} is null
      and ${creatorMatch}
  )`;
}

export function momentService(db: Db) {
  /** 点赞/评论/收藏的行为主体条件 —— agent 与 user 只能命中自己那行。 */
  function likeActorCondition(momentId: string, actor: MomentActor) {
    assertActor(actor);
    return actor.agentId
      ? and(eq(momentLikes.momentId, momentId), eq(momentLikes.actorAgentId, actor.agentId))
      : and(eq(momentLikes.momentId, momentId), eq(momentLikes.actorUserId, actor.userId!));
  }

  function favoriteActorCondition(momentId: string, actor: MomentActor) {
    assertActor(actor);
    return actor.agentId
      ? and(
          eq(collectionItems.sourceMomentId, momentId),
          eq(collectionItems.createdByAgentId, actor.agentId),
        )
      : and(
          eq(collectionItems.sourceMomentId, momentId),
          eq(collectionItems.createdByUserId, actor.userId!),
        );
  }

  const svc = {
    /** 路由层鉴权用:先拿到 companyId 才能 assertCompanyAccess。软删的当不存在。 */
    getById: (id: string) =>
      db
        .select()
        .from(moments)
        .where(and(eq(moments.id, id), isNull(moments.deletedAt)))
        .limit(1)
        .then((rows) => rows[0] ?? null),

    /**
     * 信息流。keyset 分页 + likedByMe/favoritedByMe 一次算完(无 N+1)。
     * 作者名/职位由 LEFT JOIN agents 解出 —— 不在 moments 里冗余名字,员工改名后旧动态不该还是旧名。
     */
    async listFeed(
      companyId: string,
      actor: MomentActor,
      filters: MomentFeedFilters = {},
    ): Promise<MomentFeedPage> {
      const limit = clampLimit(filters.limit);
      const conditions = [eq(moments.companyId, companyId), isNull(moments.deletedAt)];
      if (filters.category) conditions.push(eq(moments.category, filters.category));
      if (filters.cursor) {
        const cursorAt = new Date(filters.cursor);
        if (Number.isNaN(cursorAt.getTime())) throw badRequest("Invalid cursor");
        conditions.push(lt(moments.createdAt, cursorAt));
      }

      const rows = await db
        .select({
          moment: moments,
          agentName: agents.name,
          agentRole: agents.role,
          agentIcon: agents.icon,
          likedByMe: likedByMeSql(actor),
          favoritedByMe: favoritedByMeSql(actor),
        })
        .from(moments)
        .leftJoin(agents, eq(agents.id, moments.authorAgentId))
        .where(and(...conditions))
        .orderBy(desc(moments.createdAt), desc(moments.id))
        .limit(limit);

      const feed = rows.map((row) =>
        toMoment(
          row.moment,
          { name: row.agentName, role: row.agentRole, icon: row.agentIcon },
          { likedByMe: Boolean(row.likedByMe), favoritedByMe: Boolean(row.favoritedByMe) },
        ),
      );

      return {
        moments: feed,
        // 只有「这一页装满了」才可能还有下一页;没装满就是到底了。
        nextCursor: feed.length === limit && feed.length > 0 ? feed[feed.length - 1]!.createdAt : null,
      };
    },

    /**
     * AI 员工(或操盘手)发一条动态。
     * author* 全部从 actor 推,入参里没有身份字段 —— 客户端无从冒充。
     */
    async create(companyId: string, actor: MomentActor, input: CreateMomentInput): Promise<Moment> {
      assertActor(actor);
      const authorType = actor.agentId ? "agent" : "user";
      const kind: MomentKind = input.kind ?? "update";
      const category: MomentCategory = input.category ?? inferCategory(authorType, kind);
      // 员工忘了打标签是常态 —— 从正文里抽,和 UI 预览用的是同一份 parseTags。
      const tags = input.tags ?? parseTags(input.content);

      const row = await db
        .insert(moments)
        .values({
          companyId,
          authorType,
          authorAgentId: actor.agentId,
          authorUserId: actor.agentId ? null : actor.userId,
          content: input.content,
          kind,
          category,
          tags,
          card: (input.card as Record<string, unknown> | null) ?? null,
          issueId: input.issueId ?? null,
          douyinAccountId: input.douyinAccountId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!);

      const agent = actor.agentId
        ? await db
            .select({ name: agents.name, role: agents.role, icon: agents.icon })
            .from(agents)
            .where(eq(agents.id, actor.agentId))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null;

      return toMoment(row, agent, { likedByMe: false, favoritedByMe: false });
    },

    /** 软删。谁能删由路由层判定(作者本人或公司管理员),这里只认结论。 */
    async remove(id: string, actor: MomentActor, canModerate: boolean): Promise<void> {
      assertActor(actor);
      const existing = await svc.getById(id);
      if (!existing) throw notFound("Moment not found");
      const isAuthor = actor.agentId
        ? existing.authorAgentId === actor.agentId
        : existing.authorUserId === actor.userId;
      if (!isAuthor && !canModerate) {
        throw forbidden("Only the author or a company admin can delete this moment");
      }
      await db
        .update(moments)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(moments.id, id), isNull(moments.deletedAt)));
    },

    /**
     * 点赞。幂等:重复点赞返回当前状态,不 500、**也不把计数器加第二次**。
     * 插入与计数器同事务,且增量由 insert 的实际返回推出(空数组 = 唯一索引挡下了 = 不加)。
     */
    async like(momentId: string, actor: MomentActor): Promise<{ liked: true; likeCount: number }> {
      assertActor(actor);
      return db.transaction(async (tx) => {
        const moment = await tx
          .select({ id: moments.id, companyId: moments.companyId, likeCount: moments.likeCount })
          .from(moments)
          .where(and(eq(moments.id, momentId), isNull(moments.deletedAt)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!moment) throw notFound("Moment not found");

        const inserted = await tx
          .insert(momentLikes)
          .values({
            companyId: moment.companyId,
            momentId,
            actorType: actor.agentId ? "agent" : "user",
            actorAgentId: actor.agentId,
            actorUserId: actor.agentId ? null : actor.userId,
          })
          .onConflictDoNothing()
          .returning({ id: momentLikes.id });

        if (inserted.length === 0) {
          // 双击 / 重放:已经点过了,计数器不动。
          return { liked: true as const, likeCount: moment.likeCount };
        }

        const updated = await tx
          .update(moments)
          .set({ likeCount: sql`${moments.likeCount} + 1`, updatedAt: new Date() })
          .where(eq(moments.id, momentId))
          .returning({ likeCount: moments.likeCount })
          .then((rows) => rows[0] ?? null);

        return { liked: true as const, likeCount: updated?.likeCount ?? moment.likeCount + 1 };
      });
    },

    /** 取消点赞。同样幂等:没点过就什么都不做,计数器不会被减成负数。 */
    async unlike(momentId: string, actor: MomentActor): Promise<{ liked: false; likeCount: number }> {
      assertActor(actor);
      return db.transaction(async (tx) => {
        const moment = await tx
          .select({ id: moments.id, likeCount: moments.likeCount })
          .from(moments)
          .where(and(eq(moments.id, momentId), isNull(moments.deletedAt)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!moment) throw notFound("Moment not found");

        const deleted = await tx
          .delete(momentLikes)
          .where(likeActorCondition(momentId, actor))
          .returning({ id: momentLikes.id });

        if (deleted.length === 0) {
          return { liked: false as const, likeCount: moment.likeCount };
        }

        const updated = await tx
          .update(moments)
          .set({
            // greatest(...,0):历史脏数据不该让计数器变成负数
            likeCount: sql`greatest(${moments.likeCount} - ${deleted.length}, 0)`,
            updatedAt: new Date(),
          })
          .where(eq(moments.id, momentId))
          .returning({ likeCount: moments.likeCount })
          .then((rows) => rows[0] ?? null);

        return { liked: false as const, likeCount: updated?.likeCount ?? Math.max(moment.likeCount - 1, 0) };
      });
    },

    /** 评论列表(含楼中楼,按时间正序 —— 前端自己按 parentCommentId 拼树)。 */
    async listComments(momentId: string, limit = 100): Promise<MomentComment[]> {
      const rows = await db
        .select({
          comment: momentComments,
          agentName: agents.name,
          agentRole: agents.role,
          agentIcon: agents.icon,
        })
        .from(momentComments)
        .leftJoin(agents, eq(agents.id, momentComments.authorAgentId))
        .where(and(eq(momentComments.momentId, momentId), isNull(momentComments.deletedAt)))
        .orderBy(asc(momentComments.createdAt))
        .limit(Math.max(1, Math.min(200, limit)));

      return rows.map((row) => ({
        id: row.comment.id,
        momentId: row.comment.momentId,
        parentCommentId: row.comment.parentCommentId ?? null,
        author: toAuthor(row.comment, {
          name: row.agentName,
          role: row.agentRole,
          icon: row.agentIcon,
        }),
        body: row.comment.body,
        createdAt: row.comment.createdAt.toISOString(),
      }));
    },

    /** 发评论。评论行与 comment_count 同事务 —— 与 like 同样的纪律。 */
    async addComment(
      momentId: string,
      actor: MomentActor,
      input: { body: string; parentCommentId?: string | null },
    ): Promise<MomentComment> {
      assertActor(actor);
      const created = await db.transaction(async (tx) => {
        const moment = await tx
          .select({ id: moments.id, companyId: moments.companyId })
          .from(moments)
          .where(and(eq(moments.id, momentId), isNull(moments.deletedAt)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!moment) throw notFound("Moment not found");

        if (input.parentCommentId) {
          // 楼中楼的父评论必须属于同一条动态,否则会拼出跨动态的孤儿楼
          const parent = await tx
            .select({ id: momentComments.id, momentId: momentComments.momentId })
            .from(momentComments)
            .where(eq(momentComments.id, input.parentCommentId))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!parent || parent.momentId !== momentId) {
            throw badRequest("parentCommentId does not belong to this moment");
          }
        }

        const row = await tx
          .insert(momentComments)
          .values({
            companyId: moment.companyId,
            momentId,
            parentCommentId: input.parentCommentId ?? null,
            authorType: actor.agentId ? "agent" : "user",
            authorAgentId: actor.agentId,
            authorUserId: actor.agentId ? null : actor.userId,
            body: input.body,
          })
          .returning()
          .then((rows) => rows[0]!);

        await tx
          .update(moments)
          .set({ commentCount: sql`${moments.commentCount} + 1`, updatedAt: new Date() })
          .where(eq(moments.id, momentId));

        return row;
      });

      const agent = actor.agentId
        ? await db
            .select({ name: agents.name, role: agents.role, icon: agents.icon })
            .from(agents)
            .where(eq(agents.id, actor.agentId))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null;

      return {
        id: created.id,
        momentId: created.momentId,
        parentCommentId: created.parentCommentId ?? null,
        author: toAuthor(created, agent),
        body: created.body,
        createdAt: created.createdAt.toISOString(),
      };
    },

    /**
     * 收藏 = 往知识库插一条 collection_items(source_moment_id 指回来),不是另一张表。
     * 幂等:已收藏就原样返回;之前取消过(软删)就复活同一行,而不是插重复行。
     */
    async favorite(
      momentId: string,
      actor: MomentActor,
      input: { collectionId?: string | null } = {},
    ): Promise<{ favorited: true; collectionItemId: string }> {
      assertActor(actor);
      return db.transaction(async (tx) => {
        const moment = await tx
          .select({
            id: moments.id,
            companyId: moments.companyId,
            content: moments.content,
            tags: moments.tags,
            douyinAccountId: moments.douyinAccountId,
            card: moments.card,
          })
          .from(moments)
          .where(and(eq(moments.id, momentId), isNull(moments.deletedAt)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!moment) throw notFound("Moment not found");

        const existing = await tx
          .select({ id: collectionItems.id, deletedAt: collectionItems.deletedAt })
          .from(collectionItems)
          .where(favoriteActorCondition(momentId, actor))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (existing) {
          if (existing.deletedAt) {
            await tx
              .update(collectionItems)
              .set({ deletedAt: null, updatedAt: new Date() })
              .where(eq(collectionItems.id, existing.id));
          }
          return { favorited: true as const, collectionItemId: existing.id };
        }

        const card = moment.card as { title?: string } | null;
        const title = card?.title?.trim() || moment.content.trim().slice(0, 60) || "朋友圈动态";

        const row = await tx
          .insert(collectionItems)
          .values({
            companyId: moment.companyId,
            collectionId: input.collectionId ?? null,
            douyinAccountId: moment.douyinAccountId ?? null,
            title,
            contentType: "moment",
            body: moment.content,
            sourceMomentId: momentId,
            tags: moment.tags ?? [],
            createdByType: actor.agentId ? "agent" : "user",
            createdByAgentId: actor.agentId,
            createdByUserId: actor.agentId ? null : actor.userId,
          })
          .returning({ id: collectionItems.id })
          .then((rows) => rows[0]!);

        return { favorited: true as const, collectionItemId: row.id };
      });
    },

    /** 取消收藏 = 软删那条 collection_items(与收藏模块里的删除是同一个动作,单一真相)。 */
    async unfavorite(momentId: string, actor: MomentActor): Promise<{ favorited: false }> {
      assertActor(actor);
      await db
        .update(collectionItems)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(favoriteActorCondition(momentId, actor), isNull(collectionItems.deletedAt)));
      return { favorited: false as const };
    },

    /** 侧栏:常去的 AI 员工(发动态最多)+ 热门方法包(点赞最多的 method_pack 卡片)。 */
    async sidebar(companyId: string): Promise<MomentSidebar> {
      const frequentRows = await db
        .select({
          agentId: moments.authorAgentId,
          name: agents.name,
          role: agents.role,
          momentCount: sql<number>`count(*)::int`,
        })
        .from(moments)
        .innerJoin(agents, eq(agents.id, moments.authorAgentId))
        .where(
          and(
            eq(moments.companyId, companyId),
            eq(moments.authorType, "agent"),
            isNull(moments.deletedAt),
          ),
        )
        .groupBy(moments.authorAgentId, agents.name, agents.role)
        .orderBy(sql`count(*) desc`)
        .limit(SIDEBAR_LIMIT);

      const hotRows = await db
        .select({
          momentId: moments.id,
          card: moments.card,
          likeCount: moments.likeCount,
        })
        .from(moments)
        .where(
          and(
            eq(moments.companyId, companyId),
            isNull(moments.deletedAt),
            sql`${moments.card}->>'type' = 'method_pack'`,
          ),
        )
        .orderBy(desc(moments.likeCount), desc(moments.createdAt))
        .limit(SIDEBAR_LIMIT);

      return {
        frequentAgents: frequentRows.map((row) => ({
          agentId: row.agentId!,
          name: row.name,
          role: row.role,
          momentCount: Number(row.momentCount),
        })),
        hotCards: hotRows.map((row) => {
          const card = (row.card ?? null) as Partial<MomentCard> | null;
          return {
            momentId: row.momentId,
            title: card?.title ?? "方法包",
            type: "method_pack" as const,
            likeCount: row.likeCount,
          };
        }),
      };
    },
  };

  return svc;
}

export type MomentService = ReturnType<typeof momentService>;
