#!/usr/bin/env bash
# docker-precheck.sh — 发版前本地 Docker 构建 + 冒烟测试
#
# 为什么要有这个：CI 构建绿灯 ≠ 能跑。历史上踩过的坑：
#   · require 相对路径少一层（COPY 不校验 require，CI 绿灯但启动即崩）
#   · Dockerfile COPY 了构建上下文外的文件（构建失败但被缓存层掩盖）
#   · 前端组件未挂载（构建通过，页面空白）
#   · 扩展包参数形状不对（sidecar 起得来，调用即报错）
#
# 用法：
#   ./scripts/docker-precheck.sh              # 构建 + 冒烟
#   ./scripts/docker-precheck.sh --keep       # 保留容器便于排查
#
# 依赖：本机 Docker（Docker Desktop / Docker Engine），可选 buildx。
set -uo pipefail


ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 防御：若 ROOT 下没有 package.json，说明层级算错，再退一级
if [ ! -f "$ROOT/package.json" ]; then ROOT="$(dirname "$ROOT")"; fi
IMAGE="kirari-core:precheck"
CONTAINER="kirari-precheck"
FAILED=0
KEEP=${1:-}

say() { echo "[precheck] $*"; }
fail() { echo "[precheck] ✗ $*" >&2; FAILED=1; }

# ── 0. Docker 可用性 ──────────────────────────────────────────────
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "[precheck] ✗ Docker 守护进程未运行。" >&2
  echo "          Windows/macOS: 启动 Docker Desktop 后重试" >&2
  echo "          Linux: sudo systemctl start docker" >&2
  exit 2
fi
say "Docker $(docker version --format '{{.Server.Version}}')"

# ── 1. 源码级 require 体检（进镜像之前） ──────────────────────────
if [ -f "$ROOT/scripts/check-requires.cjs" ]; then
  say "源码 require 体检…"
  if node "$ROOT/scripts/check-requires.cjs" "$ROOT/src"; then
    say "✓ require 路径全有效"
  else
    fail "require 路径有失效项（见上）"
  fi
fi

# ── 1.5 stage kirari-net（file:../kirari-net 平级依赖）─────────────
NET_SRC="$(dirname "$ROOT")/kirari-net"
if [ -d "$NET_SRC" ]; then
  say "stage kirari-net（$NET_SRC）…"
  rm -rf "$ROOT/.kirari-net-build"
  mkdir -p "$ROOT/.kirari-net-build"
  cp "$NET_SRC/package.json" "$ROOT/.kirari-net-build/" 2>/dev/null || true
  cp -r "$NET_SRC/dist" "$ROOT/.kirari-net-build/dist" 2>/dev/null || fail "kirari-net/dist 不存在（先在 kirari-net 里 npm run build）"
  say "✓ kirari-net 已 stage"
else
  say "⚠ 没找到 $NET_SRC —— 镜像将缺 kirari-net（运行期会崩）"
fi

# ── 2. 构建镜像 ────────────────────────────────────────────────────
# 优先 deploy/Dockerfile（CI 用这份，含 kirari-net 处理）；失败则退回根 Dockerfile。
say "构建镜像（deploy/Dockerfile）…"
BUILD_OK=0
if [ -f "$ROOT/deploy/Dockerfile" ]; then
  # deploy/Dockerfile 需要 kirari_net 构建上下文；没有 buildx 时退回根 Dockerfile
  if docker buildx version >/dev/null 2>&1; then
    if docker build -f "$ROOT/deploy/Dockerfile" \
         --build-context kirari_net="$(dirname "$ROOT")/kirari-net" \
         -t "$IMAGE" "$ROOT" >/tmp/precheck-build.log 2>&1; then
      BUILD_OK=1
    fi
  fi
fi
if [ "$BUILD_OK" -eq 0 ]; then
  say "退回根 Dockerfile 构建…"
  if docker build -f "$ROOT/Dockerfile" -t "$IMAGE" "$ROOT" >/tmp/precheck-build.log 2>&1; then
    BUILD_OK=1
  fi
fi
if [ "$BUILD_OK" -eq 0 ]; then
  fail "镜像构建失败，最后 20 行："
  tail -20 /tmp/precheck-build.log >&2
  exit 1
fi
say "✓ 镜像构建成功"

# ── 3. 静态冒烟：容器内文件与语法 ────────────────────────────────
cleanup() {
  if [ "$KEEP" != "--keep" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

say "容器内关键文件检查…"
# 用 sleep 保活而不是跑默认 CMD（CMD 会启动服务，缺配置时立即退出）
docker run -d --name "$CONTAINER" --entrypoint sleep "$IMAGE" infinity >/dev/null || { fail "容器起不来"; exit 1; }

checks=(
  "src/app.js"
  "src/capabilities/builtin/bili_explore.js"
  "src/services/biliBiolock.js"
  "src/services/biliSettings.js"
  "web/dist/index.html"
)
for f in "${checks[@]}"; do
  if MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" test -f "/app/$f"; then say "  ✓ $f"; else fail "  缺文件: $f"; fi
done

# ── 4. require 图加载（不 listen，纯加载） ──────────────────────
say "require 图加载测试…"
if MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" node -e "require('/app/src/app.js')" >/tmp/precheck-require.log 2>&1; then
  say "✓ require 图无缺失"
else
  # app.js 会尝试启动服务，这里允许它因端口等退出，但 MODULE_NOT_FOUND 必须拦
  if grep -q 'MODULE_NOT_FOUND' /tmp/precheck-require.log; then
    fail "require 图有缺失模块："
    grep -A3 'MODULE_NOT_FOUND' /tmp/precheck-require.log | head -10 >&2
  else
    say "✓ 无 MODULE_NOT_FOUND（其他启动退出可接受）"
  fi
fi

# ── 5. 前端资源一致性（构建产物引用的 JS 是否真存在） ─────────────
say "前端资源一致性…"
JS_REF=$(MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" sh -c "grep -o 'index-[A-Za-z0-9_-]*\.js' /app/web/dist/index.html | head -1" 2>/dev/null)
if [ -n "$JS_REF" ]; then
  if MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" test -f "/app/web/dist/assets/$JS_REF"; then
    say "✓ index.html → $JS_REF 存在"
  else
    fail "index.html 引用的 $JS_REF 不存在"
  fi
else
  fail "index.html 里找不到 JS 引用"
fi

# ── 6. 扩展契约冒烟（装了扩展包时验证 sidecar 能握手） ─────────────
say "扩展宿主冒烟…"
MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" node -e "
  const {ExtensionHost}=require('/app/src/extensions/host');
  const h=new ExtensionHost({rootDir:'/app/data/extensions'});
  h.startAll().then(list=>{
    console.log('[precheck] 扩展加载:', list.map(x=>x.packId+'@'+x.version).join(', ')||'(无)');
    process.exit(0);
  }).catch(e=>{ console.error('[precheck] 扩展加载失败:', e.message); process.exit(1); });
" 2>&1 | tail -3

# ── 结果 ──────────────────────────────────────────────────────────
echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "[precheck] ✓ 全部通过，可以发版"
  exit 0
else
  echo "[precheck] ✗ 有检查项失败，先修再发版" >&2
  exit 1
fi
