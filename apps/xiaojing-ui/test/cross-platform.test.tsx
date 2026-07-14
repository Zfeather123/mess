import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMention } from '@xiaojing/protocol';
import { ChatView } from '../src/views/ChatView.js';
import { getBridge } from '../src/platform/bridge.js';
import type { XiaojingBridge } from '../src/platform/bridge.js';
import { fakeBridge, fakeClient, message, WRITER } from './fakes.js';

/**
 * JIN-58 立的架构红线,JIN-52 接着守:**同一个 React 组件**,分别跑在桌面桥和
 * Web 桥上,行为逐字一致。
 *
 * 不是靠 code review 靠自觉 —— 谁哪天在组件里写了 if (isElectron) 的分支逻辑,
 * 下面这两个用例就会开始分叉。
 *
 * 唯一允许的差别是 **agent loop 在哪跑**:桌面上桥背后是 Electron IPC(本机
 * Agent SDK),浏览器里是 HTTP/SSE(服务端)。UI 对此一无所知。
 */

afterEach(() => {
  delete (globalThis as { window?: { xiaojing?: unknown } }).window?.xiaojing;
  vi.restoreAllMocks();
});

/** 两个平台跑同一套断言:@文案编导 → 员工干活 → 流式上屏 → 落库成正式消息。 */
async function runSharedScenario(platform: 'desktop' | 'web') {
  const user = userEvent.setup();
  const bridge = fakeBridge(platform);
  const fake = fakeClient({ history: [message(1, { body: '早上好' })] });

  render(<ChatView bridge={bridge} client={fake.client} />);

  expect(screen.getByTestId('chat').dataset['platform']).toBe(platform);
  await waitFor(() => expect(screen.getByText('早上好')).toBeTruthy());

  // 用户 @ 文案编导派活
  await user.click(screen.getByLabelText(/消息输入框/));
  await user.paste(`${formatMention('agent', WRITER, '文案编导')} 写个脚本`);
  await user.click(screen.getByRole('button', { name: '发送' }));

  // 桥被调用 = 「这位员工去干活了」。在哪跑是桥的事,不是 UI 的事。
  await waitFor(() => expect(bridge.runAgent).toHaveBeenCalled());
  const calls = (bridge.runAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const call = calls[0]![0] as { runId: string; agent: { id: string } };
  expect(call.agent.id).toBe(WRITER);

  // 主进程 / 服务端把 agent 事件推回来
  await act(async () => {
    bridge.emit({ type: 'tool_call', runId: call.runId, tool: 'mcp__xiaojing__read_image', input: {} });
    bridge.emit({ type: 'text', runId: call.runId, text: '钩子:订婚三个月分手' });
  });
  await waitFor(() => {
    expect(screen.getByText(/正在调用工具/)).toBeTruthy();
    expect(screen.getByText(/钩子:订婚三个月分手/)).toBeTruthy();
  });

  // 跑完 → 落库成这位员工的一条正式消息(群里其他成员、其他端都会收到)
  await act(async () => {
    bridge.emit({ type: 'done', runId: call.runId, usage: {}, turns: 2 });
  });
  await waitFor(() =>
    expect(fake.sent.some((s) => s.senderType === 'agent' && s.senderAgentId === WRITER)).toBe(true),
  );

  return { bridge, fake };
}

describe('同一套 React 代码跑在桌面 + 浏览器', () => {
  it('桌面:agent loop 在本机(Electron IPC 桥)', async () => {
    const { bridge } = await runSharedScenario('desktop');
    expect(bridge.platform).toBe('desktop');
  });

  it('浏览器:同一个组件,agent loop 在服务端 —— 界面表现逐字一致', async () => {
    const { bridge } = await runSharedScenario('web');
    expect(bridge.platform).toBe('web');
  });
});

describe('getBridge() 选桥', () => {
  it('有 window.xiaojing(Electron preload 注入)时选桌面桥', () => {
    (window as unknown as { xiaojing: XiaojingBridge }).xiaojing = fakeBridge('desktop');
    expect(getBridge().platform).toBe('desktop');
  });

  it('没有时回落到 Web 桥 —— 不做 userAgent 嗅探', () => {
    expect(getBridge().platform).toBe('web');
  });
});
