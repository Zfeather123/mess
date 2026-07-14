# API 契约:账号档案 + TikHub 同步 + 今日任务(JIN-54)

> **为什么不在 `openapi.ts` 里?**
> 这些是小镜 fork 自有的接口面,不属于 Paperclip 的公开 API 文档。塞进 `openapi.ts` 会让**每次 upstream 合并都在那一个文件上打架**,而 upstream 可合并性是这个 fork 的命门(见 JIN-49/JIN-50)。
> 先例:JIN-52 的 `im.ts` 也是这么处理的。**排除在 OpenAPI 之外 ≠ 没有契约** —— 契约就是这份文档。

所有路由挂在 `/api` 下,鉴权沿用 Paperclip 既有中间件(`assertCompanyAccess`)。

> **响应契约已登记(#40 规矩)**:全部响应走 `API_CONTRACT_SCHEMAS`
> (`AccountProfile` / `DouyinAccount` / `ProfileSyncSource` / `ProfileGuidance` /
> `ProfileGuidanceItem` / `DouyinSyncResult` / `ProfileFactWriteResult` /
> `TodayTask*`),mapper 在 `server/src/dto/jin54.ts`,**逐字段映射,不 spread 表行**。
> 契约测试:`server/src/__tests__/jin54-contract-routes.test.ts`。
>
> **不出线的字段**(登记时顺手关掉的):`douyin_accounts.raw_profile`(TikHub 原始透传响应,
> 字段名连我们自己都标着「待实测」)、`profile_sync_sources.cursor`(翻页游标)、
> `issues` 的 40+ 列执行层内务(`executionPolicy` / `checkoutRunId` …)、
> `approvals.decisionNote`。

---

## 一、TikHub 同步

### `POST /api/companies/:companyId/douyin-accounts/sync`

一条抖音链接 → 预填好的账号档案。**产品的第一次 Aha。**

**Request**
```jsonc
{
  "link": "7.53 复制打开抖音,看看【张律师的作品】... https://v.douyin.com/idFqvUms/",
  "maxVideoPages": 3,        // 可选,默认 3(每页 ≤20 条)
  "fetchPlayCounts": true    // 可选,默认 true
}
```
`link` 接受:分享短链 / **整段分享口令文案**(带表情的那一大坨,不要求用户清洗)/ 长链 / 直接 `sec_uid`。

**Response 200**
```jsonc
{
  "douyinAccountId": "uuid",
  "profileId": "uuid",
  "videosSynced": 58,
  "playCountsFetched": 20,
  "factsWritten": 3,
  "completenessPct": 30,
  "missingFields": ["positioning", "target_audience", "tone_preferences", "..."]
}
```

**错误码**(TikHub 的失败必须能被前端分辨,不能一律 500)

| HTTP | code | 含义 | 前端该怎么办 |
|---|---|---|---|
| 503 | — | 没配 `TIKHUB_API_KEY` | 这是**我们的**配置缺失,提示管理员,别怪用户 |
| 502 | `unauthorized` | 我们的 TikHub key 无效 | **不能回 401** —— 会误导用户去重新登录 |
| 402 | `insufficient_balance` | TikHub 余额不足 | 提示充值(是我们的账户) |
| 429 | `rate_limited` | 触发 TikHub 限流(10 QPS) | 稍后重试 |
| 404 | `not_found` / `private_account` | 账号不存在或私密 | 提示换一个公开账号 |
| 400 | `invalid_input` | 链接解析不出 sec_uid | 提示重新复制分享链接 |

**局部失败是被容忍的**:拉不到作品不会让已经拿到的账号资料一起丢掉 —— 每一步的产出立即落库。

---

## 二、账号档案

### `GET /api/companies/:companyId/douyin-accounts/:douyinAccountId/profile`
返回 `{ profile, syncSources, guidance }`。`profile.curatedSnapshot` 就是注入 prompt 的那一份。

### `GET /api/profiles/:profileId/guidance`
「缺失信息引导补全」/「不会填,帮我诊断一下」的数据面。

```jsonc
{
  "completenessPct": 30,
  "missingRequiredFields": ["positioning", "target_audience"],
  "autoFillable": [ /* 点「重新同步全部来源」就能补掉的 */ ],
  "needsUser":   [ /* 无论如何都得问用户的,如 禁用表达 */ ]
}
```
UI 按这两栏分区。每项带 `question`(直接发进群聊的问法)和 `diagnosisStrategy`(诊断师怎么推)。

> **`banned_expressions` 永远在 `needsUser`** —— 合规红线不能由模型代填。模型替律师承诺「不会说什么」是不可接受的风险。

### `POST /api/profiles/:profileId/facts`
用户手填。`source` 由服务端**强制**为 `user`(优先级 100),调用方不能自称 `tikhub` 来抢优先级。

```jsonc
{ "facts": [ { "fieldKey": "positioning", "value": "高净值离婚财产分割律师" } ] }
```
返回里带被拒的原因(`lower_priority` / `empty_value` / `unknown_field`)—— **静默不写是排查噩梦,拒绝必须有理由**。

### `GET /api/profiles/:profileId/sync-sources`
每个来源的同步状态与时间(原型第 7 张图那一排状态行)。`status ∈ never_synced | syncing | synced | error`。

---

## 三、AI 员工读档案

### `POST /api/tools/read_account_profile`
`xiaojing-executor` 的 `RemoteExecutor` 把 `cloud.*` 工具 POST 到 `${serverBaseUrl}/api/tools/<name>`,所以落在这里。返回 `{ text }`。

> ⚠️ **安全边界:不信任 `body.agentId`。**
> 档案归属完全由**已认证的 actor** 推导(`agent → squad → douyin_account → profile`)。
> 如果认 body 里的 agentId,任何 agent 只要改个 ID 就能读到别的小队的档案 —— 而 agent 的输入是**模型生成的**,等于把越权读取的开关交给模型。

**两条读取路径,都要,不是二选一:**
1. **工具**(pull)—— 模型主动调,可能忘了调
2. **系统提示词静态注入**(push)—— `buildProfilePromptBlock()`,保证「所有 AI 员工生成内容时都读得到」这条产品硬要求

> 注入位置必须在 `buildSystemPrompt` 的 **`staticParts`(cache 断点之前)**。档案是「共享且很少变」的内容,放 `dynamicParts` 会让它每轮重新计费 —— JIN-51 实测 prompt caching 命中省 94% input,**放错边这 94% 直接蒸发**。缓存失效用 `profile.revision` 做 key。

---

## 四、今日任务

### `GET /api/companies/:companyId/today-tasks`
Query:`assigneeAgentId` / `assigneeUserId` / `squadId` / `buckets` / `limit` / `cursor`。

返回 `{ tasks: [{ issue, bucket, progress, openApprovals }], hasMore, nextCursor }`。

### `GET /api/companies/:companyId/today-tasks/summary`
四个 tab 的角标计数。

**四个桶的语义(唯一有真逻辑的地方):**

| bucket | 中文 | 判定 |
|---|---|---|
| `needs_confirmation` | 待确认 | **不是 issue 状态**,而是「挂着未决审批」(`pending` / `revision_requested`)。**压过 issue 自身状态** —— 堵在这儿的是人,不是 AI |
| `done` | 已完成 | `status = done`。**终态** —— 干完的活不会因为一个没人清理的 pending 审批天天跳回待确认,否则今日任务永远清不空 |
| `in_progress` | 进行中 | `in_progress`,或 `in_review` 且无未决审批 |
| `todo` | 待处理 | `todo` / `blocked` |

`backlog` / `cancelled` **不属于今日任务**,直接排除。

**进度**(「补充 3 项关键信息 2/5」):`issues` 上**没有进度列**。进度**只从子 issue 推**(完成数/总数);没有子 issue 就返回 `null` —— **绝不编一个百分比**。

**写路径不在这里**:AI 员工创建/更新任务、用户派任务、审批,全部复用 Paperclip 既有接口(`POST /companies/:id/issues`、`PATCH /issues/:id`、`POST /approvals/:id/approve`),agent 可通过 MCP 的 `paperclipApiRequest` 直达。本模块只做**读聚合 + 桶语义**。

> 顺带补上 JIN-50 的一个缺口:`issues.owner_squad_id` 原本**有列无写入口**(不在 create/update 的 zod schema 里),「派任务给小队,队长再分派」在 API 上根本走不通,这列实际只能是 null。已补为可选字段。
