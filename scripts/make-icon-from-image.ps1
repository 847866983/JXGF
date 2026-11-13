# 从一张 PNG 生成多尺寸 Windows ICO（256/128/64/48/32/16），并输出 256 PNG 预览。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icon-from-image.ps1 -InputImage "路径.png" -OutIco "build/icon.ico"
param(
  [Parameter(Mandatory = $true)][string] $InputImage,
  [string] $OutIco = 'build\icon.ico',
  [string] $OutPng = 'build\icon.png'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outIcoPath = if ([System.IO.Path]::IsPathRooted($OutIco)) { $OutIco } else { Join-Path $root $OutIco }
$outPngPath = if ([System.IO.Path]::IsPathRooted($OutPng)) { $OutPng } else { Join-Path $root $OutPng }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outIcoPath) | Out-Null

$sizes = @(256, 128, 64, 48, 32, 16)
$src = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $InputImage))

function Resize-PngBytes([System.Drawing.Image]$image, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  # 先铺白/透明底（保留原图）
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($image, 0, 0, $size, $size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

# 生成各尺寸 PNG 字节
$pngDatas = @()
foreach ($s in $sizes) {
  $pngDatas += ,(Resize-PngBytes $src $s)
}
# 256 尺寸单独存为预览
[System.IO.File]::WriteAllBytes($outPngPath, $pngDatas[0])
$src.Dispose()

# 组装 ICO（ICONDIR + N×ICONDIRENTRY + PNG 数据）
$count = $sizes.Count
$totalSize = 6 + 16 * $count
foreach ($d in $pngDatas) { $totalSize += $d.Length }
$buf = New-Object byte[] $totalSize
$off = 0
# ICONDIR
$buf[0] = 0; $buf[1] = 0; $buf[2] = 1; $buf[3] = 0
$buf[4] = [byte]$count; $buf[5] = 0
$off = 6
$imgOffset = 6 + 16 * $count
$idx = 0
foreach ($s in $sizes) {
  $data = $pngDatas[$idx]
  # ICONDIRENTRY
  $dim = if ($s -ge 256) { 0 } else { [byte]$s }
  $buf[$off] = $dim          # width
  $buf[$off + 1] = $dim      # height
  $buf[$off + 2] = 0         # colorCount
  $buf[$off + 3] = 0         # reserved
  $buf[$off + 4] = 1; $buf[$off + 5] = 0   # planes
  $buf[$off + 6] = 32; $buf[$off + 7] = 0   # bitCount
  [Array]::Copy([BitConverter]::GetBytes([uint32]$data.Length), 0, $buf, $off + 8, 4)
  [Array]::Copy([BitConverter]::GetBytes([uint32]$imgOffset), 0, $buf, $off + 12, 4)
  $off += 16
  [Array]::Copy($data, 0, $buf, $imgOffset, $data.Length)
  $imgOffset += $data.Length
  $idx++
}
[System.IO.File]::WriteAllBytes($outIcoPath, $buf)
Write-Host "OK -> $outIcoPath ($($buf.Length) bytes, $count sizes)"
Write-Host "PNG preview -> $outPngPath"
