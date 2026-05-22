#!/bin/bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-root@walletaa.com}"
REMOTE_DIR="${REMOTE_DIR:-/root/ZKBuy}"
# 同步后远程只装依赖，不 build、不启动；你在服务器上自己 npm run dev
REMOTE_NPM_CI="${REMOTE_NPM_CI:-1}"
# 若用 pm2 托管 dev，可设: REMOTE_RESTART='pm2 restart zkbuy'
REMOTE_RESTART="${REMOTE_RESTART:-}"

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

print_git() {
    local label="$1"
    local dir="$2"
    if git -C "$dir" rev-parse --is-inside-work-tree &>/dev/null; then
        echo "📌 ${label}: $(git -C "$dir" log -1 --format='%h %s (%ci) [%D]')"
    else
        echo "⚠️  ${label}: 无 git 仓库"
    fi
}

print_git "本地（同步前）" "$LOCAL_DIR"

DEPLOY_COMMIT="$(git -C "$LOCAL_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DEPLOY_MSG="$(git -C "$LOCAL_DIR" log -1 --format='%s' 2>/dev/null || echo '')"
DEPLOY_DATE="$(git -C "$LOCAL_DIR" log -1 --format='%ci' 2>/dev/null || echo '')"

echo ""
echo "🚀 同步 ${LOCAL_DIR}/ → ${REMOTE_HOST}:${REMOTE_DIR}/"
rsync -avz --progress --delete \
    --exclude='node_modules' \
    --exclude='.next' \
    "${LOCAL_DIR}" \
    "${REMOTE_HOST}:${REMOTE_DIR}/"
