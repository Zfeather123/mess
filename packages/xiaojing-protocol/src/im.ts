/**
 * IM 协议层 —— 群聊 / 私聊的**共享真相**。
 *
 * 这里的东西同时被三处引用:
 *   - 服务端(server/src/services/im.ts):落库、分配 seq、解析 @提及
 *   - Web UI(apps/xiaojing-ui):渲染、乐观发送、断线补齐
 *   - 桌面客户端(apps/desktop):本地 agent 跑完后把结果作为消息回传
 *
 * 放在这里而不是各写一份,是因为「同一个概念两份真相」已经在后端踩过坑:
 * @提及的文本格式如果客户端和服务端各解析各的,迟早会出现「UI 上高亮了但
 * agent 没被唤醒」这种最难查的 bug。格式只有一份定义,就在下面。
 *
 * 数据结构直接对应 0148 迁移的表(conversations / messages / message_mentions),
 * 不另造一套。
 */

// ---------------------------------------------------------------------------
// 实体
// ---------------------------------------------------------------------------

export type ConversationKind = 'group' | 'direct';
export type MessageKind = 'text' | 'card' | 'image' | 'file' | 'system';
export type SenderType = 'user' | 'agent' | 'system';
export type MentionType = 'user' | 'agent' | 'squad' | 'all';

/** 卡片类型 —— 结构化消息的载荷判别式。新增卡片必须同时在这里和 UI 的渲染表里登记。 */
export type CardType =
  | 'topic_list' // 选题列表
  | 'draft' // 文案初稿
  | 'profile_gap' // 档案补全提示
  | 'diagnosis' // 诊断报告
  | 'approval'; // 待确认审批

export interface ImMember {
  memberType: 'user' | 'agent';
  /** user 时是 userId(裸 text),agent 时是 agentId(uuid)。 */
  id: string;
  name: string;
  avatarUrl?: string | null;
  role?: string;
  /** AI 员工的在线/工作状态 —— 右侧面板用。 */
  presence?: 'online' | 'working' | 'offline';
}

export interface ImConversation {
  id: string;
  kind: ConversationKind;
  title: string;
  avatarUrl?: string | null;
  lastSeq: number;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  /** 未读数 = lastSeq - lastReadSeq,由服务端 O(1) 算出,不扫 messages。 */
  unread: number;
  /** 未读里是否有 @我 —— 决定红点是数字还是「@」。 */
  mentioned: boolean;
  muted: boolean;
  pinned: boolean;
  members: ImMember[];
}

export interface ImMention {
  mentionType: MentionType;
  userId?: string | null;
  agentId?: string | null;
  squadId?: string | null;
}

export interface ImMessage {
  id: string;
  conversationId: string;
  /** 会话内全序。**排序、分页、补洞都只认它**,不认 createdAt(同毫秒并发会乱序)。 */
  seq: number;
  senderType: SenderType;
  senderUserId?: string | null;
  senderAgentId?: string | null;
  senderName?: string | null;
  kind: MessageKind;
  body: string | null;
  cardType?: CardType | null;
  cardPayload?: Record<string, unknown> | null;
  issueId?: string | null;
  documentId?: string | null;
  approvalId?: string | null;
  replyToMessageId?: string | null;
  mentions?: ImMention[];
  clientNonce?: string | null;
  createdAt: string;
  /** 仅存在于本地:乐观发送中的消息,seq 还没拿到。 */
  pending?: boolean;
  /** 仅存在于本地:发送失败,UI 显示重发按钮。 */
  failed?: boolean;
}

export interface SendMessageInput {
  body?: string;
  kind?: MessageKind;
  cardType?: CardType;
  cardPayload?: Record<string, unknown>;
  replyToMessageId?: string;
  issueId?: string;
  documentId?: string;
  approvalId?: string;
  /** 幂等键。断线重发同一条不会变成两条(DB 上有 (conversation_id, client_nonce) 唯一索引)。 */
  clientNonce?: string;
  /** 代表某个 AI 员工发言(桌面客户端本地跑完 agent 后回传结果时用)。 */
  senderType?: SenderType;
  senderAgentId?: string;
}

/** 会话实时通道推给客户端的事件。 */
export type ImEvent =
  | { type: 'message.created'; conversationId: string; message: ImMessage }
  | { type: 'conversation.read'; conversationId: string; lastReadSeq: number }
  | {
      /** @了某个 AI 员工 → 该员工需要被唤醒执行(桌面端本地跑 agent loop)。 */
      type: 'agent.invoke';
      conversationId: string;
      agentId: string;
      messageId: string;
      prompt: string;
    }
  | { type: 'ping'; ts: number };

// ---------------------------------------------------------------------------
// @提及:唯一的格式定义
// ---------------------------------------------------------------------------

/**
 * 提及在消息正文里的存储格式:`@[显示名](agent:<uuid>)`。
 *
 * 为什么不是裸 `@文案编导`:显示名会改,重名也存在。把 id 编进正文,
 * 路由就永远打得中,哪怕这位 AI 员工三个月后改了名。
 *
 * 支持的 kind:agent / user / squad / all(`@[所有人](all:)`)。
 */
const MENTION_RE = /@\[([^\]]{1,64})\]\((agent|user|squad|all):([^)]{0,64})\)/g;

export interface ParsedMention extends ImMention {
  /** 显示名,渲染高亮用。 */
  label: string;
  /** 在正文中的起止,渲染分片用。 */
  start: number;
  end: number;
}

/** 从正文里解析出所有 @提及。服务端用它写 message_mentions,UI 用它做高亮。 */
export function parseMentions(body: string | null | undefined): ParsedMention[] {
  if (!body) return [];
  const out: ParsedMention[] = [];
  // 每次调用重置 lastIndex —— 全局正则是有状态的,复用会漏匹配
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body)) !== null) {
    const [raw, label = '', kind = '', id = ''] = m;
    const mention: ParsedMention = {
      mentionType: kind as MentionType,
      label,
      start: m.index,
      end: m.index + raw.length,
      userId: kind === 'user' ? id : null,
      agentId: kind === 'agent' ? id : null,
      squadId: kind === 'squad' ? id : null,
    };
    // all 类型没有 id;其余三种缺 id 就是坏标记,丢掉(宁可不高亮,不可错路由)
    if (kind !== 'all' && !id) continue;
    out.push(mention);
  }
  return out;
}

/** 把消息正文切成「纯文本 / 提及」的片段,给 UI 直接 map 成 <span>。 */
export function segmentBody(
  body: string,
): Array<{ type: 'text'; text: string } | { type: 'mention'; mention: ParsedMention }> {
  const mentions = parseMentions(body);
  if (mentions.length === 0) return [{ type: 'text', text: body }];
  const segs: Array<{ type: 'text'; text: string } | { type: 'mention'; mention: ParsedMention }> = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.start > cursor) segs.push({ type: 'text', text: body.slice(cursor, mention.start) });
    segs.push({ type: 'mention', mention });
    cursor = mention.end;
  }
  if (cursor < body.length) segs.push({ type: 'text', text: body.slice(cursor) });
  return segs;
}

/** 组装一个提及标记 —— UI 的 @选择器插入正文时用,保证格式和解析器同源。 */
export function formatMention(kind: MentionType, id: string, label: string): string {
  return `@[${label}](${kind}:${kind === 'all' ? '' : id})`;
}

/** 去掉提及标记,留下人类可读文本 —— 会话列表的「最后一条消息」预览用。 */
export function plainPreview(body: string | null | undefined): string {
  if (!body) return '';
  return body.replace(MENTION_RE, (_raw, label: string) => `@${label}`);
}

/** 这条消息是否 @到了我(或 @所有人)。驱动会话列表的红点。 */
export function mentionsMe(
  message: Pick<ImMessage, 'mentions' | 'body'>,
  me: { userId?: string | null; agentId?: string | null },
): boolean {
  const mentions = message.mentions ?? parseMentions(message.body);
  return mentions.some((m) => {
    if (m.mentionType === 'all') return true;
    if (m.mentionType === 'user' && me.userId && m.userId === me.userId) return true;
    if (m.mentionType === 'agent' && me.agentId && m.agentId === me.agentId) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// 消息流:排序 / 去重 / 补洞
// ---------------------------------------------------------------------------

export interface IngestResult {
  /** 收到的消息里有洞:seq 在 (contiguousSeq, gapUntil) 之间的还没拿到,要去补。 */
  gap: { fromSeq: number; toSeq: number } | null;
}

/**
 * 客户端消息流。**「实时推送不丢消息、断线能重连补齐」这条验收就靠它。**
 *
 * 核心不变量:messages 按 seq 严格升序、无重复。
 *
 * 三个真实场景:
 *   1. 断线期间漏了 seq 8..12 → 重连后 EventSource 带 sinceSeq=7 重放,补齐。
 *   2. 推送乱序到达(seq 10 先于 9)→ 10 进 pending,等 9 到了再一起落位。
 *   3. 推送先于 HTTP 响应到达(自己发的消息)→ 用 clientNonce 认出是同一条,
 *      替换掉本地那条 pending 的乐观消息,而不是冒出两条一模一样的。
 *
 * 有洞且洞迟迟补不上时,由调用方拿 gap 去 HTTP 拉 —— store 只负责识别洞,
 * 不负责发请求(纯逻辑,好测)。
 */
export class MessageStore {
  private readonly byId = new Map<string, ImMessage>();
  private readonly byNonce = new Map<string, string>();
  /** seq > contiguousSeq 但前面还有洞的消息,等洞补上再落位。 */
  private readonly pending = new Map<number, ImMessage>();
  private list: ImMessage[] = [];
  /** 已经连续拿到的最大 seq。重连时把它作为 sinceSeq 发给服务端。 */
  private contiguous = 0;

  /** 已连续收到的最大 seq —— 重连补齐的水位线。 */
  get sinceSeq(): number {
    return this.contiguous;
  }

  /** 按 seq 升序的消息(含乐观发送中的,排在最后)。 */
  get messages(): ImMessage[] {
    return this.list;
  }

  /**
   * 首屏加载:服务端按 seq 倒序给的最近 N 条(本身连续)。
   *
   * 水位线直接抬到最大 seq —— 首屏之前的更早消息不是「洞」,那是历史,
   * 靠上翻分页拉,不该触发补洞。
   */
  reset(messages: ImMessage[]): void {
    this.byId.clear();
    this.byNonce.clear();
    this.pending.clear();
    this.list = [];
    this.contiguous = 0;
    const sorted = [...messages].sort((a, b) => a.seq - b.seq);
    for (const m of sorted) {
      // 去重:首屏和补齐的结果可能有重叠(客户端拉取时又推来一条),重了不能画两遍
      if (this.byId.has(m.id)) continue;
      this.byId.set(m.id, m);
      if (m.clientNonce) this.byNonce.set(m.clientNonce, m.id);
      this.list.push(m);
    }
    const last = sorted[sorted.length - 1];
    this.contiguous = last ? last.seq : 0;
  }

  /** 上翻分页:把更早的消息插到头部(不影响水位线)。 */
  prepend(older: ImMessage[]): void {
    for (const m of older) {
      if (this.byId.has(m.id)) continue;
      this.byId.set(m.id, m);
      this.list.push(m);
    }
    this.sort();
  }

  /** 乐观发送:本地先上屏,seq 用 Number.MAX_SAFE_INTEGER 占位排到最后。 */
  addPending(message: ImMessage): void {
    this.byId.set(message.id, message);
    if (message.clientNonce) this.byNonce.set(message.clientNonce, message.id);
    this.list.push(message);
    this.sort();
  }

  markFailed(localId: string): void {
    const existing = this.byId.get(localId);
    if (existing) existing.failed = true;
  }

  /**
   * 收到一条服务端消息(SSE 推送、或 HTTP 发送的响应、或补洞拉回来的)。
   * 返回是否出现了洞 —— 有洞就该去 HTTP 补。
   */
  ingest(message: ImMessage): IngestResult {
    this.place(message);
    this.drainPending();
    const nextPendingSeq = this.smallestPending();
    if (nextPendingSeq !== null && nextPendingSeq > this.contiguous + 1) {
      return { gap: { fromSeq: this.contiguous, toSeq: nextPendingSeq - 1 } };
    }
    return { gap: null };
  }

  ingestMany(messages: ImMessage[]): IngestResult {
    let gap: IngestResult['gap'] = null;
    for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
      gap = this.ingest(m).gap;
    }
    return { gap };
  }

  private place(message: ImMessage): void {
    // 幂等:同一条消息可能既走 HTTP 响应又走 SSE 推送回来
    const existingById = this.byId.get(message.id);
    if (existingById) {
      Object.assign(existingById, message, { pending: false, failed: false });
      this.sort();
      this.advance(message.seq);
      return;
    }
    // 自己发的:用 nonce 把本地那条 pending 换成服务端的权威版本
    const localId = message.clientNonce ? this.byNonce.get(message.clientNonce) : undefined;
    if (localId) {
      const local = this.byId.get(localId);
      if (local) {
        this.byId.delete(localId);
        this.list = this.list.filter((m) => m.id !== localId);
      }
    }
    this.byId.set(message.id, message);
    if (message.clientNonce) this.byNonce.set(message.clientNonce, message.id);

    if (message.seq <= this.contiguous + 1) {
      this.list.push(message);
      this.advance(message.seq);
      this.sort();
    } else {
      // 前面还有洞 —— 先扣住,别让它先上屏造成顺序错乱
      this.pending.set(message.seq, message);
    }
  }

  private advance(seq: number): void {
    if (seq > this.contiguous) this.contiguous = seq;
  }

  /** 洞补上后,把扣住的消息依次落位。 */
  private drainPending(): void {
    let moved = false;
    for (;;) {
      const next = this.pending.get(this.contiguous + 1);
      if (!next) break;
      this.pending.delete(next.seq);
      this.list.push(next);
      this.advance(next.seq);
      moved = true;
    }
    if (moved) this.sort();
  }

  private smallestPending(): number | null {
    let min: number | null = null;
    for (const seq of this.pending.keys()) {
      if (min === null || seq < min) min = seq;
    }
    return min;
  }

  private sort(): void {
    this.list.sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt));
  }
}

/** 乐观消息占位 seq —— 排在所有已确认消息之后。 */
export const PENDING_SEQ = Number.MAX_SAFE_INTEGER;
