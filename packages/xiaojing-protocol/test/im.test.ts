import { describe, expect, it } from 'vitest';
import {
  formatMention,
  MessageStore,
  mentionsMe,
  parseMentions,
  PENDING_SEQ,
  plainPreview,
  segmentBody,
  type ImMessage,
} from '../src/im.js';

const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';

function msg(seq: number, over: Partial<ImMessage> = {}): ImMessage {
  return {
    id: over.id ?? `m${seq}`,
    conversationId: 'c1',
    seq,
    senderType: 'agent',
    senderAgentId: AGENT_A,
    kind: 'text',
    body: `第 ${seq} 条`,
    createdAt: new Date(1_700_000_000_000 + Math.min(seq, 10_000) * 1000).toISOString(),
    ...over,
  };
}

describe('@提及解析 —— 客户端和服务端共用同一份格式', () => {
  it('解析出 agent / user / squad / all 四类', () => {
    const body = `${formatMention('agent', AGENT_A, '文案编导')} 帮我写个脚本,抄送 ${formatMention('user', 'u_1', '老张')}`;
    const mentions = parseMentions(body);
    expect(mentions.map((m) => m.mentionType)).toEqual(['agent', 'user']);
    expect(mentions[0]?.agentId).toBe(AGENT_A);
    expect(mentions[0]?.label).toBe('文案编导');
    expect(mentions[1]?.userId).toBe('u_1');
  });

  it('@所有人 没有 id,但仍然是合法提及', () => {
    expect(parseMentions(formatMention('all', '', '所有人'))[0]?.mentionType).toBe('all');
  });

  it('缺 id 的坏标记直接丢掉 —— 宁可不高亮,不可错路由', () => {
    expect(parseMentions('@[文案编导](agent:)')).toEqual([]);
  });

  it('正文切片:纯文本和提及交替,顺序不变', () => {
    const body = `请 ${formatMention('agent', AGENT_A, '选题策划师')} 出 5 个选题`;
    const segs = segmentBody(body);
    expect(segs.map((s) => s.type)).toEqual(['text', 'mention', 'text']);
    expect(segs[2]).toEqual({ type: 'text', text: ' 出 5 个选题' });
  });

  it('会话列表预览把标记压成人类可读的 @名字', () => {
    expect(plainPreview(`${formatMention('agent', AGENT_A, '合规审稿员')} 看下这条`)).toBe('@合规审稿员 看下这条');
  });

  it('mentionsMe:@我 / @所有人 命中,@别人 不命中', () => {
    const me = { userId: 'u_1', agentId: null };
    expect(mentionsMe({ body: formatMention('user', 'u_1', '老张'), mentions: undefined }, me)).toBe(true);
    expect(mentionsMe({ body: formatMention('all', '', '所有人'), mentions: undefined }, me)).toBe(true);
    expect(mentionsMe({ body: formatMention('user', 'u_2', '小李'), mentions: undefined }, me)).toBe(false);
    // AI 员工视角:@到它自己才算
    expect(mentionsMe({ body: formatMention('agent', AGENT_B, '档案管家'), mentions: undefined }, { agentId: AGENT_B })).toBe(true);
  });
});

describe('MessageStore —— 不丢消息、不乱序、不重复', () => {
  it('乱序到达的推送会被扣住,等洞补上再一起落位', () => {
    const store = new MessageStore();
    store.reset([msg(1)]);

    // seq 3 先到(seq 2 还在路上)—— 不能让它先上屏
    const r1 = store.ingest(msg(3));
    expect(store.messages.map((m) => m.seq)).toEqual([1]);
    expect(r1.gap).toEqual({ fromSeq: 1, toSeq: 2 });

    // seq 2 到了 —— 2 和 3 一起落位,顺序正确
    const r2 = store.ingest(msg(2));
    expect(store.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(r2.gap).toBeNull();
    expect(store.sinceSeq).toBe(3);
  });

  it('断线重连:sinceSeq 是水位线,HTTP 补齐后接上直播', () => {
    const store = new MessageStore();
    store.reset([msg(1), msg(2)]);
    expect(store.sinceSeq).toBe(2); // 重连时带给服务端的游标

    // 断线期间产生了 3/4/5;重连后先收到直播的 6 → 识别出洞
    const live = store.ingest(msg(6));
    expect(live.gap).toEqual({ fromSeq: 2, toSeq: 5 });

    // 拿 gap 去 HTTP 拉回 3/4/5 → 全部落位,一条不丢
    const filled = store.ingestMany([msg(3), msg(4), msg(5)]);
    expect(filled.gap).toBeNull();
    expect(store.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('同一条消息走两条路回来(HTTP 响应 + SSE 推送)只留一条', () => {
    const store = new MessageStore();
    store.reset([msg(1)]);
    store.ingest(msg(2, { id: 'server-2' }));
    store.ingest(msg(2, { id: 'server-2' }));
    expect(store.messages.filter((m) => m.seq === 2)).toHaveLength(1);
  });

  it('乐观发送:本地气泡被服务端的权威版本按 clientNonce 替换,不冒双份', () => {
    const store = new MessageStore();
    store.reset([msg(1)]);
    store.addPending({
      ...msg(PENDING_SEQ, { id: 'local-1', senderType: 'user', senderAgentId: null, senderUserId: 'u_1' }),
      clientNonce: 'n-1',
      pending: true,
    });
    expect(store.messages).toHaveLength(2);
    expect(store.messages[1]?.pending).toBe(true);

    store.ingest(msg(2, { id: 'server-1', senderType: 'user', senderAgentId: null, senderUserId: 'u_1', clientNonce: 'n-1' }));

    expect(store.messages).toHaveLength(2);
    expect(store.messages[1]?.id).toBe('server-1');
    expect(store.messages[1]?.pending).toBeUndefined();
  });

  it('上翻分页拉到的历史不影响补洞水位线', () => {
    const store = new MessageStore();
    store.reset([msg(10), msg(11)]);
    store.prepend([msg(8), msg(9)]);
    expect(store.messages.map((m) => m.seq)).toEqual([8, 9, 10, 11]);
    expect(store.sinceSeq).toBe(11);
  });

  it('发送失败的消息被标记出来,UI 才有得重发', () => {
    const store = new MessageStore();
    store.addPending({ ...msg(PENDING_SEQ, { id: 'local-1' }), clientNonce: 'n-9', pending: true });
    store.markFailed('local-1');
    expect(store.messages[0]?.failed).toBe(true);
  });
});
