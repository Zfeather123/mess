# 部署骨架

Paperclip 自带的 `Dockerfile`(多阶段,node:lts-trixie-slim)是**能直接用**的,我们不重写,只在外面套一层部署编排。

## 单机 / 预发

```bash
cd deploy
cp .env.example .env      # 填 POSTGRES_PASSWORD / BETTER_AUTH_SECRET / ANTHROPIC_API_KEY
docker compose up -d --build
curl -fsS localhost:3100/api/health
```

> **国内 build 慢**(卡在 `apt-get` 从 `deb.debian.org` 拉包)就在 `.env` 里设
> `DEBIAN_MIRROR=mirrors.aliyun.com`(或 `mirrors.ustc.edu.cn`)换 Debian apt 源;
> 留空则用官方源(海外/CI 默认,行为不变)。裸 `docker build` 时用
> `--build-arg DEBIAN_MIRROR=mirrors.aliyun.com`。

三个服务:

| 服务 | 说明 |
|---|---|
| `db` | Postgres 17,带 healthcheck,数据在具名 volume |
| `migrate` | **一次性容器**:server 起来之前先把迁移跑完,跑完退出 |
| `server` | 应用本体(server + 托管前端),依赖 migrate 成功完成 |

**为什么单拆一个 migrate 容器**:多副本部署时如果每个副本都在启动时跑迁移,会并发抢锁 / 半成品状态。迁移必须是一次性的、部署前置的、幂等的。这是后面上 K8s 时也要保持的形状(migrate = Job / initContainer)。

## 健康与回滚

- `server` 有 healthcheck(`/api/health`,60s start_period);编排层据此判断是否切流量
- 日志滚动已配(json-file,10m × 3),避免磁盘被日志打满
- **回滚 = 换镜像 tag 重启**。迁移是只增不改的(`check:migrations` 强制),所以回滚应用不需要回滚数据库

## CI 里的 docker lane

`.github/workflows/jin-ci.yml` 的 `docker` job 每个 PR 都构建一次镜像(带 GHA layer cache,不推送)。目的:**镜像构建失败要在 PR 就发现,而不是发版时**。

## 还没做(下一步)

这一版只到「能起、能健康检查、能回滚」。以下是明确的欠账,等有真实环境和流量了再补,别提前造:

- [ ] 镜像推到 registry + 按 tag 发布(等确定了云厂商)
- [ ] 蓝绿 / 金丝雀发布(等有生产环境)
- [ ] Prometheus 指标 + 黄金信号看板(延迟 / 流量 / 错误 / 饱和度)
- [ ] SLO 与错误预算(建议起步:可用性 99.9%,p95 延迟;先测量,再定目标)
- [ ] 备份自动化(pg_dump 定时 + 恢复演练 —— **没演练过的备份等于没有备份**)
