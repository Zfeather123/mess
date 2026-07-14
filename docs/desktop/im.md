# 小镜 IM(消息模块)— JIN-52

群聊 / 私聊 / 卡片消息 / @提及 / 实时推送。数据结构直接用 0148 协作层的表
(`conversations` / `conversation_members` / `messages` / `message_mentions`),不另造一套。

## 三层

| 层 | 位置 | 职责 |
|---|---|---|
| 协议 | `packages/xiaojing-protocol/src/im.ts` | 消息类型、**@提及格式的唯一定义**、客户端 `MessageStore`(排序/去重/补洞) |
| 服务端 | `server/src/services/im.ts` + `routes/im.ts` | 落库、分配 `seq`、解析 @提及、SSE 推送 |
| UI | `apps/xiaojing-ui/src/{im,components,views}` | 一套 React 代码,桌面壳和浏览器共用 |

@提及的格式(`@[显示名](agent:<uuid>)`)只在协议层定义一次,客户端和服务端调同一个
`parseMentions()`。各解析各的迟早会出现「UI 高亮了但 agent 没被唤醒」——这类 bug 最难查。

## 三条不变量(DB 保证,不靠应用层自觉)

1. **全序**:`seq` 在事务里由 `UPDATE conversations SET last_seq = last_seq + 1 RETURNING` 分配,
   并发发送被行锁排队 → 严格递增、无空洞。客户端的补洞逻辑完全建立在「无空洞」上。
   不能用 `created_at` 排序:同毫秒并发 + 多实例时钟漂移都会乱序。
2. **幂等**:`(conversation_id, client_nonce)` 唯一索引。断线重发不会变成两条。
3. **未读 O(1)**:`unread = conversations.last_seq - conversation_members.last_read_seq`,永不扫 `messages`。

## 不丢消息:水位线 + 补洞

```
客户端 MessageStore.sinceSeq(已连续收到的最大 seq)
   │
   ├─ 连接:GET /conversations/:id/events?sinceSeq=N
   │     服务端先重放 seq > N 的,再转直播(重放期间的直播事件先缓冲,重放完再冲出去)
   │
   └─ 直播中收到 seq 跳号(比如水位线 3,来了 6)
         → store 扣住 6(不让它先上屏,否则顺序错乱)
         → 报告 gap {from:3, to:5}
         → GET /conversations/:id/messages?afterSeq=3 补回 4、5
         → 4、5、6 依次落位
```

`afterSeq` 的分页方向是**正序**(最老的先给),`beforeSeq`/首屏是倒序取最近 N 条。
截错方向会把最该补的那段丢掉。

## agent loop 在哪跑

**不在服务端。** @到某个 AI 员工时,服务端只把 mention 标成 `pending` 并推 `agent.invoke`;
真正的执行发生在用户的桌面客户端(内嵌 Agent SDK),跑完后客户端把结果作为一条
`senderType=agent` 的消息回传。服务端会校验这位员工确实在群里 —— 否则任何登录用户
都能伪造任意 AI 员工发言。

UI 侧对此一无所知:它只调 `bridge.runAgent()`,桥背后是 Electron IPC(桌面,本机跑)
还是 HTTP/SSE(浏览器,服务端跑),由运行环境决定。`test/cross-platform.test.tsx`
用两个桥跑同一组断言,把「UI 不写两套」这条红线钉死。

**AI 员工之间互 @ 不触发唤醒** —— 否则两个 agent 能互相 @ 到天亮,烧的是用户的算力点数。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/companies/:companyId/conversations` | 会话列表(未读数 / @我红点) |
| POST | `/api/companies/:companyId/conversations` | 建群 / 建私聊 |
| GET | `/api/conversations/:id/members` | 成员(@选择器 + 右侧面板) |
| GET | `/api/conversations/:id/messages` | 首屏 / `beforeSeq` 上翻 / `afterSeq` 补齐 |
| POST | `/api/conversations/:id/messages` | 发消息(`clientNonce` 幂等;命中返回 200,新建 201) |
| POST | `/api/conversations/:id/read` | 已读游标前移(只前移不后退) |
| GET | `/api/conversations/:id/events` | SSE(`sinceSeq` 断点续传,25s 心跳) |
| POST | `/api/conversations/:id/messages/:messageId/claim` | 领走 @唤醒(防重复烧算力) |

SSE 而不是 WebSocket:推送是单向的,上行走普通 HTTP 就够;SSE 自带重连语义,
且能穿透常挡 WS 的企业代理。真需要双向低延迟(第二期协同编辑)再升级 ——
客户端的 `MessageStore` 不关心底下是哪种通道。

多实例部署时把 `imEventBus`(进程内 EventEmitter)换成 Redis pub/sub,路由层和客户端都不用动。
