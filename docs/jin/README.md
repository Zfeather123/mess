# 小镜(仓库:Zfeather123/mess)

面向律师 / 自媒体创作者的 **AI 团队协作 App**:微信式群聊界面,用户 + 一队 AI 员工(账号主理人 / 档案管家 / 账号诊断师 / 选题策划师 / 文案编导 / 合规审稿员)+ 真人协作者,一起做抖音内容运营。

本仓库 fork 自 [paperclipai/paperclip](https://github.com/paperclipai/paperclip)(MIT),作为协作底座。

## 文档索引

| 文档 | 内容 |
|---|---|
| [ONBOARDING.md](./ONBOARDING.md) | **《上手指南》** — 30 分钟本地跑起来(实测过的命令) |
| [PAPERCLIP-TRIMMING.md](./PAPERCLIP-TRIMMING.md) | **《Paperclip 裁剪评估》** — 哪些模块要 / 不要 / 能不能摘 |
| [UPSTREAM.md](./UPSTREAM.md) | 与 upstream 保持可合并的规矩 + 同步流程 |
| [BRANDING.md](./BRANDING.md) | 去品牌化方案(可重放脚本,不手改) |
| [DEPLOY.md](./DEPLOY.md) | Docker 化与部署骨架 |
| [ENV.md](./ENV.md) | 环境变量规范(GLM / TikHub / DB / 计费) |

## 分支模型

- `master` — **upstream 镜像**,只跟 `paperclipai/paperclip` 同步,我们不在上面写代码
- `main` — **我们的默认分支**,所有业务代码在这里

upstream 的 CI 全部绑定在 `master`(或 `workflow_dispatch`)上,因此不会在我们的 `main` PR 上误触发;我们自己的流水线是 `.github/workflows/jin-ci.yml`。
