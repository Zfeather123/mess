# 上手指南(30 分钟跑起来)

> 本文所有命令都在 Ubuntu(WSL2)/ Node 24.14 / pnpm 9.15.4 上**实测跑通过**,时间是实测耗时。
> 遇到和本文不一致的现象,先看最后一节「已知坑」。

## 0. 前置

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node | **>= 20**,建议 24 | `package.json` engines 要求 |
| pnpm | **9.15.4**(精确) | 仓库 `packageManager` 锁定,用 `corepack enable` 装 |
| Docker | 任意近期版本 | 只用来跑 Postgres(也可用内嵌 PG,见 §2 方案 B) |

```bash
corepack enable && corepack prepare pnpm@9.15.4 --activate
```

## 1. 拉代码 + 装依赖(约 2 分钟)

```bash
git clone https://github.com/Zfeather123/mess.git
cd mess
git remote add upstream https://github.com/paperclipai/paperclip.git   # 保持可合并,见 UPSTREAM.md

pnpm install --frozen-lockfile   # 实测 2m17s,1256 个包
```

安装尾部会打印几条 `WARN Failed to create bin at .../paperclip-plugin-dev-server`,**这是正常的**(plugin-sdk 还没 build,bin 软链先失败),不影响后续步骤。

## 2. 起数据库

### 方案 A(推荐):Docker Postgres

```bash
docker run -d --name jin-pg \
  -e POSTGRES_USER=paperclip -e POSTGRES_PASSWORD=paperclip -e POSTGRES_DB=paperclip \
  -p 15432:5432 postgres:17-alpine
```

> 端口用 15432 而不是 5432,避免和机器上其他项目的 PG 撞端口。

### 方案 B:内嵌 Postgres(不装 Docker)

Paperclip 自带 `embedded-postgres`,把 §3 的配置文件里 `"database": { "mode": "embedded-postgres" }` 即可,不用起容器,也不用设 `DATABASE_URL`。

## 3. 配环境

```bash
cp .env.example .env       # 按 docs/jin/ENV.md 填 GLM / TikHub 的 key
export DATABASE_URL=postgres://paperclip:paperclip@localhost:15432/paperclip
export PAPERCLIP_HOME=$HOME/.paperclip
```

Paperclip 除了 `.env` 还有一份**实例配置文件**,首次要生成:

```bash
mkdir -p "$PAPERCLIP_HOME/instances/default"
cat > "$PAPERCLIP_HOME/instances/default/config.json" <<'EOF'
{
  "$meta": { "version": 1, "updatedAt": "2026-01-01T00:00:00.000Z", "source": "onboard" },
  "database": { "mode": "database-url" },
  "logging":  { "mode": "file" },
  "server":   { "deploymentMode": "local_trusted", "host": "127.0.0.1", "port": 3100 },
  "auth":     { "baseUrlMode": "auto" },
  "storage":  { "provider": "local_disk" },
  "secrets":  { "provider": "local_encrypted", "strictMode": false }
}
EOF
```

## 4. 跑迁移(约 30 秒)

```bash
pnpm db:migrate
# Applying 146 pending migration(s)... Migrations complete
```

实测建出 **125 张表**。迁移是 drizzle,文件在 `packages/db/src/migrations/*.sql`。

| 命令 | 作用 |
|---|---|
| `pnpm db:generate` | 改完 `packages/db/src/schema/*.ts` 后生成新迁移 SQL |
| `pnpm db:migrate` | 应用未执行的迁移 |
| `pnpm --filter @paperclipai/db seed` | 灌种子数据 |

> ⚠️ 迁移**只能加新文件,不能改历史文件**——`check:migrations` 会校验编号连续性和安全性,改历史直接红。

## 5. 起服务

```bash
pnpm dev          # 一把起 server + ui(watch 模式)
# 或者分开:
pnpm dev:server   # 只起 server(tsx 直跑 TS)
pnpm dev:ui       # 只起 ui(vite)
```

验证:

```bash
curl -s localhost:3100/api/health
# {"status":"ok","version":"2026.707.0+...","deploymentMode":"local_trusted","authReady":true,...}
```

## 6. 跑测试 / 构建

```bash
pnpm test:run                  # 全量(很重,CI 里是分片跑的)
pnpm test:run:general          # 一般用例
pnpm test:run:serialized       # 必须串行的 server 用例
npx vitest run packages/db packages/shared   # 只跑某几个包(实测 45 文件 / 319 用例全绿,2 分钟)

pnpm typecheck                 # 类型检查
pnpm build                     # 全量构建(实测 ~4 分钟,ui + server + cli 都产出 dist)
```

**没有 ESLint / Biome**——Paperclip 不做 lint,靠 `typecheck` + 一组策略脚本(`check:tokens` / `check:no-git-push` / `check-docker-deps-stage`)把关。我们的 CI 沿用同一套,别自己加 lint 工具(会和 upstream 冲突,见 UPSTREAM.md)。

## 7. 仓库地图

| 目录 | 是什么 | 我们怎么用 |
|---|---|---|
| `server/` | Hono HTTP server + 路由 + services + realtime | **主战场** |
| `ui/` | React 19 + Vite + Tailwind,含 i18n(有中文 locale) | **主战场** |
| `packages/db/` | drizzle schema(99 个 schema 文件)+ 146 个迁移 | **主战场** |
| `packages/shared/` | 前后端共用类型 / zod schema | 复用 |
| `packages/adapters/*` | 11 个执行层 adapter(claude-local / codex-local / …) | **不用,但别删**(见裁剪评估) |
| `packages/plugins/sdk` | 插件 SDK,可注册**外部 adapter** | **我们自研 executor 的挂载点** |
| `packages/teams-catalog` | 预制团队模板 | 「招聘」功能直接用 |
| `packages/skills-catalog` | 技能包 | 「方法包」直接用 |
| `cli/` | 本地 CLI / daemon | **不用,但别删** |
| `docker/`, `Dockerfile` | 已经现成的容器化 | 直接用,见 DEPLOY.md |

## 8. 已知坑(踩过了,别再踩)

1. **`node server/dist/index.js` 起不来** —— 报 `ERR_MODULE_NOT_FOUND: packages/db/src/client.js`。
   原因:workspace 里 `@paperclipai/db` 的 `exports` 指向 `src/*.ts`(只有发布时才走 `dist`),纯 node 解析不了 TS。
   **本地一律用 `pnpm dev` / `pnpm dev:server`(tsx 直跑),生产用 Docker 镜像**(镜像里做了 deploy 剪枝,没这个问题)。
2. **没有 config.json 就起不来** —— 必须先生成 §3 那份实例配置。
3. **`pnpm-lock.yaml` 不要手改** —— upstream 的策略脚本会拒绝,我们的 CI 也沿用。改了 `package.json` 后跑 `pnpm install --lockfile-only` 让工具生成。
4. **端口冲突** —— 机器上如果跑着别的项目的 PG,5432/5433 大概率被占,用 15432。
