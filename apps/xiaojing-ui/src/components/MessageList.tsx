import { useEffect, useRef } from 'react';
import { PENDING_SEQ, segmentBody, type ImMessage } from '@xiaojing/protocol';
import { MessageCard, type CardAction } from './MessageCard.js';
import { Avatar } from './Avatar.js';
import type { LiveDraft } from '../im/useChat.js';

/** 正文里的 @提及高亮。格式解析来自 @xiaojing/protocol —— 和服务端同一个函数。 */
function Body({ body }: { body: string }) {
  return (
    <>
      {segmentBody(body).map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <b key={i} className="mention">
            @{seg.mention.label}
          </b>
        ),
      )}
    </>
  );
}

function time(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MessageList({
  messages,
  drafts,
  me,
  cardActions,
  onRetry,
  onLoadOlder,
}: {
  messages: ImMessage[];
  drafts: LiveDraft[];
  me: { userId: string };
  cardActions: CardAction;
  onRetry: (localId: string) => void;
  onLoadOlder: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  // 新消息进来就贴底。用户正在往上翻历史时不该被拽回来 —— 所以只在贴近底部时才滚。
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, drafts.length]);

  return (
    <div className="thread" data-testid="thread">
      {messages.length > 0 && messages[0]!.seq > 1 ? (
        <button type="button" className="thread__more" onClick={onLoadOlder}>
          查看更早的消息
        </button>
      ) : null}

      {/* aria-live=polite:AI 员工主动汇报时,屏幕阅读器会念出来,但不会打断用户当前操作 */}
      <ol className="thread__list" aria-live="polite" aria-relevant="additions">
        {messages.map((m) => {
          const mine = m.senderType === 'user' && m.senderUserId === me.userId;
          const name = m.senderType === 'user' ? (mine ? '我' : (m.senderUserId ?? '成员')) : (m.senderName ?? 'AI 员工');

          if (m.senderType === 'system') {
            return (
              <li key={m.id} className="msg msg--system" data-from="system">
                {m.body}
              </li>
            );
          }

          return (
            <li
              key={m.id}
              className={`msg ${mine ? 'msg--mine' : ''} ${m.pending ? 'is-pending' : ''} ${m.failed ? 'is-failed' : ''}`}
              data-from={m.senderType}
              data-seq={m.seq === PENDING_SEQ ? undefined : m.seq}
            >
              <Avatar name={name} kind={m.senderType} />
              <div className="msg__col">
                <span className="msg__meta">
                  <span className="msg__name">{name}</span>
                  {m.seq !== PENDING_SEQ ? <time dateTime={m.createdAt}>{time(m.createdAt)}</time> : null}
                </span>

                {m.kind === 'card' ? (
                  <MessageCard message={m} actions={cardActions} />
                ) : (
                  <p className="msg__bubble">
                    <Body body={m.body ?? ''} />
                  </p>
                )}

                {m.failed ? (
                  <button type="button" className="msg__retry" onClick={() => onRetry(m.id)}>
                    发送失败,重发
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}

        {/* 正在跑的 agent:先长出「正在输入」气泡,跑完才落库成正式消息 */}
        {drafts.map((d) => (
          <li key={d.runId} className="msg msg--draft" data-from="agent" data-draft={d.agentId}>
            <Avatar name={d.agentName} kind="agent" />
            <div className="msg__col">
              <span className="msg__meta">
                <span className="msg__name">{d.agentName}</span>
                <span className="msg__typing">正在思考…</span>
              </span>
              <p className="msg__bubble">
                {d.tool ? <span className="msg__tool">正在调用工具:{d.tool}</span> : null}
                {d.text}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div ref={endRef} />
    </div>
  );
}
