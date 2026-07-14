import type { Capability, ExecutionContext, Executor, ToolCall, ToolResult } from './types.js';
import { fail } from './types.js';

/**
 * 本地浏览器执行器 —— 第二期 Playwright 的接入点。
 *
 * ## 第二期怎么接(不用重构,照着做即可)
 *
 * 1. `pnpm --filter @xiaojing/executor add playwright`
 * 2. 新建 `src/playwright.ts`,实现 `BrowserSession`:
 *
 *    ```ts
 *    export class PlaywrightSession implements BrowserSession {
 *      async launch(profileDir: string) {
 *        // 关键:launchPersistentContext,不是 launch()。
 *        // 抖音登录态(cookie/localStorage)就活在 profileDir 里,
 *        // 留在用户机器上,永不上传服务端。
 *        this.ctx = await chromium.launchPersistentContext(profileDir, { headless: false });
 *      }
 *      async run(call, ctx) { ... }
 *      async close() { await this.ctx?.close(); }
 *    }
 *    ```
 * 3. 在 apps/desktop/src/main/tools.ts 里把
 *    `new BrowserExecutor(new UnavailableSession())`
 *    换成
 *    `new BrowserExecutor(new PlaywrightSession())`
 *
 * 就这一行。agent-runtime、主进程、渲染进程、协议层 —— 都不用动。
 * 因为它们只认识 ExecutorRegistry,而 local.browser 这个能力域的注册表项没变。
 *
 * ## 为什么现在就把接口定死
 * 等第二期再抽象,那时 agent-runtime 已经和具体工具耦合了,抽象成本 10 倍。
 * 现在定接口的成本是 0 —— 因为还没有实现要迁就。
 */

export interface BrowserSession {
  /** profileDir 是受控 Chromium 的用户目录,抖音登录态存在这里。 */
  launch(profileDir: string): Promise<void>;
  run(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult>;
  close(): Promise<void>;
}

/** MVP 占位实现:明确告诉模型"这个能力还没上线",而不是假装成功或神秘超时。 */
export class UnavailableSession implements BrowserSession {
  async launch() {
    /* no-op */
  }
  async run(call: ToolCall): Promise<ToolResult> {
    return fail(
      `本地浏览器工具 "${call.toolName}" 尚未上线(第二期接入 Playwright)。` +
        `请改用云端工具,或告知用户此功能暂不可用 —— 不要假装已经执行成功。`,
    );
  }
  async close() {
    /* no-op */
  }
}

export class BrowserExecutor implements Executor {
  readonly id = 'local-browser';
  readonly capabilities: readonly Capability[] = ['local.browser'];

  private launched = false;

  constructor(private readonly session: BrowserSession) {}

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult> {
    if (!this.launched) {
      // 懒启动:用户不用抖音自动化功能时,不该白白吃一个 Chromium 的内存。
      await this.session.launch(`${ctx.userDataDir}/douyin-profile`);
      this.launched = true;
    }
    return this.session.run(call, ctx);
  }

  async dispose() {
    if (this.launched) {
      await this.session.close();
      this.launched = false;
    }
  }
}

export { fail };
