import { EventEmitter } from "node:events";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  agents,
  conversationMembers,
  conversations,
  messageMentions,
  messages,
  type Db,
} from "@paperclipai/db";
import {
  parseMentions,
  plainPreview,
  type ImConversation,
  type ImEvent,
  type ImMember,
  type ImMessage,
  type SendMessageInput,
} from "@xiaojing/protocol";
import { badRequest, forbidden, notFound } from "../errors.js";

/**
 * IM 服务 —— 群聊 / 私聊的服务端真相。
 *
 * 三条不变量,全部由 DB 保证,不靠应用层自觉:
 *
 * 1. **全序**:seq 由 `UPDATE conversations SET last_seq = last_seq + 1 RETURNING`
 *    在事务里分配。并发发送会被行锁排队,拿到的 seq 严格递增且无空洞 ——
 *    客户端的补洞逻辑(MessageStore)完全建立在「无空洞」这个前提上。
 *    绝不能用 createdAt 排序:同毫秒并发 + 多实例时钟漂移都会乱序。
 *
 * 2. **幂等**:(conversation_id, client_nonce) 上有唯一索引。断线重发同一条
 *    不会变成两条 —— 这不是「查一下有没有」那种 TOCTOU 写法,是索引兜底。
 *
 * 3. **@提及只有一份格式**:解析用 @xiaojing/protocol 的 parseMentions,
 *    和客户端同一个函数。UI 高亮了但 agent 没被唤醒这种 bug 从根上不存在。
 *
 * 注意:agent loop **不在这里跑**。@到某个 AI 员工时,服务端只把 mention 标成
 * `pending` 并推一个 `agent.invoke` 事件出去;真正的执行发生在用户的桌面客户端
 * (内嵌 Agent SDK)。服务端是薄的。
 */

export interface ImActor {
  /** 真人:userId;AI 员工:agentId(桌面客户端代其发言时) */
  userId: string | null;
  agentId: string | null;
}

/**
 * 会话内实时事件总线(进程内)。
 *
 * 单实例够用;多实例部署时把它换成 Redis pub/sub —— 换的是这一个类,
 * 路由层和客户端都不用动(这正是它单独存在的理由)。
 */
class ImEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // SSE 连接数会随在线用户线性增长,默认 10 个 listener 上限会刷警告
    this.emitter.setMaxListeners(0);
  }

  publish(conversationId: string, event: ImEvent): void {
    this.emitter.emit(conversationId, event);
  }

  subscribe(conversationId: string, listener: (event: ImEvent) => void): () => void {
    this.emitter.on(conversationId, listener);
    return () => this.emitter.off(conversationId, listener);
  }
}

export const imEventBus = new ImEventBus();

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

type MessageRow = typeof messages.$inferSelect;

function toImMessage(row: MessageRow, senderName?: string | null): ImMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: Number(row.seq),
    senderType: row.senderType as ImMessage["senderType"],
    senderUserId: row.senderUserId,
    senderAgentId: row.senderAgentId,
    senderName: senderName ?? null,
    kind: row.kind as ImMessage["kind"],
    body: row.body,
    cardType: (row.cardType as ImMessage["cardType"]) ?? null,
    cardPayload: row.cardPayload ?? null,
    issueId: row.issueId,
    documentId: row.documentId,
    approvalId: row.approvalId,
    replyToMessageId: row.replyToMessageId,
    mentions: parseMentions(row.body).map((m) => ({
      mentionType: m.mentionType,
      userId: m.userId,
      agentId: m.agentId,
      squadId: m.squadId,
    })),
    clientNonce: row.clientNonce,
    createdAt: row.createdAt.toISOString(),
  };
}

export function imService(db: Db) {
  /** 会话成员(含 AI 员工的显示名)—— @选择器和右侧面板都要它。 */
  async function listMembers(conversationId: string): Promise<ImMember[]> {
    const rows = await db
      .select({
        memberType: conversationMembers.memberType,
        userId: conversationMembers.userId,
        agentId: conversationMembers.agentId,
        role: conversationMembers.role,
        agentName: agents.name,
      })
      .from(conversationMembers)
      .leftJoin(agents, eq(agents.id, conversationMembers.agentId))
      .where(
        and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)),
      );

    return rows.map((r) => ({
      memberType: r.memberType as ImMember["memberType"],
      id: (r.memberType === "agent" ? r.agentId : r.userId) ?? "",
      name: r.memberType === "agent" ? (r.agentName ?? "AI 员工") : (r.userId ?? "成员"),
      role: r.role,
      // MVP:AI 员工恒在线(agent loop 跑在用户自己的机器上,只要客户端开着就在)。
      // 真实 presence 等 JIN-53 的员工系统落地后再接。
      presence: r.memberType === "agent" ? "online" : "online",
    }));
  }

  async function requireMembership(conversationId: string, actor: ImActor) {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!conv) throw notFound("Conversation not found");

    const [member] = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          isNull(conversationMembers.leftAt),
          actor.agentId
            ? eq(conversationMembers.agentId, actor.agentId)
            : eq(conversationMembers.userId, actor.userId ?? "__none__"),
        ),
      )
      .limit(1);
    if (!member) throw forbidden("Not a member of this conversation");
    return { conv, member };
  }

  return {
    listMembers,
    requireMembership,

    /** 「我的会话列表」—— 未读数 O(1) 算出(lastSeq - lastReadSeq),不扫 messages。 */
    async listConversations(companyId: string, actor: ImActor): Promise<ImConversation[]> {
      const memberFilter = actor.agentId
        ? eq(conversationMembers.agentId, actor.agentId)
        : eq(conversationMembers.userId, actor.userId ?? "__none__");

      const rows = await db
        .select({
          conv: conversations,
          lastReadSeq: conversationMembers.lastReadSeq,
          muted: conversationMembers.muted,
          pinned: conversationMembers.pinned,
        })
        .from(conversationMembers)
        .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
        .where(
          and(
            eq(conversationMembers.companyId, companyId),
            isNull(conversationMembers.leftAt),
            isNull(conversations.archivedAt),
            memberFilter,
          ),
        )
        .orderBy(desc(conversations.lastMessageAt));

      if (rows.length === 0) return [];

      const convIds = rows.map((r) => r.conv.id);
      const lastMessages = await db
        .select({ id: messages.id, conversationId: messages.conversationId, body: messages.body, kind: messages.kind, cardType: messages.cardType })
        .from(messages)
        .where(inArray(messages.id, rows.map((r) => r.conv.lastMessageId).filter((id): id is string => Boolean(id))));
      const previewByConv = new Map(lastMessages.map((m) => [m.conversationId, m]));

      // 「未读里有没有 @我」—— 决定红点是数字还是「@」。只看未读区间内的提及。
      const mentionRows = await db
        .select({ conversationId: messageMentions.conversationId, seq: messages.seq, mentionType: messageMentions.mentionType, userId: messageMentions.userId, agentId: messageMentions.agentId })
        .from(messageMentions)
        .innerJoin(messages, eq(messages.id, messageMentions.messageId))
        .where(and(eq(messageMentions.companyId, companyId), inArray(messageMentions.conversationId, convIds)));

      const membersByConv = new Map<string, ImMember[]>();
      for (const id of convIds) membersByConv.set(id, await listMembers(id));

      return rows.map((r) => {
        const lastReadSeq = Number(r.lastReadSeq);
        const lastSeq = Number(r.conv.lastSeq);
        const preview = r.conv.lastMessageId ? previewByConv.get(r.conv.id) : undefined;
        const mentioned = mentionRows.some(
          (m) =>
            m.conversationId === r.conv.id &&
            Number(m.seq) > lastReadSeq &&
            (m.mentionType === "all" ||
              (m.mentionType === "user" && actor.userId != null && m.userId === actor.userId) ||
              (m.mentionType === "agent" && actor.agentId != null && m.agentId === actor.agentId)),
        );
        return {
          id: r.conv.id,
          kind: r.conv.kind as ImConversation["kind"],
          title: r.conv.title ?? "未命名会话",
          avatarUrl: r.conv.avatarUrl,
          lastSeq,
          lastMessageAt: r.conv.lastMessageAt?.toISOString() ?? null,
          lastMessagePreview: preview
            ? preview.kind === "card"
              ? `[${preview.cardType}]`
              : plainPreview(preview.body)
            : null,
          unread: Math.max(0, lastSeq - lastReadSeq),
          mentioned,
          muted: r.muted,
          pinned: r.pinned,
          members: membersByConv.get(r.conv.id) ?? [],
        } satisfies ImConversation;
      });
    },

    /** 建会话:群聊(用户 + 一队 AI 员工)或私聊(用户 + 1 个 AI 员工)。 */
    async createConversation(
      companyId: string,
      actor: ImActor,
      input: { kind: "group" | "direct"; title?: string; agentIds?: string[]; userIds?: string[]; squadId?: string },
    ): Promise<ImConversation> {
      const agentIds = input.agentIds ?? [];
      if (input.kind === "direct" && agentIds.length !== 1) {
        throw badRequest("私聊必须且只能有 1 个 AI 员工");
      }
      const userIds = new Set([...(input.userIds ?? []), ...(actor.userId ? [actor.userId] : [])]);

      const conv = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(conversations)
          .values({
            companyId,
            kind: input.kind,
            title: input.title ?? (input.kind === "group" ? "我的 AI 团队" : "私聊"),
            squadId: input.squadId ?? null,
            createdByType: actor.agentId ? "agent" : "user",
            createdByUserId: actor.userId,
            createdByAgentId: actor.agentId,
          })
          .returning();
        if (!created) throw new Error("conversation insert returned no row");

        const memberRows = [
          ...[...userIds].map((userId) => ({
            companyId,
            conversationId: created.id,
            memberType: "user" as const,
            userId,
            role: userId === actor.userId ? ("owner" as const) : ("member" as const),
          })),
          ...agentIds.map((agentId) => ({
            companyId,
            conversationId: created.id,
            memberType: "agent" as const,
            agentId,
            role: "member" as const,
          })),
        ];
        if (memberRows.length > 0) await tx.insert(conversationMembers).values(memberRows);
        return created;
      });

      return {
        id: conv.id,
        kind: conv.kind as ImConversation["kind"],
        title: conv.title ?? "未命名会话",
        avatarUrl: conv.avatarUrl,
        lastSeq: 0,
        lastMessageAt: null,
        lastMessagePreview: null,
        unread: 0,
        mentioned: false,
        muted: false,
        pinned: false,
        members: await listMembers(conv.id),
      };
    },

    /**
     * 拉消息。两种游标,对应两种场景:
     *   - beforeSeq:上翻历史(打开会话首屏 = 不传 → 最近 N 条)
     *   - afterSeq :断线补齐(客户端把水位线 sinceSeq 发过来,拿回漏掉的)
     */
    async listMessages(
      conversationId: string,
      actor: ImActor,
      opts: { beforeSeq?: number; afterSeq?: number; limit?: number } = {},
    ): Promise<ImMessage[]> {
      await requireMembership(conversationId, actor);
      const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);

      const base = and(
        eq(messages.conversationId, conversationId),
        isNull(messages.deletedAt),
        opts.beforeSeq != null ? lt(messages.seq, opts.beforeSeq) : undefined,
        opts.afterSeq != null ? gt(messages.seq, opts.afterSeq) : undefined,
      );

      // 补齐(afterSeq)必须**正序**取:漏掉的最老那条最重要,倒序取会在
      // 断线很久时把最该补的那段截掉。首屏(默认/beforeSeq)则倒序取最近 N 条。
      const rows = await db
        .select({ msg: messages, agentName: agents.name })
        .from(messages)
        .leftJoin(agents, eq(agents.id, messages.senderAgentId))
        .where(base)
        .orderBy(opts.afterSeq != null ? asc(messages.seq) : desc(messages.seq))
        .limit(limit);

      const ordered = opts.afterSeq != null ? rows : [...rows].reverse();
      return ordered.map((r) => toImMessage(r.msg, r.agentName));
    },

    /**
     * 发消息。用户发、AI 员工发(桌面客户端代发)、系统发,都走这一条路径。
     * 返回 deduped=true 表示这条 clientNonce 之前已经落过库(断线重发)。
     */
    async sendMessage(
      conversationId: string,
      actor: ImActor,
      input: SendMessageInput,
    ): Promise<{ message: ImMessage; deduped: boolean }> {
      const { conv } = await requireMembership(conversationId, actor);

      const senderType = input.senderType ?? (actor.agentId ? "agent" : "user");
      let senderAgentId: string | null = null;
      let senderUserId: string | null = null;

      if (senderType === "agent") {
        // 桌面客户端本地跑完 agent loop,代这位 AI 员工回帖。它必须真的在群里 ——
        // 否则任何登录用户都能伪造任意 agent 发言。
        senderAgentId = input.senderAgentId ?? actor.agentId;
        if (!senderAgentId) throw badRequest("senderAgentId is required when senderType=agent");
        const [agentMember] = await db
          .select({ id: conversationMembers.id })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.agentId, senderAgentId),
              isNull(conversationMembers.leftAt),
            ),
          )
          .limit(1);
        if (!agentMember) throw forbidden("该 AI 员工不在这个会话里,不能代它发言");
      } else if (senderType === "user") {
        senderUserId = actor.userId;
        if (!senderUserId) throw badRequest("senderUserId is required when senderType=user");
      }

      const kind = input.kind ?? (input.cardType ? "card" : "text");
      if (kind === "card" && !input.cardType) throw badRequest("卡片消息必须带 cardType");
      if (kind === "text" && !input.body?.trim()) throw badRequest("消息正文不能为空");

      // 幂等前置检查:命中就直接返回,连事务都不用开(热路径:断线重连批量重发)
      if (input.clientNonce) {
        const existing = await findByNonce(conversationId, input.clientNonce);
        if (existing) return { message: existing, deduped: true };
      }

      let inserted: MessageRow;
      try {
        inserted = await db.transaction(async (tx) => {
          // seq 分配 + 消息插入在同一事务:并发发送被行锁排成队,seq 严格递增无空洞
          const [bumped] = await tx
            .update(conversations)
            .set({ lastSeq: sql`${conversations.lastSeq} + 1`, updatedAt: new Date() })
            .where(eq(conversations.id, conversationId))
            .returning({ lastSeq: conversations.lastSeq });
          if (!bumped) throw notFound("Conversation not found");
          const seq = Number(bumped.lastSeq);

          const [row] = await tx
            .insert(messages)
            .values({
              companyId: conv.companyId,
              conversationId,
              seq,
              senderType,
              senderUserId,
              senderAgentId,
              kind,
              body: input.body ?? null,
              cardType: input.cardType ?? null,
              cardPayload: input.cardPayload ?? null,
              issueId: input.issueId ?? null,
              documentId: input.documentId ?? null,
              approvalId: input.approvalId ?? null,
              replyToMessageId: input.replyToMessageId ?? null,
              clientNonce: input.clientNonce ?? null,
            })
            .returning();
          if (!row) throw new Error("message insert returned no row");

          await tx
            .update(conversations)
            .set({ lastMessageId: row.id, lastMessageAt: row.createdAt })
            .where(eq(conversations.id, conversationId));

          // @提及:和客户端同一个解析器。agent 被 @ → 标 pending,等桌面客户端来领。
          const mentions = parseMentions(row.body);
          if (mentions.length > 0) {
            await tx.insert(messageMentions).values(
              mentions.map((m) => ({
                companyId: conv.companyId,
                conversationId,
                messageId: row.id,
                mentionType: m.mentionType,
                userId: m.userId ?? null,
                agentId: m.agentId ?? null,
                squadId: m.squadId ?? null,
                // AI 员工自己发的消息里 @别人不触发唤醒 —— 否则两个 agent 互相 @
                // 就是一个无限循环,烧的是用户的算力点数。
                wakeupState: m.mentionType === "agent" && senderType === "user" ? "pending" : "none",
              })),
            );
          }

          // 发言者自己的已读游标跟着推进 —— 不然自己发的消息会给自己算未读
          await tx
            .update(conversationMembers)
            .set({ lastReadSeq: seq, lastReadAt: new Date() })
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                senderType === "agent" && senderAgentId
                  ? eq(conversationMembers.agentId, senderAgentId)
                  : eq(conversationMembers.userId, senderUserId ?? "__none__"),
              ),
            );

          return row;
        });
      } catch (err) {
        // 并发重发撞上唯一索引 (conversation_id, client_nonce) —— 这不是错误,
        // 正是幂等生效了。把先落库的那条捞出来返回。
        if (input.clientNonce && isUniqueViolation(err)) {
          const existing = await findByNonce(conversationId, input.clientNonce);
          if (existing) return { message: existing, deduped: true };
        }
        throw err;
      }

      const [senderAgent] = senderAgentId
        ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, senderAgentId)).limit(1)
        : [];
      const message = toImMessage(inserted, senderAgent?.name);

      imEventBus.publish(conversationId, { type: "message.created", conversationId, message });

      // @到的 AI 员工:推唤醒事件。**agent loop 不在这里跑** —— 桌面客户端收到
      // 这个事件后在本地跑,跑完把结果作为一条 agent 消息回传(见上面的 senderType=agent)。
      if (senderType === "user") {
        for (const m of message.mentions ?? []) {
          if (m.mentionType === "agent" && m.agentId) {
            imEventBus.publish(conversationId, {
              type: "agent.invoke",
              conversationId,
              agentId: m.agentId,
              messageId: message.id,
              prompt: message.body ?? "",
            });
          }
        }
      }

      return { message, deduped: false };
    },

    /** 已读游标前移。未读数 = lastSeq - lastReadSeq,所以这一下就把红点清了。 */
    async markRead(conversationId: string, actor: ImActor, lastReadSeq: number): Promise<{ lastReadSeq: number }> {
      const { member } = await requireMembership(conversationId, actor);
      // 只前移不后退:乱序到达的 read 请求不该把红点又变回来
      const next = Math.max(Number(member.lastReadSeq), lastReadSeq);
      await db
        .update(conversationMembers)
        .set({ lastReadSeq: next, lastReadAt: new Date() })
        .where(eq(conversationMembers.id, member.id));

      // 被 @ 的 agent 唤醒事件在用户读完后没意义了吗?——不,唤醒和已读无关,
      // 这里只发已读事件,给同一用户的其它端(手机/桌面)同步红点。
      imEventBus.publish(conversationId, { type: "conversation.read", conversationId, lastReadSeq: next });
      return { lastReadSeq: next };
    },

    /** 唤醒事件被客户端领走 → 标 triggered,避免重复烧算力。 */
    async claimMention(messageId: string, agentId: string): Promise<boolean> {
      const updated = await db
        .update(messageMentions)
        .set({ wakeupState: "triggered" })
        .where(
          and(
            eq(messageMentions.messageId, messageId),
            eq(messageMentions.agentId, agentId),
            eq(messageMentions.wakeupState, "pending"),
          ),
        )
        .returning({ id: messageMentions.id });
      return updated.length > 0;
    },
  };

  async function findByNonce(conversationId: string, clientNonce: string): Promise<ImMessage | null> {
    const [row] = await db
      .select({ msg: messages, agentName: agents.name })
      .from(messages)
      .leftJoin(agents, eq(agents.id, messages.senderAgentId))
      .where(and(eq(messages.conversationId, conversationId), eq(messages.clientNonce, clientNonce)))
      .limit(1);
    return row ? toImMessage(row.msg, row.agentName) : null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
