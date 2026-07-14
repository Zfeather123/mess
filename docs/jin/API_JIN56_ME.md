# API 契约:「我的」—— 算力钱包 / 绑定操盘手 / 通知设置 / 本周概览 / 数据导出(JIN-56)

> **为什么不在 `openapi.ts` 里?**
> 同 JIN-52 / JIN-54:这些是小镜 fork 自有的接口面。塞进 `openapi.ts` 会让**每次 upstream 合并都在那一个文件上打架**,而 upstream 可合并性是这个 fork 的命门。**排除在 OpenAPI 之外 ≠ 没有契约** —— 契约就是这份文档 + `packages/xiaojing-protocol/src/me.ts` 的类型。

所有路由挂在 `/api` 下,鉴权沿用既有中间件(`assertCompanyAccess` / `assertInstanceAdmin`)。
响应类型逐字对齐 `@xiaojing/protocol` 的 `ComputeBalance` / `ComputeUsagePage` / `RechargeOrder` / `CoachBinding` / `NotificationPrefs` / `WeeklyOverview`。

**单位约定(全链路唯一一份)**:`1 点 = 1 分人民币`。`POINTS_PER_YUAN = 100`(1 元 = 100 点)。`1M token = 5 元 = 500 点`。
因此 `amountCents === points` —— 这是换算的**结果**,不是契约;服务端一律按 `POINTS_PER_YUAN` 复算。

---

## 零、先说清楚现状(别被接口的完整性骗了)

JIN-51 交付的是一个**计费库**,只有 `InMemoryCreditLedger`:进程一重启余额归零,三张表建好了但**没有任何代码读写它们**,也没有任何 HTTP 面。本次补上的是:

- `PgCreditLedger`(`packages/billing/src/pg-ledger.ts`)—— 真正落 Postgres 的账本;
- 上面这层钱包 / 「我的」HTTP 接口。

**仍然没有做的(诚实清单)**:

| 事项 | 状态 |
|---|---|
| 网关切到 `PgCreditLedger` | ❌ 未接。`packages/gateway/src/index.ts` 仍在用 `InMemoryCreditLedger`(那里的 TODO 还在)。类已经导出可用,换一行构造即可,属于后续 PR。 |
| 微信 / 支付宝收银台 | ❌ **没有接任何支付 provider**。`channel: wechat / alipay` 只会建出一张 `pending` 单,`payUrl: null`。没有回调地址,没有签名校验,没有对账。**不要在 UI 上假装能付。** |
| 线下打款 → 到账 | ✅ 有,且是 MVP 唯一真实的加点路径:`manual` / `gift` 单 + 管理员人工确认(见下面的 settle 接口)。 |
| 用量明细里的 token 级用量 | 🟡 落在 `compute_transactions.memo` 里(`glm-4.6 · 输入 120 · 缓存 3328 · 输出 500`),`listCostEvents` 能原样解回。真正的用量事实表是 Paperclip 原生的 `cost_events`,由网关落,`compute_transactions.cost_event_id` 指过去。 |

---

## 一、算力钱包

### `GET /api/companies/:companyId/compute/balance` → `ComputeBalance`

```jsonc
{
  "accountId": "uuid",
  "balancePoints": 10000,       // 账面(已结算)
  "frozenPoints": 1500,         // 正在跑的 agent 占着的
  "availablePoints": 8500,      // = balance - frozen,UI 上的「剩余算力」
  "monthlyUsedPoints": 300,     // 本月 debit 流水之和(自然月,UTC)
  "monthlyQuotaPoints": null,   // 来自 budget_policies;没配 = null = 不限
  "lowBalanceThreshold": 1000,  // 低于这个值弹「余额不足」横幅
  "status": "active"            // active | suspended
}
```

- **首次读自动建账户**:从没充过值的用户看到的是 `0`,不是 404。「我的 → 算力」是常驻入口,不该因为「你还没花过钱」而报错。
- `monthlyQuotaPoints` 取 `budget_policies` 里 `scope_type='company' + window_kind='calendar_month_utc' + metric='billed_cents'` 的活跃策略;`metric` 的单位是分,与点 1:1,直接就是点数。
- **三个数都要露出来**。只给一个 `balance` 的话,用户会看到「余额没变但钱不够用」(冻结中)——那是最招投诉的一种数字。

### `GET /api/companies/:companyId/compute/usage?limit=20&cursor=<cursor>` → `ComputeUsagePage`

```jsonc
{
  "transactions": [
    {
      "id": "uuid",
      "direction": "debit",           // credit | debit
      "points": 250,
      "balanceAfter": 9750,
      "reason": "consume",            // recharge | consume | refund | adjust | gift | freeze | unfreeze
      "agentId": "uuid",
      "agentName": "文案编导",         // 服务端 join,UI 不再为每行发一次请求
      "issueId": "uuid",
      "issueTitle": "写一条普法短视频脚本",
      "memo": "glm-4.6 · 输入 120 · 缓存 3328 · 输出 500",
      "createdAt": "2026-07-14T02:00:00.000Z"
    }
  ],
  "nextCursor": "2026-07-14T02:00:00.000Z|uuid"   // null = 到底了
}
```

- **keyset 游标**,不是 offset:钱包是边翻页边扣费的列表,offset 会漏行 / 重行。游标形如 `<createdAt ISO>|<id>`,原样回传即可。
- 走 `compute_transactions_account_created_idx (account_id, created_at desc)`;员工名 / 任务标题在同一条 SQL 里 left join(无 N+1)。
- `limit` ∈ [1, 100],默认 20。

### `POST /api/companies/:companyId/compute/recharge` → `RechargeOrder`(201)

**Request**(= 协议里的 `CreateRechargeInput`)
```jsonc
{ "points": 5000, "channel": "manual" }   // channel: wechat | alipay | manual | gift
```

**Response**
```jsonc
{
  "id": "uuid",
  "points": 5000,
  "amountCents": 5000,   // 服务端按 POINTS_PER_YUAN 复算:5000 点 = 50 元 = 5000 分
  "channel": "manual",
  "status": "pending",
  "payUrl": null,        // MVP 恒为 null —— 没接收银台
  "createdAt": "...",
  "paidAt": null
}
```

- ⚠️ **请求体里没有 `amountCents` 这个字段**。客户端根本没机会传一个「1 分钱买 5 万点」的价 —— 少一个字段,就少一条攻击路径。传了也会被 zod 丢掉。
- `points` ∈ [100, 1_000_000](1 元 ~ 1 万元)。面额档位见协议里的 `RECHARGE_PRESETS`。
- `wechat` / `alipay`:**建单成功 ≠ 能付**。没有 provider,没有回调。UI 要么隐藏这两个渠道,要么明确写「暂未开放」。

### `POST /api/companies/:companyId/compute/recharge/:orderId/settle` → `RechargeOrder`

**人工确认到账(线下打款)。这个接口凭空造钱。**

```jsonc
{ "externalOrderId": "bank-流水-001", "memo": "对公转账已核实" }   // 两个字段都可选
```

| 守卫 | 行为 |
|---|---|
| `assertInstanceAdmin` | 不是实例管理员 / board → **403**。公司管理员也不行。 |
| 渠道 | 只认 `manual` / `gift`。`wechat` / `alipay` → **422**(没收到钱就发货 = 白送算力)。 |
| 重复调用 | 单已 `paid` → **409**;且底层 `ledger.credit()` 以 `recharge:<orderId>` 为幂等键,**即使并发重放也只加一次点**。 |
| 顺序 | 先 `credit()` 后置 `paid`。反过来一旦中间崩溃,单是 paid 但钱**永远不会到账**,而且账面看起来是成功的。 |

成功后:`balance_points += points`,`total_recharged_points += points`,落一条 `credit` / `recharge` 流水。

---

## 二、绑定操盘手

操盘手是**真人供给方**(造 agent 卖给用户 + 提供真人点评),不是 AI 员工 —— 所以它进不了 `squad_members`,也进不了 `imService.createConversation` 的 direct 分支(那条路径硬性要求「必须且只能有 1 个 AI 员工」)。

### `GET /api/companies/:companyId/me/coach` → `CoachBinding`
```jsonc
{ "coach": null, "boundAt": null }   // 没绑 = coach 为 null,不是 404
```
绑了之后:
```jsonc
{
  "coach": {
    "userId": "coach-9",
    "name": "李操盘",
    "title": "资深抖音法律内容操盘手",
    "avatarUrl": null,
    "bio": "带过 30 个法律号",
    "conversationId": "uuid"   // null = 还没聊过,点「私聊」时现建
  },
  "boundAt": "2026-07-14T02:00:00.000Z"
}
```

### `PUT /api/companies/:companyId/me/coach` → `CoachBinding`
```jsonc
{ "coachUserId": "coach-9", "name": "李操盘", "title": "...", "avatarUrl": null, "bio": "..." }
```
- **更换** = 旧行置 `ended` + 插新行(历史留痕)。「当前操盘手只有一个」由部分唯一索引 `coach_bindings_active_uq` 保证,不是靠应用层自觉。
- 重复绑同一个人 = 只刷新展示信息,**不会把 `conversation_id` 洗掉**(私聊记录不会丢)。

### `POST /api/companies/:companyId/me/coach/dm` → `{ "conversationId": "uuid" }`
- 没有会话就现建一个 `kind='direct'` 的会话(两个 **user** 成员:我 + 操盘手),并把 `conversation_id` 回填到绑定行。
- **幂等**:再点一次返回同一个会话,不会每点一次多建一个空会话(行锁 + 复查)。
- 没绑操盘手 → **404**。

---

## 三、通知设置

### `GET /api/companies/:companyId/me/notifications` → `NotificationPrefs`
### `PUT /api/companies/:companyId/me/notifications` → `NotificationPrefs`

```jsonc
{ "dailyTasks": true, "agentSummary": true, "complianceRisk": true }
```

- **没有行 = 全开**,且**读的时候不写库**(看一眼设置页不该产生一行数据)。新用户不该因为「没点过设置」就静默收不到合规风险提醒 —— 那是这个产品里最不该失败的一条推送。
- PUT 是 upsert 且是**部分更新**:传 `{ "dailyTasks": false }` 只改这一个,其余保持原值。

---

## 四、本周概览

### `GET /api/companies/:companyId/me/overview` → `WeeklyOverview`

```jsonc
{
  "weekStart": "2026-07-13",     // 本周一(UTC)
  "tasksCompleted": 12,          // issues.status='done' 且 completed_at >= 周一
  "draftsProduced": 5,           // 本周新建的 documents
  "pointsUsed": 2500,            // 本周 debit 流水之和
  "perAgent": [
    { "agentId": "uuid", "agentName": "文案编导", "points": 1800, "tasks": 7 }
  ]
}
```
`perAgent` 按点数倒序;**干了活但没烧点数的员工也会出现**(tasks > 0, points = 0),否则「员工工作小结」会莫名少人。

---

## 五、数据导出

### `GET /api/companies/:companyId/me/export`

`Content-Type: application/json; charset=utf-8`
`Content-Disposition: attachment; filename="xiaojing-export-<companyId>-<YYYY-MM-DD>.json"`

```jsonc
{
  "exportedAt": "...",
  "companyId": "uuid",
  "profile": { "userId": "...", "name": "王律师", "email": "wang@example.com" },
  "notifications": { "dailyTasks": true, "agentSummary": true, "complianceRisk": true },
  "coach": { "userId": "coach-9", "name": "李操盘", "...": "..." },
  "moments": [ /* 只有 author_user_id = 我 的动态 */ ],
  "computeTransactions": [ /* 公司算力账户的流水,与「我的 → 算力」看到的是同一份 */ ]
}
```

**只导调用者本人的数据**:朋友圈只取本人发的(不是全公司信息流),操盘手 / 通知设置同理。算力流水是公司账户级的 —— 调用者本来就能在「我的 → 算力」看到同一份,导出**不新增任何可见面**。

---

## 六、鉴权与错误码

| 情况 | HTTP |
|---|---|
| 未登录 | 401 |
| 访问别的公司 | 403 |
| **agent key 调「我的」接口** | 403 —— AI 员工没有「我」这个主体(没有操盘手、没有通知设置、没有可导出的自己) |
| 非实例管理员调 recharge settle | 403 |
| 参数不合法(面额越界 / 未知渠道) | 400 |
| 充值单不存在 | 404 |
| 充值单已 paid / 非 pending | 409 |
| 对 wechat / alipay 单做人工确认 | 422 |
| 算力不足(网关侧,不是本文档的接口) | 402 + `InsufficientCreditsError` |

---

## 七、两阶段扣费(UI 必须理解的中间态)

```
reserve(冻结)  →  settle(按真实用量结算) | release(退还)
frozen += 上界      frozen -= 上界             frozen -= 上界
balance 不动        balance -= 实际            balance 不动
```

- 为什么不能「事后 sum 再拦」:10 个请求并发时每个都看到「余额还够」,于是 10 个全放行 —— 但其实只够 1 个。token 花出去了要不回来。
- 进程在 reserve 之后、settle 之前被 kill:那笔冻结永远挂在 `held`。`sweepExpiredReservations`(TTL 默认 15 分钟)负责扫出来退还。sweeper 与 settle 撞车时,谁先把状态推离 `held` 谁生效,另一边是 no-op —— 不会双花。
- **UI 侧的含义**:`availablePoints` 才是「还能不能派活」;`balancePoints - availablePoints` 是「正在跑的任务占着的」。两者的差值会自己回来(结算或退还),不需要用户做任何事。

---

## 八、相关文件

| 层 | 文件 |
|---|---|
| 协议 | `packages/xiaojing-protocol/src/me.ts` |
| 账本(Postgres) | `packages/billing/src/pg-ledger.ts`(`PgCreditLedger`) |
| 服务 | `server/src/services/compute.ts`、`server/src/services/me.ts` |
| 路由 | `server/src/routes/compute.ts`、`server/src/routes/me.ts` |
| 校验 | `packages/shared/src/validators/compute.ts`、`packages/shared/src/validators/me.ts` |
| 表 | `packages/db/src/schema/compute.ts`、`packages/db/src/schema/me.ts`(迁移 `0151_moments_feed_and_me.sql`) |
| 测试 | `packages/billing/test/pg-ledger.test.ts`、`server/src/__tests__/compute-routes.test.ts`、`server/src/__tests__/me-routes.test.ts` |
