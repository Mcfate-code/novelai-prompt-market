#!/bin/bash
# install-launchagent.sh
# 安装「标签超市」macOS LaunchAgent 后台服务（用户级，无需 root）
# 用法:
#   bash install-launchagent.sh            # 安装并加载 LaunchAgent
#   bash install-launchagent.sh --print    # 仅打印将生成的 plist 内容，不写盘、不加载

set -euo pipefail

# ---- 自动解析真实项目路径（脚本位于仓库根） ----
SCRIPT_PATH="$0"
if [ -L "$SCRIPT_PATH" ]; then
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
fi
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

LABEL="com.tagsupermarket.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/TagSupermarket"
PYTHON="$PROJECT_DIR/.venv/bin/python"

if [ ! -f "$PYTHON" ]; then
    echo "错误：未找到项目 Python 解释器：$PYTHON" >&2
    echo "请先在本项目目录创建 .venv（uv sync 或 python -m venv .venv）后再运行。" >&2
    exit 1
fi

# ---- 生成 plist 内容（路径含空格/中文，直接作为 XML 字符串） ----
generate_plist() {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$PROJECT_DIR/app.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>TAGS_MARKET_RELOAD</key>
        <string>0</string>
    </dict>
</dict>
</plist>
EOF
}

# ---- --print：仅输出 plist，不写盘、不加载 ----
if [ "${1:-}" = "--print" ]; then
    generate_plist
    exit 0
fi

# ---- 默认模式：安装并加载 ----
echo "安装 LaunchAgent：$LABEL"
mkdir -p "$LOG_DIR"
generate_plist > "$PLIST"
echo "已写入：$PLIST"

if launchctl load "$PLIST" 2>/dev/null; then
    echo "launchctl load 成功。"
else
    echo "launchctl load 未成功（较新 macOS 可能提示改用 bootstrap）。" >&2
    echo "请手动执行：" >&2
    echo "  launchctl bootstrap gui/\$(id -u) $PLIST" >&2
fi

echo
echo "=============================="
echo "服务标签    : $LABEL"
echo "项目路径    : $PROJECT_DIR"
echo "Python 路径 : $PYTHON"
echo "日志路径    : $LOG_DIR"
echo "网页入口    : http://127.0.0.1:8123"
echo
echo "打开网页：open http://127.0.0.1:8123"
echo "ONE-TIME USER ACTION: 在 Safari 中打开 http://127.0.0.1:8123 → 添加到程序坞"
echo "=============================="
