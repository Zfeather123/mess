# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/billing/package.json packages/billing/
COPY packages/gateway/package.json packages/gateway/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/hermes/package.json packages/adapters/hermes/
COPY packages/adapters/hermes-gateway/package.json packages/adapters/hermes-gateway/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
# 小镜桌面客户端(JIN-58)。这些 manifest 必须复制进来 —— 不是因为服务端镜像要跑桌面端,
# 而是因为 pnpm install --frozen-lockfile 需要**所有** workspace 包的 manifest 才能校验
# lockfile;少一个就直接失败。scripts/check-docker-deps-stage.mjs 守的就是这条。
COPY apps/desktop/package.json apps/desktop/
COPY apps/xiaojing-ui/package.json apps/xiaojing-ui/
COPY packages/xiaojing-agent-runtime/package.json packages/xiaojing-agent-runtime/
COPY packages/xiaojing-executor/package.json packages/xiaojing-executor/
COPY packages/xiaojing-protocol/package.json packages/xiaojing-protocol/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

# 服务端镜像永远不会运行 Electron,但装 @xiaojing/desktop 的依赖时 electron 的
# postinstall 会去下一个 ~100MB 的二进制 —— 白白撑大镜像,还给构建加了一个会 flake
# 的外网依赖。打包桌面端时 electron-builder 会自己下 dist,不靠这个 postinstall。
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# 桌面端的包**只复制 manifest、不装依赖**。
#
# 为什么 manifest 必须在:pnpm install --frozen-lockfile 要拿全部 workspace manifest
# 才能校验 lockfile(check-docker-deps-stage.mjs 守的就是这条)。
# 为什么依赖不能装:服务端镜像根本不跑桌面端,而 @xiaojing/agent-runtime 依赖的
# @anthropic-ai/claude-agent-sdk@0.3.209 会拖进 248MB(glibc)+243MB(musl)的原生
# 二进制 —— 而且和 upstream 已有的 0.3.191 是**两份**,不去重。实测会让生产镜像
# 凭空胖 ~491MB。
# --filter='!@xiaojing/*' 之后:35 个项目 → 30 个,server/ui/cli/root 一个不少。
RUN pnpm install --frozen-lockfile --filter='!@xiaojing/*'

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
