# ============================================================
#  本地一键部署：构建网站 -> 推送到 gh-pages 分支 -> GitHub Pages 发布
#  用法：双击同目录下的「部署网站.bat」
#
#  第一次使用后，请去 GitHub 仓库做一次设置（只需一次）：
#    Settings -> Pages -> Build and deployment
#    Source 选 “Deploy from a branch”
#    Branch 选 “gh-pages” + “/ (root)” -> Save
#  之后每次只要双击「部署网站.bat」即可，完全不再依赖 GitHub Actions。
# ============================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

try {
    Write-Host ''
    Write-Host '[1/3] 正在构建网站…' -ForegroundColor Cyan
    $env:ASTRO_TELEMETRY_DISABLED = '1'
    npm run build
    if ($LASTEXITCODE -ne 0) { throw '构建失败，请查看上面的报错。' }

    $dist = Join-Path $root 'dist'
    if (-not (Test-Path $dist)) { throw '没有找到 dist 目录，构建可能失败了。' }

    Write-Host '[2/3] 准备 gh-pages 内容…' -ForegroundColor Cyan
    $remote = (git remote get-url origin)
    if ($remote) { $remote = $remote.Trim() }
    if (-not $remote) { throw '找不到 git remote origin。' }

    $un = (git config user.name)
    if ([string]::IsNullOrWhiteSpace($un)) { $un = 'takinol' }
    $ue = (git config user.email)
    if ([string]::IsNullOrWhiteSpace($ue)) { $ue = 'takinol@users.noreply.github.com' }

    Push-Location $dist
    try {
        $nested = Join-Path $dist '.git'
        if (Test-Path $nested) { Remove-Item -Recurse -Force $nested }

        git init -q
        git checkout -q -b gh-pages
        # .nojekyll 必须存在：否则 _astro 这种下划线开头的目录会被 Jekyll 忽略
        New-Item -ItemType File -Path '.nojekyll' -Force | Out-Null
        git add -A -f
        git -c "user.name=$un" -c "user.email=$ue" commit -q -m ("deploy " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

        Write-Host '[3/3] 推送到 gh-pages 分支…' -ForegroundColor Cyan
        git push -f $remote gh-pages
        if ($LASTEXITCODE -ne 0) { throw '推送失败，请检查网络或 GitHub 登录状态。' }
    }
    finally {
        Pop-Location
        $nested = Join-Path $dist '.git'
        if (Test-Path $nested) { Remove-Item -Recurse -Force $nested }
    }

    Write-Host ''
    Write-Host '✅ 部署完成！' -ForegroundColor Green
    Write-Host '   网站地址：https://takinol.github.io/'
    Write-Host '   GitHub Pages 一般 30 秒~1 分钟内生效，记得按 Ctrl+F5 强刷。'
    Write-Host '   如果这是第一次用，别忘了先去 Settings -> Pages 把 Source 改成 gh-pages 分支。'
}
catch {
    Write-Host ''
    Write-Host ('❌ 出错：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
