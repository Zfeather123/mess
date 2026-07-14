# 《TikHub 能力清单》

> 数据来源:TikHub OpenAPI 规范 <https://api.tikhub.io/openapi.json>(V5.3.2)与官方文档 <https://docs.tikhub.io>。
> 实现:`packages/tikhub`(`@paperclipai/tikhub`)。
>
> **本文档的诚实性声明**:TikHub 的响应信封是 `{ code, router, params, data }`,其中 `data` 是
> **抖音原始对象的透传**,openapi.json **把它声明为无类型**(没有 schema)。
> 因此下文所有**字段名**都是「spec 示例 + 社区惯例」的最佳猜测,凡是 spec 证明不了的,一律显式标注 **【待实测】**。
> 接口**路径**、**限额**、**计费**是 spec / 官方文档白纸黑字写死的,可信。
> 不要把本文里标了【待实测】的字段名当成已验证事实来写业务逻辑。

---

## §1 定位与产品结论

TikHub 是**第三方抖音数据 API**。它的定位是:**用我们自己的服务端 token,拉抖音的公开数据**。

一句话结论:

- **公开数据(别人也能在 App 里看到的)→ 能拉。** 粉丝数、获赞、作品列表、点赞/评论/分享/收藏、话题、IP 属地、认证信息、评论内容。
- **创作者后台数据(只有账号主本人登录才看得到的)→ 拉不到。** 完播率、播放来源、观众画像、涨粉净值、DOU+ 转化。
  这些只存在于 `creator_v2` 系列接口,而那套接口**必须由账号主本人提供 creator.douyin.com 的 Cookie**。
  TikHub 在这里的角色是「**代持你自己的 Cookie**」,不是「绕过抖音授权」。详见 §5。

**MVP 产品结论**:**不做 Cookie 路线**。凭据等同登录态,合规与用户信任成本过高,且 Cookie 会过期、需要用户反复重新授权。
受众画像改用 **评论语义分析** 替代 —— 评论是我们**确定能拉到**的、最强的受众意图信号(见 §3.4)。

---

## §2 接入约定(认证 / 限流 / 域名 / 计费)

| 项 | 值 |
| --- | --- |
| 认证 | HTTP 头 `Authorization: Bearer <token>` |
| 限流 | **10 QPS**(客户端侧必须自己限流,见 `packages/tikhub/src/http.ts` 的 `RateLimiter`) |
| 默认域名 | `https://api.tikhub.io` |
| **大陆域名** | ⚠️ **`https://api.tikhub.dev`** —— 路径完全相同,只是可达性不同。**部署在国内节点必须换这个**,否则直接连不上 |
| 401 | 未授权(token 错/失效)—— **永不重试** |
| 402 | **余额不足** —— **永不重试**(TikHub 按次计费,重试只会继续烧钱) |
| 429 | 触发限流 —— 可重试(指数退避 + 满抖动) |

**计费(按次)**:

- 常规接口:约 **$0.001–0.01 / 次**
- 批量播放量(`fetch_video_statistics`):约 **$0.025 / 次**
- 星图粉丝画像 V1(`kol_fans_portrait_v1`):约 **$0.02 / 次**
- 热点宝粉丝画像:比星图 **便宜约 20 倍**

环境变量(已在 `.env.example:28-29` 声明,勿另起一套):

```bash
TIKHUB_API_KEY=
TIKHUB_BASE_URL=https://api.tikhub.io   # 大陆改成 https://api.tikhub.dev
```

---

## §3 ✅ 能拉到

### §3.1 分享链接 / 口令文案 → `sec_uid`

| | |
| --- | --- |
| 主接口 | `POST /api/v1/douyin/web/get_all_sec_user_id`(**批量,≤10 条**) |
| 单条备选 | `GET /api/v1/douyin/web/get_sec_user_id?url=` |

**输入原样透传,不要在本地写正则拆链接。** spec 自己的示例里同时包含:

- 短链 `https://v.douyin.com/idFqvUms/`
- 整段分享口令文案(「7.94 复制打开抖音,看看【…】的作品 … **长按复制此条消息**,打开抖音搜索…」)

上游有能力自己拆。本地写正则去跟抖音的分享文案格式赛跑,必输。

**返回字段**:`sec_user_id`。【待实测】`data` 的确切嵌套形状(数组?对象?)——
实现里用递归搜索 `sec_user_id|sec_uid` 键来对形状漂移免疫(`parse.ts: extractSecUid`)。

`sec_uid` 是抖音账号的**稳定主键**,后续所有接口都以它为入参。

### §3.2 账号公开资料

| | |
| --- | --- |
| 主接口 | `GET /api/v1/douyin/app/v3/handler_user_profile?sec_user_id=` |
| 备选 | `GET /api/v1/douyin/web/handler_user_profile?sec_user_id=` |

⚠️ **优先用 APP 接口** —— TikHub 官方文档明说「尽量用 APP 接口,WEB 接口可能不稳定」。

能拿到的字段(均**【待实测】**确切键名,需用真 key 打一次快照):

| 业务含义 | 猜测字段名 | 用途 |
| --- | --- | --- |
| 粉丝数 | `follower_count` | 账号体量 |
| 关注数 | `following_count` | |
| 作品数 | `aweme_count` | |
| 总获赞 | `total_favorited` | ⚠️ 抖音**常以字符串返回**,必须强转 |
| 昵称 | `nickname` | |
| 抖音号 | `unique_id` | |
| 头像 | `avatar_larger.url_list[0]` | ⚠️ 嵌套在 `url_list` 数组里 |
| 简介 | `signature` | 可推 law_firm / 业务领域 |
| **IP 属地 / 省份** | `ip_location` | → 用来推 **city** |
| **个人认证** | `custom_verify` | 如「XX律所律师」→ **高价值**,用来推 **law_firm** |
| 企业认证 | `enterprise_verify_reason` | |

### §3.3 作品列表

```
GET /api/v1/douyin/app/v3/fetch_user_post_videos?sec_user_id=&max_cursor=&count=&sort_type=0
```

- `count` **不得超过 20**(官方警告)。实现里强制夹到 20。
- 翻页:用响应里的 `max_cursor` 作为下一页入参,直到 `has_more` 为假。
- `has_more` 可能是 `true/false`,也可能是 `1/0` → 两种都要认。

每条作品能拿到:

| 业务含义 | 猜测字段名【待实测】 |
| --- | --- |
| 作品 ID | `aweme_id` |
| 文案 | `desc` |
| 发布时间 | `create_time`(**秒级** unix) |
| 时长 | `video.duration`(毫秒) |
| 封面 | `video.cover.url_list[0]` |
| 分享链接 | `share_info.share_url` |
| **话题** | `text_extra[].hashtag_name`(不带 `#`) |
| 点赞 / 评论 / 分享 / 收藏 | `statistics.digg_count` / `comment_count` / `share_count` / `collect_count` |
| 播放量 | ⚠️ **不可信,见 §4** |

### §3.4 评论(受众意图分析的**主力信号**)

评论内容可拉。这是我们**确定能拿到**的、最强的受众意图信号 —— 在放弃 Cookie 路线(§5)之后,
**受众画像就靠它**:从评论里做语义分析,反推「谁在看」「他们在问什么法律问题」「痛点在哪」。

相关接口(`/api/v1/douyin/app/v3/` 与 `/web/` 下均有评论系列,如 `fetch_video_comments`、
`fetch_video_comment_replies`)。【待实测】确切路径、分页参数与单次条数上限 —— 本次未实现,
但它是**画像替代方案的基石**,应作为下一个迭代的首要接口。

### §3.5 ⚠️ 有条件能拉到:粉丝画像(性别 / 年龄 / 地域)—— **两条侧路,均【待实测】**

我们**没有**账号主 Cookie(§5),所以拿不到官方后台的观众画像。但 TikHub 有**两条侧路**,
都不需要 Cookie。**两条都必须实测,不要在实测前写进产品承诺。**

**侧路 A — 星图(巨量星图 KOL 库)**

```
GET .../get_xingtu_kolid_by_sec_user_id?sec_user_id=   →  kolid
GET .../kol_fans_portrait_v1?kol_id=                   →  粉丝画像(性别/年龄/地域)
```

- 成本:**$0.02 / 次**
- 🚨 **最大风险**:星图是**广告接单平台**,只有**入驻了星图**的达人才有 `kolid`。
  **律师账号多半没入驻星图 → `sec_user_id → kolid` 很可能根本换不到。**
  → **必须实测:拿一批真实律师账号,统计 kolid 的换算成功率。** 成功率过低则这条路直接废掉。

**侧路 B — 热点宝(抖音热点榜)**

```
GET .../billboard/fetch_hot_account_fans_portrait_list?sec_uid=&option=2|3|4
```

- `option` 切换维度:**2/3/4 分别对应 性别 / 年龄 / 地域**(【待实测】具体映射)
- 成本:比星图 **便宜约 20 倍**
- 🚨 **最大风险**:热点宝的数据源是**热榜账号**。**长尾账号(绝大多数律师号)可能压根没有数据。**
  → **必须实测:拿长尾律师账号打这个接口,看是否返回空。**

---

## §4 播放量 —— 单独成节,因为这是**最大的坑**

### §4.1 核心陷阱:作品列表里的 `play_count` **不可信**,真实播放量必须走专用接口

> TikHub 官方文档原文:**「抖音大多数接口已经不再返回作品的播放数,只能通过此接口获取。」**

**这意味着:**

1. 作品列表(§3.3)返回的 `statistics.play_count` **通常是 0 或缺失**。
   它是「**没有数据**」的伪装,**不是「0 次播放」**。
2. 真实播放量**只能**通过专用统计接口拿:

```
GET /api/v1/douyin/app/v3/fetch_video_statistics?aweme_ids=<id1>,<id2>
```

- ⚠️ **一次最多 2 个 `aweme_id`**(逗号分隔)。这不是可调参数 —— 超了上游直接不回数据。
  → 拉 N 条作品的播放量 = **⌈N/2⌉ 次请求**。100 条作品 = 50 次请求 ≈ **$1.25**。这是**成本模型的关键输入**。
- 返回:`digg_count` / `download_count` / `play_count` / `share_count`
- ⚠️ 该接口**不返回 `comment_count` / `collect_count`** → 必须与列表 stats **合并**使用。

### §4.2 铁律:`null` ≠ `0`(数据模型级约束)

| 场景 | `play_count` | `play_count_source` |
| --- | --- | --- |
| 走专用统计接口拿到(含真实的 0 播放) | 实际值(可以是 `0`) | `statistics_api` ✅ 可信 |
| 列表载荷确实带回了**非 0** 播放量 | 实际值 | `aweme_payload` ⚠️ 弱可信 |
| **没拉到** | **`null`** | **`null`** |

**绝不把「没拉到」写成 0。**
否则「爆款识别」会把**尚未同步到播放量的作品**误判成**扑街作品** —— 这是会直接毁掉产品核心功能的错误。

DB 侧已经把这条铁律固化成约束(`packages/db/src/migrations/0150_douyin_sync_and_profile_sources.sql`):

```sql
"play_count" bigint,                    -- 可空是刻意的
"play_count_source" text,
CONSTRAINT "douyin_video_metrics_play_source_check"
  CHECK ("play_count_source" IS NULL OR "play_count_source" IN ('statistics_api','aweme_payload'))
```

客户端类型 `PlayCountSource` 与该 CHECK 约束**逐字对齐**。

---

## §5 ❌ 拉不到

### §5.1 创作者后台数据 —— 需要**账号主本人的 Cookie**

| 拉不到的指标 | 为什么 |
| --- | --- |
| **完播率** | 只存在于 `creator_v2` 系列 |
| **播放来源**(推荐/关注/搜索/主页) | 同上 |
| **观众画像**(官方口径的性别/年龄/地域/活跃时段) | 同上 |
| **涨粉净值**(净增/取关拆分) | 同上 |
| **DOU+ 转化数据** | 同上 |

TikHub 确实有 `creator_v2` 系列接口,但它们**必须传入账号主本人 `creator.douyin.com` 的 Cookie**。

**TikHub 在这里的定位是「代持你自己的 Cookie」,不是「绕过抖音授权」。** 没有 Cookie 就是没有,
不存在别的口子。

### §5.2 完全没有接口

- **草稿箱** —— 无接口
- **私信** —— 无接口

### §5.3 PII

- **手机号**等个人身份信息 —— **无**。(公开数据里本就没有。)

### §5.4 产品结论(复述 §1)

**MVP 不做 Cookie 路线。** 理由:

1. **合规**:Cookie 等同于用户的登录态,持有它 = 持有账号控制权。
2. **信任成本**:要求律师交出抖音登录凭据,获客转化会当场死掉。
3. **工程成本**:Cookie 会过期,需要用户反复重新授权,运维负担高。

→ **受众画像改用「评论语义分析」替代**(§3.4)。

---

## §6 必做实测清单(spec 证明不了的 4 件事)

openapi.json 把 `data` 声明为**无类型透传**,所以以下 4 件事**只能靠打真实请求来确认**。
在拿到真 key 之前,不要把它们当成已知事实。

| # | 要验证什么 | 为什么它是风险 | 判定标准 |
| --- | --- | --- | --- |
| 1 | **星图 `kolid` 对律师账号的换算成功率** | 律师多半没入驻星图 → `sec_user_id → kolid` 很可能换不到,侧路 A 直接废掉 | 取 N≥20 个真实律师账号,统计换到 `kolid` 的比例 |
| 2 | **热点宝对长尾账号是否有数据** | 数据源是热榜 → 长尾律师号可能返回空,侧路 B 直接废掉 | 取 N≥20 个**非热榜**律师号,统计非空返回比例 |
| 3 | **作品列表能回溯多深** | `max_cursor` 翻页可能有隐性截断(只给最近 N 条)→ 直接决定「历史内容分析」这个功能做不做得成 | 找一个作品数 >200 的账号,一直翻到底,看实际能拿到多少条 |
| 4 | **profile / aweme 的真实字段快照** | **本文所有字段名都是猜测**。spec 把 `data` 声明为无类型 → **上游抖音改版会直接改变字段**,而我们不会收到任何通知 | 落盘一份真实 `raw` 快照作为基线,并**上线 schema 漂移告警** |

### 关于第 4 项:**schema 漂移告警是必需品,不是加分项**

因为 `data` 是无类型透传,抖音上游一改版,我们的解析器会**静默地**开始返回 `undefined` / `0` ——
**不报错,只是数据慢慢变成垃圾**。这是最危险的失败模式。

缓解措施(已在实现里):

- 所有解析器**防御式**:缺字段 → `undefined`,**永不抛错**(`parse.ts`)。
- 完整 `raw` 对象**落盘留档**(`douyin_videos.raw_aweme`),供漂移排查与**历史数据重解析**。
- 解析器单独导出(`parseUserProfile` / `parseVideo`),可以直接拿库里的 `raw` 重跑一遍。

**仍待补**:对关键字段(`follower_count`、`aweme_id`、`statistics.*`)做**非空率监控** ——
非空率突然掉到 0 = 上游改版,立刻告警。

---

## §7 实现映射(`packages/tikhub`)

| 契约方法 | 打的接口 | 关键约束 |
| --- | --- | --- |
| `resolveSecUid(input)` | `POST /api/v1/douyin/web/get_all_sec_user_id` | 输入原样透传;已经是 `sec_uid` 则**不发请求**(省钱) |
| `fetchUserProfile(secUid)` | `GET /api/v1/douyin/app/v3/handler_user_profile` | APP 接口优先 |
| `fetchUserVideos(secUid, opts)` | `GET /api/v1/douyin/app/v3/fetch_user_post_videos` | `count ≤ 20`;`max_cursor` 翻页;`has_more` 为假即停 |
| `fetchVideoStatistics(awemeIds)` | `GET /api/v1/douyin/app/v3/fetch_video_statistics` | **自动按每批 2 个切分** |

HTTP 层(`src/http.ts`):超时 30s / 指数退避+满抖动重试(最多 3 次)/ 客户端限流 10 QPS。
**401 / 402 / 参数错误永不重试。**
