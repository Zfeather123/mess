import { useState } from 'react';
import type { CardType, ImMessage } from '@xiaojing/protocol';

/**
 * 卡片消息 —— AI 员工的结构化产出:选题列表 / 文案初稿 / 档案补全 / 诊断报告 / 待审批。
 *
 * 卡片不是「好看的文本」,是**可操作的**:「复制」直接进剪贴板,「继续调整」把上下文
 * 塞回输入框并 @回那位员工。用户不需要重新描述一遍「就刚才那条」。
 *
 * 渲染只吃 cardPayload 的快照,不回查实体 —— 聊天记录是历史,不该因为选题后来被改了
 * 就回溯篡改当时的对话。要看最新的,点「打开」跳到实体去。
 */

export interface CardAction {
  /** 「继续调整」:把这条卡片的上下文回填到输入框,并 @回作者。 */
  onRefine: (message: ImMessage, hint: string) => void;
  /** 「打开」:跳到权威实体(issue / document / approval)。 */
  onOpen?: (message: ImMessage) => void;
}

const CARD_LABEL: Record<CardType, string> = {
  topic_list: '选题',
  draft: '文案初稿',
  profile_gap: '档案待补全',
  diagnosis: '账号诊断',
  approval: '待你确认',
};

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 复制到剪贴板。老浏览器 / 没有 clipboard 权限时静默降级,不弹错误吓用户。 */
async function copy(content: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(content);
    return true;
  } catch {
    return false;
  }
}

export function MessageCard({ message, actions }: { message: ImMessage; actions: CardAction }) {
  const [copied, setCopied] = useState(false);
  const payload = message.cardPayload ?? {};
  const cardType = (message.cardType ?? 'draft') as CardType;
  const title = text(payload.title, CARD_LABEL[cardType] ?? '卡片');

  const copyText = buildCopyText(cardType, payload);

  return (
    <article className="card" aria-label={`${CARD_LABEL[cardType]}卡片:${title}`}>
      <header className="card__head">
        <span className={`card__tag card__tag--${cardType}`}>{CARD_LABEL[cardType]}</span>
        <h3 className="card__title">{title}</h3>
      </header>

      <div className="card__body">{renderBody(cardType, payload)}</div>

      <footer className="card__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            void copy(copyText).then((ok) => {
              setCopied(ok);
              if (ok) window.setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => actions.onRefine(message, `就上面这条「${title}」,`)}
        >
          继续调整
        </button>
        {(message.issueId || message.documentId || message.approvalId) && actions.onOpen ? (
          <button type="button" className="btn btn--ghost" onClick={() => actions.onOpen?.(message)}>
            打开
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function renderBody(cardType: CardType, payload: Record<string, unknown>) {
  switch (cardType) {
    case 'topic_list':
      return (
        <ol className="card__list">
          {asArray(payload.topics).map((topic, i) => (
            <li key={i} className="card__list-item">
              <span className="card__item-title">{text(topic.title)}</span>
              {topic.hook ? <span className="card__item-sub">钩子:{text(topic.hook)}</span> : null}
            </li>
          ))}
        </ol>
      );

    case 'draft':
      return (
        <>
          <p className="card__excerpt">{text(payload.body)}</p>
          {payload.wordCount ? <p className="card__meta">约 {String(payload.wordCount)} 字</p> : null}
        </>
      );

    case 'profile_gap':
      return (
        <ul className="card__list">
          {asArray(payload.gaps).map((gap, i) => (
            <li key={i} className="card__list-item">
              <span className="card__item-title">{text(gap.field)}</span>
              <span className="card__item-sub">{text(gap.why)}</span>
            </li>
          ))}
        </ul>
      );

    case 'diagnosis':
      return (
        <>
          <dl className="card__stats">
            {asArray(payload.metrics).map((metric, i) => (
              <div key={i} className="card__stat">
                <dt>{text(metric.label)}</dt>
                <dd>
                  {text(metric.value)}
                  {metric.delta ? (
                    <span className={`card__delta ${text(metric.delta).startsWith('-') ? 'is-down' : 'is-up'}`}>
                      {text(metric.delta)}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          {payload.summary ? <p className="card__excerpt">{text(payload.summary)}</p> : null}
        </>
      );

    case 'approval':
      return <p className="card__excerpt">{text(payload.summary, '有一项需要你确认。')}</p>;

    default:
      return null;
  }
}

/** 「复制」拿到的应该是能直接用的东西 —— 文案就是文案本身,选题就是可粘的清单。 */
function buildCopyText(cardType: CardType, payload: Record<string, unknown>): string {
  if (cardType === 'draft') return text(payload.body);
  if (cardType === 'topic_list') {
    return asArray(payload.topics)
      .map((topic, i) => `${i + 1}. ${text(topic.title)}${topic.hook ? ` —— ${text(topic.hook)}` : ''}`)
      .join('\n');
  }
  if (cardType === 'diagnosis') {
    const metrics = asArray(payload.metrics)
      .map((metric) => `${text(metric.label)}:${text(metric.value)}${text(metric.delta)}`)
      .join('\n');
    return [text(payload.title), metrics, text(payload.summary)].filter(Boolean).join('\n');
  }
  return [text(payload.title), text(payload.summary)].filter(Boolean).join('\n');
}
