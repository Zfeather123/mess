# API 契约:AI 员工市场 + 招聘(JIN-67)

> **为什么不在 `openapi.ts` 里?**
> 这是小镜 fork 自有的接口面,不属于 Paperclip 的公开 API 文档。`openapi.ts` 是 Paperclip 原有文件(upstream 的 #9380 / #9508 都在改它),塞进去会让**每次 upstream 合并都在那一个文件上打架**,直接违反 [UPSTREAM.md](./UPSTREAM.md) 第 2 条「不改 Paperclip 原有文件」。
> 先例:JIN-52 的 `im.ts`、JIN-54 的 `account-profiles.ts` / `today-tasks.ts` 都是这么处理的。**排除在 OpenAPI 之外 ≠ 没有契约 —— 契约就是这份文档。**

所有路由挂在 `/api` 下(`server/src/routes/employee-market.ts`),鉴权一律走 Paperclip 既有的 `assertCompanyAccess(req, companyId)`:调用方必须对该 company 有访问权,否则 `403`。

---

## 供给模型:双供给源,单一读模型

| 供给源 | 存储 | `source` | `refId` 形状 |
|---|---|---|---|
| 操盘手预制 | teams-catalog 只读展开 + `employee-presets.ts`(**不落库**) | `preset` | `catalog:<teamId>:<agentSlug>` 或 `jin:<slug>` |
| 用户自定义 | `agent_templates` 表(迁移 `0152`) | `custom` | `agent_templates.id`(uuid) |

前端只认 `EmployeeCard` 这一个形状,**不关心底下是文件还是表**。两条供给路在服务层收敛到同一个 `materializeEmployee()`。

---

## 一、读模型

### `GET /api/companies/:companyId/employee-market`

返回 preset + custom 的 **union**,形状一致。

Query(全部可选):

| 参数 | 类型 | 说明 |
|---|---|---|
| `source` | `preset` \| `custom` | 只看某一个供给源 |
| `category` | `content` \| `operations` \| `compliance` | 市场分类 |
| `q` | string | 名称 / 角色模糊搜索 |
| `hired` | boolean | 只看已招募 / 未招募 |

**`200`** → `EmployeeCard[]`:

```jsonc
[
  {
    "source": "preset",
    "refId": "jin:content-lead",
    "name": "内容主理人",
    "avatar": "...",
    "role": "内容生产",
    "category": "content",
    "summary": "...",
    "methods": [{ "id": "xhs-note", "name": "小红书笔记" }],
    "hired": true,
    "agentId": "uuid | null",   // hired=true 时给出已招的 agent
    "outOfDate": false          // 模板/catalog 内容变了但员工没跟进
  }
]
```

> `outOfDate` 的算法见下文「provenance」。**「已招募」不是一个真分类** —— 它是前端按 `hired` 过滤出来的。

---

## 二、招聘

### `POST /api/companies/:companyId/employee-hires`

```jsonc
{ "source": "preset", "refId": "jin:content-lead" }
```

**`201`** → `EmployeeHireResult`:

```jsonc
{
  "agentId": "uuid",
  "requiresApproval": true,
  "approvalId": "uuid | null",
  "warnings": ["..."]   // 例:desired skill 未安装
}
```

### 🔴 materialize 在 POST 当场跑完,不挂审批回调

`activatePendingApproval` 里**没有任何 catalog/template 展开逻辑** —— 它只是「激活一行早已建好的 agent」。所以:

- **`POST` 这一刻**就把 agent 建全:人格指令 bundle、模型/adapter 配置、desiredSkills 全部落地。
- **审批只负责激活**(`requiresApproval: true` 时 agent 先建好但未激活)。

把 materialize 挂到审批回调上,会**静默建出一个空壳员工** —— 招聘"成功"了、员工没有人格没有方法包,而且**不报错**。这是本单最容易踩的坑。

### 配置历史

`agents.create()` **从不**记录配置修订,`update()` 也只在调用方**显式传 `options.recordRevision`** 时才记(`server/src/services/agents.ts:529`)。materialize 显式传了 `recordRevision: { source: "employee_hire:<refId>" }`,所以新招员工**有配置历史**,前端已上线的「配置历史 / 回滚」对它可用。

### 错误码

| 码 | 何时 |
|---|---|
| `403` | 对该 company 无访问权 |
| `404` | `refId` 解析不到(catalog team / agent slug / 模板不存在或已归档) |
| `409` | 该 `refId` 已招募过(同一员工不重复招) |
| `422` | body 不合法(`source` 不在枚举内 / 缺 `refId`) |

---

## 三、自定义模板

| 路由 | 作用 |
|---|---|
| `GET /api/companies/:companyId/agent-templates` | 列出本 company 的模板 |
| `POST /api/companies/:companyId/agent-templates` | 新建模板;传 `{ fromAgentId }` = 「把这个员工存为模板」 |
| `PATCH /api/companies/:companyId/agent-templates/:templateId` | 改模板(内容列变更 → DB 触发器自增 `version`) |
| `DELETE /api/companies/:companyId/agent-templates/:templateId` | **归档**(`status='archived'`),不物理删除 → `204` |

字段:`name` / `avatar` / `role` / `category` / `instructions` / `adapter_config` / `desired_skills` / `visibility`(`private` \| `company` \| `public`)。

`version` **由 DB 触发器兜底自增**(只在内容列真的变了时才 +1),**不依赖调用方记得传** —— 这是 out-of-date 判定的基准。

---

## 四、provenance:不建 FK 关联表

沿用 teams-catalog 的既有做法(`metadata.paperclip.catalogTeam`),写进 **`agents.metadata.jin.employee`**:

```jsonc
{ "source": "preset", "refId": "catalog:content/content-machine:content-lead", "contentHash": "sha256:..." }
```

- **preset**:`contentHash` 直接用 teams-catalog manifest 里**现成的 sha256**(`catalog-builder.ts:418`,每个 agent 文件行本来就带 `path + sha256`),不用自己算。
- **custom**:拿 `agent_templates.version` 比。

**out-of-date 徽章 = 存的 hash/version ≠ 当前 hash/version。** 白嫖,零额外存储。

> 我们的东西一律挂在 `metadata.jin` 下(`JIN_METADATA_NAMESPACE`),一眼能认出来,跟 upstream 永不冲突。

---

## 五、`packages/teams-catalog` 零源码改动

预制员工**不需要**改 teams-catalog 一行源码:

- **一个预制员工 = 一个单 agent 的 team 目录**。builder 只要求 `TEAM.md` + 一个能解析到包内 `AGENTS.md` 的 `manager:` 字段(`catalog-builder.ts:490-502`),**没有最小 agent 数限制**(线上两个 team 本来就各只有 1 个 agent)。这是纯内容新增。
- frontmatter 解析器 `parseFrontmatterMarkdown` 是**导出的**(`src/frontmatter.ts:35`),直接 import 复用。
- `installCatalogTeam`(`server/src/services/teams-catalog.ts:902`)走 portability bundle,**不创建 squad 行、也没有 agent 数下限** → 这条路现成可用。

员工粒度索引放在 **jin 自己的新模块**,纯加法。

---

## 相关

- 迁移:`packages/db/src/migrations/0152_agent_templates.sql`;不变量对账:`packages/db/src/verify/verify_0152.sql`
- 常量/枚举单一真相:`packages/shared/src/constants.ts`(值必须与 `0152` 的 CHECK 约束一致)
- 前端招聘市场 UI:JIN-68
