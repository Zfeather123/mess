import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    /**
     * 这些用例的 setup hook 会真起一个 embedded postgres 并重放**全部**迁移。
     * 迁移数只增不减:到 0148 时,并行跑全量套件实测单个 hook 已需 ~13.5s,
     * 踩爆 vitest 默认的 10s hookTimeout(单独跑能过、并行争资源时挂 —— 典型的临界值)。
     * 给足余量:CI 机器通常比开发机弱。
     */
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
