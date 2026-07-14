# Paperclip 裁剪评估

**结论先说:`packages/adapters` 和 `cli` 不要物理删除,用 Paperclip 自带的「禁用 + 外部 adapter 注册」机制把它们关掉。**
删是能删,但代价远大于收益 —— 下面是数据。

## 1. 为什么不删(实测耦合度)

任务里写的是「我们不需要 daemon/runtime/adapter 层,评估能不能安全摘掉」。摘之前先量了一下耦合:

| 包 | 谁依赖它 | server/src 里的 import 点 |
|---|---|---|
| `@paperclipai/adapter-utils` | server / ui / cli | **43** |
| `adapter-opencode-local` | server / ui / cli | 23 |
| `adapter-codex-local` | server / ui / cli | 18 |
| `adapter-claude-local` | server / ui / cli | 14 |
| `adapter-cursor-local` | server / ui / cli | 13 |
| `adapter-gemini-local` | server / ui / cli | 10 |
| 其余 5 个 adapter | server / ui / cli | 14 |

**adapters 不是可插拔的边缘模块,它被 server 和 ui 双向写死引用**(`server/src/adapters/registry.ts` 静态 import 全部 11 个;`ui/package.json` 也全量依赖)。

物理删除意味着:
- 改 `server/src/adapters/registry.ts`、`ui` 的 adapter 配置面板、`cli` —— **135+ 个 import 点**,全在 Paperclip 迭代最频繁的核心文件里
- 每次 merge upstream 都要在同样的文件上重新解一遍冲突
- 换来的只有:少装几个 npm 包、镜像小几十 MB

Paperclip 6 周 7.3 万星、迭代极快。**为了几十 MB 去动它的核心注册表,是拿未来每一次 upstream 合并的痛去换一次性的整洁,不划算。**

## 2. 正确的做法:用它自带的两个官方缝

翻源码发现 Paperclip 已经把这个场景做好了(`adapter-plugin.md` + `server/src/adapters/registry.ts`):

| 能力 | API | 我们怎么用 |
|---|---|---|
| **注册外部 adapter** | `registerServerAdapter(adapter)` / `unregisterServerAdapter(type)` / `requireServerAdapter(type)`(registry 是可变 map) | 自研执行层注册成一个外部 adapter,**核心文件零改动** |
| **禁用内置 adapter** | `getDisabledAdapterTypes()`(`server/src/services/adapter-plugin-store.ts`) | 把 11 个内置 adapter 全部禁用,UI 里就不会出现「Claude Local / Codex …」这些用户看不懂的选项 |

也就是说:**代码留着、依赖留着、运行时关掉**。upstream diff = 0,我们的执行层作为纯新增模块挂上去。

这同时也把「MVP 纯 Web、二期加桌面客户端」的可插拔 executor 要求落到了实处 —— 二期的桌面 executor 就是**再注册一个 adapter**,不用重构。

## 3. 模块逐个清单

### ✅ 直接复用(不动)

| 模块 | 对应我们的产品功能 |
|---|---|
| `packages/db`(99 schema / 146 迁移 / 125 表) | 协作层数据底座(见 JIN-50) |
| `agents` / `agent_config_revisions` | AI 员工 + 配置版本化 |
| `user` / `session` / `company_memberships` / `project_memberships` / `principal_permission_grants` | 多真人协作 + 权限 |
| `cases` / `pipelines` / `pipeline_stages` | 今日任务 |
| `approvals` / `approval_comments` | 文案待确认(审批) |
| `budget_policies` / `spent_monthly_cents` | 算力计费底座(见 JIN-51) |
| `activity_log` / `agent_task_sessions` | 工作记录 |
| `packages/teams-catalog` | 招聘(预制团队模板) |
| `packages/skills-catalog` | 方法包 |
| `packages/shared` | 前后端共用类型 |
| `server/` + `ui/`(含 i18n,已有中文 locale) | 主体 |
| `Dockerfile` / `docker/` | 容器化,基本现成 |

### 🔇 保留但运行时禁用(**不删**)

| 模块 | 处理 |
|---|---|
| `packages/adapters/*`(11 个) | `getDisabledAdapterTypes()` 全禁;依赖留在 `package.json` 里,保证 upstream 可合并 |
| `cli/`(本地 CLI / daemon) | 不部署、不进生产镜像、CI 不跑它的发布链路。留在仓库里当死代码,成本几乎为零 |
| `packages/plugins/sandbox-providers`、`evals/`、`releases/`、`report/` | 同上,不用不删 |
| upstream 的 9 个 workflow | **全部绑在 `master` 或 `workflow_dispatch` 上**,我们的默认分支是 `main`,天然不会触发,不用删 |

### ➕ 我们要新增(纯加法)

| 新增 | 落点 |
|---|---|
| 自研执行层 executor(GLM 直连) | 注册成外部 adapter,新目录 `packages/jin-executor`(待 JIN-51) |
| 视觉三工具(`read_image` / `generate_image` / `compose_cover`) | 同上,走 GLM 原生 OpenAI 端点 |
| 小队 + 队长路由 / 账号档案 / IM / 收藏 / 朋友圈 / 算力账户 | 新 schema 文件 + 新迁移(见 JIN-50) |
| 品牌资产 | 见 BRANDING.md,用可重放脚本,不手改 upstream 文件 |

## 4. 什么时候可以真删

只有当以下**同时**成立时,再回头考虑物理删除:

1. 我们的 executor 已经稳定跑在生产,确认永远不需要 Paperclip 的任何内置 adapter;
2. 决定**不再跟 upstream 合并**(彻底分叉);
3. 镜像体积 / 依赖攻击面成为实际瓶颈(有数据,不是感觉)。

在那之前:**关掉,不删掉。**
