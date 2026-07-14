import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { once } from "node:events";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  conversations,
  createDb,
  messageMentions,
  messages,
} from "@paperclipai/db";
import { formatMention } from "@xiaojing/protocol";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { imRoutes } from "../routes/im.js";
import { imEventBus } from "../services/im.js";
import type { ImEvent, ImMessage } from "@xiaojing/protocol";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres IM route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("IM 路由(群聊 / 私聊 / 卡片 / @提及 / 实时补齐)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const USER = "user_zhang";
  const OTHER_USER = "user_li";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("xiaojing-im-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const server of openServers.splice(0)) server.close();
    // conversations 一删,members / messages / mentions 全部 cascade 掉(0148 的外键定义)
    await db.delete(conversations);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * 显式绑 127.0.0.1 —— supertest 默认让 express 监听 `::`,再回连 `::1`。
   * 没有 IPv6 回环的机器(容器 / WSL)上会 EADDRNOTAVAIL 全红,和被测代码无关。
   */
  const openServers: Server[] = [];
  async function app(actor: Partial<Express.Request["actor"]> = {}): Promise<Server> {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      // local_implicit:公司作用域的鉴权由 authz 层保证(它自己有测试),
      // 这里要测的是「会话成员资格」这一层 —— 不是群成员就读不到、发不出。
      req.actor = {
        type: "board",
        source: "local_implicit",
        userId: USER,
        isInstanceAdmin: true,
        ...actor,
      } as Express.Request["actor"];
      next();
    });
    instance.use("/api", imRoutes(db));
    instance.use(errorHandler);
    const server = instance.listen(0, "127.0.0.1");
    openServers.push(server);
    // 必须等 listening —— 否则 supertest 读到 address() 为 null,会自己再 listen 一次(绑到 ::)
    await once(server, "listening");
    return server;
  }

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "小镜", issuePrefix: `X${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    return company!;
  }

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return agent!;
  }

  /** 一个群:操盘手(真人)+ 文案编导 + 账号诊断师。 */
  async function seedGroup() {
    const company = await seedCompany();
    const writer = await seedAgent(company.id, "文案编导");
    const doctor = await seedAgent(company.id, "账号诊断师");
    const res = await request(await app())
      .post(`/api/companies/${company.id}/conversations`)
      .send({ kind: "group", title: "我的 AI 团队", agentIds: [writer.id, doctor.id] })
      .expect(201);
    return { company, writer, doctor, conversationId: res.body.id as string };
  }

  it("建群:真人 + 一队 AI 员工都在成员里", async () => {
    const { conversationId, writer } = await seedGroup();
    const res = await request(await app()).get(`/api/conversations/${conversationId}/members`).expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.find((m: { id: string }) => m.id === writer.id)).toMatchObject({
      memberType: "agent",
      name: "文案编导",
    });
  });

  it("发消息:seq 严格递增且无空洞 —— 客户端补洞逻辑全靠这个前提", async () => {
    const { conversationId } = await seedGroup();
    for (const body of ["第一条", "第二条", "第三条"]) {
      await request(await app()).post(`/api/conversations/${conversationId}/messages`).send({ body }).expect(201);
    }
    const res = await request(await app()).get(`/api/conversations/${conversationId}/messages`).expect(200);
    expect(res.body.map((m: ImMessage) => m.seq)).toEqual([1, 2, 3]);
    expect(res.body.map((m: ImMessage) => m.body)).toEqual(["第一条", "第二条", "第三条"]);
  });

  it("clientNonce 幂等:断线重发同一条不会变成两条", async () => {
    const { conversationId } = await seedGroup();
    const payload = { body: "这条我重发了三次", clientNonce: "nonce-1" };

    const first = await request(await app()).post(`/api/conversations/${conversationId}/messages`).send(payload).expect(201);
    // 重发命中幂等 → 200(而不是 201),返回的是同一条
    const again = await request(await app()).post(`/api/conversations/${conversationId}/messages`).send(payload).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.seq).toBe(first.body.seq);

    const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(rows).toHaveLength(1);
  });

  it("并发发送:seq 不重不漏(唯一索引 + 事务内自增顶住)", async () => {
    const { conversationId } = await seedGroup();
    const client = await app();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(client).post(`/api/conversations/${conversationId}/messages`).send({ body: `并发 ${i}` }),
      ),
    );
    const rows = await db.select({ seq: messages.seq }).from(messages).where(eq(messages.conversationId, conversationId));
    expect([...rows.map((r) => Number(r.seq))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("@提及某个 AI 员工:落 mention 行 + 标 pending(等桌面客户端来领着跑)", async () => {
    const { conversationId, writer } = await seedGroup();
    const body = `${formatMention("agent", writer.id, "文案编导")} 写一条讲彩礼返还的脚本`;

    const res = await request(await app()).post(`/api/conversations/${conversationId}/messages`).send({ body }).expect(201);
    expect(res.body.mentions).toEqual([
      { mentionType: "agent", agentId: writer.id, userId: null, squadId: null },
    ]);

    const rows = await db.select().from(messageMentions).where(eq(messageMentions.messageId, res.body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: writer.id, mentionType: "agent", wakeupState: "pending" });
  });

  it("@提及路由到指定员工:@诊断师不会顺手唤醒编导", async () => {
    const { conversationId, writer, doctor } = await seedGroup();
    const body = `${formatMention("agent", doctor.id, "账号诊断师")} 看下最近掉粉`;
    const res = await request(await app()).post(`/api/conversations/${conversationId}/messages`).send({ body }).expect(201);

    const pending = await db
      .select({ agentId: messageMentions.agentId })
      .from(messageMentions)
      .where(and(eq(messageMentions.messageId, res.body.id), eq(messageMentions.wakeupState, "pending")));
    expect(pending.map((p) => p.agentId)).toEqual([doctor.id]);
    expect(pending.map((p) => p.agentId)).not.toContain(writer.id);
  });

  it("AI 员工之间互 @ 不触发唤醒 —— 否则两个 agent 能互相 @ 到天亮,烧的是用户算力", async () => {
    const { conversationId, writer, doctor } = await seedGroup();
    const body = `${formatMention("agent", doctor.id, "账号诊断师")} 你怎么看`;

    await request(await app())
      .post(`/api/conversations/${conversationId}/messages`)
      .send({ body, senderType: "agent", senderAgentId: writer.id })
      .expect(201);

    const rows = await db.select().from(messageMentions).where(eq(messageMentions.agentId, doctor.id));
    expect(rows[0]?.wakeupState).toBe("none");
  });

  it("AI 员工主动发言:桌面客户端代它回帖,但它必须真的在群里", async () => {
    const { conversationId, writer, company } = await seedGroup();

    const ok = await request(await app())
      .post(`/api/conversations/${conversationId}/messages`)
      .send({ body: "选题给你出好了", senderType: "agent", senderAgentId: writer.id })
      .expect(201);
    expect(ok.body).toMatchObject({ senderType: "agent", senderAgentId: writer.id, senderName: "文案编导" });

    // 不在群里的员工不能被冒名顶替 —— 否则任何登录用户都能伪造任意 AI 员工发言
    const outsider = await seedAgent(company.id, "合规审稿员");
    await request(await app())
      .post(`/api/conversations/${conversationId}/messages`)
      .send({ body: "我不在这个群", senderType: "agent", senderAgentId: outsider.id })
      .expect(403);
  });

  it("卡片消息:落库带 payload,缺 cardType 直接 400", async () => {
    const { conversationId, writer } = await seedGroup();
    const payload = {
      title: "本周 5 个选题",
      topics: [{ title: "彩礼能不能要回来", hook: "订婚三个月分手" }],
    };

    const res = await request(await app())
      .post(`/api/conversations/${conversationId}/messages`)
      .send({ kind: "card", cardType: "topic_list", cardPayload: payload, senderType: "agent", senderAgentId: writer.id })
      .expect(201);
    expect(res.body).toMatchObject({ kind: "card", cardType: "topic_list" });
    expect(res.body.cardPayload).toEqual(payload);

    await request(await app())
      .post(`/api/conversations/${conversationId}/messages`)
      .send({ kind: "card", cardPayload: payload })
      .expect(400);
  });

  it("未读数 = lastSeq - lastReadSeq;已读后清零,自己发的不算未读", async () => {
    const { conversationId, company, writer } = await seedGroup();

    // AI 员工发了 2 条 → 用户有 2 条未读
    for (const body of ["汇报一", "汇报二"]) {
      await request(await app())
        .post(`/api/conversations/${conversationId}/messages`)
        .send({ body, senderType: "agent", senderAgentId: writer.id })
        .expect(201);
    }
    let list = await request(await app()).get(`/api/companies/${company.id}/conversations`).expect(200);
    expect(list.body[0]).toMatchObject({ unread: 2, mentioned: false });
    expect(list.body[0].lastMessagePreview).toBe("汇报二");

    await request(await app()).post(`/api/conversations/${conversationId}/read`).send({ lastReadSeq: 2 }).expect(200);
    list = await request(await app()).get(`/api/companies/${company.id}/conversations`).expect(200);
    expect(list.body[0].unread).toBe(0);

    // 自己发的消息不该给自己算未读
    await request(await app()).post(`/api/conversations/${conversationId}/messages`).send({ body: "收到" }).expect(201);
    list = await request(await app()).get(`/api/companies/${company.id}/conversations`).expect(200);
    expect(list.body[0].unread).toBe(0);
  });

  it("@我 的未读点亮红点(mentioned=true)", async () => {
    const { conversationId, company, writer } = await seedGroup();
    await request(await app())
      .post(`/api/conversations/${conversationId}/messages`)
      .send({
        body: `${formatMention("user", USER, "老张")} 初稿好了,你看下`,
        senderType: "agent",
        senderAgentId: writer.id,
      })
      .expect(201);

    const list = await request(await app()).get(`/api/companies/${company.id}/conversations`).expect(200);
    expect(list.body[0]).toMatchObject({ unread: 1, mentioned: true });
  });

  it("断线补齐:afterSeq 拿回漏掉的那一段,一条不少", async () => {
    const { conversationId } = await seedGroup();
    for (const body of ["1", "2", "3", "4", "5"]) {
      await request(await app()).post(`/api/conversations/${conversationId}/messages`).send({ body }).expect(201);
    }
    // 客户端断线时水位线停在 seq=2
    const res = await request(await app())
      .get(`/api/conversations/${conversationId}/messages?afterSeq=2`)
      .expect(200);
    expect(res.body.map((m: ImMessage) => m.seq)).toEqual([3, 4, 5]);
  });

  it("上翻历史:beforeSeq 倒着分页", async () => {
    const { conversationId } = await seedGroup();
    for (const body of ["1", "2", "3", "4", "5"]) {
      await request(await app()).post(`/api/conversations/${conversationId}/messages`).send({ body }).expect(201);
    }
    const res = await request(await app())
      .get(`/api/conversations/${conversationId}/messages?beforeSeq=4&limit=2`)
      .expect(200);
    expect(res.body.map((m: ImMessage) => m.seq)).toEqual([2, 3]);
  });

  it("SSE:先重放断线期间漏的,再转直播 —— 中间不丢消息", async () => {
    const { conversationId } = await seedGroup();
    for (const body of ["1", "2", "3"]) {
      await request(await app()).post(`/api/conversations/${conversationId}/messages`).send({ body }).expect(201);
    }

    const received: ImEvent[] = [];
    const server = await app();
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/conversations/${conversationId}/events?sinceSeq=1`,
        { signal: controller.signal },
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      const pump = (async () => {
        let buf = "";
        while (received.length < 3) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (line) received.push(JSON.parse(line.slice(6)) as ImEvent);
          }
        }
      })();

      // 重放(seq 2、3)完之后,再来一条直播的(seq 4)
      await new Promise((r) => setTimeout(r, 150));
      await request(await app()).post(`/api/conversations/${conversationId}/messages`).send({ body: "直播的" }).expect(201);
      await pump;
      controller.abort();

      const seqs = received
        .filter((e): e is Extract<ImEvent, { type: "message.created" }> => e.type === "message.created")
        .map((e) => e.message.seq);
      expect(seqs).toEqual([2, 3, 4]);
    } finally {
      controller.abort();
      server.close();
    }
  });

  it("SSE 推 agent.invoke:@员工时唤醒事件发出去(agent loop 在客户端跑,不在这里)", async () => {
    const { conversationId, writer } = await seedGroup();
    const events: ImEvent[] = [];
    const unsubscribe = imEventBus.subscribe(conversationId, (e) => events.push(e));

    const res = await request(await app())
      .post(`/api/conversations/${conversationId}/messages`)
      .send({ body: `${formatMention("agent", writer.id, "文案编导")} 出个脚本` })
      .expect(201);
    unsubscribe();

    expect(events.map((e) => e.type)).toEqual(["message.created", "agent.invoke"]);
    expect(events[1]).toMatchObject({ type: "agent.invoke", agentId: writer.id, messageId: res.body.id });

    // 客户端领走唤醒 → 标 triggered,重复领取返回 false(不会重复烧算力)
    const claim = await request(await app())
      .post(`/api/conversations/${conversationId}/messages/${res.body.id}/claim`)
      .send({ agentId: writer.id })
      .expect(200);
    expect(claim.body.claimed).toBe(true);

    const again = await request(await app())
      .post(`/api/conversations/${conversationId}/messages/${res.body.id}/claim`)
      .send({ agentId: writer.id })
      .expect(200);
    expect(again.body.claimed).toBe(false);
  });

  it("不是群成员就读不到、发不出 —— 私聊不会漏给别人", async () => {
    const { conversationId } = await seedGroup();
    const outsider = await app({ userId: OTHER_USER });

    await request(outsider).get(`/api/conversations/${conversationId}/messages`).expect(403);
    await request(outsider).post(`/api/conversations/${conversationId}/messages`).send({ body: "偷看" }).expect(403);
  });

  it("私聊:必须且只能有 1 个 AI 员工", async () => {
    const company = await seedCompany();
    const writer = await seedAgent(company.id, "文案编导");

    const ok = await request(await app())
      .post(`/api/companies/${company.id}/conversations`)
      .send({ kind: "direct", title: "文案编导", agentIds: [writer.id] })
      .expect(201);
    expect(ok.body.kind).toBe("direct");

    await request(await app())
      .post(`/api/companies/${company.id}/conversations`)
      .send({ kind: "direct", agentIds: [] })
      .expect(400);
  });
});
