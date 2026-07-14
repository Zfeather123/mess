import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageStore,
  PENDING_SEQ,
  parseMentions,
  type ImEvent,
  type ImMessage,
  type SendMessageInput,
} from '@xiaojing/protocol';
import type { ImClient } from './client.js';
import type { AgentEvent, XiaojingBridge } from '../platform/bridge.js';

/** 某个 AI 员工正在本地/服务端跑,还没落库的流式输出 —— 就是那个「正在输入…」气泡。 */
export interface LiveDraft {
  runId: string;
  agentId: string;
  agentName: string;
  text: string;
  tool: string | null;
}

export interface ChatState {
  messages: ImMessage[];
  drafts: LiveDraft[];
  /** 连接状态 —— 顶部那条「网络不稳,正在重连」提示。 */
  connected: boolean;
  send: (input: SendMessageInput & { mentionedAgents?: Array<{ id: string; name: string }> }) => Promise<void>;
  retry: (localId: string) => Promise<void>;
  loadOlder: () => Promise<void>;
}

let nonceCounter = 0;
function newNonce(): string {
  nonceCounter += 1;
  return `c-${Date.now().toString(36)}-${nonceCounter}`;
}

/**
 * 群聊/私聊的全部运行时逻辑。组件只管画,状态全在这。
 *
 * 「实时推送不丢消息、断线能重连补齐」在这里闭环:
 *   SSE 推来的消息 → store.ingest() → 发现 seq 有洞 → HTTP 按 afterSeq 补 → 洞填上。
 * store 只识别洞(纯逻辑,在 @xiaojing/protocol 里单测),这里负责去补。
 */
export function useChat(opts: {
  client: ImClient;
  bridge: XiaojingBridge;
  conversationId: string;
  me: { userId: string };
  agents: Array<{ id: string; name: string; staticPrompt?: string[] }>;
}): ChatState {
  const { client, bridge, conversationId, me, agents } = opts;
  const store = useMemo(() => new MessageStore(), [conversationId]);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);
  const [drafts, setDrafts] = useState<LiveDraft[]>([]);
  const [connected, setConnected] = useState(false);
  /** runId → 这一轮是替哪位员工跑的。done 事件里只有 runId,得靠它找回员工。 */
  const runs = useRef(new Map<string, { agentId: string; agentName: string }>());

  const fillGap = useCallback(
    async (gap: { fromSeq: number; toSeq: number }) => {
      const missed = await client.listMessages(conversationId, {
        afterSeq: gap.fromSeq,
        limit: gap.toSeq - gap.fromSeq,
      });
      store.ingestMany(missed);
      rerender();
    },
    [client, conversationId, store, rerender],
  );

  // 首屏 + 实时订阅
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const history = await client.listMessages(conversationId, { limit: 50 });
      if (cancelled) return;
      store.reset(history);
      rerender();
      if (history.length > 0) {
        void client.markRead(conversationId, store.sinceSeq).catch(() => {});
      }

      unsubscribe = client.subscribe(conversationId, store.sinceSeq, (event: ImEvent) => {
        if (event.type === 'message.created') {
          const { gap } = store.ingest(event.message);
          rerender();
          void client.markRead(conversationId, store.sinceSeq).catch(() => {});
          // 有洞就去补 —— 断线期间漏的、乱序到的,都在这一条路径上收敛
          if (gap) void fillGap(gap);
        } else if (event.type === 'ping') {
          setConnected(true);
        }
      });
      setConnected(true);
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      setConnected(false);
    };
  }, [client, conversationId, store, rerender, fillGap]);

  /**
   * 让被 @ 的 AI 员工干活。
   *
   * **agent loop 跑在哪由 bridge 决定,不由这里决定** —— 桌面上是用户本机
   * (内嵌 Agent SDK),浏览器里是服务端。这个组件对此一无所知,这正是重点:
   * 同一份 UI 代码,两个执行位置。
   */
  const runAgent = useCallback(
    async (agent: { id: string; name: string; staticPrompt?: string[] }, prompt: string) => {
      const runId = `run-${newNonce()}`;
      runs.current.set(runId, { agentId: agent.id, agentName: agent.name });
      setDrafts((prev) => [...prev, { runId, agentId: agent.id, agentName: agent.name, text: '', tool: null }]);
      await bridge.runAgent({
        runId,
        agent: { id: agent.id, name: agent.name, staticPrompt: agent.staticPrompt ?? [] },
        prompt,
      });
    },
    [bridge],
  );

  // agent 的流式输出:先在「正在输入」气泡里长出来,跑完了才落库成一条正式消息
  useEffect(() => {
    return bridge.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'text') {
        // 工具状态行不清掉 —— 「读了图 → 正在写」这个过程本身就是用户想看到的进度,
        // 一有文字就把工具行抹掉,反而像什么都没发生过。
        setDrafts((prev) => prev.map((d) => (d.runId === e.runId ? { ...d, text: d.text + e.text } : d)));
      } else if (e.type === 'tool_call') {
        setDrafts((prev) => prev.map((d) => (d.runId === e.runId ? { ...d, tool: e.tool } : d)));
      } else if (e.type === 'done' || e.type === 'error') {
        const run = runs.current.get(e.runId);
        setDrafts((prev) => {
          const draft = prev.find((d) => d.runId === e.runId);
          const body = e.type === 'error' ? `出错了:${e.message}` : (draft?.text ?? '');
          if (run && body.trim()) {
            // 落库:这条消息从此属于这位 AI 员工,其他成员(和其他端)都会收到
            void client
              .sendMessage(conversationId, {
                body,
                senderType: 'agent',
                senderAgentId: run.agentId,
                clientNonce: e.runId, // 同一轮 run 重发不会变两条
              })
              .then((message) => {
                store.ingest(message);
                rerender();
              })
              .catch(() => {});
          }
          runs.current.delete(e.runId);
          return prev.filter((d) => d.runId !== e.runId);
        });
      }
    });
  }, [bridge, client, conversationId, store, rerender]);

  const send = useCallback<ChatState['send']>(
    async (input) => {
      const clientNonce = input.clientNonce ?? newNonce();
      const localId = `local-${clientNonce}`;

      // 乐观上屏:先画出来,再等服务端确认。服务端回来的那条按 nonce 顶替它,不会冒双份。
      store.addPending({
        id: localId,
        conversationId,
        seq: PENDING_SEQ,
        senderType: 'user',
        senderUserId: me.userId,
        kind: input.kind ?? (input.cardType ? 'card' : 'text'),
        body: input.body ?? null,
        cardType: input.cardType ?? null,
        cardPayload: input.cardPayload ?? null,
        clientNonce,
        createdAt: new Date().toISOString(),
        pending: true,
      });
      rerender();

      try {
        const saved = await client.sendMessage(conversationId, { ...input, clientNonce });
        store.ingest(saved);
        rerender();

        // @到的员工开始干活。找不到的 agentId 直接跳过 —— 可能是刚被移出群的员工
        const mentioned = parseMentions(input.body).filter((m) => m.mentionType === 'agent');
        for (const mention of mentioned) {
          const agent = agents.find((a) => a.id === mention.agentId);
          if (agent) void runAgent(agent, input.body ?? '');
        }
      } catch {
        store.markFailed(localId);
        rerender();
      }
    },
    [client, conversationId, me.userId, store, rerender, agents, runAgent],
  );

  const retry = useCallback(
    async (localId: string) => {
      const failed = store.messages.find((m) => m.id === localId);
      if (!failed) return;
      await send({ body: failed.body ?? undefined, clientNonce: failed.clientNonce ?? undefined });
    },
    [store, send],
  );

  const loadOlder = useCallback(async () => {
    const oldest = store.messages.find((m) => m.seq !== PENDING_SEQ);
    if (!oldest || oldest.seq <= 1) return;
    const older = await client.listMessages(conversationId, { beforeSeq: oldest.seq, limit: 50 });
    store.prepend(older);
    rerender();
  }, [client, conversationId, store, rerender]);

  return { messages: store.messages, drafts, connected, send, retry, loadOlder };
}
