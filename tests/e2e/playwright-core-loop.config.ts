import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// JIN-88 核心闭环 E2E。
//
// 为什么单独一份 config(不复用默认的 playwright.config.ts):
//   默认 config 跑在 local_trusted 下,actor.source = "local_implicit",assertCompanyAccess
//   对它整段免检 —— 核心闭环的授权/协作层会「恒绿零覆盖」。这里刻意跑 **authenticated** 模式,
//   逼每一次请求走生产 resolveBoardAccess()(真人 session)。
//
// 这条 config 自带 webServer:先迁移干净 DB,再用非交互方式起一个 authenticated 实例。
// 关键点:`onboard --yes --bind <x>` 时 preferTrustedLocal=false(见 cli onboard.ts:463),
// 于是 PAPERCLIP_DEPLOYMENT_MODE=authenticated 才会被采纳;DATABASE_URL 存在 → postgres 模式
//(authenticated 不允许 embedded-postgres,见 onboard.ts canCreateBootstrapInviteImmediately)。
//
// DATABASE_URL 必填(CI 里由 postgres service 提供,本地由 docker pg 提供)。

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3110);
const BASE_URL = process.env.PAPERCLIP_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "playwright-core-loop.config.ts 需要 DATABASE_URL(authenticated 模式不能用 embedded-postgres)。" +
      "本地: docker run postgres 后 export DATABASE_URL=postgres://...;CI 由 postgres service 注入。",
  );
}

const PAPERCLIP_HOME = process.env.PAPERCLIP_E2E_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "jin-core-loop-home-"));
const INSTANCE_ID = "xiaojing-core-loop";
const CONFIG_PATH = path.join(PAPERCLIP_HOME, "instances", INSTANCE_ID, "config.json");
const AGENT_JWT_SECRET = process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "xiaojing-core-loop-agent-jwt-secret";
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "xiaojing-core-loop-better-auth-secret-0123456789";
const PLAYWRIGHT_CHANNEL = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;

// Export the resolved bootstrap coordinates so the spec (running in the test-runner
// process) reads exactly what the webServer booted with.
process.env.PAPERCLIP_E2E_BASE_URL = BASE_URL;
process.env.PAPERCLIP_E2E_DATA_DIR = PAPERCLIP_HOME;
process.env.PAPERCLIP_HOME = PAPERCLIP_HOME;
process.env.PAPERCLIP_E2E_CONFIG_PATH = CONFIG_PATH;

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  DATABASE_URL,
  PAPERCLIP_HOME,
  PAPERCLIP_INSTANCE_ID: INSTANCE_ID,
  PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
  PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
  PAPERCLIP_BIND: "loopback",
  PAPERCLIP_AGENT_JWT_SECRET: AGENT_JWT_SECRET,
  BETTER_AUTH_SECRET,
  // Never let the throwaway e2e instance burn real LLM budget by default.
  PAPERCLIP_E2E_SKIP_LLM: process.env.PAPERCLIP_E2E_SKIP_LLM ?? "true",
};

export default defineConfig({
  testDir: ".",
  testMatch: "xiaojing-core-loop.spec.ts",
  timeout: 240_000,
  expect: { timeout: 25_000 },
  // 不重试:authenticated 的 bootstrap_ceo 认领是一次性的(同一个 webServer 生命周期内实例只能被认领一次)。
  // 同一 webServer 上重试会撞「Someone else has already claimed this instance」——重试只会把真失败盖成假失败。
  // CI 里每次 job 是干净的 postgres service + 全新实例,天然确定;flake 要修根因,不能靠 retry 兜。
  retries: 0,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "on",
    trace: "retain-on-failure",
  },
  // 单 project。authenticated 的 bootstrap_ceo 认领是一次性的:同一个 webServer 上跑多个 project
  // 会让第二个 project 撞「已被认领」。移动端覆盖改为在同一条 test 内切到移动视口复跑核心 shell
  //(同一 session,不重复 bootstrap),见 spec 里的「移动端」段。
  projects: [
    {
      name: "desktop-chromium",
      use: {
        browserName: "chromium",
        ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
  webServer: {
    // 先把干净 DB 迁到最新,再非交互起 authenticated 实例。
    command: `pnpm db:migrate && pnpm paperclipai onboard --yes --bind loopback --run`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: serverEnv,
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
