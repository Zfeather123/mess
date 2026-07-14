import type { ImConversation } from '@xiaojing/protocol';

/**
 * 会话列表 —— 微信式:未读红点、@我 高亮、置顶、免打扰。
 *
 * 未读数是服务端算好的(lastSeq - lastReadSeq),客户端不自己数 ——
 * 自己数就意味着「必须把所有消息都拉下来才知道有几条没读」,那在群多了以后就废了。
 */
export function ConversationList({
  conversations,
  activeId,
  onSelect,
}: {
  conversations: ImConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const sorted = [...conversations].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '');
  });

  return (
    <nav className="convs" aria-label="会话列表">
      <ul className="convs__list">
        {sorted.map((c) => {
          const agentCount = c.members.filter((m) => m.memberType === 'agent').length;
          return (
            <li key={c.id}>
              <button
                type="button"
                className={`conv ${c.id === activeId ? 'is-active' : ''}`}
                aria-current={c.id === activeId ? 'true' : undefined}
                onClick={() => onSelect(c.id)}
              >
                <span className="conv__avatar" aria-hidden="true">
                  {c.title.slice(0, 1)}
                </span>
                <span className="conv__col">
                  <span className="conv__row">
                    <span className="conv__title">{c.title}</span>
                    {c.unread > 0 ? (
                      <span
                        className={`badge ${c.mentioned ? 'badge--at' : ''} ${c.muted ? 'badge--muted' : ''}`}
                        // 红点必须能被读出来 —— 否则屏幕阅读器用户永远不知道有新消息
                        aria-label={c.mentioned ? `有人 @ 了你,${c.unread} 条未读` : `${c.unread} 条未读`}
                      >
                        {c.mentioned ? '@' : c.unread > 99 ? '99+' : c.unread}
                      </span>
                    ) : null}
                  </span>
                  <span className="conv__preview">
                    {c.lastMessagePreview ?? (agentCount > 0 ? `${agentCount} 位 AI 员工待命中` : '还没有消息')}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
