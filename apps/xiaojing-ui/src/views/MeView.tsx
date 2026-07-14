import { useEffect, useState } from 'react';
import {
  POINTS_PER_YUAN,
  RECHARGE_PRESETS,
  pointsToYuan,
  type CoachBinding,
  type ComputeBalance,
  type ComputeTransaction,
  type NotificationPrefs,
  type WeeklyOverview,
} from '@xiaojing/protocol';
import { createHttpMeClient, type MeClient } from '../me/client.js';
import { Avatar } from '../components/Avatar.js';

const REASON_LABEL: Record<ComputeTransaction['reason'], string> = {
  recharge: '充值',
  consume: '消耗',
  refund: '退还',
  adjust: '调整',
  gift: '赠送',
  freeze: '冻结',
  unfreeze: '解冻',
};

function yuan(points: number): string {
  return `¥${pointsToYuan(points).toFixed(2)}`;
}

/**
 * 「我的」—— 算力钱包 / 绑定操盘手 / 通知设置 / 本周概览 / 数据导出。
 *
 * 算力这块必须同时露出**余额 / 冻结中 / 可用**三个数。只给一个「余额」的话,用户会看到
 * 「余额没变但不够用了」(正在跑的 agent 把额度冻结着)—— 那是最招投诉的一种数字。
 */
export function MeView({
  client = createHttpMeClient(),
  companyId = 'default',
  me = { userId: 'me' },
  onOpenConversation,
}: {
  client?: MeClient;
  companyId?: string;
  me?: { userId: string };
  /** 点「私聊操盘手」后跳回消息模块。 */
  onOpenConversation?: (conversationId: string) => void;
}) {
  const [balance, setBalance] = useState<ComputeBalance | null>(null);
  const [txs, setTxs] = useState<ComputeTransaction[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [binding, setBinding] = useState<CoachBinding | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [overview, setOverview] = useState<WeeklyOverview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void client.balance(companyId).then(setBalance).catch(() => setBalance(null));
    void client
      .usage(companyId)
      .then((page) => {
        setTxs(page.transactions);
        setCursor(page.nextCursor);
      })
      .catch(() => setTxs([]));
    void client.coach(companyId).then(setBinding).catch(() => setBinding(null));
    void client.notifications(companyId).then(setPrefs).catch(() => setPrefs(null));
    void client.overview(companyId).then(setOverview).catch(() => setOverview(null));
  }, [client, companyId]);

  const loadMoreUsage = async () => {
    if (!cursor) return;
    const page = await client.usage(companyId, { cursor });
    setTxs((prev) => [...prev, ...page.transactions]);
    setCursor(page.nextCursor);
  };

  const recharge = async (points: number) => {
    // MVP 只有 manual(线下打款 + 管理员人工确认)是真能到账的路径。
    // 微信/支付宝没接 provider —— 见下面被禁用的两个按钮。
    const order = await client.recharge(companyId, { points, channel: 'manual' });
    setNotice(
      `已创建充值单 ${yuan(order.points)}(${order.points} 点),状态:待确认。线下打款后由管理员确认到账。`,
    );
  };

  const toggle = async (key: keyof NotificationPrefs) => {
    if (!prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next); // 乐观:开关必须立刻跟手
    try {
      setPrefs(await client.updateNotifications(companyId, { [key]: next[key] }));
    } catch {
      setPrefs(prefs);
      setNotice('设置没保存上,请重试');
    }
  };

  const dm = async () => {
    const { conversationId } = await client.openCoachDm(companyId);
    onOpenConversation?.(conversationId);
  };

  const low = balance !== null && balance.availablePoints <= balance.lowBalanceThreshold;

  return (
    <div className="me" data-testid="me">
      <div className="me__col">
        {/* ---- 算力余额 ---- */}
        <section className="panel" aria-label="算力余额">
          <h2 className="panel__title">算力余额</h2>

          {balance === null ? (
            <p className="empty" role="status">
              正在加载算力……
            </p>
          ) : (
            <>
              {low ? (
                <p className="banner banner--warn" role="status">
                  可用算力不足({balance.availablePoints} 点),AI 员工可能随时停工。
                </p>
              ) : null}

              <div className="wallet">
                <div className="wallet__main">
                  <span className="wallet__points">{balance.availablePoints}</span>
                  <span className="wallet__unit">点可用 · 约 {yuan(balance.availablePoints)}</span>
                </div>
                <dl className="wallet__grid" role="group" aria-label="算力明细">
                  <div>
                    <dt>账面余额</dt>
                    <dd>{`${balance.balancePoints} 点`}</dd>
                  </div>
                  <div>
                    {/* 冻结 = 正在跑的员工占着的额度。不露出来,用户会以为钱凭空少了。 */}
                    <dt>冻结中</dt>
                    <dd>{`${balance.frozenPoints} 点`}</dd>
                  </div>
                  <div>
                    <dt>本月已用</dt>
                    {/* 一个文本节点,不是拼出来的两截 —— 屏幕阅读器会把碎片读成两句话。 */}
                    <dd>
                      {balance.monthlyQuotaPoints !== null
                        ? `${balance.monthlyUsedPoints} / ${balance.monthlyQuotaPoints} 点`
                        : `${balance.monthlyUsedPoints} 点(不限额)`}
                    </dd>
                  </div>
                </dl>

                {balance.monthlyQuotaPoints !== null ? (
                  <div
                    className="progress"
                    role="progressbar"
                    aria-label="本月额度使用"
                    aria-valuemin={0}
                    aria-valuemax={balance.monthlyQuotaPoints}
                    aria-valuenow={balance.monthlyUsedPoints}
                  >
                    <span
                      className="progress__fill"
                      style={{
                        width: `${Math.min(
                          100,
                          (balance.monthlyUsedPoints / Math.max(1, balance.monthlyQuotaPoints)) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                ) : null}
              </div>

              <h3 className="panel__sub">充值</h3>
              <p className="panel__hint">1 元 = {POINTS_PER_YUAN} 点 · 1M token ≈ 5 元</p>
              <div className="recharge">
                {RECHARGE_PRESETS.map((p) => (
                  <button
                    key={p.points}
                    type="button"
                    className="btn recharge__preset"
                    onClick={() => void recharge(p.points)}
                  >
                    {p.label}
                    <span className="recharge__points">{p.points} 点</span>
                  </button>
                ))}
              </div>
              {/*
                微信/支付宝还没接收银台(没有 provider、没有回调、没有对账)。
                在 UI 上摆一个能点的按钮 = 骗用户点了以为在付钱。宁可明写「暂未开放」。
              */}
              <p className="panel__hint">
                当前仅支持<b>线下打款</b>(创建充值单后由管理员确认到账)。
                <button type="button" className="btn btn--ghost" disabled title="暂未开放">
                  微信支付(暂未开放)
                </button>
                <button type="button" className="btn btn--ghost" disabled title="暂未开放">
                  支付宝(暂未开放)
                </button>
              </p>

              {notice ? (
                <p className="banner" role="status">
                  {notice}
                </p>
              ) : null}
            </>
          )}
        </section>

        {/* ---- 用量明细 ---- */}
        <section className="panel" aria-label="用量明细">
          <h2 className="panel__title">用量明细</h2>
          {txs.length === 0 ? (
            <p className="empty">还没有算力流水。</p>
          ) : (
            <ul className="ledger">
              {txs.map((t) => (
                <li key={t.id} className="ledger__row">
                  <span className="ledger__what">
                    <b>{t.agentName ?? REASON_LABEL[t.reason]}</b>
                    {t.issueTitle ? <span className="ledger__task">{t.issueTitle}</span> : null}
                    {t.memo ? <span className="ledger__memo">{t.memo}</span> : null}
                  </span>
                  <span
                    className={`ledger__points ledger__points--${t.direction}`}
                    aria-label={`${t.direction === 'credit' ? '增加' : '消耗'} ${t.points} 点`}
                  >
                    {t.direction === 'credit' ? '+' : '−'}
                    {t.points}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {cursor ? (
            <button type="button" className="btn btn--ghost" onClick={() => void loadMoreUsage()}>
              加载更多
            </button>
          ) : null}
        </section>
      </div>

      <div className="me__col">
        {/* ---- 绑定操盘手 ---- */}
        <section className="panel" aria-label="绑定操盘手">
          <h2 className="panel__title">我的操盘手</h2>
          {binding?.coach ? (
            <div className="coach">
              <Avatar name={binding.coach.name} kind="user" size="lg" />
              <div className="coach__main">
                <span className="coach__name">{binding.coach.name}</span>
                {binding.coach.title ? (
                  <span className="coach__title">{binding.coach.title}</span>
                ) : null}
                {binding.coach.bio ? <p className="coach__bio">{binding.coach.bio}</p> : null}
              </div>
              <div className="coach__actions">
                <button type="button" className="btn btn--primary" onClick={() => void dm()}>
                  私聊
                </button>
              </div>
            </div>
          ) : (
            <p className="empty">
              还没有绑定操盘手。操盘手是真人 —— 他给你配 AI 员工,也做真人点评。
            </p>
          )}
        </section>

        {/* ---- 本周使用概览 ---- */}
        <section className="panel" aria-label="本周使用概览">
          <h2 className="panel__title">本周使用概览</h2>
          {overview === null ? (
            <p className="empty">暂无数据。</p>
          ) : (
            <>
              <dl className="stats">
                <div>
                  <dt>完成任务</dt>
                  <dd>{overview.tasksCompleted}</dd>
                </div>
                <div>
                  <dt>生成文案</dt>
                  <dd>{overview.draftsProduced}</dd>
                </div>
                <div>
                  <dt>消耗算力</dt>
                  <dd>{overview.pointsUsed} 点</dd>
                </div>
              </dl>
              <h3 className="panel__sub">员工工作小结</h3>
              {overview.perAgent.length === 0 ? (
                <p className="empty">这周还没有员工干活。</p>
              ) : (
                <ul className="side-block__list">
                  {overview.perAgent.map((a) => (
                    <li key={a.agentId}>
                      <span>{a.agentName}</span>
                      <span className="side-block__meta">
                        {a.tasks} 个任务 · {a.points} 点
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        {/* ---- 通知设置 ---- */}
        <section className="panel" aria-label="通知设置">
          <h2 className="panel__title">通知设置</h2>
          {prefs === null ? (
            <p className="empty">暂无数据。</p>
          ) : (
            <ul className="switches">
              <Switch label="今日任务提醒" on={prefs.dailyTasks} onToggle={() => void toggle('dailyTasks')} />
              <Switch
                label="员工工作小结"
                on={prefs.agentSummary}
                onToggle={() => void toggle('agentSummary')}
              />
              <Switch
                label="合规风险提醒"
                on={prefs.complianceRisk}
                onToggle={() => void toggle('complianceRisk')}
              />
            </ul>
          )}
        </section>

        {/* ---- 数据导出 ---- */}
        <section className="panel" aria-label="数据导出">
          <h2 className="panel__title">账号设置</h2>
          <p className="panel__hint">当前登录:{me.userId}</p>
          <a className="btn btn--ghost" href={client.exportUrl(companyId)} download>
            导出我的数据(JSON)
          </a>
        </section>
      </div>
    </div>
  );
}

function Switch({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <li className="switches__row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`switch${on ? ' is-on' : ''}`}
        onClick={onToggle}
      >
        <span className="switch__knob" />
      </button>
    </li>
  );
}
