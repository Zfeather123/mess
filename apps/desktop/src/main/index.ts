import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHost } from '@xiaojing/agent-runtime';
import { MemoryOutboxStore, Outbox } from '@xiaojing/protocol';
import { registerIpc } from './ipc.js';
import { buildRegistry } from './tools.js';
import { platformKey, resolveClaudeBinary } from './binary.js';
import { initAutoUpdate } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 服务端地址由构建期注入;dev 指向本地 Paperclip。 */
const SERVER_URL = process.env['XIAOJING_SERVER_URL'] ?? 'http://localhost:3000';
/** 渲染进程:dev 走 vite dev server(热更新),prod 走打包好的静态文件。 */
const RENDERER_DEV_URL = process.env['XIAOJING_RENDERER_URL'];

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 700,
    // 微信式的无边框质感:标题栏隐藏,红绿灯往里挪
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b0b0f',
    show: false, // 先别显示,等渲染完再 show —— 避免白屏闪一下
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      // ── 安全三件套。渲染进程跑的是网页代码,必须当作不可信。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 外链一律用系统浏览器打开,不在应用内开新窗口(防钓鱼页伪装成应用界面)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (RENDERER_DEV_URL) {
    void mainWindow.loadURL(RENDERER_DEV_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

async function bootstrap() {
  const userDataDir = app.getPath('userData');

  // TODO(JIN-50/51):登录流程接入后,从服务端换取真正的 sessionToken。
  // 这里只放一个占位 —— 但注意它的类型和位置已经定死:客户端只碰 token,永远碰不到模型 key。
  let sessionToken = process.env['XIAOJING_SESSION_TOKEN'] ?? '';

  const registry = buildRegistry(SERVER_URL);

  const host = new AgentHost({
    registry,
    // 模型请求全部打到我们的网关。网关校验 token → 换成真 key → 转发 GLM。
    gatewayBaseUrl: `${SERVER_URL}/api/gateway`,
    getSessionToken: () => sessionToken,
    userDataDir,
    defaultModel: 'glm-4.6',
    pathToClaudeCodeExecutable: await resolveClaudeBinary({
      userDataDir,
      devPath: process.env['XIAOJING_CLAUDE_BIN'],
      spec: {
        platformKey: platformKey(),
        // 由服务端配置下发,便于换源 / 灰度。sha256 必须校验 —— 见 binary.ts。
        url: `${SERVER_URL}/api/runtime/${platformKey()}/claude`,
        sha256: process.env['XIAOJING_CLAUDE_SHA256'] ?? '',
        sizeBytes: 248 * 1024 * 1024,
      },
      onProgress: (received, total) => {
        mainWindow?.webContents.send('runtime:download', { received, total });
      },
    }).catch((err: unknown) => {
      // 下载失败不该让应用起不来 —— 界面照常显示,只是 agent 功能不可用。
      console.error('[xiaojing] agent 运行时不可用:', err);
      return undefined;
    }),
  });

  const outbox = new Outbox(new MemoryOutboxStore(), async (envelope) => {
    const res = await fetch(`${SERVER_URL}/api/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken}`,
        // 幂等键:重连补投可能重复送达,服务端按它去重
        'idempotency-key': envelope.idempotencyKey,
      },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) throw new Error(`sync ${res.status}`);
  });

  registerIpc({
    window: () => mainWindow,
    host,
    outbox,
    flush: () => void outbox.flush(),
  });

  createWindow();
  initAutoUpdate();

  void sessionToken; // 登录接入后由 auth 流程写入
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
