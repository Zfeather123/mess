# ADR-0001:桌面外壳选 Electron,不选 Tauri

- 状态:**已决定**
- 日期:2026-07-14
- 决策人:Tech Lead(JIN-58)
- 影响范围:整个桌面客户端

## 结论

**用 Electron。** Tauri 的包体优势在小镜这个具体场景里被稀释到 ~25%,而代价是丢掉
整条 Node 集成链路 —— 而 Agent SDK 和第二期的 Playwright **都是 Node 库**。

## 决策依据(先看数字)

小镜的桌面包里有一个绕不开的大家伙:Agent SDK 的 agent loop 跑在一个 **248MB 的原生
二进制**里(bun 打包的单文件,按平台分发)。这个二进制**两种外壳都得带** —— 它是
agent loop 本身,不是外壳的一部分。

| 组成 | Electron | Tauri |
|---|---|---|
| 外壳运行时 | 95–110 MB(实测,见下) | ~10 MB(官方数据,未实测) |
| **Node 运行时** | **0**(Electron 主进程自带) | **~50 MB**(必须额外带,见下) |
| claude 原生二进制 | 248 MB | 248 MB |
| **合计(磁盘)** | **~350 MB** | **~310 MB** |

**Tauri 只省下约 40MB / 11%。** 它宣传的"10MB vs 100MB"在这里不成立 —— 因为那个
对比的前提是"应用只有一个 UI 外壳",而小镜是一个**本地 agent 运行时宿主**。

## 为什么 Tauri 逃不掉那 50MB Node

Agent SDK 的架构是:`sdk.mjs`(Node 库)拉起 `claude` 原生二进制,两者之间走 stdio 上的
私有控制协议。Tauri 的前端是系统 WebView,进程里**没有 Node**。于是只剩三条路:

1. **把 Node 当 sidecar 一起打包** —— 那就是 Tauri(10MB) + Node(50MB) + 自己写
   WebView↔Rust↔Node 的两跳 IPC。等于把 Electron 主进程重新实现一遍,还更难调。

2. **用 Rust 重写 SDK 的控制协议** —— 这个协议不是公开稳定 API,SDK 版本号已经
   `0.3.209`(迭代极快)。上游一改我们就断。创业公司不该把地基压在别人的私有协议上。

3. **Rust 直接拉起 claude 二进制的 CLI JSON 模式** —— 技术上可行,但**会丢掉进程内
   MCP 工具**(`createSdkMcpServer`)。而进程内工具正是我们本地执行器的接入方式
   (见 `packages/xiaojing-agent-runtime/src/mcp-bridge.ts`)。要保住它,还得再起一个独立的
   Node MCP server 进程 —— 于是又绕回第 1 条:还是得带 Node。

**三条路都通向"还是得带 Node"。** 那就不如直接用一个自带 Node、且和它深度集成的外壳。

## 还有一条更硬的理由:第二期

第二期要接 Playwright 操作用户的抖音(私信自动回复、自动发布)。**Playwright 也是
Node 库。** Electron 里它就在主进程 `import` 一下的事;Tauri 里它得跑在那个 sidecar
Node 进程里,再把浏览器操作的结果跨两跳 IPC 传回来。

我们要 Node 的地方越来越多,而不是越来越少。这个方向上,Electron 的优势是**递增**的。

## 我们放弃了什么(诚实记录)

- **内存**:Electron 空载约 150–250MB,Tauri 约 80–120MB。但 claude 二进制(bun 运行时)
  本身就吃几百 MB,**两种方案都吃**,所以实际差距远小于纸面。
- **包体**:上面算过,约 40MB。
- 如果小镜将来退化成一个"纯 UI 壳 + 全部逻辑上云",这个决策**应该重新评估** ——
  那时 Tauri 的优势才是真的。

## 未实测项(不要当成实测数据引用)

本环境没有 Rust 工具链(`rustc`/`cargo` 均不存在),**Tauri 的包体与内存我没有亲手测**,
上表中 Tauri 那一列来自官方文档与公开基准。Electron 的数字是实测的(见下)。

如果要推翻这个决策,应该先补一个 Tauri + Node sidecar 的最小可运行原型,实测它的
包体、内存、以及 WebView↔Rust↔Node 两跳 IPC 的延迟 —— 再来谈。

## 实测数据来源

- Electron 33.4.11 官方发布产物(GitHub Release API 实测):
  - `win32-x64` **109.7 MB**
  - `darwin-arm64` **95.1 MB**
  - `darwin-x64` **99.6 MB**
- Agent SDK `0.3.209`:
  - 核心包 `@anthropic-ai/claude-agent-sdk` **3.8 MB**
  - 原生二进制 `claude-agent-sdk-<platform>/claude` **248 MB**(gzip 后 **76.3 MB**)
  - 二进制是 **optionalDependency 按平台分发**,单平台构建只带 1 份,不是 8 份
- 详见 `bundle-size-report.md`
