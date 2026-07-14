# 模型网关 + 视觉工具层 + 算力计费(JIN-51)

## 这一层是什么(以及**不是**什么)

网关是**带鉴权和计量的薄反向代理**,**不是 agent 框架**。

```
【小镜桌面客户端】                      【服务器:网关】
 内嵌 Claude Agent SDK                  ① 鉴权:sessionToken → 哪个用户/员工
   → agent loop 在这里跑                ② 预留算力:余额不足 → 402,请求根本不发出去
   → 工具循环在这里                     ③ 注入 GLM key 转发(客户端永远拿不到 key)
   → ANTHROPIC_BASE_URL 指向网关 ──────▶ ④ 从响应 usage 读真实 token → 结算扣费
```

**工具循环/上下文管理不在网关里** —— 那是客户端 Agent SDK 的事。网关不跑 agent。

### 路由

| 路由 | 用途 | 后端 |
|---|---|---|
| `POST /v1/messages` | Agent SDK 的模型请求,**原样透传** | GLM **Anthropic 兼容端点** |
| `POST /vision/read_image` | 读截图/合同图 | GLM **原生 OpenAI 端点** ⚠️ |
| `POST /vision/generate_image` | 出底图 | GLM 原生端点(CogView) |
| `POST /vision/compose_cover` | 封面标题渲染 | **纯本地代码,不调模型,不计费** |

---

## ⚠️ 三个必须知道的坑(都有实测数据)

### 1. 视觉绝不能走消息流 —— Anthropic 兼容端点看不到图

同一张中文劳动合同截图,核对 6 个事实点:

| 走法 | 结果 |
|---|---|
| **原生 OpenAI 端点 + `glm-4.6v`** | ✅ **6/6 全读对**(公司名/工号/日期/金额/条款) |
| Anthropic 兼容端点 | ❌ **0/6** —— 模型答「我不具备识别图像的能力」 |

所以视觉必须封装成工具、内部绕到原生端点。**这就是 `/vision/*` 存在的唯一理由。**

### 2. 请求体原样透传,别动 `cache_control`

实测:同一带 `cache_control` 断点的 system 连打两次,
`input 2788 → 100`,`cache_read_input_tokens = 2688`,**省 96%**。

网关**不许**"优化"请求体 —— 动了断点就等于把用户的 prompt caching 打没了。
话术库/人设这类每次都带的大块内容,一定要打在断点**之前**(静态在前、动态在后,
顺序错了前缀就变了,缓存永远不命中)。

### 3. 流式响应的 usage 分散在两个事件里

```
message_start → message.usage : input_tokens / cache_read_input_tokens
                                (output_tokens 是**占位初值**,通常 1~3)
message_delta → usage         : output_tokens 的**最终值**
```

**output 必须以 `message_delta` 覆盖**,不能只读 `message_start` ——
只读前者会把几千个 output token 当 1 个收费。Agent SDK 默认就是流式,这是生产主路径。

---

## 算力计费:两阶段扣费(reserve → settle)

### 为什么不能事后 `sum(cost_events)` 拦截

事后统计在并发下**必然超卖**:10 个请求同时进来,每个都看到"余额还够",
于是 10 个全放行 —— 但其实只够 1 个。token 花出去了要不回来。

这不是加个事务能救的,是**时序**问题:上游扣钱发生在我们知道用量**之前**。

### 所以

```
① reserve  按最坏情况冻结(output 上界 = max_tokens,input 按最贵档算)
           └─ 余额不足 → 402,请求根本不发给上游
② forward  放行
③ settle   按响应里的真实 usage 回冲,多退少补 + 写用量明细
   (上游失败 → release,原样退还,不产生明细)
```

`reserve` **必须是单条原子语句**:

```sql
UPDATE credit_accounts SET balance_points = balance_points - $1
 WHERE id = $2 AND balance_points >= $1;   -- 靠受影响行数判断成败
```

❌ 绝不能"先 SELECT 查余额,再 UPDATE 扣减" —— 两条语句之间就是超卖窗口。

### 复用 vs 新增(核过 Paperclip 代码,别重造)

| 需求 | 用什么 |
|---|---|
| 用量明细(哪个员工/哪个任务/花了多少) | ✅ **复用** Paperclip 的 `cost_events`(字段和索引都现成) |
| 花费上限告警 | ✅ **复用** `budget_policies` |
| **点数余额 + 余额不足拦截** | ❌ Paperclip **没有** → 新增 `credit_accounts` / `credit_transactions` / `credit_reservations` |

`budget_policies` 是"花超了拦"(允许透支到超出那一次),点数制是"不够就不让发"(一分不能透支)。
语义不同,不能拿它顶。

### ⚠️ 运维必须有的补偿任务

网关进程若在 `reserve` 之后、`settle` 之前被 kill,这笔冻结会永远挂在 `held` ——
**用户的点数凭空消失**。必须定时扫 `state='held'` 且超时(如 15 分钟)的预留,一律 `release`。

---

## 配置项(全部走环境变量,不硬编码)

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://open.bigmodel.cn/api/anthropic` | GLM Anthropic 兼容端点 |
| `ANTHROPIC_API_KEY` | (必填) | GLM key。**只在服务端,永不下发客户端** |
| `GLM_NATIVE_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | 原生 OpenAI 端点,**视觉工具专用** |
| `GLM_API_KEY` | (必填) | 同上 |
| `GLM_VISION_MODEL` | `glm-4.6v` | 读图。实测满分 |
| `GLM_IMAGE_MODEL` | `cogview-4` | 出底图 |
| `COVER_FONT_PATH` | — | 封面中文字体。**缺了会渲染成豆腐块** |
| `BILLING_YUAN_PER_1M_INPUT` | `5.0` | 新 input token 费率(元/1M) |
| `BILLING_YUAN_PER_1M_CACHED_INPUT` | `0.5` | **缓存命中的 input**。实测省 96%,不能和上面一口价 |
| `BILLING_YUAN_PER_1M_OUTPUT` | `5.0` | output 费率 |
| `BILLING_POINTS_PER_YUAN` | `100` | 元 → 点数 |
| `VISION_POINTS_PER_IMAGE` | `20` | CogView 按**张**计费(不是 token 计价) |

> **为什么费率必须分三档**:缓存读取的 token 在上游本就按 ~1/10 计价。
> 一口价 = 要么用户替缓存买单,要么我们亏。具体倍率待 GLM 官方计价确认,改配置即可,不用改代码。

---

## 待决策(需要产品/合规拍板)

**CogView 出的图带「AI生成」水印,抠不掉。**

- 实测:传 `watermark_enabled: false` **接口接受但不生效**,水印照样在(右下角)
- 这大概率是《人工智能生成合成内容标识办法》要求的强制标识
- 目前 `compose_cover` 的标题安全区在**中上部**,和右下角水印**不冲突**,不影响可读性

⚠️ 这是**合规问题,不是渲染 bug** —— 我没有去裁掉/遮挡它。
是保留、还是裁掉底部、还是换图源,请产品和合规确认后再动。

---

## 跑测试

```bash
# 单测(假上游,不需要 key,进 CI)
pnpm --filter @xiaojing/billing test
pnpm --filter @xiaojing/gateway test

# 真机验收(需要真 key,默认 skip)
RUN_LIVE_GLM=1 ANTHROPIC_API_KEY=xxx GLM_API_KEY=xxx \
COVER_FONT_PATH=/path/to/msyh.ttc \
  pnpm --filter @xiaojing/gateway test
```
