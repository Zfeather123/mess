import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getBridge } from './platform/bridge.js';
import { ChatView } from './views/ChatView.js';

/**
 * 唯一入口 —— 桌面和浏览器共用。
 *
 * 桌面:Electron 加载打包后的 index.html,preload 已经注入了 window.xiaojing
 * 浏览器:vite dev / 静态托管,没有 window.xiaojing,自动回落到 WebBridge
 *
 * 没有 if (isElectron) 分支散落在业务代码里 —— 差异被收口在 getBridge() 这一处。
 */
const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <ChatView bridge={getBridge()} />
  </StrictMode>,
);
