# FrameForge 发布前检查：类型检查、自检、构建、可选打包 + 关键配置体检。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -Package
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\preflight.ps1 -NodePath "C:\...\node.exe"
param(
  [string] $NodePath = 'node',
  [switch] $Package
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$failed = $false

function Say([string]$s) { Write-Host $s }
function Ok([string]$s) { Write-Host "[OK]   $s" -ForegroundColor Green }
function Warn([string]$s) { Write-Host "[WARN] $s" -ForegroundColor Yellow }
function Bad([string]$s) { Write-Host "[FAIL] $s" -ForegroundColor Red; $script:failed = $true }

function Run([string]$label, [string[]]$argsList) {
  Say "--- $label ---"
  & $NodePath @argsList
  if ($LASTEXITCODE -ne 0) { Bad "$label failed (exit $LASTEXITCODE)" }
  else { Ok "$label" }
  Say ''
}

Say "FrameForge preflight"
Say "root = $root"
Say ''

# ---- 关键配置体检 ----
if (-not (Test-Path (Join-Path $root 'build\icon.ico'))) {
  Warn 'build\icon.ico missing: run scripts\gen-icon.ps1 then node scripts\make-ico.mjs'
} else {
  Ok 'build\icon.ico present'
}

$eb = Get-Content (Join-Path $root 'electron-builder.yml') -Raw
if ($eb -match 'signAndEditExecutable:\s*false') {
  Warn 'signAndEditExecutable=false is set (for dev machines without symlink privilege). For a real release, enable Windows Developer Mode and remove this line so the exe gets the icon and version info.'
}
if ($eb -match 'owner:\s*frameforge-studio') {
  Warn 'publish.owner/repo in electron-builder.yml is still the placeholder; set it to your real GitHub repo before publishing updates.'
}

# ---- 验证链 ----
Run 'typecheck (node)' @('node_modules\typescript\bin\tsc', '--noEmit', '-p', 'tsconfig.node.json')
Run 'typecheck (web)' @('node_modules\typescript\bin\tsc', '--noEmit', '-p', 'tsconfig.web.json')
Run 'selftest' @('scripts\selftest.mts')
Run 'build' @('node_modules\electron-vite\bin\electron-vite.js', 'build')

if ($Package) {
  Run 'electron-builder --win' @('node_modules\electron-builder\cli.js', '--win')
  $installer = Get-ChildItem (Join-Path $root 'release') -Filter '*Setup*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  $yml = Join-Path $root 'release\latest.yml'
  if (-not $installer) { Bad 'no NSIS installer found in release/' }
  else { Ok ("installer: " + $installer.Name + ' (' + [math]::Round($installer.Length / 1MB, 1) + ' MB)') }
  if (Test-Path $yml) { Ok 'release\latest.yml present (auto-update metadata)' }
  else { Bad 'release\latest.yml missing' }
}

Say ''
if ($failed) { Say 'PREFLIGHT FAILED' -ForegroundColor Red; exit 1 }
Say 'PREFLIGHT OK' -ForegroundColor Green
