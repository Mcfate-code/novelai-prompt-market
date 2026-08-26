#!/bin/zsh
# start-nai.sh — 启动 NovelAI 联动环境
#   ./start-nai.sh --login   GUI 模式（首次登录 NovelAI 用，登录后关闭窗口）
#   ./start-nai.sh           默认：headless 后台模式 + Node 联动层(8787)
set -e
cd "$(dirname "$0")"

EDGE="${EDGE_BIN:-/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge}"
NODE="${NODE_BIN:-}"
WORKBUDDY="${WORKBUDDY_HOME:-$HOME/.workbuddy}"
if [ -z "$NODE" ] && [ -x "$WORKBUDDY/binaries/node/versions/22.12.0/bin/node" ]; then
  NODE="$WORKBUDDY/binaries/node/versions/22.12.0/bin/node"
fi
if [ -z "$NODE" ]; then
  NODE="$(command -v node || true)"
fi
if [ ! -x "$EDGE" ]; then
  echo "❌ 未找到 Microsoft Edge。可通过 EDGE_BIN 指定可执行文件。" >&2
  exit 1
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "❌ 未找到 Node.js 22+。可通过 NODE_BIN 指定可执行文件。" >&2
  exit 1
fi
PROFILE="$(pwd)/.edge-profile"
mkdir -p "$PROFILE"

if [ "$1" = "--login" ]; then
  echo "🔓 登录模式：请在打开的 Edge 中登录 novelai.net，登录完成后关闭窗口。"
  "$EDGE" --remote-debugging-port=9222 --no-sandbox "--remote-allow-origins=*" \
    --use-angle=swiftshader --disable-gpu-sandbox \
    "--user-data-dir=$PROFILE" https://novelai.net/ &
  echo "登录完成后：关闭窗口，然后重新运行 ./start-nai.sh 即可进入后台模式。"
  exit 0
fi

# headless 后台 Edge（复用登录态 profile）
echo "🚀 启动无头 Edge（后台运行 NovelAI）…"
"$EDGE" --headless=new --no-sandbox "--remote-allow-origins=*" --remote-debugging-port=9222 \
  --use-angle=swiftshader --disable-gpu-sandbox --disable-extensions \
  --disable-component-update --disable-background-networking --no-first-run \
  "--user-data-dir=$PROFILE" https://novelai.net/image >/dev/null 2>&1 &

echo "🚀 启动 NovelAI 联动层（8787）…"
NODE_MODULES="$WORKBUDDY/binaries/node/workspace/node_modules"
exec env NODE_OPTIONS= NODE_PATH="$NODE_MODULES" "$NODE" --experimental-sqlite server.mjs --port 8787 --cdp 9222
