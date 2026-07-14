import { contextBridge, ipcRenderer } from 'electron';

/**
 * 桌面桥 —— 渲染进程能看到的**全部**主进程能力,一个不多。
 *
 * 这个对象的形状必须和 @xiaojing/ui 里的 WebBridge 完全一致 —— 那是"一套 React 代码
 * 同时跑桌面和浏览器"的关键:UI 只依赖 XiaojingBridge 这个接口,不关心背后是 IPC
 * 还是 HTTP。见 apps/xiaojing-ui/src/platform/。
 */
const bridge = {
  platform: 'desktop' as const,

  runAgent: (req: unknown) => ipcRenderer.invoke('agent:run', req),
  cancelAgent: (runId: string) => ipcRenderer.invoke('agent:cancel', runId),

  onAgentEvent: (cb: (e: unknown) => void) => {
    const listener = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.off('agent:event', listener);
  },

  onRuntimeDownload: (cb: (p: { received: number; total: number }) => void) => {
    const listener = (_: unknown, payload: { received: number; total: number }) => cb(payload);
    ipcRenderer.on('runtime:download', listener);
    return () => ipcRenderer.off('runtime:download', listener);
  },
};

contextBridge.exposeInMainWorld('xiaojing', bridge);

export type DesktopBridge = typeof bridge;
