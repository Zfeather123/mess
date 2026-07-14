import { useEffect, useMemo, useState } from 'react';
import { formatMention, type ImConversation, type ImMember, type ImMessage } from '@xiaojing/protocol';
import type { XiaojingBridge } from '../platform/bridge.js';
import { createHttpImClient, type ImClient } from '../im/client.js';
import { useChat } from '../im/useChat.js';
import { ConversationList } from '../components/ConversationList.js';
import { MessageList } from '../components/MessageList.js';
import { Composer } from '../components/Composer.js';
import { TeamPanel, type TodayTask } from '../components/TeamPanel.js';

/**
 * 消息模块主界面 —— 整个产品的第一屏。
 *
 * 三栏:会话列表 / 群聊 / 今日任务+成员。手机上折成一栏,靠 data-pane 切换。
 *
 * 这个组件对「agent loop 在哪跑」一无所知 —— 它只跟两个接口说话:
 *   - ImClient      :消息的收发与持久化(永远是我们的服务器)
 *   - XiaojingBridge:让员工干活(桌面=本机 Agent SDK,浏览器=服务端)
 *
 * 所以桌面壳和浏览器跑的是**同一份 JSX**,没有 if (isElectron) 散落在业务代码里。
 * test/cross-platform.test.tsx 用两个桥跑同一组断言,把这条红线钉死。
 */
export function ChatView({
  bridge,
  client = createHttpImClient(),
  companyId = 'default',
  me = { userId: 'me' },
  tasks = [],
}: {
  bridge: XiaojingBridge;
  client?: ImClient;
  companyId?: string;
  me?: { userId: string };
  tasks?: TodayTask[];
}) {
  const [conversations, setConversations] = useState<ImConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [members, setMembers] = useState<ImMember[]>([]);
  const [draft, setDraft] = useState('');
  // 手机上一次只显示一栏,靠它切;桌面上三栏并排,这个值不起作用(见 styles.css)
  const [pane, setPane] = useState<'convs' | 'chat' | 'panel'>('chat');

  useEffect(() => {
    void client.listConversations(companyId).then((list) => {
      setConversations(list);
      setActiveId((current) => current ?? list[0]?.id ?? null);
    });
  }, [client, companyId]);

  useEffect(() => {
    if (!activeId) return;
    void client.listMembers(activeId).then(setMembers);
  }, [client, activeId]);

  const agents = useMemo(
    () => members.filter((m) => m.memberType === 'agent').map((m) => ({ id: m.id, name: m.name })),
    [members],
  );

  const active = conversations.find((c) => c.id === activeId) ?? null;

  return (
    <div className="app" data-testid="chat" data-platform={bridge.platform} data-pane={pane}>
      <header className="app__bar">
        <button
          type="button"
          className="app__nav"
          aria-label="会话列表"
          aria-expanded={pane === 'convs'}
          onClick={() => setPane(pane === 'convs' ? 'chat' : 'convs')}
        >
          会话
        </button>
        <h1 className="app__title">{active?.title ?? '小镜'}</h1>
        <button
          type="button"
          className="app__nav"
          aria-label="今日任务与团队状态"
          aria-expanded={pane === 'panel'}
          onClick={() => setPane(pane === 'panel' ? 'chat' : 'panel')}
        >
          任务
        </button>
      </header>

      <div className="app__body">
        <div className="app__col app__col--convs">
          <ConversationList
            conversations={conversations}
            activeId={activeId}
            onSelect={(id) => {
              setActiveId(id);
              setPane('chat');
              // 点进去红点立刻清,不等服务端往返(useChat 挂载时会把已读游标推上去)
              setConversations((prev) =>
                prev.map((c) => (c.id === id ? { ...c, unread: 0, mentioned: false } : c)),
              );
            }}
          />
        </div>

        {activeId ? (
          <ChatPane
            key={activeId}
            client={client}
            bridge={bridge}
            conversationId={activeId}
            me={me}
            members={members}
            agents={agents}
            tasks={tasks}
            draft={draft}
            setDraft={setDraft}
          />
        ) : (
          <div className="app__col app__col--chat">
            <p className="empty">还没有会话。去「招聘」招几位 AI 员工,他们会拉你进群。</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 单个会话的运行时。key={conversationId} 保证切会话时整个重挂 ——
 * 消息流、SSE 订阅、正在跑的 agent 全部干净重来,不会串台到上一个会话。
 */
function ChatPane({
  client,
  bridge,
  conversationId,
  me,
  members,
  agents,
  tasks,
  draft,
  setDraft,
}: {
  client: ImClient;
  bridge: XiaojingBridge;
  conversationId: string;
  me: { userId: string };
  members: ImMember[];
  agents: Array<{ id: string; name: string }>;
  tasks: TodayTask[];
  draft: string;
  setDraft: (next: string) => void;
}) {
  const { messages, drafts, connected, send, retry, loadOlder } = useChat({
    client,
    bridge,
    conversationId,
    me,
    agents,
  });

  /** 「继续调整」:把卡片上下文回填输入框并 @回作者 —— 用户不用重述「就刚才那条」。 */
  const onRefine = (message: ImMessage, hint: string) => {
    const author = members.find((m) => m.memberType === 'agent' && m.id === message.senderAgentId);
    const at = author ? `${formatMention('agent', author.id, author.name)} ` : '';
    setDraft(`${at}${hint}`);
  };

  return (
    <>
      <main className="app__col app__col--chat">
        {!connected ? (
          <p className="banner" role="status">
            正在连接…… 断线期间的消息不会丢,连上就补齐。
          </p>
        ) : null}

        <MessageList
          messages={messages}
          drafts={drafts}
          me={me}
          cardActions={{ onRefine }}
          onRetry={(id) => void retry(id)}
          onLoadOlder={() => void loadOlder()}
        />

        <Composer
          members={members}
          value={draft}
          onChange={setDraft}
          onSend={(body) => void send({ body })}
        />
      </main>

      <div className="app__col app__col--panel">
        <TeamPanel members={members} tasks={tasks} workingAgentIds={drafts.map((d) => d.agentId)} />
      </div>
    </>
  );
}
