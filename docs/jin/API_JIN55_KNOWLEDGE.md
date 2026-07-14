# JIN-55 · 知识库 RAG(按员工引用开关)+ 方法包 skills

小镜 fork 自有接口面,不进 Paperclip 的公开 OpenAPI 文档(理由同 JIN-52 / 54 / 56:
塞进 `openapi.ts` 会让每次 upstream 合并都在那个文件上打架)。

鉴权:所有接口一律 `assertCompanyAccess` —— agent key 只能碰自己所属公司的知识库。

---

## 一、核心设计:引用开关焊在 SQL 里

产品要求「同一条收藏,选题策划师 ✅、文案编导 ✅、合规审稿员 ✅、账号诊断师 ❌」——
权限粒度到 **(收藏项 × AI员工)**。

**授权解析式**(0148 已建好的数据模型):

```
allowed = COALESCE(collection_citation_grants.allowed, collection_items.default_citable)
```

即 **「默认开关 + 例外行」**:授权表只存「和默认不同」的那几行,所以它始终很小
(产品里「账号诊断师不可引用」就只是一行),既不用在加员工时回填全部历史条目,
也不用在加收藏时回填全部员工。

**这个条件写在 `retrieve()` 的 `WHERE` 里,不是查回来再 filter。**
差别在于:后者只要有人多写一条 code path(管理员预览、批量导出),就会绕过 filter 把关掉的条目泄出去。
焊在取数那一层,新增的调用方想泄漏都泄漏不了。

**检索接口的 `agentId` 是必填的** —— 「以谁的身份检索」决定能看到哪些条目。
没有「不指定员工、看全部」的口子,那个口子等于把开关绕过去。

## 二、向量层:为什么不是 pgvector

本仓库跑 embedded postgres,机器上**没有 `vector.control`** —— `CREATE EXTENSION vector` 会直接失败,
CI 和本地全红。所以:

- 向量落成原生 `real[]`,**写入侧 L2 归一化** → 检索侧的余弦退化成**点积**
- 排序在应用层做。候选集先被 `company + 未删除 + 有向量 + 可引用` 四道条件砍过,
  当前规模(单公司百~千 chunk)是亚毫秒级
- 候选集上限 5000 chunk,**打满会 `logger.warn`**(不静默截断 —— 静默截断读起来像「全覆盖」,其实不是)
- 换 pgvector / 外部向量库时,只有 `knowledge_chunks` 的读写实现要动,`retrieve()` 的调用方一行都不用改

## 三、embedding provider

⚠️ 走 GLM 的**原生 OpenAI 端点** `GLM_OPENAI_BASE_URL`(`/api/paas/v4`),
**不是** Anthropic 兼容端点 —— 兼容端点会静默丢内容并瞎编,而且它根本没有 `/embeddings`。

| provider | 何时用 | 说明 |
|---|---|---|
| `glm` | 配了 `GLM_OPENAI_API_KEY` | `embedding-3`,1024 维,真花钱 |
| `deterministic` | CI / 本地 / 没 key | hashed 字符 n-gram,不联网,同文本永远同向量 |

`deterministic` 不是凑合,是必需的:CI 里没有 GLM key(仓库是公开的,也不该有),
而「按员工的引用开关」是**检索层**的语义,它的正确性不该依赖某个模型的权重。
用确定性向量恰恰能把开关测死 —— 向量一样,唯一的变量就是开关。

provider 名字会如实记进 `collection_item_index_state.embedding_model`,不假装自己用的是真模型。

**key 一律读环境变量,绝不硬编码**(仓库公开,推送保护会拦)。

---

## 四、接口

### 知识库

#### `GET /api/companies/:companyId/knowledge/search`

以某个 AI 员工的身份检索。**★ 引用开关在这里生效。**

查询参数:

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | ✅ | 检索词 |
| `agentId` | ✅ | 以哪个 AI 员工的身份检索 |
| `topK` | | 默认 5,上限 20 |
| `douyinAccountId` | | 限定某个抖音账号的知识范围 |

```jsonc
{
  "query": "离婚财产分割",
  "agentId": "…",
  "embeddingModel": "embedding-3",
  "citations": [
    { "itemId": "…", "chunkId": "…", "title": "离婚财产分割案例",
      "snippet": "高净值客户离婚财产分割:婚前财产认定…", "score": 0.82, "tags": ["离婚", "金牌素材"] }
  ]
}
```

一条 item 只出一个最佳 chunk —— 否则一篇长文档能把 top-K 全占满,别的资料一条都进不去。
低于 0.05 分的召回直接丢掉:宁可不给,也不要塞不相干的东西进 prompt 误导模型。

#### `POST /api/companies/:companyId/knowledge/items/:itemId/index`

(重新)索引一条收藏。Body:`{ "force": false }`。

幂等:原文哈希没变就 `skipped`,不重复烧 embedding 的钱。`force=true` 强制重算(换模型时用)。

**索引失败返回 502**(不是 200)—— 否则用户以为资料已经入库了。失败原因写进
`collection_item_index_state.error`,不吞。原文 chunk 不删:一次 429 不该让用户重新上传资料。

#### `POST /api/companies/:companyId/knowledge/reindex`

批量补索引,返回 `{ total, indexed, skipped, failed, results }`。

#### `GET /api/companies/:companyId/knowledge/items/:itemId/grants`

一条收藏 × 全公司 AI 员工的**生效**引用矩阵 —— 原型里那一列勾选框读的就是它。

```jsonc
{
  "itemId": "…",
  "defaultCitable": true,
  "agents": [
    { "agentId": "…", "agentName": "选题策划师", "explicit": null,  "effective": true  },
    { "agentId": "…", "agentName": "账号诊断师", "explicit": false, "effective": false }
  ]
}
```

`explicit` 和 `effective` 都要给:UI 才能区分「默认开着」和「显式打开」——
后者用户关掉时要删例外行,前者要新建一条 `allowed=false`。

#### `PUT /api/companies/:companyId/knowledge/items/:itemId/grants/:agentId`

拨开关。Body:`{ "allowed": true | false | null }`。`null` = **删掉例外行,回落到条目默认值**。

**开关不重新索引、不删向量** —— 它是读侧的授权,和向量无关。
「关掉就删向量」会有两个后果:再打开要重新烧钱,而且别的员工也跟着检索不到了。

### 方法包

方法包 = `company_skills` 里带 `method:<category>` 分类的 skill。**零新表。**

| 分类 | 展示名 |
|---|---|
| `platform_method` | 平台方法 |
| `exclusive_method` | 专属方法 |
| `compliance_rule` | 合规规则 |

- `GET    /api/companies/:companyId/method-packs?category=&agentId=` —— 带 `agentId` 时返回每个包的绑定状态
- `POST   /api/companies/:companyId/method-packs` —— 建包 + 首版打标签(`versionLabel: "v2.1"`)
- `GET    /api/companies/:companyId/method-packs/:id/versions` —— 版本历史
- `POST   /api/companies/:companyId/method-packs/:id/versions` —— 发新版
- `PUT    /api/companies/:companyId/method-packs/:id/bindings` —— 绑定到员工(`versionId` 不传 = 跟随最新版;传了 = 钉死这一版)
- `DELETE /api/companies/:companyId/method-packs/:id/bindings/:agentId` —— 解绑

**⚠️ 两个上游的坑(都被测试逮到了,改动别绕过去):**

1. **分类必须写进 SKILL.md 的 frontmatter,不能只写 DB。**
   skills 系统把 SKILL.md 当分类的唯一真相:`updateFile` / `ensureSkillInventoryCurrent`
   每次都从 frontmatter 重新推导 `categories` 并覆盖 DB 那一列。只写 DB 的话,
   **发一次新版分类就被清空,方法包直接从列表里消失。**

2. **`createLocalSkill` 和 `updateFile` 都会自己顺手发一版。**
   再调 `createVersion` 就会凭空多出一版(revision 直接跳到 3)。
   正确做法:把它们刚发的那一版**重新打标签**。

另外方法包的名字基本全是中文,而上游 slug 是 ASCII-only —— 中文名 normalize 完是空串,
所有方法包都会回落到同一个字面量 slug `"skill"`,**第二个开始必然 409**。
所以 `methodPackSlug()` 显式兜底:能 ASCII 化就 ASCII 化,不能就用名字的 sha256 前 8 位。

---

## 五、运行期注入

知识库召回走 **task markdown**(`buildPaperclipTaskMarkdown` 的 `knowledgeCitations`),
和 JIN-50 的反馈笔记同一个位置、同样的三个理由:

1. 所有 adapter 都通过 `joinPromptSections` 渲染 `paperclipTaskMarkdown` → **零 adapter 改动**
2. 它是 per-run 上下文,位于可缓存系统前缀之后 → **不击穿 prompt caching**(硬约束)
3. 续跑会抑制 `instructionsPrefix` / `renderedPrompt`,但 task markdown 照常带上

query = issue 的标题 + 描述。召回失败(provider 欠费 / 限流)**不拖垮 run** —— 知识库是增强项。

**方法包的运行期注入,本 issue 一行代码都没碰** —— 因为绑定写的就是 skills 系统那份
`agents.adapter_config.paperclipSkillSync.desiredSkills`,heartbeat 的
`listRuntimeSkillEntries` → adapter 的 `promptInstructions` 链路照常生效。这正是复用而非重造的收益。
