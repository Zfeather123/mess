# 与 upstream 保持可合并

Paperclip 迭代极快(6 周 7.3 万星)。fork 一旦漂太远,后面每次合并都是灾难。这里是硬规矩。

## 仓库

**`Zfeather123/multi-lawmcn`** 是唯一的正式仓库。

## 分支模型

```
paperclipai/paperclip  ──►  origin/master   (upstream 镜像,我们不写代码)
                                  │ merge
                                  ▼
                            origin/main     (我们的默认分支,业务代码在这)
                                  ▲
                                  │ PR(--allow-unrelated-histories)
                      feat/jin-58-desktop-shell  (Tech Lead 的绿地工程,历史与 main 无关)
```

`main` 是**用 `git branch main upstream/master` 种下来的,带完整 git 历史**(3067 个 commit),`git merge-base --is-ancestor upstream/master main` 成立 —— 这是 `git merge upstream/master` 能一直跑下去的前提。
**永远不要用 tarball / squash 的方式重建 `main`**:历史一断,「对 upstream 只做加法」这个性质就静默报废了,没人会收到报错,只是从此再也合不回去。

## 四条硬规矩

1. **只做加法。** 新功能 = 新文件 / 新目录 / 新表 / 新迁移。
2. **不改 Paperclip 原有文件**,除非没有别的办法。必须改时,改动要小、要集中,并在 PR 里说明「为什么没法用加法做」。
3. **不删 Paperclip 的模块。** 要关掉的东西用运行时禁用(见 [PAPERCLIP-TRIMMING.md](./PAPERCLIP-TRIMMING.md))。
4. **不引新的全局工具链**(ESLint / Biome / 换包管理器 / 换构建工具)——这类改动会污染每一个文件,合并时寸步难行。

我们自己的东西一律带前缀,一眼能认出来、合并时永不冲突:

- 文档 → `docs/jin/`
- 脚本 → `scripts/jin/`
- 流水线 → `.github/workflows/jin-*.yml`
- 部署 → `deploy/`
- 代码包 → `packages/jin-*`

目前对 upstream 原有文件的改动**只有两处**,都是纯追加:

| 文件 | 改动 |
|---|---|
| `.env.example` | 末尾追加我们的变量段 |
| `README.md` | 顶部加 3 行 fork 说明,原文保留不动 |

冲突了也是 30 秒的事。**这个清单要一直保持这么短。**

## 同步流程

```bash
./scripts/jin/sync-upstream.sh          # 拉 upstream/master → 更新 origin/master → 试合并到 main
```

脚本做的事:

1. `git fetch upstream`
2. 把 `upstream/master` 推到 `origin/master`(镜像分支保持最新)
3. 在 `sync/upstream-<日期>` 分支上把 `upstream/master` merge 进 `main`
4. 跑 `pnpm install` + `typecheck` + `build`,绿了再让你开 PR

**冲突了怎么办**:冲突基本只会出现在我们改过的 upstream 文件上(现在只有 `.env.example`)。如果发现冲突范围在扩大,说明我们违反了「只做加法」——停下来重构,别硬解。

## 节奏

建议**每两周**同步一次。间隔越长,一次要吃的 diff 越大,痛感是超线性增长的。
