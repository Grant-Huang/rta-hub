#!/bin/bash
# 启动 RTA-Hub 开发服务器 + Cloudflare 隧道

cd "$(dirname "$0")"

# 启动 cloudflare 隧道
echo "🚀 启动 Cloudflare 隧道..."
cloudflared tunnel --config ~/.cloudflared/config.yml run rta-hub &

# 等待隧道就绪
sleep 3

# 启动 RTA-Hub
echo "🚀 启动 RTA-Hub..."
pnpm dev

# 捕获 Ctrl+C
trap "pkill -f cloudflared; pkill -f 'tsx watch'" EXIT
