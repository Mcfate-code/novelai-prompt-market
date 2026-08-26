#!/usr/bin/env sh
# start-nai.sh — 启动 NovelAI 官方 API 联动层（Node 8787）
#   ./start-nai.sh   默认：启动 Node 服务（官方 API-only，无需 Edge / CDP / 浏览器登录）
set -eu
cd "$(dirname "$0")"

NODE="${NODE_BIN:-}"
WORKBUDDY="${WORKBUDDY_HOME:-$HOME/.workbuddy}"
if [ -z "$NODE" ] && [ -x "$WORKBUDDY/binaries/node/versions/22.12.0/bin/node" ]; then
  NODE="$WORKBUDDY/binaries/node/versions/22.12.0/bin/node"
fi
if [ -z "$NODE" ]; then
  NODE="$(command -v node || true)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "❌ 未找到 Node.js 22.5+。可通过 NODE_BIN 指定可执行文件。" >&2
  exit 1
fi

echo "🚀 启动 NovelAI 联动层（8787，官方 API-only）…"
NODE_MODULES="$WORKBUDDY/binaries/node/workspace/node_modules"
exec env NODE_OPTIONS= NODE_PATH="$NODE_MODULES" "$NODE" --experimental-sqlite server.mjs --port 8787
