import type { ImMember } from '@xiaojing/protocol';

/** 今日任务 —— JIN-54 会接 issue 系统;这里先定好形状,数据由上层灌进来。 */
export interface TodayTask {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  /** 谁在做(AI 员工名)。 */
  owner?: string;
}

const STATUS_LABEL: Record<TodayTask['status'], string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
};

const PRESENCE_LABEL: Record<NonNullable<ImMember['presence']>, string> = {
  online: '在线',
  working: '干活中',
  offline: '离线',
};

/**
 * 右侧面板:今日任务进度 + 团队成员在线状态。
 *
 * 这块在移动端会被折叠进抽屉(见 styles.css 的媒体查询)—— 手机上聊天窗口宽度是
 * 稀缺资源,不能被侧栏吃掉。
 */
export function TeamPanel({
  members,
  tasks,
  workingAgentIds,
}: {
  members: ImMember[];
  tasks: TodayTask[];
  /** 正在跑 agent loop 的员工 —— 他们的状态实时显示为「干活中」。 */
  workingAgentIds: string[];
}) {
  const done = tasks.filter((t) => t.status === 'done').length;
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;

  return (
    <aside className="panel" aria-label="今日任务与团队状态">
      <section className="panel__section">
        <h2 className="panel__title">今日任务</h2>
        <div
          className="progress"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`今日任务完成度 ${pct}%`}
        >
          <span className="progress__fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="panel__meta">
          {done}/{tasks.length} 已完成
        </p>

        <ul className="tasks">
          {tasks.map((t) => (
            <li key={t.id} className={`task task--${t.status}`}>
              <span className="task__title">{t.title}</span>
              <span className="task__meta">
                {t.owner ? <span className="task__owner">{t.owner}</span> : null}
                <span className="task__status">{STATUS_LABEL[t.status]}</span>
              </span>
            </li>
          ))}
          {tasks.length === 0 ? <li className="panel__empty">今天还没派活</li> : null}
        </ul>
      </section>

      <section className="panel__section">
        <h2 className="panel__title">团队成员</h2>
        <ul className="team">
          {members.map((m) => {
            const presence = workingAgentIds.includes(m.id) ? 'working' : (m.presence ?? 'offline');
            return (
              <li key={`${m.memberType}-${m.id}`} className="team__row">
                <span className={`dot dot--${presence}`} aria-hidden="true" />
                <span className="team__name">{m.name}</span>
                <span className="team__role">
                  {m.memberType === 'agent' ? PRESENCE_LABEL[presence] : '协作者'}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
