# Agent SDK 实测发现(所有要碰 agent 的人都该读)

针对 `@anthropic-ai/claude-agent-sdk@0.3.209` 的实测。测试代码:
`packages/agent-runtime/test/local-agent-loop.test.ts`(可复跑)。

---

## 1. 🔴 默认配置会上送 53 个工具定义,还会泄露宿主机的 MCP 配置

**JIN-47 说"`allowedTools` 不会减少上送的工具定义",这是对的,但只说了一半。**

我们只想给模型 1 个工具。实测默认配置下,**每一轮**上送给模型的工具定义有 **53 个**:

```
["Agent","Bash","CronCreate","CronDelete","Edit","Read","Write","WebFetch","WebSearch",
 "Workflow", ... ,"mcp__local__douyin_stats",
 "mcp__plugin_playwright_playwright__browser_click", ...]   ← 53 个
```

注意最后那一坨:**那是我这台机器上 `~/.claude/settings.json` 里配的 MCP server 漏进来的。**

这不只是烧 token。**这是安全问题** —— 小镜跑在用户的电脑上,用户自己装了什么 Claude Code
插件/MCP server,就会被原样注入进小镜的 agent loop。用户装了个能读本地文件的 MCP,
小镜的 AI 员工就凭空多了读用户硬盘的能力,而我们的代码里根本没写过这行。

### 修法:三个开关,缺一不可

```ts
{
  tools: [],              // 关掉全部内置工具(Bash/Read/Edit/Web…)
  settingSources: [],     // 隔离宿主机 ~/.claude/settings.json —— 防的就是上面那个泄露
  strictMcpConfig: true,  // 只用我们显式传入的 MCP server
  allowedTools: [...],    // 免确认白名单(注意:它**不**影响上送数量)
}
```

**实测:53 → 1。**

SDK 文档原话(`sdk.d.ts` 的 `allowedTools` 注释):

> List of tool names that are auto-allowed **without prompting for permission**.
> **To restrict which tools are available, use the `tools` option instead.**

`allowedTools` 是**权限**开关,`tools` 才是**可见性**开关。两个概念,名字长得像,踩坑的人不会少。

已封装在 `packages/agent-runtime/src/options.ts` 的 `buildHardenedOptions()`。
**不要绕过它直接调 `query()`。**

---

## 2. 🔴 `env` 是全量替换,不是合并

```
// sdk.d.ts
// When set, this value REPLACES the subprocess environment entirely
```

我们**故意**利用这一点:如果继承 `process.env`,用户机器上万一存在 `ANTHROPIC_API_KEY` 或
`ANTHROPIC_BASE_URL`,就会污染甚至**劫持**我们的模型请求(把用户的对话打到别人的端点上)。

但全量替换会把 `HOME`/`PATH`/`TEMP` 一起清掉,原生二进制起不来。所以 `options.ts` 里做了
**白名单放行**(Windows 上 `SYSTEMROOT`/`APPDATA` 缺一不可)。改这块前先想清楚。

---

## 3. 🟡 工具的 zod schema 会**剥掉**未声明的字段

注册工具时 schema 写成 `{}`,模型传的参数会被**静默丢弃**,工具函数收到空对象 `{}` ——
不报错,不告警,就是没有。我在写测试时被这个坑了一次(工具跑了,但 `account` 是空的)。

**schema 不是文档,是运行时的过滤器。** 字段必须声明全。

---

## 4. ✅ agent loop 确实能在本地跑通,且客户端不需要模型 key

这是 JIN-58 的核心验收项,已跑通。证据(`local-agent-loop.test.ts` 断言):

```
[assistant] tool_use → mcp__xiaojing__douyin_stats
  >>> 工具在本地 Node 进程内执行 (pid 一致)
[tool_result] 回传给模型
[assistant] text: 已拿到数据:粉丝 12800,昨日涨粉 340。
[result] success turns=2
```

- **完整的工具调用回路**:模型发起 → 工具在**我们的进程里**执行 → 结果回传 → 模型收尾
- **客户端不持有模型 key**:上送给网关的 `x-api-key` 是 `sessionToken`,不是模型 key。
  接法就是 JIN-47 说的:`ANTHROPIC_BASE_URL` 指向我们的网关即可。
- **工具定义被裁到 1 个**,且没有执行器的能力域(`local.browser`)根本不会出现在
  工具定义里 —— 不给模型一把注定拧不动的螺丝刀。

---

## 5. 💭 prompt caching 的断点位置

SDK 导出了 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`,把 `systemPrompt` 传成数组时用它标记分界:
**边界之前是静态(可缓存),之后是动态。**

顺序错了缓存就永远不命中(前缀变了)。所以:

- 边界**之前**:人设、话术库 —— 几千 token 的固定内容
- 边界**之后**:当前账号数据、今日任务 —— 每次都变

已封装在 `buildSystemPrompt()`。JIN-51 实测 prompt caching 省 94%(input 1223 → 71),
话术库那几千 token **必须**落在边界前面才吃得到这个收益。
