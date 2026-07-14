import react from '@vitejs/plugin-react';
// 从 vitest/config 引 —— vite 自己的 defineConfig 不认识 test 字段
import { defineConfig } from 'vitest/config';

/**
 * 同一份源码,两个产物:
 *   pnpm build          → dist/            (Web 版,静态托管)
 *   pnpm build:desktop  → ../desktop/dist/renderer/  (Electron 渲染进程)
 *
 * 桌面产物要 base: './' —— Electron 用 file:// 加载,绝对路径 /assets/... 会 404。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
  },
});
