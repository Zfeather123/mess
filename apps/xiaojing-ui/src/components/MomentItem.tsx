import { useState } from 'react';
import type { Moment, MomentCard, MomentComment } from '@xiaojing/protocol';
import { Avatar } from './Avatar.js';

/** 卡片类型 → 标签文案。新增卡片类型必须在这里登记,否则 tag 会是空的。 */
const CARD_LABEL: Record<MomentCard['type'], string> = {
  method_pack: '方法包',
  rule_set: '规则更新',
  trend: '趋势洞察',
  service: '服务名额',
};

function when(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/**
 * 朋友圈的一条动态。
 *
 * 点赞/收藏是**乐观更新**:AI 员工的动态流是拿来随手刷的,点一下要等一个往返才变色,
 * 手感就废了。失败时回滚并把错误抛给上层(而不是静默装作成功 —— 那会让用户以为收藏了)。
 */
export function MomentItem({
  moment,
  onToggleLike,
  onToggleFavorite,
  onLoadComments,
  onComment,
}: {
  moment: Moment;
  onToggleLike: (moment: Moment) => void;
  onToggleFavorite: (moment: Moment) => void;
  onLoadComments: (momentId: string) => Promise<MomentComment[]>;
  onComment: (momentId: string, body: string) => Promise<void>;
}) {
  const [comments, setComments] = useState<MomentComment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  const toggleComments = async () => {
    if (comments) {
      setComments(null);
      return;
    }
    setComments(await onLoadComments(moment.id));
  };

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onComment(moment.id, body);
      setDraft('');
      setComments(await onLoadComments(moment.id));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="moment" aria-label={`${moment.author.name} 的动态`}>
      <Avatar name={moment.author.name} kind={moment.author.type} size="lg" />

      <div className="moment__main">
        <header className="moment__head">
          <span className="moment__author">{moment.author.name}</span>
          {moment.author.role ? <span className="moment__role">{moment.author.role}</span> : null}
          <time className="moment__time" dateTime={moment.createdAt}>
            {when(moment.createdAt, now)}
          </time>
        </header>

        <p className="moment__body">{moment.content}</p>

        {moment.tags.length > 0 ? (
          <p className="moment__tags">
            {moment.tags.map((t) => (
              <span key={t} className="badge badge--muted">
                #{t}
              </span>
            ))}
          </p>
        ) : null}

        {moment.card ? <MomentCardView card={moment.card} /> : null}

        <footer className="moment__actions">
          <button
            type="button"
            className={`moment__act${moment.likedByMe ? ' is-on' : ''}`}
            aria-pressed={moment.likedByMe}
            aria-label={moment.likedByMe ? '取消点赞' : '点赞'}
            onClick={() => onToggleLike(moment)}
          >
            赞 {moment.likeCount > 0 ? moment.likeCount : ''}
          </button>
          <button
            type="button"
            className="moment__act"
            aria-expanded={comments !== null}
            aria-label="评论"
            onClick={() => void toggleComments()}
          >
            评论 {moment.commentCount > 0 ? moment.commentCount : ''}
          </button>
          <button
            type="button"
            className={`moment__act${moment.favoritedByMe ? ' is-on' : ''}`}
            aria-pressed={moment.favoritedByMe}
            aria-label={moment.favoritedByMe ? '取消收藏' : '收藏'}
            onClick={() => onToggleFavorite(moment)}
          >
            收藏
          </button>
        </footer>

        {comments !== null ? (
          <section className="moment__comments" aria-label="评论">
            {comments.length === 0 ? (
              <p className="empty">还没有评论。</p>
            ) : (
              <ul className="moment__comment-list">
                {comments.map((c) => (
                  <li key={c.id} className="moment__comment">
                    <b>{c.author.name}</b>
                    <span>{c.body}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="moment__comment-box">
              <input
                className="moment__comment-input"
                aria-label="写评论"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn--primary"
                disabled={!draft.trim() || busy}
                onClick={() => void submit()}
              >
                发送
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </article>
  );
}

function MomentCardView({ card }: { card: MomentCard }) {
  return (
    <div className={`card card--moment card--${card.type}`}>
      <div className="card__head">
        <span className={`card__tag card__tag--${card.type}`}>{CARD_LABEL[card.type]}</span>
        {card.version ? <span className="badge badge--muted">{card.version}</span> : null}
      </div>
      <h3 className="card__title">{card.title}</h3>
      {card.summary ? <p className="card__excerpt">{card.summary}</p> : null}
      {card.items && card.items.length > 0 ? (
        <ul className="card__list">
          {card.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {card.actionLabel ? (
        <div className="card__actions">
          <a className="btn btn--ghost" href={card.href ?? '#'}>
            {card.actionLabel}
          </a>
        </div>
      ) : null}
    </div>
  );
}
