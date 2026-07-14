import type { z } from 'zod';

/**
 * 可插拔执行器 —— 本骨架最重要的扩展点。
 *
 * agent 的一次工具调用,可能需要在两个完全不同的地方执行:
 *   - 云端:内容生产类(改写文案、生成封面、查 TikHub)—— 无状态、要 key、要算力
 *   - 本地:操作用户自己的机器(抖音私信自动回复、自动发布)—— 需要用户的登录态
 *
 * agent-runtime 只认识 ToolSpec 和 ExecutorRegistry,不认识 Playwright、
 * 不认识 HTTP。所以第二期接 Playwright = 注册一个新 executor + 几个 ToolSpec,
 * agent-runtime / desktop 主进程 一行都不用改。这就是"不用重构"的含义。
 *
 * 见 docs/desktop/executor-extension.md。
 */

/** 工具按能力域路由到执行器。加新域 = 加一个字符串,不用改路由逻辑。 */
export type Capability =
  | 'cloud.content' // 文案/选题/合规 —— 云端
  | 'cloud.data' // TikHub 抖音数据 —— 云端(服务端持 token)
  | 'cloud.vision' // read_image / generate_image / compose_cover —— 云端原生端点
  | 'local.browser' // 操作用户浏览器(抖音)—— 第二期 Playwright
  | 'local.fs'; // 读写用户本地文件

export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  /** 模型看到的工具名,如 douyin_stats。会被 SDK 前缀成 mcp__xiaojing__douyin_stats。 */
  name: string;
  description: string;
  schema: S;
  /** 决定这个工具由哪个执行器跑。 */
  capability: Capability;
}

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ExecutionContext {
  runId: string;
  agentId: string;
  /** 会话凭证 —— 云端执行器拿它调我们的服务端。绝不是模型 key。 */
  sessionToken: string;
  /** 用户数据目录。本地执行器在这里放受控 Chromium 的 profile(抖音登录态)。 */
  userDataDir: string;
  signal: AbortSignal;
}

export interface Executor {
  readonly id: string;
  /** 这个执行器负责哪些能力域。 */
  readonly capabilities: readonly Capability[];
  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult>;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
