# 生成 FrameForge 应用图标：build/icon.png（256）+ build/icon.ico（含 256 PNG 条目）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-icon.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$pngPath = Join-Path $build 'icon.png'
$icoPath = Join-Path $build 'icon.ico'

Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角背景
$rect = New-Object System.Drawing.Rectangle 12, 12, 232, 232
$r = 52
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $r * 2, $r * 2, 180, 90)
$path.AddArc($rect.Right - $r * 2, $rect.Y, $r * 2, $r * 2, 270, 90)
$path.AddArc($rect.Right - $r * 2, $rect.Bottom - $r * 2, $r * 2, $r * 2, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $r * 2, $r * 2, $r * 2, 90, 90)
$path.CloseFigure()

$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 124, 92, 255))
$g.FillPath($bg, $path)

# 白色播放三角
$pts = @(
  (New-Object System.Drawing.PointF 102, 74),
  (New-Object System.Drawing.PointF 102, 182),
  (New-Object System.Drawing.PointF 184, 128)
)
$fg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillPolygon($fg, [System.Drawing.PointF[]]$pts)

$g.Dispose()
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# 组装 ICO（单条目，256x256 PNG 压缩，Windows Vista+ 有效）
$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$total = 22 + $pngBytes.Length
$all = New-Object byte[] $total
[Array]::Copy([byte[]](0, 0, 1, 0, 1, 0), 0, $all, 0, 6)                 # ICONDIR
[Array]::Copy([byte[]](0, 0, 0, 0, 1, 0, 32, 0), 0, $all, 6, 8)         # 条目前 8 字节
[Array]::Copy([BitConverter]::GetBytes([uint32]$pngBytes.Length), 0, $all, 14, 4)  # size
[Array]::Copy([BitConverter]::GetBytes([uint32]22), 0, $all, 18, 4)                # offset
[Array]::Copy($pngBytes, 0, $all, 22, $pngBytes.Length)                 # PNG 数据
[System.IO.File]::WriteAllBytes($icoPath, $all)

Write-Host "icon.png -> $pngPath ($((Get-Item $pngPath).Length) bytes)"
Write-Host "icon.ico -> $icoPath ($((Get-Item $icoPath).Length) bytes)"
