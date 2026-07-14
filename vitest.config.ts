import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/skills-catalog",
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-cloud",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      "packages/adapters/grok-local",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "packages/plugins/sdk",
      "packages/plugins/create-paperclip-plugin",
      "server",
      "ui",
      "cli",
      // 小镜桌面客户端(JIN-58)。agent-runtime 的用例是架构红线的守卫:
      // 它断言 agent loop 在本地跑、客户端不持有模型 key、工具定义被裁到 1 个。
      // 不挂在这里,CI 就跑不到它 —— 红线也就没人守。
      "packages/xiaojing-protocol",
      "packages/xiaojing-executor",
      "packages/xiaojing-agent-runtime",
      "apps/xiaojing-ui",
      "apps/desktop",
    ],
  },
});
