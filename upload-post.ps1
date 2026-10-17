# ============================================================
#  upload-post.ps1 —— 一键把 Obsidian 文章（含图片）导入博客
#  用法：
#    方式1：双击「上传文章.bat」，然后粘贴文章绝对路径
#    方式2：powershell -ExecutionPolicy Bypass -File upload-post.ps1 -Path "D:\...\文章.md"
#  脚本会自动：
#    1) 复制 .md 到 src\content\blog\
#    2) 找出文章里的 ![[图片]] 并复制到 public\images\（大图自动压缩成 jpg）
#    3) 把 ![[...]] 改写成网页能显示的图片语法，[[双链]] 转成文字
#    4) 如果没有 frontmatter，自动补上 title/date
#  之后你只需 git add . / git commit / git push
# ============================================================

param(
    [string]$Path = ""
)

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------- 1. 拿到要上传的 md 路径 ----------
if (-not $Path) {
    $Path = Read-Host "请粘贴 Obsidian 文章的绝对路径（或直接把文件拖进窗口）"
    $Path = $Path.Trim().Trim('"')
}
if (-not $Path) { Write-Host "没有输入路径，已退出。"; exit 1 }
if (-not (Test-Path $Path -PathType Leaf)) { Write-Host "找不到文件：$Path"; exit 1 }
if ([System.IO.Path]::GetExtension($Path) -ne ".md") { Write-Host "这不是 .md 文件：$Path"; exit 1 }

Write-Host ""
Write-Host "== 1/4 读取文章 =="
Write-Host "    来源：$Path"
$content = [System.IO.File]::ReadAllText($Path)

# ---------- 2. 找 Obsidian 仓库根（含 .obsidian 文件夹的目录） ----------
function Get-ObsidianRoot([string]$startDir) {
    $dir = $startDir
    while ($dir) {
        if (Test-Path (Join-Path $dir ".obsidian")) { return $dir }
        $dir = Split-Path -Parent $dir
    }
    return $null
}
$obsidianRoot = Get-ObsidianRoot (Split-Path -Parent $Path)
if (-not $obsidianRoot) {
    Write-Host "    提示：没找到 .obsidian 文件夹，图片只会在文章同目录里找。"
    $obsidianRoot = Split-Path -Parent $Path
}

# ---------- 3. 处理图片 ----------
$imgDir = Join-Path $repoRoot "public\images"
New-Item -ItemType Directory -Force -Path $imgDir | Out-Null

$imgRefs = [regex]::Matches($content, '!\[\[(.+?\.(?:png|jpe?g|gif|webp|svg))(?:\|\d+x\d+)?\]\]')
Write-Host ("== 2/4 处理图片（共找到 {0} 张）==" -f $imgRefs.Count)

$handled = @{}
foreach ($m in $imgRefs) {
    $imgName = $m.Groups[1].Value

    # 同一张图被引用多次，只处理一次
    if ($handled.ContainsKey($imgName)) {
        $content = $content.Replace($m.Value, $handled[$imgName])
        continue
    }

    # 找图片：先在文章同目录找，找不到再全 Obsidian 仓库搜
    $srcImg = Get-ChildItem -Path (Split-Path -Parent $Path) -Recurse -File -Filter $imgName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $srcImg) {
        $srcImg = Get-ChildItem -Path $obsidianRoot -Recurse -File -Filter $imgName -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $srcImg) {
        Write-Host "    [跳过] 没找到图片：$imgName（请手动处理）"
        continue
    }

    $base = [System.IO.Path]::GetFileNameWithoutExtension($imgName)
    $ext = [System.IO.Path]::GetExtension($imgName).ToLower()
    $destName = "$base$ext"
    $destPath = Join-Path $imgDir $destName

    # 大图自动压缩：PNG 超过 300KB 转成 JPG（网页加载更快）
    if ($srcImg.Length -gt 300KB -and $ext -eq ".png") {
        $destName = "$base.jpg"
        $destPath = Join-Path $imgDir $destName
        try {
            Add-Type -AssemblyName System.Drawing
            $img = [System.Drawing.Image]::FromFile($srcImg.FullName)
            $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.Clear([System.Drawing.Color]::White)
            $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
            $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
            $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
            $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
            $bmp.Save($destPath, $codec, $ep)
            $g.Dispose(); $bmp.Dispose(); $img.Dispose()
            Write-Host ("    [压缩] {0}  ({1:N0}KB -> {2:N0}KB)" -f $imgName, ($srcImg.Length / 1KB), ((Get-Item $destPath).Length / 1KB))
        } catch {
            $destName = "$base$ext"
            $destPath = Join-Path $imgDir $destName
            Copy-Item $srcImg.FullName $destPath -Force
            Write-Host "    [复制] 压缩失败，已用原图：$imgName"
        }
    } else {
        Copy-Item $srcImg.FullName $destPath -Force
        Write-Host "    [复制] $imgName"
    }

    $ref = "/images/$destName"
    $newSyntax = "`n`n![$base]($ref)`n`n"
    $content = $content.Replace($m.Value, $newSyntax)
    $handled[$imgName] = $newSyntax
}

# ---------- 4. 双链转文字 + 自动补 frontmatter ----------
Write-Host "== 3/4 整理内容 =="
$content = [regex]::Replace($content, '\[\[([^\[\]|]+)(?:\|[^\[\]]+)?\]\]', '$1')

$fileName = [System.IO.Path]::GetFileName($Path)
$hasFrontmatter = $content -match '^\s*---\s*\r?\n'
if (-not $hasFrontmatter) {
    $today = Get-Date -Format "yyyy-MM-dd"
    $title = [System.IO.Path]::GetFileNameWithoutExtension($fileName)
    $frontmatter = "---`ntitle: $title`ndate: $today`ndescription: ''`n---`n`n"
    $content = $frontmatter + $content
    Write-Host "    已自动补上文章信息（title/date），需要的话你自己再改。"
} else {
    Write-Host "    文章已有 frontmatter，保留。"
}

# ---------- 5. 写入博客 ----------
$destMd = Join-Path $repoRoot ("src\content\blog\" + $fileName)
[System.IO.File]::WriteAllText($destMd, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "== 4/4 完成！文章已保存到 src\content\blog\$fileName =="
Write-Host ""
$auto = Read-Host "要自动执行 git add . 和 git commit 吗？(y=执行，其他=跳过)"
if ($auto -eq "y" -or $auto -eq "Y") {
    Push-Location $repoRoot
    git add -A
    git commit -m "上传新文章"
    Pop-Location
    Write-Host ""
    Write-Host "已自动提交。现在只剩最后一步（PowerShell 里输入）："
    Write-Host "    git push"
} else {
    Write-Host ""
    Write-Host "已跳过自动提交，请手动执行（PowerShell 里依次输入）："
    Write-Host "    cd D:\A学习\大一暑假\dsh\takinol.github.io"
    Write-Host "    git add ."
    Write-Host "    git commit -m ""上传新文章"""
    Write-Host "    git push"
}
Write-Host ""
Read-Host "按回车键关闭窗口"
