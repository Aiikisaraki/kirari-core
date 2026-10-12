#!/usr/bin/env bash
# install-service.sh — 在 Linux 机器上把 Kirari Core 装成 systemd 服务。
#
# 用法：
#   sudo ./deploy/install-service.sh              # 从当前目录安装
#   sudo ./deploy/install-service.sh /opt/kirari  # 装到指定目录（已存在则只更新服务）
#
# 做的事：
#   1. 建独立用户 kirari（不用 root 跑业务）
#   2. 拷贝代码到 /opt/kirari-core（首次）或原地更新（已存在）
#   3. 同步组网层 kirari-net 到与目标目录平级的位置（依赖写的是 file:../kirari-net）
#   4. npm ci --omit=dev 安装生产依赖，并自检 kirari-net 能 require 到
#   5. 生成 .env（已存在则保留，不覆盖！）
#   6. 注册并启动 systemd 服务，设置开机自启
#
# 幂等：重复执行安全，不会覆盖你已配置的 .env。
#
# 前置：kirari-net 必须与 kirari-core **平级**放在一起
#   （本地工作区里就是 D:/personal-proj/{kirari-core,kirari-net} 这种布局）。

set -euo pipefail

APP_DIR="${1:-/opt/kirari-core}"
SERVICE_NAME="kirari-core"
SERVICE_USER="kirari"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 源目录: $SRC_DIR"
echo "==> 目标目录: $APP_DIR"

# ── 1. 前置检查 ────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 node。请先安装 Node.js 24+（nvm 用户请注意 systemd 读不到 nvm 的 PATH，见 README 常见问题）" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node 版本过低（当前 $(node -v)），需要 20 以上，建议 24" >&2
  exit 1
fi
echo "==> Node $(node -v)"

# ── 2. 创建服务用户 ────────────────────────────────────────
if id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> 用户 $SERVICE_USER 已存在"
else
  echo "==> 创建用户 $SERVICE_USER（无登录 shell）"
  useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# ── 3. 放置代码 ────────────────────────────────────────────
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  if [ -d "$APP_DIR" ]; then
    echo "==> 目标目录已存在，保留 .env 与 data/，只更新代码"
    # 同步代码但排除运行期数据
    rsync -a --delete \
      --exclude '.env' \
      --exclude 'data/' \
      --exclude 'node_modules/' \
      --exclude 'web/node_modules/' \
      --exclude '.git/' \
      "$SRC_DIR"/ "$APP_DIR"/
  else
    echo "==> 创建目录并拷贝代码"
    mkdir -p "$APP_DIR"
    rsync -a --exclude 'node_modules/' --exclude 'web/node_modules/' --exclude '.git/' "$SRC_DIR"/ "$APP_DIR"/
  fi
fi
cd "$APP_DIR"

# ── 4. 组网层 kirari-net（与本源码目录**平级**的本地包）──────
# package.json 里的依赖写的是 file:../kirari-net —— 也就是「本源码目录的上一级」。
# 目标目录（默认 /opt/kirari-core）的上一级同样要能看到它，否则 npm ci 只会
# 留一个悬空软链：安装一路绿灯，启动时 require("kirari-net") 直接 MODULE_NOT_FOUND。
# 与其让它到运行期才炸，不如在部署期就把话说清楚。
NET_SRC="$(dirname "$SRC_DIR")/kirari-net"
NET_DST="$(dirname "$APP_DIR")/kirari-net"
if [ "$NET_SRC" != "$NET_DST" ]; then
  if [ -d "$NET_SRC" ]; then
    echo "==> 同步组网层: $NET_SRC → $NET_DST"
    mkdir -p "$NET_DST"
    rsync -a --delete --exclude 'node_modules/' --exclude '.git/' "$NET_SRC"/ "$NET_DST"/
  else
    echo "✗ 找不到组网层目录: $NET_SRC" >&2
    echo "  核心版的依赖写的是 file:../kirari-net，这个包必须与 kirari-core 平级放一起。" >&2
    echo "  处理：把 kirari-net 仓库放到 $NET_DST 之后重跑本脚本。" >&2
    exit 1
  fi
fi
# 运行期只用它的 dist（预编译产物），没构建过就先构建一次
if [ ! -f "$NET_DST/dist/index.js" ]; then
  echo "==> 组网层还没构建过，先构建（需要 typescript，会用 npm 装它的开发依赖）"
  ( cd "$NET_DST" && npm install --no-audit --no-fund && npm run build )
fi

# ── 5. 生产依赖 ────────────────────────────────────────────
echo "==> 安装生产依赖（npm ci --omit=dev）"
# better-sqlite3 的预编译产物是 N-API，安装时无需本地编译工具链。
npm ci --omit=dev --no-audit --no-fund
# 自检：npm ci 对 file: 依赖不校验目标是否存在，所以这里必须真的 require 一次。
# 否则要等到服务启动才暴露「组网层没装进来」。
node -e "require('kirari-net'); console.log('    ✓ kirari-net 可加载')"

# ── 5.5 Web 控制台（可选）─────────────────────────────────
# 优先用源目录里已构建好的 web/dist（本地 npm run build 的产物）；
# 没有就在服务器上现构建。构建失败不阻断服务 —— 控制台是可选功能。
if [ ! -f web/dist/index.html ]; then
  echo "==> 控制台还没构建过，尝试在服务器上构建 web/"
  if ( cd web && npm install --no-audit --no-fund && npm run build ); then
    echo "    ✓ 控制台构建完成"
  else
    echo "    ⚠ 控制台构建失败（服务照常启动，只是没有 /console 页面）" >&2
  fi
else
  echo "==> 使用自带的控制台构建产物（web/dist）"
fi

# ── 6. 配置文件 ────────────────────────────────────────────
if [ -f .env ]; then
  echo "==> .env 已存在，保持不动"
else
  echo "==> 生成 .env（请务必修改其中的密钥与口令）"
  cp .env.example .env
  # 自动生成两个随机密钥，避免沿用示例值
  if command -v openssl >/dev/null 2>&1; then
    BOT_TOKEN="$(openssl rand -hex 32)"
    SESSION_SECRET="$(openssl rand -hex 32)"
    ADMIN_PASSWORD="$(openssl rand -hex 32)"
  else
    BOT_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    SESSION_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    ADMIN_PASSWORD="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=$BOT_TOKEN|" .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SESSION_SECRET|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PASSWORD|" .env
  chmod 600 .env
  echo ""
  echo "    ┌──────────────────────────────────────────┐"
  echo "    │ 已生成随机密钥并写入 .env（权限 600）      │"
  echo "    │ 接入口令 BOT_TOKEN / 控制台口令见下方      │"
  echo "    └──────────────────────────────────────────┘"
  echo "    BOT_TOKEN      = $BOT_TOKEN"
  echo "    ADMIN_PASSWORD = $ADMIN_PASSWORD   ← 登录网页控制台用（/console）"
  echo ""
fi

# ── 7. 目录权限 ────────────────────────────────────────────
mkdir -p data
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
chmod 600 .env

# ── 8. 注册 systemd 服务 ───────────────────────────────────
# 用绝对路径指向仓库里的 unit 文件（可能是脚本所在目录，也可能是 APP_DIR）
UNIT_SRC="$SRC_DIR/deploy/kirari-core.service"
echo "==> 注册 systemd 服务"
cp "$UNIT_SRC" /etc/systemd/system/$SERVICE_NAME.service
systemctl daemon-reload
systemctl enable $SERVICE_NAME >/dev/null 2>&1
systemctl restart $SERVICE_NAME

sleep 2
echo ""
if systemctl is-active --quiet $SERVICE_NAME; then
  PORT="$(grep -E '^PORT=' .env | cut -d= -f2 || echo 9089)"
  echo "✓ 服务已启动：$SERVICE_NAME"
  echo "  健康检查: curl http://127.0.0.1:${PORT:-9089}/health"
  echo "  网页控制台: http://127.0.0.1:${PORT:-9089}/console（口令 = .env 的 ADMIN_PASSWORD）"
  echo "  看日志  : journalctl -u $SERVICE_NAME -f"
else
  echo "✗ 服务启动失败，日志如下：" >&2
  journalctl -u $SERVICE_NAME -n 30 --no-pager >&2
  exit 1
fi

echo ""
echo "后续："
echo "  1) 配模型：通过控制台 /console「大脑」添加模型套（多模型）"
echo "     （或先用 curl 看 /api-token/status 是否已有配置）"
echo "  2) 放行端口：firewall-cmd --add-port=${PORT:-9089}/tcp --permanent && firewall-cmd --reload"
echo "  3) 常用命令：systemctl restart|stop|status $SERVICE_NAME"
