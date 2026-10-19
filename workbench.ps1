# ============================================================
#  workbench.ps1 —— 博客工作台
#  用法：双击同目录下的「工作台.bat」
#
#  功能：
#    1) 上传照片到照片墙（自动压缩大图 + 可选便利贴说明 + 可选自动部署）
#    2) 一键压缩照片文件夹里的大图
#    3) 上传博客文章（复用 upload-post.ps1，从 Obsidian 笔记导入）
#    4) 构建并部署上线（复用 deploy-gh-pages.ps1，不依赖 GitHub Actions）
#    5) 本地预览（自动打开开发服务器）
#    6) 打开照片文件夹
#
#  参数 -Test 仅供自检用（压缩一张图后退出，不弹菜单）
# ============================================================

param([switch]$Test)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$repo       = $PSScriptRoot
$photosDir  = Join-Path $repo 'public\photos'
$notesFile  = Join-Path $repo 'src\data\photos.ts'
$backupDir  = Join-Path $repo '.原图备份'

Set-Location $repo

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
[System.Windows.Forms.Application]::EnableVisualStyles()

$imgExt = @('.jpg', '.jpeg', '.png', '.gif', '.webp')

# ---------------- 小工具 ----------------
function Line($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Head($text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
function Ok($text)   { Write-Host "   [OK] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   [!] $text" -ForegroundColor Yellow }
function Bad($text)  { Write-Host "   [x] $text" -ForegroundColor Red }

function Pause-Menu {
    Write-Host ''
    Read-Host '按回车返回菜单' | Out-Null
}

# 让文件名安全：去掉 Windows 不允许的字符
function Safe-Name([string]$name) {
    foreach ($c in [System.IO.Path]::GetInvalidFileNameChars()) {
        $name = $name.Replace([string]$c, '-')
    }
    return $name.Trim()
}

# 同名文件自动加 -2 / -3 后缀
function Unique-Path([string]$dir, [string]$base, [string]$ext) {
    $p = Join-Path $dir ($base + $ext)
    $i = 2
    while (Test-Path $p) {
        $p = Join-Path $dir ($base + '-' + $i + $ext)
        $i++
    }
    return $p
}

# ---------------- 用 System.Drawing 压缩图片 ----------------
function Compress-Image {
    param(
        [string]$Src,
        [string]$Dst,
        [int]$MaxEdge = 1600,
        [int]$Quality = 85
    )
    $img = $null
    $bmp = $null
    $g = $null
    try {
        $img = [System.Drawing.Image]::FromFile($Src)
        $w = $img.Width
        $h = $img.Height
        $scale = [Math]::Min(1.0, $MaxEdge / [Math]::Max($w, $h))
        $nw = [int][Math]::Round($w * $scale)
        $nh = [int][Math]::Round($h * $scale)
        if ($nw -lt 1) { $nw = 1 }
        if ($nh -lt 1) { $nh = 1 }

        $bmp = New-Object System.Drawing.Bitmap $nw, $nh
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        # PNG 透明区域转 JPG 会变黑，先铺白底
        $g.Clear([System.Drawing.Color]::White)
        $g.DrawImage($img, 0, 0, $nw, $nh)
        $g.Dispose(); $g = $null

        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
            Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter (
            [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
        $bmp.Save($Dst, $codec, $ep)
        $bmp.Dispose(); $bmp = $null
        return (Get-Item $Dst).Length
    }
    finally {
        if ($g) { $g.Dispose() }
        if ($bmp) { $bmp.Dispose() }
        if ($img) { $img.Dispose() }
    }
}

# ---------------- 往 photos.ts 里加一条便利贴 ----------------
function Add-PhotoNote([string]$key, [string]$note) {
    if (-not (Test-Path $notesFile)) { return $false }
    $text = Get-Content -Raw -Encoding UTF8 $notesFile
    if ($text -match ("'" + [regex]::Escape($key) + "'\s*:")) { return $false } # 已经存在

    $escKey = $key.Replace("'", "\'")
    $escNote = $note.Replace("'", "\'")
    $line = "  '" + $escKey + "': '" + $escNote + "',`r`n"
    $idx = $text.LastIndexOf('};')
    if ($idx -lt 0) { return $false }
    $text = $text.Substring(0, $idx) + $line + $text.Substring($idx)
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($notesFile, $text, $utf8NoBom)
    return $true
}

# ---------------- 1) 上传照片 ----------------
function Step-AddPhotos {
    Head '== 上传照片到照片墙 =='
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = '选择要上传到照片墙的图片（可多选）'
    $dlg.Filter = '图片文件|*.jpg;*.jpeg;*.png;*.gif;*.webp|所有文件|*.*'
    $dlg.Multiselect = $true
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        Warn '已取消。'
        return
    }

    foreach ($src in $dlg.FileNames) {
        $fi = Get-Item $src
        $ext = $fi.Extension.ToLower()
        if ($imgExt -notcontains $ext) {
            Warn ("跳过不支持的格式: " + $fi.Name)
            continue
        }
        $base = Safe-Name ([System.IO.Path]::GetFileNameWithoutExtension($fi.Name))
        $sizeKB = [math]::Round($fi.Length / 1KB)

        # 大图自动压成 JPG；小图原样复制
        if ($fi.Length -gt 400KB) {
            $dst = Unique-Path $photosDir $base '.jpg'
            try {
                $newLen = Compress-Image -Src $fi.FullName -Dst $dst -MaxEdge 1600 -Quality 85
                Ok ($fi.Name + '  ' + $sizeKB + 'KB -> ' + [math]::Round($newLen / 1KB) + 'KB（已压缩）')
                $finalBase = [System.IO.Path]::GetFileNameWithoutExtension($dst)
            }
            catch {
                Bad ('压缩失败，改为原样复制: ' + $fi.Name + '  ' + $_.Exception.Message)
                $dst = Unique-Path $photosDir $base $ext
                Copy-Item $fi.FullName $dst
                $finalBase = [System.IO.Path]::GetFileNameWithoutExtension($dst)
            }
        }
        else {
            $dst = Unique-Path $photosDir $base $ext
            Copy-Item $fi.FullName $dst
            Ok ($fi.Name + '  ' + $sizeKB + 'KB（未超限，原样复制）')
            $finalBase = [System.IO.Path]::GetFileNameWithoutExtension($dst)
        }

        # 便利贴（可选）
        Write-Host ''
        Write-Host ('  给「' + $finalBase + '」写一句说明（直接回车 = 不写）：') -ForegroundColor DarkCyan
        $note = Read-Host '  便利贴'
        if ($note -and $note.Trim()) {
            if (Add-PhotoNote $finalBase $note.Trim()) {
                Ok '已写入便利贴（src/data/photos.ts）'
            }
            else {
                Warn '便利贴没写进去（可能已存在同名条目），可手动编辑 src/data/photos.ts'
            }
        }
    }

    Write-Host ''
    $doDeploy = Read-Host '现在就构建并部署上线吗？(y/N)'
    if ($doDeploy -match '^[yY]') { Step-Deploy }
}

# ---------------- 2) 批量压缩 ----------------
function Step-CompressAll {
    Head '== 压缩照片文件夹里的大图 =='
    $files = Get-ChildItem $photosDir -File | Where-Object {
        $imgExt -contains $_.Extension.ToLower() -and $_.Length -gt 400KB
    }
    if (-not $files) { Ok '没有超过 400KB 的图片，不需要压缩。'; return }

    if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

    $totalBefore = 0
    $totalAfter = 0
    foreach ($f in $files) {
        $totalBefore += $f.Length
        # 备份原图（放在仓库根 .原图备份 里，不会被网站发布）
        Copy-Item $f.FullName (Join-Path $backupDir $f.Name) -Force

        $base = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
        $tmp = Join-Path $photosDir ($base + '.__tmp.jpg')
        try {
            $newLen = Compress-Image -Src $f.FullName -Dst $tmp -MaxEdge 1600 -Quality 85
            if ($newLen -ge $f.Length) {
                Remove-Item $tmp -Force
                Warn ($f.Name + ' 压缩后反而更大，已跳过')
                continue
            }
            $finalPath = Join-Path $photosDir ($base + '.jpg')
            if ($f.Extension.ToLower() -ne '.jpg' -and (Test-Path $finalPath)) {
                $finalPath = Unique-Path $photosDir $base '.jpg'
            }
            Move-Item $tmp $finalPath -Force
            if ($finalPath -ne $f.FullName) { Remove-Item $f.FullName -Force }
            $totalAfter += (Get-Item $finalPath).Length
            Ok ($f.Name + ': ' + [math]::Round($f.Length / 1KB) + 'KB -> ' + [math]::Round((Get-Item $finalPath).Length / 1KB) + 'KB')
        }
        catch {
            if (Test-Path $tmp) { Remove-Item $tmp -Force }
            Bad ($f.Name + ' 处理失败: ' + $_.Exception.Message)
        }
    }
    Write-Host ''
    Ok ('合计: ' + [math]::Round($totalBefore / 1MB, 2) + ' MB -> ' + [math]::Round($totalAfter / 1MB, 2) + ' MB')
    Warn ('原图已备份到: ' + $backupDir + '（确认满意后可以删掉）')
}

# ---------------- 3) 上传博客文章 ----------------
function Step-AddPost {
    Head '== 上传博客文章（从 Obsidian 笔记）=='
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = '选择 Obsidian 笔记（.md）'
    $dlg.Filter = 'Markdown 笔记|*.md|所有文件|*.*'
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Warn '已取消。'; return }

    $script = Join-Path $repo 'upload-post.ps1'
    if (-not (Test-Path $script)) { Bad '找不到 upload-post.ps1'; return }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Path $dlg.FileName

    Write-Host ''
    $doDeploy = Read-Host '现在就构建并部署上线吗？(y/N)'
    if ($doDeploy -match '^[yY]') { Step-Deploy }
}

# ---------------- 4) 构建 + 部署 ----------------
function Step-Deploy {
    Head '== 构建并部署上线 =='
    $script = Join-Path $repo 'deploy-gh-pages.ps1'
    if (-not (Test-Path $script)) { Bad '找不到 deploy-gh-pages.ps1'; return }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script
    Write-Host ''
    Warn '如果这是第一次用：请去 GitHub 仓库 Settings -> Pages 把 Source 改成 gh-pages 分支。'
}

# ---------------- 5) 本地预览 ----------------
function Step-Preview {
    Head '== 本地预览 =='
    Line '正在新窗口启动开发服务器，稍等几秒后浏览器打开：' 'Gray'
    Line '    http://localhost:4321' 'Cyan'
    $cmd = "Set-Location '$repo'; `$env:ASTRO_TELEMETRY_DISABLED='1'; npm run dev"
    Start-Process -FilePath 'powershell' -ArgumentList @(
        '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd
    ) | Out-Null
    Start-Sleep -Seconds 4
    Start-Process 'http://localhost:4321' | Out-Null
    Ok '已尝试打开浏览器。'
}

# ---------------- 自检（-Test）----------------
if ($Test) {
    $src = Get-ChildItem $photosDir -File |
        Where-Object { $imgExt -contains $_.Extension.ToLower() } |
        Sort-Object Length -Descending | Select-Object -First 1
    if (-not $src) { Bad '照片文件夹里没有图片，无法自检'; exit 1 }
    $dst = Join-Path $env:TEMP 'workbench-selftest.jpg'
    if (Test-Path $dst) { Remove-Item $dst -Force }
    $len = Compress-Image -Src $src.FullName -Dst $dst -MaxEdge 1600 -Quality 85
    Line ('自检: ' + $src.Name + '  ' + [math]::Round($src.Length / 1KB) + 'KB -> ' + [math]::Round($len / 1KB) + 'KB') 'Green'
    Remove-Item $dst -Force
    exit 0
}

# ---------------- 主菜单 ----------------
if (-not (Test-Path $photosDir)) { New-Item -ItemType Directory -Path $photosDir -Force | Out-Null }

while ($true) {
    try { Clear-Host } catch { }
    Write-Host '==================================================' -ForegroundColor Cyan
    Write-Host '              博客工作台  ·  takinol' -ForegroundColor Cyan
    Write-Host '==================================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '   1  上传照片到照片墙（自动压缩 + 便利贴）'
    Write-Host '   2  压缩照片文件夹里的大图'
    Write-Host '   3  上传博客文章（从 Obsidian 笔记）'
    Write-Host '   4  构建并部署上线'
    Write-Host '   5  本地预览'
    Write-Host '   6  打开照片文件夹'
    Write-Host '   0  退出'
    Write-Host ''
    $choice = Read-Host '请输入序号'

    switch ($choice) {
        '1' { Step-AddPhotos;   Pause-Menu }
        '2' { Step-CompressAll; Pause-Menu }
        '3' { Step-AddPost;     Pause-Menu }
        '4' { Step-Deploy;      Pause-Menu }
        '5' { Step-Preview;     Start-Sleep -Seconds 1 }
        '6' { Start-Process 'explorer.exe' $photosDir; Start-Sleep -Seconds 1 }
        '0' { return }
        default { }
    }
}
