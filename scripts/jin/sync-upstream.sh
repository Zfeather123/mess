#!/usr/bin/env bash
# 同步 upstream(paperclipai/paperclip)到本 fork。
# 用法:./scripts/jin/sync-upstream.sh [--no-verify]
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "==> 添加 upstream remote"
  git remote add upstream https://github.com/paperclipai/paperclip.git
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区不干净,先提交或 stash。" >&2
  exit 1
fi

echo "==> fetch upstream"
git fetch upstream master

echo "==> 更新镜像分支 origin/master"
git push origin "upstream/master:master"

BRANCH="sync/upstream-$(date +%Y%m%d)"
echo "==> 在 $BRANCH 上把 upstream/master 合进 main"
git checkout main
git pull --ff-only origin main
git checkout -b "$BRANCH"

if ! git merge --no-edit upstream/master; then
  echo ""
  echo "❌ 合并冲突。冲突文件:"
  git diff --name-only --diff-filter=U
  echo ""
  echo "提醒:冲突应该只出现在我们改过的 upstream 文件上(目前只有 .env.example)。"
  echo "如果冲突面在扩大,说明违反了「只做加法」——见 docs/jin/UPSTREAM.md。"
  exit 1
fi

if [ "${1:-}" != "--no-verify" ]; then
  echo "==> 验证:install / typecheck / build"
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm build
fi

echo ""
echo "✅ 合并干净且验证通过。推分支并开 PR:"
echo "   git push -u origin $BRANCH && gh pr create --base main"
