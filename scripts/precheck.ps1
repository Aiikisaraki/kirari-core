# precheck.ps1 — 发版前本地 Docker 预检（Windows 入口）
#
# 为什么：CI 构建绿灯 ≠ 能跑。历史上踩过 require 路径少一层、组件未挂载、
# 参数形状不对等坑，都是「构建通过、运行即崩」。发版前在本机 Docker 里真跑一遍。
#
# 用法：
#   ./scripts/precheck.ps1
#   ./scripts/precheck.ps1 -Keep     # 保留容器便于排查
param([switch]$Keep)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host '[precheck] 检查 Docker...'
try {
    $ver = docker version --format '{{.Server.Version}}' 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'docker version failed' }
    Write-Host "[precheck] Docker $ver"
} catch {
    Write-Host '[precheck] ✗ Docker 守护进程未运行' -ForegroundColor Red
    Write-Host '          Windows: 启动 Docker Desktop 后重试' -ForegroundColor Yellow
    exit 2
}

$gitBash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $gitBash)) {
    Write-Host '[precheck] ✗ 找不到 Git Bash（需要它执行 .sh）' -ForegroundColor Red
    Write-Host '          或直接运行: bash scripts/docker-precheck.sh' -ForegroundColor Yellow
    exit 2
}

$script = Join-Path $root 'scripts\docker-precheck.sh'
$args = @($script)
if ($Keep) { $args += '--keep' }

& $gitBash @args
exit $LASTEXITCODE
