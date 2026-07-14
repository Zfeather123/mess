import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { conversations, type Db } from "@paperclipai/db";
import type { ImEvent } from "@xiaojing/protocol";
import { validate } from "../middleware/validate.js";
import { imEventBus, imService, type ImActor } from "../services/im.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * IM 路由(挂在 /api 下)—— 群聊 / 私聊的 HTTP + SSE 接口。
 *
 *   GET  /companies/:companyId/conversations        会话列表(带未读数 / @我红点)
 *   POST /companies/:companyId/conversations        建群 / 建私聊
 *   GET  /conversations/:id/members                 成员(@选择器 + 右侧面板)
 *   GET  /conversations/:id/messages                首屏 / 上翻(beforeSeq) / 补齐(afterSeq)
 *   POST /conversations/:id/messages                发消息(clientNonce 幂等)
 *   POST /conversations/:id/read                    已读游标前移
 *   GET  /conversations/:id/events                  SSE 实时推送(sinceSeq 断点续传)
 *   POST /conversations/:id/messages/:messageId/claim  领走 @唤醒(防重复烧算力)
 *
 * 为什么是 SSE 不是 WebSocket:推送是**单向**的(服务端 → 客户端),上行走普通
 * HTTP 就够。SSE 自带断线重连和 Last-Event-ID 语义,能穿透企业代理,而 WS 经常
 * 被挡。真需要双向低延迟(第二期的协同编辑)再升级 —— 客户端的 MessageStore
 * 不关心底下是哪种通道。
 */

const createConversationSchema = z.object({
  kind: z.enum(["group", "direct"]),
  title: z.string().min(1).max(120).optional(),
  agentIds: z.array(z.string().uuid()).max(50).optional(),
  userIds: z.array(z.string().min(1)).max(50).optional(),
  squadId: z.string().uuid().optional(),
});

const sendMessageSchema = z.object({
  body: z.string().max(20_000).optional(),
  kind: z.enum(["text", "card", "image", "file", "system"]).optional(),
  cardType: z.enum(["topic_list", "draft", "profile_gap", "diagnosis", "approval"]).optional(),
  cardPayload: z.record(z.unknown()).optional(),
  replyToMessageId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
  approvalId: z.string().uuid().optional(),
  clientNonce: z.string().min(1).max(120).optional(),
  senderType: z.enum(["user", "agent", "system"]).optional(),
  senderAgentId: z.string().uuid().optional(),
});

const markReadSchema = z.object({ lastReadSeq: z.number().int().min(0) });

/** SSE 心跳周期。代理通常在 60s 静默后砍连接,25s 留足余量。 */
const HEARTBEAT_MS = 25_000;

function actorOf(req: Parameters<typeof getActorInfo>[0]): ImActor {
  const actor = getActorInfo(req);
  return actor.actorType === "agent"
    ? { userId: null, agentId: actor.agentId }
    : { userId: actor.actorId, agentId: null };
}

function parseSeq(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function imRoutes(db: Db) {
  const router = Router();
  const svc = imService(db);

  /** 会话作用域的鉴权:先确认公司可访问,成员校验由 service 层做。 */
  async function conversationCompany(id: string): Promise<string> {
    const [conv] = await db
      .select({ companyId: conversations.companyId })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!conv) throw notFound("Conversation not found");
    return conv.companyId;
  }

  router.get("/companies/:companyId/conversations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listConversations(companyId, actorOf(req)));
  });

  router.post(
    "/companies/:companyId/conversations",
    validate(createConversationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.status(201).json(await svc.createConversation(companyId, actorOf(req), req.body));
    },
  );

  router.get("/conversations/:id/members", async (req, res) => {
    const id = req.params.id as string;
    assertCompanyAccess(req, await conversationCompany(id));
    const actor = actorOf(req);
    await svc.requireMembership(id, actor);
    res.json(await svc.listMembers(id));
  });

  router.get("/conversations/:id/messages", async (req, res) => {
    const id = req.params.id as string;
    assertCompanyAccess(req, await conversationCompany(id));
    const messages = await svc.listMessages(id, actorOf(req), {
      beforeSeq: parseSeq(req.query.beforeSeq),
      afterSeq: parseSeq(req.query.afterSeq),
      limit: parseSeq(req.query.limit),
    });
    res.json(messages);
  });

  router.post("/conversations/:id/messages", validate(sendMessageSchema), async (req, res) => {
    const id = req.params.id as string;
    assertCompanyAccess(req, await conversationCompany(id));
    const { message, deduped } = await svc.sendMessage(id, actorOf(req), req.body);
    // 幂等命中返回 200 而不是 201 —— 客户端据此知道「这条之前就落库了,不是新建的」
    res.status(deduped ? 200 : 201).json(message);
  });

  router.post("/conversations/:id/read", validate(markReadSchema), async (req, res) => {
    const id = req.params.id as string;
    assertCompanyAccess(req, await conversationCompany(id));
    res.json(await svc.markRead(id, actorOf(req), req.body.lastReadSeq));
  });

  router.post("/conversations/:id/messages/:messageId/claim", async (req, res) => {
    const id = req.params.id as string;
    const messageId = req.params.messageId as string;
    assertCompanyAccess(req, await conversationCompany(id));
    const actor = actorOf(req);
    await svc.requireMembership(id, actor);
    const agentId = (req.body?.agentId as string | undefined) ?? actor.agentId;
    if (!agentId) {
      res.status(400).json({ error: "agentId is required" });
      return;
    }
    res.json({ claimed: await svc.claimMention(messageId, agentId) });
  });

  /**
   * SSE 实时通道。**「不丢消息、断线能重连补齐」的服务端一半。**
   *
   * 客户端带上水位线 `?sinceSeq=N` 重连 → 服务端先重放 N 之后的消息,再转直播。
   * 重放期间到达的直播事件先入缓冲区,重放完再冲出去 —— 否则会出现「新消息先于
   * 旧消息到达」,客户端 store 虽然能扛(它会扣住乱序的),但白白多一次补洞往返。
   */
  router.get("/conversations/:id/events", async (req, res) => {
    const id = req.params.id as string;
    assertCompanyAccess(req, await conversationCompany(id));
    const actor = actorOf(req);
    await svc.requireMembership(id, actor);
    const sinceSeq = parseSeq(req.query.sinceSeq);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // nginx 默认会缓冲响应体,SSE 就变成「攒一堆再一起吐」。必须关掉。
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const write = (event: ImEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let replaying = true;
    const buffered: ImEvent[] = [];
    const unsubscribe = imEventBus.subscribe(id, (event) => {
      if (replaying) buffered.push(event);
      else write(event);
    });

    const heartbeat = setInterval(() => write({ type: "ping", ts: Date.now() }), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    try {
      if (sinceSeq != null) {
        const missed = await svc.listMessages(id, actor, { afterSeq: sinceSeq, limit: 200 });
        for (const message of missed) write({ type: "message.created", conversationId: id, message });
      }
    } finally {
      replaying = false;
      for (const event of buffered) write(event);
      buffered.length = 0;
    }
  });

  return router;
}
