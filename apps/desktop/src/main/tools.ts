import { BrowserExecutor, ExecutorRegistry, RemoteExecutor, TOOL_CATALOG, UnavailableSession } from '@xiaojing/executor';

/**
 * 组装执行器注册表 —— 整个客户端唯一决定"哪个工具在哪跑"的地方。
 *
 * ## 第二期接 Playwright,改的就是这个文件的一行:
 *
 *   - new BrowserExecutor(new UnavailableSession())
 *   + new BrowserExecutor(new PlaywrightSession())
 *
 * agent-runtime、主进程 IPC、渲染进程、协议层,一行都不用改。
 * 因为它们只依赖 ExecutorRegistry 这个抽象,不依赖具体执行器。
 */
export function buildRegistry(serverBaseUrl: string): ExecutorRegistry {
  const registry = new ExecutorRegistry();

  // 云端:内容生产 / 抖音数据 / 视觉三件套 —— key 和 token 都在服务端
  registry.registerExecutor(new RemoteExecutor(`${serverBaseUrl}/api`));

  // 本地浏览器:MVP 阶段是占位实现,调用时明确返回"第二期上线"。
  // 注册它是为了让能力域存在;但注意 —— UnavailableSession 下这些工具依然
  // 会被上送给模型。如果不想让模型看到它们,就干脆别注册这个执行器
  // (registry.listRunnableTools() 会自动把 local.browser 的工具过滤掉)。
  //
  // MVP 的选择:**不注册**,让模型完全看不到这些工具。
  // 第二期把下面这行的注释去掉,并换成 PlaywrightSession。
  //
  // registry.registerExecutor(new BrowserExecutor(new UnavailableSession()));

  for (const spec of TOOL_CATALOG) {
    registry.registerTool(spec);
  }

  return registry;
}

export { BrowserExecutor, UnavailableSession };
