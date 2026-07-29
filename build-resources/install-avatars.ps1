# 安装包安装阶段调用：把官方皮肤从安装目录释放到用户数据目录。
# 只会在 NSIS 安装过程中执行一次；程序启动后不再调用此脚本，也不会再替换皮肤。
param(
    [string]$SourceDir = "$PSScriptRoot\resources\official-avatars",
    [string]$DestDir = "$env:APPDATA\akisaki-kirari\avatars"
)

if (!(Test-Path $SourceDir -PathType Container)) {
    Write-Host "[install-avatars] 源目录不存在，跳过: $SourceDir"
    exit 0
}

New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

function Get-Author($dir) {
    $json = Join-Path $dir "frames.json"
    if (Test-Path $json) {
        try {
            $obj = Get-Content $json -Raw -Encoding UTF8 | ConvertFrom-Json
            return $obj.author
        }
        catch {
            return $null
        }
    }
    return $null
}

foreach ($skin in Get-ChildItem -Path $SourceDir -Directory) {
    $srcDir = $skin.FullName
    $dstDir = Join-Path $DestDir $skin.Name
    $srcAuthor = Get-Author $srcDir
    $dstAuthor = Get-Author $dstDir

    $shouldInstall = $true
    if (Test-Path $dstDir -PathType Container) {
        if ($dstAuthor -and ($dstAuthor -ne $srcAuthor)) {
            Write-Host "[install-avatars] 跳过 $($skin.Name)：目标作者 '$dstAuthor' 与源作者 '$srcAuthor' 不一致"
            $shouldInstall = $false
        }
    }

    if ($shouldInstall) {
        if (Test-Path $dstDir) {
            Remove-Item -Recurse -Force $dstDir
        }
        Copy-Item -Recurse -Force $srcDir $dstDir
        Write-Host "[install-avatars] 已安装 $($skin.Name) (author=$srcAuthor)"
    }
}

exit 0
