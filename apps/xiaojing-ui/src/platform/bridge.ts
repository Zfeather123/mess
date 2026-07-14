/**
 * 平台桥 —— "一套 React 代码,既跑桌面又跑浏览器" 的支点。
 *
 * UI 组件只 import 这个接口。它背后是谁,由运行环境决定:
 *   - 桌面:DesktopBridge —— 走 Electron IPC,agent loop 在本地跑
 *   - 浏览器:WebBridge   —— 走 HTTP/SSE,agent loop 在服务端跑
 *
 * 所以 Web 版不是"阉割版",而是同一套界面 + 另一个 agent 执行位置。
 * 用户在浏览器里能做除了"操作我的抖音"之外的一切。
 *
 * ⚠️ 加新能力时,两个实现都要加 —— TypeScript 会强制你加(接口不满足会编译不过)。
 * 这就是我们防止"UI 写成两套"的机制:它是编译期强制的,不是靠自觉。
 */

export interface AgentRunRequest {
  runId: string;
  agent: { id: string; name: string; staticPrompt: string[] };
  prompt: string;
  dynamicContext?: string[];
}

export type AgentEvent =
  | { type: 'text'; runId: string; text: string }
  | { type: 'tool_call'; runId: string; tool: string; input: unknown }
  | { type: 'tool_result'; runId: string; tool: string; isError: boolean }
  | { type: 'done'; runId: string; usage: unknown; turns: number }
  | { type: 'error'; runId: string; message: string };

export interface XiaojingBridge {
  readonly platform: 'desktop' | 'web';
  runAgent(req: AgentRunRequest): Promise<{ runId: string }>;
  cancelAgent(runId: string): Promise<boolean>;
  /** 返回取消订阅函数。 */
  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
}

declare global {
  interface Window {
    xiaojing?: XiaojingBridge;
  }
}

/**
 * 运行时选桥。
 *
 * 判据是 window.xiaojing 存不存在 —— 那是 Electron preload 通过 contextBridge 注入的。
 * 不用 userAgent 嗅探:Electron 的 UA 可以被改,而且 Web 版将来也可能跑在 Electron
 * 里的普通标签页中。有没有那座桥,才是唯一可靠的判据。
 */
export function getBridge(): XiaojingBridge {
  if (typeof window !== 'undefined' && window.xiaojing) {
    return window.xiaojing;
  }
  return createWebBridge();
}

/** 浏览器实现:agent loop 在服务端跑,事件走 SSE。 */
export function createWebBridge(baseUrl = '/api'): XiaojingBridge {
  const listeners = new Set<(e: AgentEvent) => void>();
  let stream: EventSource | null = null;

  const ensureStream = () => {
    if (stream) return;
    stream = new EventSource(`${baseUrl}/agent/events`);
    stream.onmessage = (evt) => {
      const parsed = JSON.parse(evt.data) as AgentEvent;
      for (const cb of listeners) cb(parsed);
    };
  };

  return {
    platform: 'web',

    async runAgent(req) {
      ensureStream();
      const res = await fetch(`${baseUrl}/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`启动 agent 失败:${res.status}`);
      return (await res.json()) as { runId: string };
    },

    async cancelAgent(runId) {
      const res = await fetch(`${baseUrl}/agent/${runId}/cancel`, { method: 'POST' });
      return res.ok;
    },

    onAgentEvent(cb) {
      ensureStream();
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) {
          stream?.close();
          stream = null;
        }
      };
    },
  };
}
