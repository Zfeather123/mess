import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, collectionItems, companies, createDb, moments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockMomentService = vi.hoisted(() => ({
  getById: vi.fn(),
  listFeed: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  like: vi.fn(),
  unlike: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  favorite: vi.fn(),
  unfavorite: vi.fn(),
  sidebar: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/moments.js", () => ({
  momentService: () => mockMomentService,
}));

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
}));

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }],
  source: "session",
  isInstanceAdmin: false,
};

const AGENT_ACTOR = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
};

async function createApp(actor: Record<string, unknown> = BOARD_ACTOR) {
  vi.resetModules();
  const [{ errorHandler }, { momentRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/moments.js") as Promise<typeof import("../routes/moments.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", momentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

/**
 * supertest 直接吃 app 会绑到 ::1,WSL / 纯 IPv4 环境下必 EADDRNOTAVAIL。
 * 和 activity-routes.test.ts 一样,显式监听 127.0.0.1。
 */
async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function momentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "moment-1",
    companyId: "company-1",
    category: "ai_update",
    kind: "update",
    authorType: "agent",
    authorAgentId: "agent-1",
    authorUserId: null,
    content: "已更新「高净值场景开头」方法 v2.1 #抖音趋势",
    tags: ["抖音趋势"],
    card: null,
    likeCount: 0,
    commentCount: 0,
    deletedAt: null,
    ...overrides,
  };
}

describe.sequential("朋友圈路由", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockMomentService)) mock.mockReset();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("信息流:cursor 游标分页透传给服务层,limit 有上限", async () => {
    mockMomentService.listFeed.mockResolvedValue({ moments: [], nextCursor: null });

    const app = await createApp();
    const cursor = "2026-07-14T03:00:00.000Z";
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(
      `/api/companies/company-1/moments?cursor=${encodeURIComponent(cursor)}&limit=50`,
    ));

    expect(res.status).toBe(200);
    expect(mockMomentService.listFeed).toHaveBeenCalledWith(
      "company-1",
      { userId: "user-1", agentId: null },
      { cursor, limit: 50 },
    );
    expect(res.body).toEqual({ moments: [], nextCursor: null });
  });

  it("信息流:limit 超过 50 被 zod 拒掉,不会把整库拉下来", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/moments?limit=5000"));

    expect(res.status).toBe(400);
    expect(mockMomentService.listFeed).not.toHaveBeenCalled();
  });

  it("信息流:category tab 过滤透传;非法 category 被拒", async () => {
    mockMomentService.listFeed.mockResolvedValue({ moments: [], nextCursor: null });

    const app = await createApp();
    const ok = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/moments?category=industry"));
    expect(ok.status).toBe(200);
    expect(mockMomentService.listFeed).toHaveBeenCalledWith(
      "company-1",
      { userId: "user-1", agentId: null },
      { category: "industry", limit: 20 },
    );

    const bad = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/moments?category=gossip"));
    expect(bad.status).toBe(400);
  });

  it("发动态:作者由 actor 推导,客户端自称的 authorAgentId 被忽略", async () => {
    mockMomentService.create.mockResolvedValue({ id: "moment-9", category: "ai_update", kind: "update", card: null });

    const app = await createApp(AGENT_ACTOR);
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/moments")
      .send({
        content: "发现一个爆款规律 #选题",
        // 冒充别的员工 —— 必须被丢掉
        authorType: "user",
        authorAgentId: "agent-999",
        authorUserId: "someone-else",
      }));

    expect(res.status).toBe(201);
    const [companyId, actor, body] = mockMomentService.create.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    // 作者 = 拿着 key 的那个 agent,不是 body 里写的那个
    expect(actor).toEqual({ userId: null, agentId: "agent-1" });
    expect(body).toEqual({ content: "发现一个爆款规律 #选题" });
    expect(body).not.toHaveProperty("authorAgentId");
    expect(body).not.toHaveProperty("authorType");
  });

  it("发动态:跨公司被拒 —— agent key 发不进别人公司的朋友圈", async () => {
    const app = await createApp(AGENT_ACTOR);
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-2/moments")
      .send({ content: "越界发帖" }));

    expect(res.status).toBe(403);
    expect(mockMomentService.create).not.toHaveBeenCalled();
  });

  it("读信息流:跨公司同样被拒", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-2/moments"));

    expect(res.status).toBe(403);
    expect(mockMomentService.listFeed).not.toHaveBeenCalled();
  });

  it("匿名请求先 401,不会先去查动态是否存在", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await requestApp(app, (baseUrl) => request(baseUrl).post("/api/moments/moment-1/like"));

    expect(res.status).toBe(401);
    expect(mockMomentService.like).not.toHaveBeenCalled();
  });

  it("点赞:重复点赞是幂等的,likeCount 不会被加第二次", async () => {
    mockMomentService.getById.mockResolvedValue(momentFixture({ likeCount: 1 }));
    mockMomentService.like.mockResolvedValue({ liked: true, likeCount: 1 });

    const app = await createApp();
    const first = await requestApp(app, (baseUrl) => request(baseUrl).post("/api/moments/moment-1/like"));
    const second = await requestApp(app, (baseUrl) => request(baseUrl).post("/api/moments/moment-1/like"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // 双击不该 500(唯一索引冲突在服务层被吃掉),两次都回同一个计数
    expect(second.body).toEqual({ liked: true, likeCount: 1 });
    expect(mockMomentService.like).toHaveBeenCalledTimes(2);
    expect(mockMomentService.like).toHaveBeenLastCalledWith("moment-1", {
      userId: "user-1",
      agentId: null,
    });
  });

  it("取消点赞:走 unlike", async () => {
    mockMomentService.getById.mockResolvedValue(momentFixture({ likeCount: 1 }));
    mockMomentService.unlike.mockResolvedValue({ liked: false, likeCount: 0 });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).delete("/api/moments/moment-1/like"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liked: false, likeCount: 0 });
  });

  it("点赞不存在的动态 → 404", async () => {
    mockMomentService.getById.mockResolvedValue(null);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).post("/api/moments/missing/like"));

    expect(res.status).toBe(404);
    expect(mockMomentService.like).not.toHaveBeenCalled();
  });

  it("点赞别的公司的动态 → 403", async () => {
    mockMomentService.getById.mockResolvedValue(momentFixture({ companyId: "company-2" }));

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).post("/api/moments/moment-1/like"));

    expect(res.status).toBe(403);
    expect(mockMomentService.like).not.toHaveBeenCalled();
  });

  it("评论:支持楼中楼,parentCommentId 透传", async () => {
    const parentId = randomUUID();
    mockMomentService.getById.mockResolvedValue(momentFixture());
    mockMomentService.addComment.mockResolvedValue({ id: "c1", momentId: "moment-1" });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/moments/moment-1/comments")
      .send({ body: "这个方法我们试过,有效", parentCommentId: parentId }));

    expect(res.status).toBe(201);
    expect(mockMomentService.addComment).toHaveBeenCalledWith(
      "moment-1",
      { userId: "user-1", agentId: null },
      { body: "这个方法我们试过,有效", parentCommentId: parentId },
    );
  });

  it("评论:空内容被拒", async () => {
    mockMomentService.getById.mockResolvedValue(momentFixture());

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).post("/api/moments/moment-1/comments").send({ body: "   " }));

    expect(res.status).toBe(400);
    expect(mockMomentService.addComment).not.toHaveBeenCalled();
  });

  it("收藏:写进知识库,返回 collection_items 的 id", async () => {
    mockMomentService.getById.mockResolvedValue(momentFixture());
    mockMomentService.favorite.mockResolvedValue({ favorited: true, collectionItemId: "item-1" });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).post("/api/moments/moment-1/favorite").send({}));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ favorited: true, collectionItemId: "item-1" });
    expect(mockMomentService.favorite).toHaveBeenCalledWith(
      "moment-1",
      { userId: "user-1", agentId: null },
      {},
    );
  });

  it("取消收藏:软删知识库那一行", async () => {
    mockMomentService.getById.mockResolvedValue(momentFixture());
    mockMomentService.unfavorite.mockResolvedValue({ favorited: false });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).delete("/api/moments/moment-1/favorite"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ favorited: false });
  });

  it("删除:agent 永远不是管理员,只能删自己的(canModerate=false)", async () => {
    mockMomentService.getById.mockResolvedValue(momentFixture());
    mockMomentService.remove.mockResolvedValue(undefined);

    const app = await createApp(AGENT_ACTOR);
    const res = await requestApp(app, (baseUrl) => request(baseUrl).delete("/api/moments/moment-1"));

    expect(res.status).toBe(204);
    expect(mockMomentService.remove).toHaveBeenCalledWith(
      "moment-1",
      { userId: null, agentId: "agent-1" },
      false,
    );
  });

  it("删除:公司 owner 可以删别人的动态(canModerate=true)", async () => {
    mockMomentService.getById.mockResolvedValue(momentFixture());
    mockMomentService.remove.mockResolvedValue(undefined);

    const app = await createApp({
      ...BOARD_ACTOR,
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    });
    const res = await requestApp(app, (baseUrl) => request(baseUrl).delete("/api/moments/moment-1"));

    expect(res.status).toBe(204);
    expect(mockMomentService.remove).toHaveBeenCalledWith(
      "moment-1",
      { userId: "user-1", agentId: null },
      true,
    );
  });

  it("侧栏:常去的 AI 员工 / 热门方法包", async () => {
    mockMomentService.sidebar.mockResolvedValue({ frequentAgents: [], hotCards: [] });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/moments/sidebar"));

    expect(res.status).toBe(200);
    expect(mockMomentService.sidebar).toHaveBeenCalledWith("company-1");
  });
});

// ---------------------------------------------------------------------------
// 真库测试:计数器的事务纪律,mock 是验证不了的 —— 双击点赞会不会把 like_count 顶到 2,
// 只有真的打到 Postgres(部分唯一索引 + 事务)才知道。
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("朋友圈计数器与收藏(真库)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let svc: Awaited<ReturnType<typeof loadService>>;
  let companyId: string;
  let agentId: string;

  async function loadService() {
    const actual = await vi.importActual<typeof import("../services/moments.js")>(
      "../services/moments.js",
    );
    return actual.momentService(db);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-moments-");
    db = createDb(tempDb.connectionString);
    svc = await loadService();

    const company = await db
      .insert(companies)
      .values({
        name: `Moments ${randomUUID()}`,
        issuePrefix: `MO${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;

    const agent = await db
      .insert(agents)
      .values({ companyId, name: "文案编导", role: "文案编导" })
      .returning()
      .then((rows) => rows[0]!);
    agentId = agent.id;
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("AI 员工发动态:category / tags 兜底推断,作者是 agent", async () => {
    const moment = await svc.create(
      companyId,
      { userId: null, agentId },
      { content: "行业里在传的这个玩法其实过时了 #抖音趋势 #内容建议", kind: "insight" },
    );

    // insight → 行业资讯 tab(inferCategory)
    expect(moment.category).toBe("industry");
    expect(moment.tags).toEqual(["抖音趋势", "内容建议"]);
    expect(moment.author).toMatchObject({ type: "agent", id: agentId, name: "文案编导" });
    expect(moment.likedByMe).toBe(false);
    expect(moment.favoritedByMe).toBe(false);
  });

  it("双击点赞不会把 like_count 顶到 2,取消点赞会减回去", async () => {
    const moment = await svc.create(companyId, { userId: null, agentId }, { content: "点赞计数器测试" });
    const user = { userId: "user-1", agentId: null };

    const first = await svc.like(moment.id, user);
    const second = await svc.like(moment.id, user);
    expect(first.likeCount).toBe(1);
    expect(second.likeCount).toBe(1);

    const stored = await db
      .select({ likeCount: moments.likeCount })
      .from(moments)
      .where(eq(moments.id, moment.id))
      .then((rows) => rows[0]!);
    expect(stored.likeCount).toBe(1);

    // 另一个人点赞 → 2;agent 与 user 是不同主体
    const byAgent = await svc.like(moment.id, { userId: null, agentId });
    expect(byAgent.likeCount).toBe(2);

    const unliked = await svc.unlike(moment.id, user);
    expect(unliked.likeCount).toBe(1);
    // 重复取消不会减成负数
    const again = await svc.unlike(moment.id, user);
    expect(again.likeCount).toBe(1);
  });

  it("并发点赞(同一个人 5 次)最终 like_count 仍是 1", async () => {
    const moment = await svc.create(companyId, { userId: null, agentId }, { content: "并发点赞" });
    const user = { userId: "user-race", agentId: null };

    await Promise.all(Array.from({ length: 5 }, () => svc.like(moment.id, user)));

    const stored = await db
      .select({ likeCount: moments.likeCount })
      .from(moments)
      .where(eq(moments.id, moment.id))
      .then((rows) => rows[0]!);
    expect(stored.likeCount).toBe(1);
  });

  it("likedByMe / favoritedByMe 按当前 actor 计算,不串号", async () => {
    const moment = await svc.create(companyId, { userId: null, agentId }, { content: "likedByMe 测试" });
    const me = { userId: "user-me", agentId: null };
    const other = { userId: "user-other", agentId: null };

    await svc.like(moment.id, me);
    await svc.favorite(moment.id, me);

    const mine = await svc.listFeed(companyId, me, { limit: 50 });
    const seenByMe = mine.moments.find((item) => item.id === moment.id)!;
    expect(seenByMe.likedByMe).toBe(true);
    expect(seenByMe.favoritedByMe).toBe(true);

    const theirs = await svc.listFeed(companyId, other, { limit: 50 });
    const seenByOther = theirs.moments.find((item) => item.id === moment.id)!;
    expect(seenByOther.likedByMe).toBe(false);
    expect(seenByOther.favoritedByMe).toBe(false);
  });

  it("收藏写的是 collection_items(不是第二张收藏表),取消收藏是软删同一行", async () => {
    const moment = await svc.create(companyId, { userId: null, agentId }, { content: "收藏落知识库" });
    const user = { userId: "user-fav", agentId: null };

    const favorited = await svc.favorite(moment.id, user);
    const item = await db
      .select()
      .from(collectionItems)
      .where(eq(collectionItems.id, favorited.collectionItemId))
      .then((rows) => rows[0]!);
    expect(item.sourceMomentId).toBe(moment.id);
    expect(item.contentType).toBe("moment");
    expect(item.createdByUserId).toBe("user-fav");
    expect(item.deletedAt).toBeNull();

    // 重复收藏不产生第二行
    const again = await svc.favorite(moment.id, user);
    expect(again.collectionItemId).toBe(favorited.collectionItemId);
    const rows = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.sourceMomentId, moment.id),
          eq(collectionItems.createdByUserId, "user-fav"),
        ),
      );
    expect(rows).toHaveLength(1);

    await svc.unfavorite(moment.id, user);
    const softDeleted = await db
      .select({ deletedAt: collectionItems.deletedAt })
      .from(collectionItems)
      .where(eq(collectionItems.id, favorited.collectionItemId))
      .then((r) => r[0]!);
    expect(softDeleted.deletedAt).not.toBeNull();
  });

  it("评论:comment_count 同事务累加,楼中楼的父评论必须同属一条动态", async () => {
    const moment = await svc.create(companyId, { userId: null, agentId }, { content: "评论计数器" });
    const other = await svc.create(companyId, { userId: null, agentId }, { content: "另一条动态" });
    const user = { userId: "user-c", agentId: null };

    const root = await svc.addComment(moment.id, user, { body: "顶一个" });
    await svc.addComment(moment.id, { userId: null, agentId }, { body: "谢谢", parentCommentId: root.id });

    const stored = await db
      .select({ commentCount: moments.commentCount })
      .from(moments)
      .where(eq(moments.id, moment.id))
      .then((rows) => rows[0]!);
    expect(stored.commentCount).toBe(2);

    const list = await svc.listComments(moment.id);
    expect(list).toHaveLength(2);
    expect(list[1]!.parentCommentId).toBe(root.id);
    expect(list[1]!.author).toMatchObject({ type: "agent", id: agentId });

    // 跨动态挂楼 → 400
    await expect(
      svc.addComment(other.id, user, { body: "越界", parentCommentId: root.id }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("信息流:cursor 分页不重不漏,软删的不出现", async () => {
    const fresh = `feed-${randomUUID()}`;
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      created.push(
        await svc.create(companyId, { userId: null, agentId }, { content: `${fresh} 第 ${i} 条` }),
      );
    }
    const user = { userId: "user-feed", agentId: null };

    const page1 = await svc.listFeed(companyId, user, { limit: 2 });
    expect(page1.moments).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.moments[1]!.createdAt);

    const page2 = await svc.listFeed(companyId, user, { limit: 2, cursor: page1.nextCursor! });
    const page1Ids = page1.moments.map((m) => m.id);
    for (const item of page2.moments) {
      expect(page1Ids).not.toContain(item.id);
    }

    // 软删后不再出现在信息流
    await svc.remove(created[0]!.id, { userId: null, agentId }, false);
    const after = await svc.listFeed(companyId, user, { limit: 50 });
    expect(after.moments.map((m) => m.id)).not.toContain(created[0]!.id);
  });

  it("删除:不是作者、也不是管理员 → 403", async () => {
    const moment = await svc.create(companyId, { userId: null, agentId }, { content: "别人的动态" });
    await expect(
      svc.remove(moment.id, { userId: "user-stranger", agentId: null }, false),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("侧栏:常去的 AI 员工按发帖数排序,热门方法包按点赞数排序", async () => {
    const packed = await svc.create(
      companyId,
      { userId: null, agentId },
      {
        content: "方法包更新",
        card: { type: "method_pack", title: "高净值场景开头 v2.1", version: "v2.1" },
      },
    );
    await svc.like(packed.id, { userId: "user-sidebar", agentId: null });

    const sidebar = await svc.sidebar(companyId);
    expect(sidebar.frequentAgents[0]).toMatchObject({ agentId, name: "文案编导" });
    expect(sidebar.frequentAgents[0]!.momentCount).toBeGreaterThan(0);
    expect(sidebar.hotCards.map((card) => card.momentId)).toContain(packed.id);
    expect(sidebar.hotCards[0]).toMatchObject({ type: "method_pack" });
  });
});
