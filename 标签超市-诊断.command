#!/bin/bash
# ============================================================
# 「标签超市」诊断工具
#
# 本文件仅用于故障诊断/维修，不是日常入口；
# 日常入口是 Dock 里的 Web App（标签超市）。
#
# 只做诊断与用户主动选择的操作，不做自动修复、
# 不做环境安装、不做进程强制终止。
# ============================================================

LABEL="com.tagsupermarket.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/TagSupermarket"
URL="http://127.0.0.1:8123"

show_status() {
    echo "=============================="
    echo "标签超市 服务诊断"
    echo "=============================="
    echo
    echo "[1] LaunchAgent 加载状态"
    if launchctl list | grep -q "$LABEL"; then
        echo "    $LABEL  已加载"
        launchctl list | grep "$LABEL"
    else
        echo "    $LABEL  未加载（或当前 GUI 会话未登录）"
        echo "    可执行 r 重新加载，或运行 install-launchagent.sh"
    fi
    echo
    echo "[2] 8123 端口监听"
    if lsof -iTCP:8123 -sTCP:LISTEN >/dev/null 2>&1; then
        echo "    正在监听 ✓"
        lsof -iTCP:8123 -sTCP:LISTEN
    else
        echo "    未监听 ✗  （服务可能未启动，请查看下方日志）"
    fi
    echo
    echo "[3] 日志"
    for f in "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log"; do
        if [ -f "$f" ]; then
            echo "    $f  $(ls -lh "$f" | awk '{print $5}')"
        else
            echo "    $f  （不存在）"
        fi
    done
    echo
}

show_menu() {
    echo "=============================="
    echo "操作菜单"
    echo "  r) 重新加载 LaunchAgent"
    echo "  o) 打开网页 $URL"
    echo "  q) 退出"
    echo "=============================="
}

reload_service() {
    echo "卸载 LaunchAgent ..."
    launchctl unload "$PLIST" 2>/dev/null || true
    echo "加载 LaunchAgent ..."
    if launchctl load "$PLIST" 2>/dev/null; then
        echo "重新加载成功 ✓"
    else
        echo "launchctl load 未成功（较新 macOS 可能提示改用 bootstrap）"
        echo "请手动执行："
        echo "  launchctl bootstrap gui/\$(id -u) $PLIST"
    fi
}

# ---- 主流程 ----
show_status
while true; do
    show_menu
    read -r -p "请选择 [r/o/q]: " choice
    case "$choice" in
        r|R)
            reload_service
            show_status
            ;;
        o|O)
            open "$URL"
            ;;
        q|Q)
            echo "再见。"
            exit 0
            ;;
        *)
            echo "无效选择，请重新输入。"
            ;;
    esac
done
