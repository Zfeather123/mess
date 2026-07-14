import { build } from 'esbuild';

/**
 * 打包 Electron 主进程 + preload。
 *
 * 为什么用 esbuild 而不是 tsc:主进程要 import 三个 workspace 包
 * (@xiaojing/agent-runtime 等),它们是**源码包**(main 指向 src/*.ts,不产出 dist)。
 * tsc 没法把跨包的 TS 源码打进一个产物里,esbuild 的 bundle 可以 —— 顺带也让
 * Electron 的 asar 里只有一个文件,启动更快。
 *
 * external 的三类东西不能打进去:
 *   - electron:运行时由 Electron 自己提供
 *   - electron-updater:要读 app-update.yml,打进 bundle 会找不到
 *   - Agent SDK:它要在运行时 spawn 那个 248MB 的原生二进制,必须留在 node_modules 里
 */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external: ['electron', 'electron-updater', '@anthropic-ai/claude-agent-sdk'],
};

await build({
  ...shared,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
  format: 'esm',
  banner: {
    // bundle 成 ESM 后 __dirname 没了,但主进程要用它定位 preload / renderer
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

await build({
  ...shared,
  entryPoints: ['src/preload/index.ts'],
  // preload 必须是 CJS:sandbox 模式下的 preload 不支持 ESM
  outfile: 'dist/preload/index.cjs',
  format: 'cjs',
});

console.log('[desktop] built dist/main/index.js + dist/preload/index.cjs');
