import { app, dialog } from 'electron';
import pkg from 'electron-updater';

const { autoUpdater } = pkg;

/**
 * 自动更新(Windows + macOS)。
 *
 * electron-updater 走 electron-builder 生成的 latest.yml / latest-mac.yml。
 * 更新包必须**签名**:macOS 用 Developer ID + notarize,Windows 用代码签名证书。
 * 没签名的话 macOS Gatekeeper 会直接拒绝启动,Windows 会弹 SmartScreen 警告 ——
 * 用户会以为我们是病毒。签名证书要提前买,别等到发版前一天。
 *
 * 静默下载、下次启动时安装 —— 不打断用户正在跑的 agent 任务。
 */
export function initAutoUpdate() {
  if (!app.isPackaged) return; // 开发环境不折腾更新

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['重启更新', '稍后'],
      defaultId: 1, // 默认"稍后" —— 别在用户跑任务时把应用关掉
      title: '小镜有新版本',
      message: `新版本 ${info.version} 已下载完成。`,
      detail: '重启后生效,也可以下次打开时自动更新。',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    // 更新失败不该打扰用户,记日志即可 —— 下次启动会重试
    console.error('[xiaojing] 自动更新失败:', err);
  });

  void autoUpdater.checkForUpdates();
}
