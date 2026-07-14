import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, XiaojingBridge } from '../platform/bridge.js';

/**
 * 群聊主界面(骨架版)。
 *
 * 这个组件对"agent 在哪跑"一无所知 —— 它只跟 XiaojingBridge 说话。
 * 桌面上 bridge 背后是 Electron IPC(agent loop 在本地),浏览器里是 HTTP/SSE
 * (agent loop 在服务端)。同一份 JSX,两处运行。
 *
 * JIN-52 会把它做成真正的微信式群聊;这里只保证接线是通的。
 */
export function ChatView({ bridge }: { bridge: XiaojingBridge }) {
  const [messages, setMessages] = useState<Array<{ from: string; text: string }>>([]);
  const [running, setRunning] = useState(false);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    return bridge.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'text') {
        // 流式追加:同一个 runId 的文本片段合并到最后一条消息里,
        // 而不是每个 chunk 冒一条新气泡。
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.from === 'agent') {
            return [...prev.slice(0, -1), { from: 'agent', text: last.text + e.text }];
          }
          return [...prev, { from: 'agent', text: e.text }];
        });
      } else if (e.type === 'tool_call') {
        setMessages((prev) => [...prev, { from: 'system', text: `正在调用工具:${e.tool}` }]);
      } else if (e.type === 'done') {
        setRunning(false);
      } else if (e.type === 'error') {
        setMessages((prev) => [...prev, { from: 'system', text: `出错了:${e.message}` }]);
        setRunning(false);
      }
    });
  }, [bridge]);

  async function send(text: string) {
    const runId = `run_${Date.now()}`;
    runIdRef.current = runId;
    setMessages((prev) => [...prev, { from: 'user', text }]);
    setRunning(true);
    await bridge.runAgent({
      runId,
      agent: {
        id: 'account-doctor',
        name: '账号诊断师',
        staticPrompt: ['你是小镜的账号诊断师。'],
      },
      prompt: text,
    });
  }

  return (
    <div data-testid="chat" data-platform={bridge.platform}>
      <ul>
        {messages.map((m, i) => (
          <li key={i} data-from={m.from}>
            {m.text}
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={running}
        onClick={() => void send('查一下 lawyer_zhang 的抖音数据')}
      >
        {running ? '思考中…' : '发送'}
      </button>
    </div>
  );
}
