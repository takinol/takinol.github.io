# ============================================================
#  upload-post.ps1 —— 把一篇 Obsidian 笔记（含图片）一键搬进博客仓库
#
#  用法（三种任选）：
#    1) 双击「上传文章.bat」，粘贴笔记的绝对路径，回车
#    2) 把 .md 文件直接拖到「上传文章.bat」图标上
#    3) powershell -ExecutionPolicy Bypass -File upload-post.ps1 -Path "D:\...\笔记.md"
#
#  它会自动做完这些事：
#    1) 找出笔记里的图片（![[...]] / ![](...) 都支持），复制到 public\images\
#       - 大 PNG 自动压成 JPG；文件名里的空格换成 -（否则网页链接会断）
#       - 不同文章的同名图片不会互相覆盖，自动加 -2 后缀
#    2) 把图片语法改写成网页能显示的 ![](/images/xxx)
#    3) 把 Obsidian 专有语法转成标准 Markdown：
#       [[双链]] -> 文字、![[笔记]] -> 文字、> [!info] 提示块 -> 加粗引用、%%注释%% 删除
#    4) 修正 frontmatter：补 title/date，把 tags: [a, b] 改成列表写法
#       （不改的话站点会解析失败，整篇文章被跳过）
#    5) 自动 git add + git commit —— 你只需要最后敲一次 git push
#
#  可选参数：
#    -NoCommit     只导入文件，不自动提交
#    -SkipMissing  有图片找不到时也继续（默认会中止，避免上线后图裂）
# ============================================================

param(
    [string]$Path = "",
    [switch]$NoCommit,
    [switch]$SkipMissing
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$repoRoot = $PSScriptRoot
$blogDir  = Join-Path $repoRoot "src\content\blog"
$imgDir   = Join-Path $repoRoot "public\images"
$assetExts = @(".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif")

function Write-Head($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" }
function Write-Note($text) { Write-Host "    [!] $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "    [x] $text" -ForegroundColor Red }

# ---------- 1. 拿到笔记路径 ----------
if (-not $Path) {
    Write-Host ""
    Write-Host "把 Obsidian 笔记的绝对路径粘贴进来（也可以直接把 .md 文件拖进这个窗口）：" -ForegroundColor Cyan
    $Path = Read-Host "路径"
}
if (-not $Path) { Write-Bad "没有输入路径，已退出。"; exit 1 }

# 去掉复制时带上的引号、首尾空格
$Path = $Path.Trim().Trim('"').Trim("'").Trim()
if (-not (Test-Path -LiteralPath $Path)) { Write-Bad "找不到这个文件：$Path"; exit 1 }

$srcItem = Get-Item -LiteralPath $Path
if ($srcItem.PSIsContainer) { Write-Bad "这是一个文件夹，需要的是 .md 文件。"; exit 1 }
if ($srcItem.Extension.ToLower() -ne ".md") { Write-Bad "不是 .md 文件：$($srcItem.Name)"; exit 1 }

$srcPath = $srcItem.FullName
$mdDir   = Split-Path -Parent $srcPath

if (-not (Test-Path -LiteralPath $blogDir)) { Write-Bad "没找到文章目录：$blogDir（脚本要放在博客仓库根目录）"; exit 1 }
if (-not (Test-Path -LiteralPath $imgDir)) { New-Item -ItemType Directory -Force -Path $imgDir | Out-Null }

# 落地文件名：空格换成 -（否则文章网址里会出现 %20），去掉 Windows 不允许的字符
$fileName = [System.IO.Path]::GetFileName($srcPath)
$safeFileName = ($fileName -replace '\s+', '-') -replace '-{2,}', '-'
$safeFileName = $safeFileName -replace '[\\/:*?"<>|]', ''
$destMd  = Join-Path $blogDir $safeFileName
$existed = Test-Path -LiteralPath $destMd

Write-Head "== 1/5 读取笔记 =="
Write-Ok "来源：$srcPath"
if ($safeFileName -ne $fileName) { Write-Ok "文件名里的空格已换成 -：$safeFileName" }

$raw = [System.IO.File]::ReadAllText($srcPath, [System.Text.Encoding]::UTF8)
# 统一换行，避免 \r 混进正文
$raw = $raw -replace "`r`n", "`n" -replace "`r", "`n"
$content = $raw

# ---------- 2. 找 Obsidian 仓库根 ----------
function Get-VaultRoot([string]$start) {
    $dir = $start
    while ($dir) {
        if (Test-Path -LiteralPath (Join-Path $dir ".obsidian")) { return $dir }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

$vaultRoot = Get-VaultRoot $mdDir
if (-not $vaultRoot) {
    Write-Note "没找到 .obsidian 文件夹，只在笔记所在目录里找图片。"
    $vaultRoot = $mdDir
} else {
    Write-Ok "Obsidian 仓库：$vaultRoot"
}

# 全库图片索引（只建一次，避免每张图都递归扫一遍）
$script:assetIndex = $null
function Get-AssetIndex() {
    if ($null -ne $script:assetIndex) { return $script:assetIndex }
    $idx = @{}
    if ($vaultRoot -and (Test-Path -LiteralPath $vaultRoot)) {
        Get-ChildItem -LiteralPath $vaultRoot -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            if ($assetExts -contains $_.Extension.ToLower()) {
                $k = $_.Name.ToLower()
                if (-not $idx.ContainsKey($k)) { $idx[$k] = New-Object System.Collections.ArrayList }
                [void]$idx[$k].Add($_.FullName)
            }
        }
    }
    $script:assetIndex = $idx
    return $idx
}

function Resolve-Asset([string]$target) {
    $t = $target.Trim()
    # 绝对路径（D:\... 或 D:/...）直接检查
    if ($t -match '^[A-Za-z]:[\\/]' -or $t.StartsWith("\\")) {
        $abs = $t -replace "/", "\"
        if (Test-Path -LiteralPath $abs -PathType Leaf) { return (Get-Item -LiteralPath $abs).FullName }
        return $null
    }
    $t = $t -replace "/", "\"
    $cands = New-Object System.Collections.ArrayList
    [void]$cands.Add((Join-Path $mdDir $t))
    if ($vaultRoot -ne $mdDir) { [void]$cands.Add((Join-Path $vaultRoot $t)) }
    foreach ($c in $cands) {
        if (Test-Path -LiteralPath $c -PathType Leaf) { return (Get-Item -LiteralPath $c).FullName }
    }

    $idx = Get-AssetIndex
    $leaf = ($t -split "\\")[-1].ToLower()
    if ($idx.ContainsKey($leaf)) {
        $list = $idx[$leaf]
        if ($list.Count -eq 1) { return $list[0] }
        # 同名多份：优先路径能对上的那个
        $want = $t.ToLower()
        foreach ($p in $list) {
            if ($p.ToLower().EndsWith($want)) { return $p }
        }
        Write-Note "同名图片有多份，取第一个：$target"
        return $list[0]
    }
    return $null
}

# ---------- 3. 复制图片 ----------
$copiedBySource = @{}
$webByHash      = @{}
$addedFiles     = New-Object System.Collections.ArrayList

function Get-DestName([string]$base, [string]$ext, [string]$hash) {
    $name = "$base$ext"
    $n = 2
    while (Test-Path -LiteralPath (Join-Path $imgDir $name)) {
        $p = Join-Path $imgDir $name
        if ((Get-FileHash -LiteralPath $p -Algorithm SHA1).Hash -eq $hash) {
            return @{ name = $name; reuse = $true }
        }
        $name = "$base-$n$ext"
        $n++
    }
    return @{ name = $name; reuse = $false }
}

function Import-Asset([string]$src) {
    $key = $src.ToLower()
    if ($copiedBySource.ContainsKey($key)) { return $copiedBySource[$key] }

    $hash = (Get-FileHash -LiteralPath $src -Algorithm SHA1).Hash
    if ($webByHash.ContainsKey($hash)) {
        $copiedBySource[$key] = $webByHash[$hash]
        Write-Ok "复用已复制过的图片：$($webByHash[$hash])"
        return $webByHash[$hash]
    }

    $base = [System.IO.Path]::GetFileNameWithoutExtension($src)
    $base = ($base -replace "\s+", "-") -replace '[#?%&]', ''
    if (-not $base) { $base = "image" }

    $origExt = [System.IO.Path]::GetExtension($src).ToLower()
    $ext = $origExt
    $size = (Get-Item -LiteralPath $src).Length
    # 大 PNG 转 JPG，网页加载更快（透明底会填成白色）
    $toJpg = ($ext -eq ".png" -and $size -gt 300KB)
    if ($toJpg) { $ext = ".jpg" }

    $pick = Get-DestName $base $ext $hash
    if ($pick.reuse) {
        $copiedBySource[$key] = "/images/$($pick.name)"
        $webByHash[$hash] = "/images/$($pick.name)"
        Write-Ok "图片已在仓库里：$($pick.name)"
        return "/images/$($pick.name)"
    }

    $destPath = Join-Path $imgDir $pick.name
    $done = $false
    if ($toJpg) {
        try {
            Add-Type -AssemblyName System.Drawing
            $img = [System.Drawing.Image]::FromFile($src)
            $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.Clear([System.Drawing.Color]::White)
            $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
            $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
            $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
            $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
            $bmp.Save($destPath, $codec, $ep)
            $g.Dispose(); $bmp.Dispose(); $img.Dispose()
            Write-Ok ("压缩 {0}  {1:N0}KB -> {2:N0}KB" -f [System.IO.Path]::GetFileName($src), ($size / 1KB), ((Get-Item -LiteralPath $destPath).Length / 1KB))
            $done = $true
        } catch {
            if (Test-Path -LiteralPath $destPath) { Remove-Item -LiteralPath $destPath -Force -ErrorAction SilentlyContinue }
            # 压缩失败就存原图
            $pick = Get-DestName $base $origExt $hash
            $destPath = Join-Path $imgDir $pick.name
            Copy-Item -LiteralPath $src -Destination $destPath -Force
            Write-Ok "压缩失败，已存原图：$($pick.name)"
            $done = $true
        }
    }
    if (-not $done) {
        Copy-Item -LiteralPath $src -Destination $destPath -Force
        Write-Ok "复制 $([System.IO.Path]::GetFileName($src)) -> $($pick.name)"
    }

    [void]$addedFiles.Add($destPath)
    $copiedBySource[$key] = "/images/$($pick.name)"
    $webByHash[$hash] = "/images/$($pick.name)"
    return "/images/$($pick.name)"
}

# ---------- 4. 改写正文里的图片 / 双链 ----------
Write-Head "== 2/5 处理图片 =="
$missing = New-Object System.Collections.ArrayList
$imageCount = 0

# 4.1 Obsidian 嵌入：![[图.png]]、![[图.png|300]]、![[图.png|300x200]]、![[图.png#anchor|300]]、![[笔记]]
$embedRe = [regex]'!\[\[(?<target>[^\]\|#]+?)(?:#(?<anchor>[^\]\|]*))?(?:\|(?<alt>[^\]]*))?\]\]'
$sb = New-Object System.Text.StringBuilder
$pos = 0
foreach ($m in $embedRe.Matches($content)) {
    [void]$sb.Append($content.Substring($pos, $m.Index - $pos))
    $target = $m.Groups["target"].Value.Trim()
    $altRaw = $m.Groups["alt"].Value.Trim()
    $ext = [System.IO.Path]::GetExtension($target).ToLower()

    if ($assetExts -contains $ext) {
        $found = Resolve-Asset $target
        if ($found) {
            $web = Import-Asset $found
            $altText = [System.IO.Path]::GetFileNameWithoutExtension($found)
            if ($altRaw -and $altRaw -notmatch '^\d+(x\d+)?$') { $altText = $altRaw }
            $altText = $altText -replace "[\[\]]", ""
            $repl = "`n`n![$altText]($web)`n`n"
            $imageCount++
        } else {
            [void]$missing.Add($target)
            if ($SkipMissing) {
                $repl = "`n`n> [图片缺失：$target]`n`n"
            } else {
                $repl = $m.Value
            }
        }
    } else {
        # 非图片嵌入（笔记 / base 文件等）：退化成纯文字，别留 ![[]]
        $name = ($target -split "[\\/]")[-1]
        $name = [System.IO.Path]::GetFileNameWithoutExtension($name)
        if ($altRaw -and $altRaw -notmatch '^\d+(x\d+)?$') { $name = $altRaw }
        $repl = $name
    }
    [void]$sb.Append($repl)
    $pos = $m.Index + $m.Length
}
[void]$sb.Append($content.Substring($pos))
$content = $sb.ToString()

# 4.2 标准 Markdown 图片：![](相对路径/图.png) —— 跳过网络图和已处理过的 /images/
#     注意路径里可能有空格（中文文件名很常见），所以用 [^)]+ 整段吃掉，再自己剥掉 "标题"
$mdImgRe = [regex]'!\[(?<alt>[^\]]*)\]\((?<src>[^)\r\n]+)\)'
$sb = New-Object System.Text.StringBuilder
$pos = 0
foreach ($m in $mdImgRe.Matches($content)) {
    [void]$sb.Append($content.Substring($pos, $m.Index - $pos))
    $src = $m.Groups["src"].Value.Trim()
    $alt = $m.Groups["alt"].Value
    $title = [regex]::Match($src, '^(?<u>.+?)\s+"[^"]*"$')
    if ($title.Success) { $src = $title.Groups["u"].Value.Trim() }
    $src = $src.Trim()
    if ($src.StartsWith("<") -and $src.EndsWith(">")) { $src = $src.Substring(1, $src.Length - 2).Trim() }
    $repl = $m.Value
    if ($src -notmatch '^(https?:|data:|//|/images/)') {
        $found = Resolve-Asset ([System.Uri]::UnescapeDataString($src))
        if ($found) {
            $web = Import-Asset $found
            if (-not $alt) { $alt = [System.IO.Path]::GetFileNameWithoutExtension($found) }
            $repl = "![$alt]($web)"
            $imageCount++
        } elseif (-not $SkipMissing) {
            [void]$missing.Add($src)
        }
    }
    [void]$sb.Append($repl)
    $pos = $m.Index + $m.Length
}
[void]$sb.Append($content.Substring($pos))
$content = $sb.ToString()

Write-Ok "处理了 $imageCount 张图片"

# ---------- 5. 正文里的 Obsidian 语法 ----------
Write-Head "== 3/5 整理正文 =="

# 只在代码块外面做替换，避免把代码里的 == 之类改坏
function Edit-OutsideCode([string]$text, [scriptblock]$fn) {
    $out = New-Object System.Text.StringBuilder
    $buf = New-Object System.Text.StringBuilder
    $inFence = $false
    foreach ($line in ($text -split "`n")) {
        $isFence = $line -match '^\s*(```|~~~)'
        if ($isFence) {
            if (-not $inFence) {
                [void]$out.Append((& $fn $buf.ToString()))
                [void]$buf.Clear()
                $inFence = $true
            } else {
                $inFence = $false
            }
            [void]$out.Append($line + "`n")
        } elseif ($inFence) {
            [void]$out.Append($line + "`n")
        } else {
            [void]$buf.Append($line + "`n")
        }
    }
    if ($buf.Length -gt 0) { [void]$out.Append((& $fn $buf.ToString())) }
    return $out.ToString()
}

$content = Edit-OutsideCode $content {
    param($chunk)
    # Obsidian 注释 %%...%% 不发布
    $chunk = [regex]::Replace($chunk, '(?s)%%[\s\S]*?%%', '')
    # 提示块 > [!info] 标题 -> > **标题**
    $chunk = [regex]::Replace($chunk, '(?m)^>\s*\[![A-Za-z]+\][+-]?[ \t]*(?<t>.*)$', {
        param($mm)
        $t = $mm.Groups["t"].Value.Trim()
        if ($t) { return "> **$t**" } else { return ">" }
    })
    # 剩下的 [[双链]] / [[笔记|别名]] -> 纯文字
    $chunk = [regex]::Replace($chunk, '\[\[(?<t>[^\[\]\|#]+)(?:#[^\[\]\|]*)?(?:\|(?<a>[^\[\]]+))?\]\]', {
        param($mm)
        $a = $mm.Groups["a"].Value
        if ($a) { return $a }
        return $mm.Groups["t"].Value
    })
    # 图片前后塞了空行，压掉连续空行，正文更干净
    $chunk = $chunk -replace "\n{3,}", "`n`n"
    return $chunk
}

# ---------- 6. 修 frontmatter ----------
$fmRe = [regex]'\A---\n(?<fm>[\s\S]*?)\n---[ \t]*(?:\n|$)'
$fmMatch = $fmRe.Match($content)
if ($fmMatch.Success) {
    $fmText = $fmMatch.Groups["fm"].Value
    $body = $content.Substring($fmMatch.Length)
} else {
    $fmText = ""
    $body = $content
}

# 标题：优先已有 title，其次正文第一个 # 标题，最后用文件名
$title = $null
$tm = [regex]::Match($fmText, '(?m)^title:\s*(.+?)\s*$')
if ($tm.Success) { $title = $tm.Groups[1].Value.Trim().Trim('"').Trim("'") }
if (-not $title) {
    $hm = [regex]::Match($body, '(?m)^#\s+(.+?)\s*$')
    if ($hm.Success) { $title = $hm.Groups[1].Value.Trim() }
}
if (-not $title) { $title = [System.IO.Path]::GetFileNameWithoutExtension($srcPath) }
$title = $title.Trim()

# 日期：笔记里已有就保留；没有的话，若这篇以前导入过就沿用旧日期（避免重复导入把发布日期改成今天）
$dateValue = $null
$dm = [regex]::Match($fmText, '(?m)^date:\s*(.+?)\s*$')
if ($dm.Success) { $dateValue = $dm.Groups[1].Value.Trim().Trim('"').Trim("'") }
if (-not $dateValue -and $existed) {
    $oldText = [System.IO.File]::ReadAllText($destMd, [System.Text.Encoding]::UTF8)
    $od = [regex]::Match($oldText, '(?m)^date:\s*(.+?)\s*$')
    if ($od.Success) { $dateValue = $od.Groups[1].Value.Trim().Trim('"').Trim("'") }
}
if (-not $dateValue) { $dateValue = (Get-Date -Format "yyyy-MM-dd") }

# 逐行过一遍 frontmatter：去掉 title/date（后面统一重写），把 tags 行内数组拆成列表
$rest = New-Object System.Collections.ArrayList
$tagFixed = $false
foreach ($line in ($fmText -split "`n")) {
    if ($line -match '^\s*$') { continue }
    if ($line -match '^title:') { continue }
    if ($line -match '^date:') { continue }

    $kv = [regex]::Match($line, '^(?<k>tags?):\s*(?<v>.*)$')
    if ($kv.Success) {
        $key = $kv.Groups["k"].Value
        $val = $kv.Groups["v"].Value.Trim()
        if ($key -eq "tag") { $key = "tags" }

        $isInlineArray = $false
        if ($val -match '^\[(.*)\]$') {
            $val = $Matches[1].Trim()
            $isInlineArray = $true
        }
        # tags: [a, b] / tags: a, b  ->  列表写法；tags: []  ->  留空（站点会解析成空数组）
        if ($isInlineArray -or ($val -and -not $val.StartsWith("-"))) {
            $items = @()
            if ($val) { $items = $val -split '[,，]' }
            [void]$rest.Add("$key`:")
            foreach ($it in $items) {
                $it = $it.Trim().Trim('"').Trim("'")
                if ($it) { [void]$rest.Add("  - $it") }
            }
            $tagFixed = $true
            continue
        }
        [void]$rest.Add($line)
        continue
    }
    [void]$rest.Add($line)
}

$safeTitle = $title -replace '"', "'"
$newFm = "title: `"$safeTitle`"`ndate: $dateValue"
if ($rest.Count -gt 0) { $newFm = $newFm + "`n" + ($rest -join "`n") }
if ($tagFixed) { Write-Ok "已把 tags 行内数组改成列表写法（站点才能正确解析）" }

# 正文开头如果有一个和标题重复的 # 标题，去掉（页面本身会显示标题）
$body = $body -replace '^\s*\n+', ''
$h1 = [regex]::Match($body, '\A#\s+(.+?)[ \t]*\n')
if ($h1.Success) {
    $h1Text = $h1.Groups[1].Value.Trim()
    if ($h1Text -eq $title) {
        $body = $body.Substring($h1.Length)
    } else {
        # 不重复但也是 h1：降成 h2，避免页面里出现两个一级标题，顺便能进右侧目录
        $body = "## " + $h1.Groups[1].Value + "`n" + $body.Substring($h1.Length)
    }
}
$body = $body.Trim()

$out = "---`n" + $newFm + "`n---`n`n" + $body + "`n"

# ---------- 7. 有图找不到就停下 ----------
if ($missing.Count -gt 0 -and -not $SkipMissing) {
    Write-Head "== 中止 =="
    Write-Bad "有 $($missing.Count) 张图片找不到，已停止写入（避免上线后图裂）："
    foreach ($x in $missing) { Write-Host "      - $x" -ForegroundColor Yellow }
    # 把这次刚复制进 public\images 的图撤掉，别留一堆没用的文件
    foreach ($f in $addedFiles) {
        if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
    }
    Write-Host ""
    Write-Host "  请确认这些图片还在 Obsidian 仓库里；确实要跳过就加 -SkipMissing 参数。" -ForegroundColor DarkGray
    exit 1
}

# ---------- 8. 写入仓库 ----------
Write-Head "== 4/5 写入仓库 =="
# 换行用 CRLF：跟仓库里现有文章的检出状态一致，提交时不会冒出 LF/CRLF 警告
$outFinal = $out -replace "`n", "`r`n"
[System.IO.File]::WriteAllText($destMd, $outFinal, (New-Object System.Text.UTF8Encoding($false)))
if ($existed) {
    Write-Ok "已更新：src\content\blog\$safeFileName"
} else {
    Write-Ok "已新建：src\content\blog\$safeFileName"
}

# ---------- 9. 自动提交 ----------
Write-Head "== 5/5 提交到 git =="
$commitHash = $null
if ($NoCommit) {
    Write-Note "已指定 -NoCommit，跳过提交。"
} else {
    Push-Location $repoRoot
    try {
        git rev-parse --is-inside-work-tree *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Note "当前目录不是 git 仓库，已跳过提交。"
        } else {
            $paths = @($destMd)
            foreach ($p in $addedFiles) { $paths += $p }
            git add -- $paths
            if ($LASTEXITCODE -ne 0) {
                Write-Note "git add 失败，请手动提交。"
            } else {
                git diff --cached --quiet
                if ($LASTEXITCODE -eq 0) {
                    Write-Note "内容没有变化，不需要提交。"
                } else {
                    # 只提交这次涉及的文件，别把别的改动一起带进去
                    git commit -m "上传文章：$title" -- $paths *> $null
                    if ($LASTEXITCODE -eq 0) {
                        $commitHash = (git rev-parse --short HEAD)
                        Write-Ok "已提交：$commitHash  上传文章：$title"
                    } else {
                        Write-Note "git commit 失败（检查一下 git 用户名/邮箱是否配置）。"
                    }
                }
            }
        }
    } finally {
        Pop-Location
    }
}

# ---------- 10. 收尾 ----------
Write-Head "== 完成 =="
Write-Host ("    文章：{0}" -f $safeFileName)
Write-Host ("    图片：{0} 张" -f $imageCount)
if ($missing.Count -gt 0) {
    Write-Host ("    缺失：{0} 张（已按 -SkipMissing 跳过）" -f $missing.Count) -ForegroundColor Yellow
}
Write-Host ""
if ($commitHash) {
    Write-Host "  现在只剩最后一步：" -ForegroundColor Green
    Write-Host "      git push" -ForegroundColor Green
} else {
    Write-Host "  还需要手动提交并推送：" -ForegroundColor Yellow
    Write-Host "      git add . ; git commit -m `"上传文章`" ; git push" -ForegroundColor Yellow
}
Write-Host ""
