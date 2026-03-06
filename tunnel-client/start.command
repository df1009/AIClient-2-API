#!/bin/bash
# API 加速客户端 - macOS 启动脚本
# 双击此文件即可运行

set -e

echo "============================================"
echo "      API 加速客户端 v1.0.0"
echo "============================================"
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "[错误] 未检测到 Node.js，请先安装 Node.js (>= 18.0)"
    echo ""
    echo "安装方式（任选一种）:"
    echo "  1. Homebrew: brew install node"
    echo "  2. 官网下载: https://nodejs.org/"
    echo ""
    echo "按回车键退出..."
    read
    exit 1
fi

echo "[信息] Node.js 版本: $(node -v)"

# 进入脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "[信息] 首次运行，正在安装依赖..."
    npm install --silent
    echo "[信息] 依赖安装完成"
    echo ""
fi

CONFIG_FILE="$SCRIPT_DIR/relay.config"
TOKEN=""
PROXY_URL=""
ACTION=""

# 解析命令行参数
while [[ $# -gt 0 ]]; do
    case "$1" in
        --token|-t)  TOKEN="$2"; shift 2 ;;
        --proxy|-p)  PROXY_URL="$2"; shift 2 ;;
        --config|--reset) ACTION="reset"; shift ;;
        --help|-h)
            echo "用法: ./start.command [选项]"
            echo ""
            echo "选项:"
            echo "  --config              修改令牌和代理配置"
            echo "  --reset               重置所有配置（效果同 --config）"
            echo "  --token,  -t <token>  直接指定令牌"
            echo "  --proxy,  -p <url>    直接指定代理地址"
            echo "  --help,   -h          显示帮助"
            exit 0
            ;;
        *) shift ;;
    esac
done

if [ "$ACTION" = "reset" ]; then
    rm -f "$CONFIG_FILE"
    TOKEN=""
    PROXY_URL=""
fi

# 读取已有配置
if [ -f "$CONFIG_FILE" ] && [ -z "$TOKEN" ]; then
    while IFS='=' read -r key value; do
        case "$key" in
            TOKEN)  TOKEN="$value" ;;
            PROXY)  PROXY_URL="$value" ;;
        esac
    done < "$CONFIG_FILE"
fi

# 函数：输入完整配置
input_all_config() {
    echo "[配置] 请填写以下信息（配置会自动保存）"
    echo ""
    TOKEN=""
    PROXY_URL=""
    read -p "请输入您的加速令牌: " TOKEN
    if [ -z "$TOKEN" ]; then
        echo "[错误] 加速令牌不能为空"
        echo "按回车键退出..."
        read
        exit 1
    fi
    echo ""
    echo "本地代理地址（可选，直接回车跳过）"
    echo "  * 如果您能正常访问海外网站，无需配置"
    echo "  * 如果需要科学上网才能访问，请填写代理地址"
    echo ""
    echo "  Clash/ClashX:  http://127.0.0.1:7890"
    echo "  V2rayU:        http://127.0.0.1:10809"
    echo "  Surge:         http://127.0.0.1:6152"
    echo "  Shadowsocks:   socks5://127.0.0.1:1080"
    echo ""
    read -p "本地代理地址: " PROXY_URL
}

# 函数：修改令牌
change_token() {
    echo ""
    echo "当前令牌: ${TOKEN:0:12}..."
    read -p "请输入新的加速令牌（直接回车=保持不变）: " NEW_TOKEN
    if [ -n "$NEW_TOKEN" ]; then
        TOKEN="$NEW_TOKEN"
    fi
}

# 函数：修改代理
change_proxy() {
    echo ""
    if [ -n "$PROXY_URL" ]; then
        echo "当前代理: $PROXY_URL"
    else
        echo "当前代理: 未设置（直连）"
    fi
    echo ""
    echo "常用代理地址:"
    echo "  Clash/ClashX:  http://127.0.0.1:7890"
    echo "  V2rayU:        http://127.0.0.1:10809"
    echo "  Surge:         http://127.0.0.1:6152"
    echo "  Shadowsocks:   socks5://127.0.0.1:1080"
    echo "  清除代理请输入: none"
    echo ""
    read -p "新的代理地址（直接回车=保持不变）: " NEW_PROXY
    if [ -n "$NEW_PROXY" ]; then
        if [ "$NEW_PROXY" = "none" ]; then
            PROXY_URL=""
        else
            PROXY_URL="$NEW_PROXY"
        fi
    fi
}

# 函数：保存配置
save_config() {
    cat > "$CONFIG_FILE" << EOF
TOKEN=$TOKEN
PROXY=$PROXY_URL
EOF
    echo ""
    echo "[信息] 配置已保存"
}

# 已有配置，显示菜单
if [ -n "$TOKEN" ]; then
    echo "当前配置:"
    echo "  令牌: ${TOKEN:0:12}..."
    if [ -n "$PROXY_URL" ]; then
        echo "  代理: $PROXY_URL"
    else
        echo "  代理: 未设置（直连）"
    fi
    echo ""
    echo "────────────────────────────────────────────"
    echo "  [1] 启动加速服务"
    echo "  [2] 修改令牌"
    echo "  [3] 修改代理地址"
    echo "  [4] 修改全部配置"
    echo "  [5] 退出"
    echo "────────────────────────────────────────────"
    echo ""
    read -p "请选择 (直接回车=启动): " CHOICE

    case "$CHOICE" in
        2) change_token; save_config ;;
        3) change_proxy; save_config ;;
        4) input_all_config; save_config ;;
        5) exit 0 ;;
        *) ;;
    esac
else
    input_all_config
    save_config
fi

echo ""
echo "============================================"
echo "  令牌: ${TOKEN:0:12}..."
if [ -n "$PROXY_URL" ]; then
    echo "  代理: $PROXY_URL"
else
    echo "  代理: 直连"
fi
echo "============================================"
echo ""
echo "[提示] 按 Ctrl+C 可停止运行，关闭此窗口也可停止"
echo ""

CMD="node proxy-relay.js --token $TOKEN"
[ -n "$PROXY_URL" ] && CMD="$CMD --proxy $PROXY_URL"

trap 'echo ""; echo "[信息] 正在停止..."; exit 0' INT TERM

eval $CMD

echo ""
echo "[信息] 程序已退出"
echo "按回车键关闭窗口..."
read
