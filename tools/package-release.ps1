# Build a portable, self-contained zip for release (ASCII-only for PS 5.1 safety)
# Usage: powershell -ExecutionPolicy Bypass -File tools\package-release.ps1
#   -Version 0.1.0
#   -ElectronDir <path to an unpacked electron dist>   (default: %USERPROFILE%\.dsh\electron)
#   -Out <zip path>                                    (default: dist\PokePet-v<ver>-win64.zip)

param(
  [string]$Version = '0.1.0',
  [string]$ElectronDir = (Join-Path $env:USERPROFILE '.dsh\electron'),
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Out) { $Out = Join-Path $root ('dist\PokePet-v' + $Version + '-win64.zip') }

Write-Host ''
Write-Host '== package-release ==' -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $ElectronDir 'electron.exe'))) {
  throw "Not an electron dist: $ElectronDir"
}
foreach ($need in @('app', 'assets')) {
  if (-not (Test-Path (Join-Path $root $need))) { throw "Missing folder: $need" }
}
if (-not (Test-Path (Join-Path $root 'app\pmd'))) {
  Write-Warning 'app\pmd is empty - the zip will show placeholder cards only.'
}

$stage = Join-Path $root 'dist\PokePet'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Write-Host '[1/5] copying electron runtime...'
& robocopy $ElectronDir $stage /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

Write-Host '[2/5] trimming locales...'
$loc = Join-Path $stage 'locales'
if (Test-Path $loc) {
  Get-ChildItem $loc -Filter *.pak | Where-Object { $_.BaseName -notin @('en-US', 'zh-CN', 'zh-TW') } | Remove-Item -Force
}

Write-Host '[3/5] installing app + assets...'
$res = Join-Path $stage 'resources'
New-Item -ItemType Directory -Path $res -Force | Out-Null
$resApp = Join-Path $res 'app'
if (Test-Path $resApp) { Remove-Item $resApp -Recurse -Force }
& robocopy (Join-Path $root 'app') $resApp /E /XD pmd cries /NFL /NDL /NJH /NJS /NP | Out-Null
& robocopy (Join-Path $root 'app\pmd') (Join-Path $resApp 'pmd') /E /NFL /NDL /NJH /NJS /NP | Out-Null
& robocopy (Join-Path $root 'app\cries') (Join-Path $resApp 'cries') /E /NFL /NDL /NJH /NJS /NP | Out-Null
& robocopy (Join-Path $root 'assets') (Join-Path $res 'assets') /E /NFL /NDL /NJH /NJS /NP | Out-Null

Write-Host '[4/5] renaming launcher...'
Move-Item (Join-Path $stage 'electron.exe') (Join-Path $stage 'PokePet.exe') -Force
$asar = Join-Path $res 'default_app.asar'
if (Test-Path $asar) { Remove-Item $asar -Force }

$readme = @(
  'PokePet - a desktop pet with 1025 Pokemon.',
  '',
  'Run PokePet.exe. First launch may trigger SmartScreen:',
  'click "More info" then "Run anyway" (the app is not code-signed).',
  '',
  'Right-click the pet for the menu. Left-click the tray icon to open the picker.',
  'Config and logs live in .\resources\data\ after the first run.'
) -join "`r`n"
Set-Content -LiteralPath (Join-Path $stage 'README.txt') -Value $readme -Encoding ASCII

Write-Host '[5/5] zipping...'
$dist = Split-Path -Parent $Out
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
if (Test-Path $Out) { Remove-Item $Out -Force }
# -a infers zip from the extension; store paths relative to the parent so the zip has one top folder
Push-Location (Split-Path -Parent $stage)
try {
  $topName = Split-Path -Leaf $stage
  & tar -a -c -f $Out $topName
  if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$mb = [math]::Round((Get-Item $Out).Length / 1MB, 1)
$files = (Get-ChildItem $stage -Recurse -File | Measure-Object).Count
Write-Host ''
Write-Host ("Done: {0}  ({1} MB, {2} files)" -f $Out, $mb, $files) -ForegroundColor Green
Write-Host ''
