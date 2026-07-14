import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/**
 * Agent SDK 的加固配置 —— 这个文件是本骨架里最容易被改坏的地方,改前先读实测数据。
 *
 * ## 实测:不加固会怎样(见 docs/desktop/agent-sdk-findings.md)
 *
 * 默认配置下,我们只想给模型 1 个工具,实际上送了 **53 个**工具定义 —— 每一轮都在烧。
 * 而且泄露进来的不只是 Claude Code 的内置工具(Bash/Write/Edit...),还有**宿主机器上
 * ~/.claude/settings.json 里配置的 MCP server**。在用户的电脑上跑,这意味着用户自己装的
 * 任何 MCP 工具都会混进小镜的 agent loop —— 这不只是烧 token,这是安全问题。
 *
 * 加固后:53 → 1。
 *
 * ## 三个开关各自防什么(缺一不可)
 *
 * | 开关                    | 防什么                                        |
 * |-------------------------|-----------------------------------------------|
 * | `tools: []`             | Claude Code 内置工具(Bash/Read/Edit/Web...)  |
 * | `settingSources: []`    | 宿主机 ~/.claude/settings.json 的 MCP / 插件   |
 * | `strictMcpConfig: true` | 项目 .mcp.json、插件、磁盘上的 agent frontmatter |
 *
 * ⚠️ `allowedTools` **不是**这个用途。SDK 文档原话:"To restrict which tools are
 * available, use the `tools` option instead." allowedTools 只是免确认白名单 ——
 * 它不会减少上送的工具定义。JIN-47 踩的就是这个坑。
 */

export interface HardenedOptionsInput {
  /** 我们的模型网关 base URL。客户端从不直连 GLM。 */
  gatewayBaseUrl: string;
  /** 会话凭证 —— 当作 x-api-key 发给我们的网关。**不是模型 key**。 */
  sessionToken: string;
  model: string;
  /** 由 ExecutorRegistry 生成的进程内 MCP server。 */
  mcpServers: NonNullable<Options['mcpServers']>;
  /** 只允许这些工具(全名,如 mcp__xiaojing__douyin_stats)。 */
  toolNames: string[];
  /** 静态部分:人设 + 话术库。会被 prompt caching 缓存。 */
  staticSystemPrompt: string[];
  /** 动态部分:当前账号数据、今日任务等每次都变的东西。不缓存。 */
  dynamicSystemPrompt: string[];
  /** claude 原生二进制的绝对路径(打包后不在 node_modules 里)。 */
  pathToClaudeCodeExecutable?: string;
  maxTurns?: number;
  cwd?: string;
}

/**
 * 系统提示词的缓存分界。
 *
 * 实测省 94%(input 1223 → 71)。原理:cache_control 断点之前的内容命中缓存后
 * 按 1/10 计价。所以**静态的放前面、动态的放后面** —— 顺序错了缓存就永远不命中,
 * 因为前缀变了。
 *
 * 话术库(几千 token 的固定内容)必须在 boundary 之前。
 */
export function buildSystemPrompt(staticParts: string[], dynamicParts: string[]): string[] {
  return [...staticParts, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamicParts];
}

/**
 * 子进程环境变量白名单。
 *
 * SDK 文档:"this value REPLACES the subprocess environment entirely"。我们**故意**
 * 利用这一点做全量替换,而不是继承 process.env —— 否则用户机器上如果存在
 * ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL,就会污染甚至劫持我们的模型请求
 * (把用户的对话打到别人的端点上)。
 *
 * 但全量替换会连 HOME / PATH / TEMP 一起清掉,原生二进制起不来。所以白名单放行
 * 操作系统必需的那几个,其余一律不透传。Windows 上 SYSTEMROOT/APPDATA 缺一不可。
 */
function osEssentialEnv(): Record<string, string> {
  const keys = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    // Windows
    'SYSTEMROOT',
    'SystemRoot',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'COMSPEC',
    'PATHEXT',
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 构造给 SDK query() 的 options。 */
export function buildHardenedOptions(input: HardenedOptionsInput): Options {
  return {
    model: input.model,
    mcpServers: input.mcpServers,

    // ── 工具裁剪(三个开关缺一不可,见文件头注释)
    tools: [], // 关掉全部内置工具
    settingSources: [], // 隔离宿主机 ~/.claude 设置
    strictMcpConfig: true, // 只用我们显式传入的 MCP server
    allowedTools: input.toolNames, // 免确认白名单(不影响上送数量)

    systemPrompt: buildSystemPrompt(input.staticSystemPrompt, input.dynamicSystemPrompt),

    // ── 模型请求全量指向我们的网关;客户端手里只有 sessionToken
    env: {
      ...osEssentialEnv(),
      ANTHROPIC_BASE_URL: input.gatewayBaseUrl,
      ANTHROPIC_API_KEY: input.sessionToken,
      // 明确关掉 SDK 的遥测/更新检查:用户的机器,别偷偷联外网
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },

    ...(input.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable }
      : {}),

    permissionMode: 'bypassPermissions', // 工具准入已由 registry 收口,不再二次弹窗
    maxTurns: input.maxTurns ?? 12,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
}
