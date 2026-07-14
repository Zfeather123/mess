# 小镜桌面客户端:架构与扩展点

## 进程图

```
┌─ 用户电脑 ───────────────────────────────────┐      ┌─ 我们的服务器(薄) ──┐
│                                              │      │                      │
│  渲染进程(不可信)                            │      │  Paperclip fork      │
│   React UI ── @xiaojing/ui                   │      │   协作层/任务/知识库  │
│   sandbox + contextIsolation,拿不到 Node     │      │                      │
│        │ IPC(preload contextBridge)         │      │  模型网关(持 key)   │
│        ▼                                     │      │   校验 token→换真 key │
│  主进程(可信)                                │      │   →转发 GLM          │
│   AgentHost ── @xiaojing/agent-runtime       │──────▶│                      │
│    └ agent loop 在这里跑(吃用户的内存)       │ HTTPS│  云端工具执行         │
│   ExecutorRegistry ── @xiaojing/executor     │      │   TikHub / CogView    │
│    ├ RemoteExecutor  → 云端工具              │──────▶│   (token 都在这边)   │
│    └ BrowserExecutor → 【第二期】Playwright  │      │                      │
│   Outbox ── @xiaojing/protocol(离线补报)     │──────▶│  算力记账             │
│                                              │      │                      │
│  抖音登录态(Chromium profile,永不上传)      │      └──────────────────────┘
└──────────────────────────────────────────────┘
```

**成本支点**:agent loop 跑在用户机器上,服务器只做"转发 + 记账"两件事,所以能很薄。

## 包结构

| 包 | 职责 | 关键文件 |
|---|---|---|
| `@xiaojing/agent-runtime` | 内嵌 Agent SDK,agent loop | `options.ts`(加固配置)`host.ts` |
| `@xiaojing/executor` | 可插拔执行器 + 工具目录 | `registry.ts` `browser.ts` |
| `@xiaojing/protocol` | 客户端↔服务端协议 | `outbox.ts` `connection.ts` |
| `@xiaojing/desktop` | Electron 外壳 | `main/index.ts` `main/binary.ts` |
| `@xiaojing/ui` | React UI(桌面+浏览器共用) | `platform/bridge.ts` |

---

## 扩展点 1:第二期接 Playwright(不用重构)

**改动就是一行。** `apps/desktop/src/main/tools.ts`:

```diff
+ registry.registerExecutor(new BrowserExecutor(new PlaywrightSession()));
```

然后实现 `BrowserSession` 接口(`packages/executor/src/browser.ts` 里有完整骨架注释):

```ts
export class PlaywrightSession implements BrowserSession {
  async launch(profileDir: string) {
    // 关键:launchPersistentContext,不是 launch()
    // 抖音登录态(cookie/localStorage)活在 profileDir 里,留在用户机器上
    this.ctx = await chromium.launchPersistentContext(profileDir, { headless: false });
  }
  async run(call, ctx) { /* 操作页面 */ }
  async close() { await this.ctx?.close(); }
}
```

**agent-runtime、主进程 IPC、渲染进程、协议层 —— 一行都不用改。** 因为它们只依赖
`ExecutorRegistry` 这个抽象。`local.browser` 能力域一旦有了执行器,`douyin_reply_dm` /
`douyin_publish` 这些工具会**自动**出现在上送给模型的工具定义里。

这条有测试守着:`packages/executor/test/registry.test.ts` 里
「注册 BrowserExecutor 后,local.browser 工具自动变为可用 —— 第二期不用改任何路由代码」。

**为什么现在就把接口定死**:等第二期再抽象,那时 agent-runtime 已经和具体工具耦合了,
抽象成本是现在的 10 倍。现在定接口的成本是 0 —— 因为还没有实现要迁就。

### 加一个新工具

1. 在 `packages/executor/src/tools.ts` 的 `TOOL_CATALOG` 里加一条(声明 `capability`)
2. 完事。路由、上送、错误处理都是自动的。

`capability` 决定它在哪台机器上跑:`cloud.*` → 服务端,`local.*` → 用户机器。

---

## 扩展点 2:一套 React 代码,跑桌面 + 浏览器

UI 只依赖 `XiaojingBridge` 接口(`apps/xiaojing-ui/src/platform/bridge.ts`):

- **桌面**:`window.xiaojing`(preload 注入)→ Electron IPC → agent loop 在本地
- **浏览器**:没有 `window.xiaojing` → 回落到 `WebBridge` → HTTP/SSE → agent loop 在服务端

选桥的判据是 **`window.xiaojing` 存不存在**,不做 userAgent 嗅探(UA 可以被改,而且
Web 版将来也可能跑在 Electron 的普通标签页里)。

**业务代码里不该出现 `if (isElectron)`。** 差异全部收口在 `getBridge()` 这一处。
`apps/xiaojing-ui/test/cross-platform.test.tsx` 用**逐字一致的断言**分别跑两个桥 ——
谁哪天在组件里写了平台分支,那两个用例就会开始分叉。

Web 版不是"阉割版",而是同一套界面 + 另一个 agent 执行位置。用户在浏览器里能做
除了"操作我自己的抖音"之外的一切。

---

## 扩展点 3:客户端 ↔ 服务端协议

三条通道,职责不重叠:

| 通道 | 用途 |
|---|---|
| `HTTP /api/*` | 认证、任务同步、算力上报 |
| `WS /api/realtime` | 消息推送(服务端 → 客户端) |
| `HTTP /api/gateway/v1/*` | 模型网关(Anthropic 兼容,服务端持 key) |

### 安全约束(不可妥协)

**客户端只持有 `sessionToken`** —— 短期、可撤销。模型厂商的真 key 只存在于服务端网关。
客户端把 `sessionToken` 当作 `x-api-key` 发给我们的网关,网关校验后换成真 key 转发 GLM。

用户不用注册 GLM、不用填 key。key 泄露的爆炸半径被限制在服务端。

### 断线重连

指数退避 + **满抖动**,上限 30s(`connection.ts`)。

抖动不是可选项:成千上万台客户端同时在线时,服务端一重启,所有客户端会在同一毫秒
重连,把刚起来的服务端**再打挂一次**(惊群)。抖动把重连打散开。

### 离线补报

**算力上报绝不能丢** —— 丢了就是我们白送算力。用户在地铁里断网,agent 仍在本地跑完
一整轮,产生的 token 消耗必须补报。

`Outbox`(`outbox.ts`)把出站信封持久化,重连后 **FIFO 重放、失败即停**(保证服务端
看到的顺序 == 客户端产生的顺序)。

**幂等由 `idempotencyKey` 保证**:重放可能重复投递(我们发出去了但没收到 ack),
**服务端必须按这个 key 去重**。宁可重发,不可丢。

> ⚠️ **给服务端的人(JIN-50/51)**:`/api/sync` 必须实现 `idempotency-key` 去重,
> 否则用户会被重复扣算力。这是协议的一部分,不是可选优化。

反复失败的"毒丸"信封在 8 次尝试后被丢弃,避免堵死整个队列。

---

## 安全基线

- 渲染进程 `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`
- 外链一律 `shell.openExternal`,不在应用内开窗(防钓鱼页伪装成应用界面)
- 下载的 claude 二进制**必须校验 sha256** 后才落盘执行(见 `bundle-size-report.md`)
- Agent SDK 用 `settingSources: []` 隔离宿主机配置(见 `agent-sdk-findings.md` 第 1 条)
