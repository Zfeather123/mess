import { vi } from 'vitest';
import type { ImConversation, ImEvent, ImMember, ImMessage, SendMessageInput } from '@xiaojing/protocol';
import type { ImClient } from '../src/im/client.js';
import type { AgentEvent, XiaojingBridge } from '../src/platform/bridge.js';

export const CONV = 'conv-1';
export const WRITER = 'agent-writer';
export const DOCTOR = 'agent-doctor';

export const MEMBERS: ImMember[] = [
  { memberType: 'user', id: 'me', name: '我', presence: 'online' },
  { memberType: 'agent', id: WRITER, name: '文案编导', presence: 'online' },
  { memberType: 'agent', id: DOCTOR, name: '账号诊断师', presence: 'online' },
];

export function conversation(over: Partial<ImConversation> = {}): ImConversation {
  return {
    id: CONV,
    kind: 'group',
    title: '我的 AI 团队',
    lastSeq: 0,
    unread: 0,
    mentioned: false,
    muted: false,
    pinned: false,
    members: MEMBERS,
    ...over,
  };
}

export function message(seq: number, over: Partial<ImMessage> = {}): ImMessage {
  return {
    id: `m-${seq}`,
    conversationId: CONV,
    seq,
    senderType: 'agent',
    senderAgentId: WRITER,
    senderName: '文案编导',
    kind: 'text',
    body: `第 ${seq} 条`,
    createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    ...over,
  };
}

/**
 * 假的 ImClient —— 让 UI 用例不需要起服务器。
 *
 * 它同时是「服务端行为」的可执行规格:seq 单调递增、clientNonce 幂等、
 * push() 模拟 SSE 推送。UI 里任何依赖这些性质的逻辑,在这里就能被证伪。
 */
export function fakeClient(opts: { history?: ImMessage[]; conversations?: ImConversation[] } = {}) {
  const history = [...(opts.history ?? [])];
  let seq = history.reduce((max, m) => Math.max(max, m.seq), 0);
  const listeners = new Set<(e: ImEvent) => void>();
  const subscribedSince: number[] = [];
  const sent: SendMessageInput[] = [];
  let failNextSend = false;

  /** 消息落库。同一条(同 id)只落一次 —— 服务端的唯一索引就是这个语义。 */
  function land(m: ImMessage) {
    if (!history.some((existing) => existing.id === m.id)) history.push(m);
    seq = Math.max(seq, m.seq);
  }

  const client: ImClient = {
    listConversations: vi.fn(async () => opts.conversations ?? [conversation()]),
    listMembers: vi.fn(async () => MEMBERS),
    listMessages: vi.fn(async (_id, o = {}) => {
      let rows = [...history].sort((a, b) => a.seq - b.seq);
      if (o.afterSeq != null) rows = rows.filter((m) => m.seq > o.afterSeq!);
      if (o.beforeSeq != null) rows = rows.filter((m) => m.seq < o.beforeSeq!);
      // 和服务端一致:补齐(afterSeq)从**最老**的那条开始截,首屏/上翻取最近 N 条。
      // 截错方向的话「补洞」会把最该补的那段丢掉 —— 这正是服务端 asc/desc 分叉的原因。
      return o.afterSeq != null ? rows.slice(0, o.limit ?? 50) : rows.slice(-(o.limit ?? 50));
    }),
    sendMessage: vi.fn(async (_id, input: SendMessageInput) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error('network down');
      }
      sent.push(input);
      const existing = input.clientNonce
        ? history.find((m) => m.clientNonce === input.clientNonce)
        : undefined;
      if (existing) return existing; // 幂等:和服务端一样,重发不产生第二条
      seq += 1;
      const saved: ImMessage = {
        id: `s-${seq}`,
        conversationId: CONV,
        seq,
        senderType: input.senderType ?? 'user',
        senderUserId: input.senderType === 'agent' ? null : 'me',
        senderAgentId: input.senderAgentId ?? null,
        senderName: input.senderAgentId
          ? (MEMBERS.find((m) => m.id === input.senderAgentId)?.name ?? null)
          : null,
        kind: input.kind ?? (input.cardType ? 'card' : 'text'),
        body: input.body ?? null,
        cardType: input.cardType ?? null,
        cardPayload: input.cardPayload ?? null,
        clientNonce: input.clientNonce ?? null,
        createdAt: new Date().toISOString(),
      };
      history.push(saved);
      return saved;
    }),
    markRead: vi.fn(async () => {}),
    subscribe: vi.fn((_id, sinceSeq, onEvent) => {
      subscribedSince.push(sinceSeq);
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    }),
  };

  return {
    client,
    sent,
    subscribedSince,
    /** 模拟服务端推一条消息过来(SSE)。重复推同一条 = 重连重放,服务端不会因此多存一条。 */
    push(message: ImMessage) {
      land(message);
      for (const cb of listeners) cb({ type: 'message.created', conversationId: CONV, message });
    },
    /** 模拟「断线期间产生的消息」—— 只落在服务端,不推给客户端。 */
    landSilently: land,
    ping() {
      for (const cb of listeners) cb({ type: 'ping', ts: 1 });
    },
    breakNextSend() {
      failNextSend = true;
    },
  };
}

/** 桌面桥的测试替身:形状必须和 preload 里 contextBridge 暴露的一致。 */
export function fakeBridge(platform: 'desktop' | 'web' = 'desktop') {
  const listeners = new Set<(e: AgentEvent) => void>();
  const bridge: XiaojingBridge & { emit: (e: AgentEvent) => void } = {
    platform,
    runAgent: vi.fn(async (req) => ({ runId: req.runId })),
    cancelAgent: vi.fn(async () => true),
    onAgentEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (e) => listeners.forEach((cb) => cb(e)),
  };
  return bridge;
}
