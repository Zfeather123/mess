import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3104);
const BASE_URL = process.env.PAPERCLIP_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * JIN-83 / 顺手项:让这条 config **自己能把服务器拉起来**。
 *
 * 原来这里只有一句 `// No webServer — expects an already-running server at BASE_URL.`,
 * 于是它在 CI 里**根本没法跑**(没人给它起服务器)—— 加上 `playwright.config.ts:24` 的
 * `testIgnore` 把 multi-user.spec.ts 挡在默认 e2e 之外,这条 spec 在**任何 workflow、
 * 任何触发条件下都从没执行过**。
 *
 * webServer 块照抄 `playwright.config.ts` 里那个**已经在 CI 里跑通过**的:
 * 独立的 throwaway PAPERCLIP_HOME + local_trusted 模式(这条 spec 的注释写明了它测的就是
 * local_trusted)。
 *
 * `reuseExistingServer` 只在非 CI 下开 —— 本地已经手动起了服务器的人,用法不变(不倒退);
 * CI 里则永远起一个干净的 throwaway 实例,不会挂到别人的实例上。
 */
const PAPERCLIP_HOME = process.env.PAPERCLIP_E2E_DATA_DIR
  ?? path.join(os.tmpdir(), `paperclip-e2e-multiuser-${PORT}`);
const PAPERCLIP_CONFIG = path.join(PAPERCLIP_HOME, "config.json");

export default defineConfig({
  testDir: ".",
  testMatch: "multi-user.spec.ts",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: `pnpm paperclipai onboard --yes --run`,
    url: `${BASE_URL}/api/health`,
    // 本地已经手动起了服务器的人:直接复用(原来的用法不倒退)。CI 里永远起干净实例。
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      PAPERCLIP_HOME,
      PAPERCLIP_CONFIG,
      PAPERCLIP_INSTANCE_ID: "playwright-e2e-multiuser",
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    },
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
