import { useState } from 'react';
import type { XiaojingBridge } from '../platform/bridge.js';
import { ChatView } from './ChatView.js';
import { MomentsView } from './MomentsView.js';
import { MeView } from './MeView.js';
import type { ImClient } from '../im/client.js';
import type { MomentsClient } from '../moments/client.js';
import type { MeClient } from '../me/client.js';

export type Tab = 'chat' | 'moments' | 'me';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'chat', label: '消息' },
  { id: 'moments', label: '朋友圈' },
  { id: 'me', label: '我的' },
];

/**
 * 顶层导航 —— 产品有 8 个模块,这里先立三个已经做完的(消息 / 朋友圈 / 我的)。
 *
 * 为什么不上 react-router:这个壳跑在 Electron 的 file:// 下,history 路由要额外配
 * hash 或自定义协议;而我们真正需要的只是「三选一」。一个 useState 就够,router 的
 * 代价(依赖 + file:// 的坑)现在买不到任何东西。等模块多到需要深链接再换,那时换的
 * 也只是这一个文件。
 *
 * 三个视图都是**同一套代码跑桌面和浏览器**:差异全收口在 XiaojingBridge,这里不做任何
 * if (isElectron) 分支。cross-platform.test.tsx 会盯着这条红线。
 */
export function AppShell({
  bridge,
  companyId = 'default',
  me = { userId: 'me' },
  imClient,
  momentsClient,
  meClient,
  initialTab = 'chat',
}: {
  bridge: XiaojingBridge;
  companyId?: string;
  me?: { userId: string };
  imClient?: ImClient;
  momentsClient?: MomentsClient;
  meClient?: MeClient;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="shell" data-testid="shell" data-tab={tab} data-platform={bridge.platform}>
      <nav className="shell__nav" aria-label="主导航">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`shell__tab${tab === t.id ? ' is-active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="shell__body">
        {/*
          三个视图都保持挂载会让 SSE 订阅/轮询在后台继续跑;但只渲染当前 tab 又会让
          切回消息时整条会话流重新拉一遍。取舍:消息模块是主场,常驻;另外两个按需挂载。
        */}
        <div className="shell__pane" hidden={tab !== 'chat'}>
          <ChatView bridge={bridge} client={imClient} companyId={companyId} me={me} />
        </div>

        {tab === 'moments' ? (
          <div className="shell__pane">
            <MomentsView client={momentsClient} companyId={companyId} />
          </div>
        ) : null}

        {tab === 'me' ? (
          <div className="shell__pane">
            <MeView
              client={meClient}
              companyId={companyId}
              me={me}
              onOpenConversation={() => setTab('chat')}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
