import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatMention, type ImMember } from '@xiaojing/protocol';

/**
 * 输入区 —— @提及选择器 + `/` 快捷指令。
 *
 * @ 插入的是 `@[显示名](agent:<uuid>)`(formatMention 出品),不是裸文本。
 * 用户看到的是「@文案编导」,存进去的是带 id 的标记 —— 员工改名了也照样路由得到。
 *
 * 键盘要能单独走完全程(不碰鼠标):@ 开菜单 → ↑↓ 选 → Enter 确认 → Enter 发送。
 * Esc 关菜单。这不是「无障碍加分项」,这是重度用户的主路径。
 */

export interface SlashCommand {
  name: string;
  hint: string;
  /** 这条指令该派给哪位员工(按名字匹配群里的 AI 员工)。 */
  agentName: string;
  template: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/选题', hint: '让选题策划师出一批选题', agentName: '选题策划师', template: '结合我最近的数据,出 5 个选题,标注钩子。' },
  { name: '/写文案', hint: '让文案编导写口播稿', agentName: '文案编导', template: '把这个选题写成 60 秒口播稿,开头 3 秒要有钩子。' },
  { name: '/诊断', hint: '让账号诊断师看数据', agentName: '账号诊断师', template: '诊断一下我最近 7 天的数据,重点看完播和涨粉。' },
  { name: '/补档案', hint: '让档案管家补全账号档案', agentName: '档案管家', template: '看看我的账号档案还缺什么,列出来。' },
  { name: '/审稿', hint: '让合规审稿员过一遍合规', agentName: '合规审稿员', template: '审一下上面这条文案的合规风险。' },
];

type Menu =
  | { kind: 'none' }
  | { kind: 'mention'; query: string; at: number; index: number }
  | { kind: 'slash'; query: string; index: number };

export function Composer({
  members,
  value,
  onChange,
  onSend,
  disabled,
}: {
  members: ImMember[];
  value: string;
  onChange: (next: string) => void;
  onSend: (body: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<Menu>({ kind: 'none' });

  const mentionables = useMemo(
    () => [
      ...members.filter((m) => m.memberType === 'agent'),
      ...members.filter((m) => m.memberType === 'user'),
    ],
    [members],
  );

  const mentionHits = useMemo(() => {
    if (menu.kind !== 'mention') return [];
    const q = menu.query.toLowerCase();
    return mentionables.filter((m) => !q || m.name.toLowerCase().includes(q)).slice(0, 6);
  }, [menu, mentionables]);

  const slashHits = useMemo(() => {
    if (menu.kind !== 'slash') return [];
    return SLASH_COMMANDS.filter((c) => c.name.includes(menu.query)).slice(0, 6);
  }, [menu]);

  function handleChange(next: string) {
    onChange(next);
    const caret = inputRef.current?.selectionStart ?? next.length;
    const before = next.slice(0, caret);

    // `/` 只在开头才是指令 —— 否则「他说 3/5 的人」会莫名其妙弹菜单
    if (/^\/[^\s]*$/.test(before)) {
      setMenu({ kind: 'slash', query: before, index: 0 });
      return;
    }
    // @ 后面还没打空格,就还在挑人
    const at = before.lastIndexOf('@');
    if (at >= 0 && !/\s/.test(before.slice(at + 1))) {
      setMenu({ kind: 'mention', query: before.slice(at + 1), at, index: 0 });
      return;
    }
    setMenu({ kind: 'none' });
  }

  function pickMention(member: ImMember) {
    if (menu.kind !== 'mention') return;
    const kind = member.memberType === 'agent' ? 'agent' : 'user';
    const next = `${value.slice(0, menu.at)}${formatMention(kind, member.id, member.name)} ${value.slice(
      (inputRef.current?.selectionStart ?? value.length),
    )}`;
    onChange(next);
    setMenu({ kind: 'none' });
    inputRef.current?.focus();
  }

  function pickSlash(command: SlashCommand) {
    // 指令自动 @上对应的员工 —— 用户不用记谁负责什么
    const agent = members.find((m) => m.memberType === 'agent' && m.name === command.agentName);
    const prefix = agent ? `${formatMention('agent', agent.id, agent.name)} ` : '';
    onChange(`${prefix}${command.template}`);
    setMenu({ kind: 'none' });
    inputRef.current?.focus();
  }

  function submit() {
    const body = value.trim();
    if (!body || disabled) return;
    onSend(body);
    onChange('');
    setMenu({ kind: 'none' });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const open = menu.kind !== 'none';
    const hits: Array<ImMember | SlashCommand> = menu.kind === 'mention' ? mentionHits : slashHits;

    if (open && hits.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setMenu((m) =>
          m.kind === 'none' ? m : { ...m, index: (m.index + delta + hits.length) % hits.length },
        );
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const picked = hits[menu.kind === 'mention' ? (menu as { index: number }).index : (menu as { index: number }).index];
        if (!picked) return;
        if (menu.kind === 'mention') pickMention(picked as ImMember);
        else pickSlash(picked as SlashCommand);
        return;
      }
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setMenu({ kind: 'none' });
      return;
    }
    // Enter 发送,Shift+Enter 换行 —— 和微信/飞书一致,肌肉记忆不用重学
    if (e.key === 'Enter' && !e.shiftKey && !open) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer">
      {menu.kind === 'mention' && mentionHits.length > 0 ? (
        <ul className="menu" role="listbox" aria-label="选择要 @ 的成员">
          {mentionHits.map((m, i) => (
            <li key={m.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === menu.index}
                className={`menu__item ${i === menu.index ? 'is-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(m);
                }}
              >
                <span className="menu__name">{m.name}</span>
                <span className="menu__hint">{m.memberType === 'agent' ? 'AI 员工' : '协作者'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {menu.kind === 'slash' && slashHits.length > 0 ? (
        <ul className="menu" role="listbox" aria-label="快捷指令">
          {slashHits.map((c, i) => (
            <li key={c.name}>
              <button
                type="button"
                role="option"
                aria-selected={i === menu.index}
                className={`menu__item ${i === menu.index ? 'is-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickSlash(c);
                }}
              >
                <span className="menu__name">{c.name}</span>
                <span className="menu__hint">{c.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <textarea
        ref={inputRef}
        className="composer__input"
        rows={2}
        value={value}
        placeholder="说点什么…… @ 找人,/ 用指令"
        aria-label="消息输入框(@ 提及成员,/ 唤起快捷指令)"
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className="composer__bar">
        <span className="composer__tip">Enter 发送 · Shift+Enter 换行</span>
        <button type="button" className="btn btn--primary" onClick={submit} disabled={disabled || !value.trim()}>
          发送
        </button>
      </div>
    </div>
  );
}
