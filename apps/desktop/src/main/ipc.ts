import { ipcMain, type BrowserWindow } from 'electron';
import type { AgentHost, RunRequest } from '@xiaojing/agent-runtime';
import type { Outbox } from '@xiaojing/protocol';

/**
 * 主进程 ↔ 渲染进程 的桥。
 *
 * 渲染进程(React UI)是**不可信**的:它跑网页代码,contextIsolation + sandbox 全开,
 * 拿不到 Node。所有能碰文件、碰网络、碰模型的能力都只在主进程,渲染进程只能通过
 * 这几个明确定义的 channel 请求。
 *
 * agent 事件用流式推送(agent:event)而不是 invoke 的返回值 —— 因为 agent loop 会跑
 * 几十秒,期间要把 token 一个个吐到界面上,否则用户盯着转圈会以为卡死了。
 */

export const CHANNELS = {
  agentRun: 'agent:run',
  agentCancel: 'agent:cancel',
  agentEvent: 'agent:event',
  transportState: 'transport:state',
} as const;

export function registerIpc(opts: {
  window: () => BrowserWindow | null;
  host: AgentHost;
  outbox: Outbox;
  flush: () => void;
}) {
  ipcMain.handle(CHANNELS.agentRun, async (_evt, req: RunRequest) => {
    // 不 await 整个 loop —— 立刻返回 runId,事件通过 agent:event 流式推。
    void (async () => {
      for await (const event of opts.host.run(req)) {
        opts.window()?.webContents.send(CHANNELS.agentEvent, event);

        // agent 跑完就把算力消耗入发件箱。断网也不会丢 —— 重连后补报。
        if (event.type === 'done') {
          await opts.outbox.enqueue({
            idempotencyKey: `usage:${event.runId}`,
            kind: 'usage.report',
            payload: event.usage,
            attempts: 0,
            createdAt: Date.now(),
          });
          opts.flush();
        }
      }
    })();

    return { runId: req.runId };
  });

  ipcMain.handle(CHANNELS.agentCancel, (_evt, runId: string) => opts.host.cancel(runId));
}
