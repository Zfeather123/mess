import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../src/views/ChatView.js';
import { createWebBridge, getBridge } from '../src/platform/bridge.js';
import type { AgentEvent, XiaojingBridge } from '../src/platform/bridge.js';

/**
 * JIN-58 验收:**同一个 React 组件**,分别跑在桌面桥和 Web 桥上,行为一致。
 *
 * 这是"UI 不写两套"的可执行证明 —— 不是靠 code review 靠自觉,而是靠这个测试:
 * 谁哪天在组件里写了 if (isElectron) 的分支逻辑,这两个用例就会开始分叉。
 */

/** 桌面桥的测试替身:形状必须和 preload 里 contextBridge 暴露的一致。 */
function makeDesktopBridge(): XiaojingBridge & { emit: (e: AgentEvent) => void } {
  const listeners = new Set<(e: AgentEvent) => void>();
  return {
    platform: 'desktop',
    runAgent: vi.fn(async (req) => ({ runId: req.runId })),
    cancelAgent: vi.fn(async () => true),
    onAgentEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (e) => listeners.forEach((cb) => cb(e)),
  };
}

afterEach(() => {
  delete (globalThis as { window?: { xiaojing?: unknown } }).window?.xiaojing;
  vi.restoreAllMocks();
});

describe('同一套 React 代码跑在桌面 + 浏览器', () => {
  it('桌面:通过 Electron IPC 桥渲染 agent 的流式输出', async () => {
    const bridge = makeDesktopBridge();
    render(<ChatView bridge={bridge} />);

    expect(screen.getByTestId('chat').dataset['platform']).toBe('desktop');

    await act(async () => screen.getByRole('button').click());
    expect(bridge.runAgent).toHaveBeenCalled();

    // 模拟主进程把 agent 事件推过来
    await act(async () => {
      bridge.emit({ type: 'tool_call', runId: 'r', tool: 'mcp__xiaojing__douyin_stats', input: {} });
      bridge.emit({ type: 'text', runId: 'r', text: '粉丝 12800' });
      bridge.emit({ type: 'done', runId: 'r', usage: {}, turns: 2 });
    });

    await waitFor(() => {
      expect(screen.getByText(/正在调用工具/)).toBeTruthy();
      expect(screen.getByText('粉丝 12800')).toBeTruthy();
    });
  });

  it('浏览器:同一个组件走 HTTP/SSE 桥,渲染出一样的结果', async () => {
    // Web 桥:agent loop 在服务端跑,事件走 SSE
    const sseHandlers: Array<(e: { data: string }) => void> = [];
    class FakeEventSource {
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor() {
        queueMicrotask(() => {
          if (this.onmessage) sseHandlers.push(this.onmessage);
        });
      }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ runId: 'r' }), { status: 200 })),
    );

    const bridge = createWebBridge();
    render(<ChatView bridge={bridge} />);

    expect(screen.getByTestId('chat').dataset['platform']).toBe('web');

    await act(async () => screen.getByRole('button').click());
    await waitFor(() => expect(sseHandlers.length).toBeGreaterThan(0));

    const push = (e: AgentEvent) => sseHandlers.forEach((h) => h({ data: JSON.stringify(e) }));
    await act(async () => {
      push({ type: 'tool_call', runId: 'r', tool: 'mcp__xiaojing__douyin_stats', input: {} });
      push({ type: 'text', runId: 'r', text: '粉丝 12800' });
      push({ type: 'done', runId: 'r', usage: {}, turns: 2 });
    });

    await waitFor(() => {
      // 和桌面用例逐字一致的断言 —— 这就是"同一套 UI"的含义
      expect(screen.getByText(/正在调用工具/)).toBeTruthy();
      expect(screen.getByText('粉丝 12800')).toBeTruthy();
    });
  });
});

describe('getBridge() 选桥', () => {
  it('有 window.xiaojing(Electron preload 注入)时选桌面桥', () => {
    (window as unknown as { xiaojing: XiaojingBridge }).xiaojing = makeDesktopBridge();
    expect(getBridge().platform).toBe('desktop');
  });

  it('没有时回落到 Web 桥 —— 不做 userAgent 嗅探', () => {
    expect(getBridge().platform).toBe('web');
  });
});
