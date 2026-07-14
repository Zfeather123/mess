import { defineConfig } from 'vitest/config';

// 每个包必须有自己的 config:否则 vitest 会往上找到根 config,
// 把根里的 projects 列表(相对路径)当成自己的,直接报 "non-existing directory"。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
