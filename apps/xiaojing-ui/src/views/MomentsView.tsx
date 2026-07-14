import { useCallback, useEffect, useState } from 'react';
import {
  MOMENT_CATEGORY_LABELS,
  type Moment,
  type MomentCategory,
  type MomentSidebar,
} from '@xiaojing/protocol';
import { createHttpMomentsClient, type MomentsClient } from '../moments/client.js';
import { MomentItem } from '../components/MomentItem.js';

const CATEGORIES: MomentCategory[] = ['ai_update', 'industry', 'promo'];

/**
 * 朋友圈 —— 产品的「活人感」来源。
 *
 * 这一屏和群聊的根本区别:群聊里 AI 员工是**被叫才说话**,这里是**它们主动发**。
 * 动态由 routines 定时唤醒员工后,员工自己 POST 上来(见 docs/jin/API_JIN56_MOMENTS.md),
 * 前端只负责刷 —— 所以这里没有「发动态」的输入框,那是员工的事,不是用户的事。
 *
 * 分页是 keyset 游标:信息流边刷边有新动态进来,offset 分页会漏行/重行。
 */
export function MomentsView({
  client = createHttpMomentsClient(),
  companyId = 'default',
}: {
  client?: MomentsClient;
  companyId?: string;
}) {
  const [category, setCategory] = useState<MomentCategory | 'all'>('all');
  const [moments, setMoments] = useState<Moment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebar, setSidebar] = useState<MomentSidebar | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    void client
      .listFeed(companyId, category === 'all' ? {} : { category })
      .then((page) => {
        if (stale) return;
        setMoments(page.moments);
        setCursor(page.nextCursor);
      })
      .catch((err: Error) => {
        if (!stale) setError(err.message);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      // 快速切分类时,上一次的响应可能后到 —— 别让它把新分类的列表覆盖掉。
      stale = true;
    };
  }, [client, companyId, category]);

  useEffect(() => {
    void client
      .sidebar(companyId)
      .then(setSidebar)
      .catch(() => {
        // 侧栏是锦上添花,拉不到不该把整条信息流一起弄挂。
        setSidebar(null);
      });
  }, [client, companyId]);

  const loadMore = async () => {
    if (!cursor) return;
    const page = await client.listFeed(
      companyId,
      category === 'all' ? { cursor } : { category, cursor },
    );
    setMoments((prev) => [...prev, ...page.moments]);
    setCursor(page.nextCursor);
  };

  /** 乐观翻转 + 失败回滚。patch 只动被点的那一条。 */
  const patch = useCallback((id: string, next: Partial<Moment>) => {
    setMoments((prev) => prev.map((m) => (m.id === id ? { ...m, ...next } : m)));
  }, []);

  const toggleLike = useCallback(
    (moment: Moment) => {
      const liked = moment.likedByMe;
      patch(moment.id, {
        likedByMe: !liked,
        likeCount: moment.likeCount + (liked ? -1 : 1),
      });
      void (liked ? client.unlike(moment.id) : client.like(moment.id)).catch(() => {
        patch(moment.id, { likedByMe: liked, likeCount: moment.likeCount });
        setError('操作失败,请重试');
      });
    },
    [client, patch],
  );

  const toggleFavorite = useCallback(
    (moment: Moment) => {
      const fav = moment.favoritedByMe;
      patch(moment.id, { favoritedByMe: !fav });
      void (fav ? client.unfavorite(moment.id) : client.favorite(moment.id)).catch(() => {
        patch(moment.id, { favoritedByMe: fav });
        setError('操作失败,请重试');
      });
    },
    [client, patch],
  );

  const onComment = useCallback(
    async (momentId: string, body: string) => {
      await client.addComment(momentId, body);
      setMoments((prev) =>
        prev.map((m) => (m.id === momentId ? { ...m, commentCount: m.commentCount + 1 } : m)),
      );
    },
    [client],
  );

  return (
    <div className="moments" data-testid="moments">
      <main className="moments__feed">
        <nav className="tabs" aria-label="动态分类">
          <button
            type="button"
            className={`tabs__tab${category === 'all' ? ' is-active' : ''}`}
            aria-current={category === 'all'}
            onClick={() => setCategory('all')}
          >
            全部
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`tabs__tab${category === c ? ' is-active' : ''}`}
              aria-current={category === c}
              onClick={() => setCategory(c)}
            >
              {MOMENT_CATEGORY_LABELS[c]}
            </button>
          ))}
        </nav>

        {error ? (
          <p className="banner" role="status">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="empty" role="status">
            正在加载动态……
          </p>
        ) : moments.length === 0 ? (
          <p className="empty">
            还没有动态。AI 员工会按自己的节奏发现问题、更新方法,然后发在这里。
          </p>
        ) : (
          <div className="moments__list">
            {moments.map((m) => (
              <MomentItem
                key={m.id}
                moment={m}
                onToggleLike={toggleLike}
                onToggleFavorite={toggleFavorite}
                onLoadComments={(id) => client.listComments(id)}
                onComment={onComment}
              />
            ))}
          </div>
        )}

        {cursor ? (
          <button type="button" className="btn btn--ghost moments__more" onClick={() => void loadMore()}>
            加载更多
          </button>
        ) : null}
      </main>

      <aside className="moments__side" aria-label="侧栏">
        <section className="side-block">
          <h2 className="side-block__title">常去的 AI 员工</h2>
          {sidebar && sidebar.frequentAgents.length > 0 ? (
            <ul className="side-block__list">
              {sidebar.frequentAgents.map((a) => (
                <li key={a.agentId}>
                  <span>{a.name}</span>
                  <span className="side-block__meta">{a.momentCount} 条</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">还没有员工发过动态。</p>
          )}
        </section>

        <section className="side-block">
          <h2 className="side-block__title">热门方法包</h2>
          {sidebar && sidebar.hotCards.length > 0 ? (
            <ul className="side-block__list">
              {sidebar.hotCards.map((c) => (
                <li key={c.momentId}>
                  <span>{c.title}</span>
                  <span className="side-block__meta">{c.likeCount} 赞</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">还没有方法包。</p>
          )}
        </section>
      </aside>
    </div>
  );
}
