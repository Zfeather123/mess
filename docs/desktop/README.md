# 小镜桌面客户端 — 上手

## 先读这个

如果你要碰 agent 相关的代码,**先读 [`agent-sdk-findings.md`](./agent-sdk-findings.md)**。
里面有两个会咬人的坑(工具定义泄露、env 全量替换),不读会踩。

- 架构与扩展点 → [`architecture.md`](./architecture.md)
- 为什么是 Electron → [`adr-0001-electron-vs-tauri.md`](./adr-0001-electron-vs-tauri.md)
- 那 248MB 怎么办 → [`bundle-size-report.md`](./bundle-size-report.md)

## 跑起来

```bash
pnpm install

# 全部测试(26 个用例)
pnpm -r test
pnpm -r typecheck

# Web 版(浏览器里跑,agent loop 在服务端)
pnpm dev:web            # → http://localhost:5173

# 桌面版(agent loop 在本地)
pnpm --filter @xiaojing/ui dev          # 先起渲染进程
pnpm --filter @xiaojing/desktop dev     # 再起 Electron 外壳
```

同一份 React 代码,两种跑法。差异只在 `getBridge()` 一处。

## 验收证据怎么复现

**「agent loop 在本地跑通,附一次完整的工具调用」:**

```bash
pnpm --filter @xiaojing/agent-runtime test
```

这个测试起一个**假的模型网关**(说 Anthropic 协议),所以**不需要任何模型 key** 就能
跑通完整的 agent loop。它一次性断言四件事:

1. 完整工具调用回路:`tool_use` → 工具在**本进程**执行(断言 pid 一致)→ `tool_result` → 模型收尾
2. 客户端不持有模型 key:网关收到的 `x-api-key` 是 `sessionToken`
3. 工具定义被裁到 1 个(不加固时是 **53** 个,还会混进宿主机的 MCP 配置)
4. 没有执行器的能力域(`local.browser`)不会出现在工具定义里

**「一套 React 代码跑桌面 + 浏览器」:**

```bash
pnpm --filter @xiaojing/ui test
```

同一个 `ChatView` 组件,分别挂到桌面桥(IPC)和 Web 桥(SSE)上,**逐字一致的断言**。

## 打包

```bash
pnpm --filter @xiaojing/ui build:desktop   # 渲染进程 → desktop/dist/renderer
pnpm --filter @xiaojing/desktop build      # 主进程 TS → JS
pnpm --filter @xiaojing/desktop pack:win   # 或 pack:mac
```

⚠️ 打出来的包**不含**那个 248MB 的 claude 二进制 —— 首次启动时按需下载并校验 sha256。
理由和取舍见 [`bundle-size-report.md`](./bundle-size-report.md)。

## 状态:骨架,不是成品

已跑通的:agent loop 本地执行、工具裁剪、执行器路由、离线补报、跨平台 UI、按需下载 + 校验。

**还没做的**(需要别的 issue 或后续接手):

- **登录流程**:`sessionToken` 现在是环境变量占位。等 JIN-50 的用户体系落地后接。
- **实时通道没接线**:`RealtimeConnection` 写好且有测试,但主进程还没把它跑起来
  (要等服务端的 WS 端点)。
- **Windows / macOS 实机安装未验证**:本环境是 Linux,`electron-builder` 出 Windows 包
  需要 wine、出 mac 包需要 macOS 主机。**打包配置是写好的,但没人在真机上装过。**
  这条验收项我不能替你们打勾 —— 需要 DevOps 在 CI 上补一次真机构建。
- 首次下载失败时的 UI 状态(现在只打日志,界面照常起但 agent 不可用)。
