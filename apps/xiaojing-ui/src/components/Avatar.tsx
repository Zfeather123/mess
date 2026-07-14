/**
 * 头像 —— 群聊、朋友圈、「我的」共用一个。
 *
 * 原来它是 MessageList 里的私有函数。朋友圈也要显示员工头像,复制一份的代价是:
 * 同一位「文案编导」在群聊里是绿的、在朋友圈里是蓝的(两份 hue 实现迟早漂移)。
 * 底色是员工的身份标识,必须只有一份定义。
 */

/** 名字 → 稳定的头像底色。同一个员工在任何设备、任何页面上都是同一个颜色。 */
export function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

export function Avatar({
  name,
  kind,
  size,
}: {
  name: string;
  kind: 'user' | 'agent' | 'system';
  /** 朋友圈的头像比群聊里大一号。默认沿用群聊尺寸。 */
  size?: 'md' | 'lg';
}) {
  return (
    <span
      className={`avatar avatar--${kind}${size === 'lg' ? ' avatar--lg' : ''}`}
      style={{ ['--avatar-hue' as string]: hue(name) }}
      aria-hidden="true"
    >
      {name.slice(0, 1)}
    </span>
  );
}
