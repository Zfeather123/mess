import { describe, expect, it, vi } from 'vitest';
import { ExecutorRegistry } from '../src/registry.js';
import { BrowserExecutor, UnavailableSession } from '../src/browser.js';
import { TOOL_CATALOG } from '../src/tools.js';
import type { Capability, ExecutionContext, Executor, ToolCall } from '../src/types.js';
import { ok } from '../src/types.js';

const ctx: ExecutionContext = {
  runId: 'r1',
  agentId: 'a1',
  sessionToken: 'tok',
  userDataDir: '/tmp/x',
  signal: new AbortController().signal,
};

class FakeExecutor implements Executor {
  constructor(
    readonly id: string,
    readonly capabilities: readonly Capability[],
    private readonly impl: (c: ToolCall) => Promise<{ content: Array<{ type: 'text'; text: string }> }> = async () =>
      ok('ok'),
  ) {}
  execute(call: ToolCall) {
    return this.impl(call);
  }
}

describe('ExecutorRegistry 路由', () => {
  it('按 capability 把工具路由到对应执行器', async () => {
    const cloud = new FakeExecutor('cloud', ['cloud.data'], async (c) => ok(`cloud:${c.toolName}`));
    const registry = new ExecutorRegistry()
      .registerExecutor(cloud)
      .registerTool({ name: 'douyin_stats', description: 'd', capability: 'cloud.data', schema: {} });

    const res = await registry.execute({ toolName: 'douyin_stats', input: {} }, ctx);
    expect(res.content[0]?.text).toBe('cloud:douyin_stats');
    expect(registry.resolve('douyin_stats')?.id).toBe('cloud');
  });

  it('没有执行器的能力域,其工具不出现在 listRunnableTools —— 不给模型拧不动的螺丝刀', () => {
    const registry = new ExecutorRegistry().registerExecutor(new FakeExecutor('cloud', ['cloud.data']));
    for (const t of TOOL_CATALOG) registry.registerTool(t);

    const runnable = registry.listRunnableTools().map((t) => t.name);
    expect(runnable).toContain('douyin_stats');
    expect(runnable).not.toContain('douyin_reply_dm'); // local.browser 无执行器
    expect(registry.listTools().length).toBeGreaterThan(runnable.length);
  });

  it('注册 BrowserExecutor 后,local.browser 工具自动变为可用 —— 第二期不用改任何路由代码', () => {
    const registry = new ExecutorRegistry().registerExecutor(new FakeExecutor('cloud', ['cloud.data']));
    for (const t of TOOL_CATALOG) registry.registerTool(t);
    expect(registry.listRunnableTools().map((t) => t.name)).not.toContain('douyin_reply_dm');

    // 这就是第二期要做的全部改动:注册一个执行器。
    registry.registerExecutor(new BrowserExecutor(new UnavailableSession()));

    expect(registry.listRunnableTools().map((t) => t.name)).toContain('douyin_reply_dm');
    expect(registry.resolve('douyin_reply_dm')?.id).toBe('local-browser');
  });

  it('工具抛异常时转成 isError 结果回给模型,而不是炸掉 agent loop', async () => {
    const boom = new FakeExecutor('boom', ['cloud.content'], async () => {
      throw new Error('上游 502');
    });
    const registry = new ExecutorRegistry()
      .registerExecutor(boom)
      .registerTool({ name: 'draft_script', description: 'd', capability: 'cloud.content', schema: {} });

    const res = await registry.execute({ toolName: 'draft_script', input: {} }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('上游 502');
  });

  it('未知工具返回 isError,不抛异常', async () => {
    const res = await new ExecutorRegistry().execute({ toolName: 'nope', input: {} }, ctx);
    expect(res.isError).toBe(true);
  });

  it('一个能力域被两个执行器抢注时立刻报错 —— 否则路由不确定', () => {
    const registry = new ExecutorRegistry().registerExecutor(new FakeExecutor('a', ['cloud.data']));
    expect(() => registry.registerExecutor(new FakeExecutor('b', ['cloud.data']))).toThrow(/已由执行器/);
  });
});

describe('BrowserExecutor(第二期扩展点)', () => {
  it('MVP 占位实现明确告知"未上线",不假装成功', async () => {
    const registry = new ExecutorRegistry()
      .registerExecutor(new BrowserExecutor(new UnavailableSession()))
      .registerTool({ name: 'douyin_reply_dm', description: 'd', capability: 'local.browser', schema: {} });

    const res = await registry.execute({ toolName: 'douyin_reply_dm', input: {} }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('第二期');
  });

  it('懒启动:第一次调用才拉起浏览器,且 profile 目录落在用户本地(抖音登录态不上传)', async () => {
    const launch = vi.fn(async () => {});
    const session = { launch, run: async () => ok('done'), close: async () => {} };
    const registry = new ExecutorRegistry()
      .registerExecutor(new BrowserExecutor(session))
      .registerTool({ name: 'douyin_publish', description: 'd', capability: 'local.browser', schema: {} });

    expect(launch).not.toHaveBeenCalled(); // 没人用就不该吃一个 Chromium 的内存

    await registry.execute({ toolName: 'douyin_publish', input: {} }, ctx);
    await registry.execute({ toolName: 'douyin_publish', input: {} }, ctx);

    expect(launch).toHaveBeenCalledTimes(1); // 只拉起一次
    expect(launch).toHaveBeenCalledWith('/tmp/x/douyin-profile');
  });
});
