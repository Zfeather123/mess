# 环境变量规范

模板见根目录 [`.env.example`](../../.env.example)。分三层:**Paperclip 原有** / **模型层(GLM)** / **业务层(抖音·计费·品牌)**。

## 1. 基础(Paperclip 原有)

| 变量 | 必填 | 示例 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | ✅ | `postgres://paperclip:paperclip@localhost:15432/paperclip` | 用内嵌 PG 时可不填(config.json 里设 `embedded-postgres`) |
| `PORT` | | `3100` | |
| `SERVE_UI` | | `true` | 生产镜像里由 server 直接托管前端 |
| `BETTER_AUTH_SECRET` | ✅ | 随机 32+ 位 | **生产必须换掉,不能用 dev 值** |
| `PAPERCLIP_PUBLIC_URL` | 生产 ✅ | `https://…` | 回调/邮件里的绝对地址 |
| `PAPERCLIP_HOME` | | `~/.paperclip` | 实例配置 / 本地存储根目录 |

## 2. 模型层(GLM 直连 —— 不要引翻译网关)

```bash
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
ANTHROPIC_API_KEY=<GLM key>
```

接入方式就是改这两个环境变量,**不要加翻译网关**(网关会静默丢掉 prompt caching / 上下文压缩)。

已验证:文字工具调用 ✅、多轮工具往返 ✅、**prompt caching 生效**(实测 input 1223 → 71,省 94%)、thinking 原生支持 ✅;`context_management` 会被静默忽略,别依赖。

### ⚠️ 视觉必须走工具,不能走消息流

**实测:GLM 的 Anthropic 兼容端点会静默丢弃图片并瞎编内容(不报错)。** 同一张图,原生 OpenAI 端点 5/5 满分,Anthropic 端点 0/5。所以视觉能力单独配一套**原生端点**变量:

| 变量 | 示例 | 用途 |
|---|---|---|
| `GLM_OPENAI_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | GLM **原生 OpenAI 端点**,视觉工具专用 |
| `GLM_OPENAI_API_KEY` | `<GLM key>` | 通常和上面同一把 key |
| `GLM_VISION_MODEL` | `glm-4.6v` | `read_image()` —— 读图,实测满分 |
| `GLM_IMAGE_MODEL` | `cogview-4` | `generate_image()` —— **只出底图,别让它写字** |

`compose_cover()` **不调模型**,用代码渲染精确中文标题(CogView 写中文全是乱码)。字体路径:

| 变量 | 示例 |
|---|---|
| `JIN_COVER_FONT_PATH` | `/app/assets/fonts/SourceHanSansSC-Bold.otf` |

## 3. 抖音数据(TikHub)

| 变量 | 说明 |
|---|---|
| `TIKHUB_API_KEY` | 服务端 token,**不碰用户抖音登录态**,无爬虫、无封号风控 |
| `TIKHUB_BASE_URL` | 默认 `https://api.tikhub.io` |

## 4. 算力计费

| 变量 | 默认 | 说明 |
|---|---|---|
| `JIN_PRICE_CNY_PER_1M_TOKENS` | `5` | **1M token = 5 元**,写成配置项,后续会调 |
| `JIN_CREDITS_ENFORCE` | `true` | 余额不足是否拦截 |

## 5. 品牌占位

| 变量 | 默认 |
|---|---|
| `JIN_BRAND_NAME` | `Jin Studio`(待定) |
| `JIN_BRAND_PRIMARY_COLOR` | `#18181b` |

见 [BRANDING.md](./BRANDING.md)。

## 6. 密钥怎么放

- 本地:`.env`(已在 `.gitignore` 里)
- 生产:走 CI/CD 的 secret store 注入,**不要提交任何真实 key**;Paperclip 自带 `local_encrypted` secrets provider(`PAPERCLIP_SECRETS_PROVIDER` / `PAPERCLIP_SECRETS_MASTER_KEY_FILE`),生产建议开 `strictMode`。
