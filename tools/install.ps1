# Installer for PokePet (ASCII-only on purpose: works under PowerShell 5.1 without BOM issues)
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Url <zip-url-or-local-path>
# Optional:
#   -Dest <folder>     default: %LOCALAPPDATA%\PokePet
#   -NoShortcut        skip desktop shortcut
#   -NoLaunch          do not start after install

param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Dest = (Join-Path $env:LOCALAPPDATA 'PokePet'),
  [switch]$NoShortcut,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host ''
Write-Host '== PokePet installer ==' -ForegroundColor Cyan
Write-Host "package : $Url"
Write-Host "target  : $Dest"
Write-Host ''

# 1) download (or use a local file)
$tmpZip = Join-Path $env:TEMP ('pokepet-' + [Guid]::NewGuid().ToString('N') + '.zip')
if (Test-Path -LiteralPath $Url) {
  Write-Host '[1/4] copying local package...'
  Copy-Item -LiteralPath $Url -Destination $tmpZip -Force
} else {
  Write-Host '[1/4] downloading (about 300 MB, be patient)...'
  $old = $ProgressPreference
  $ProgressPreference = 'Continue'
  Invoke-WebRequest -Uri $Url -OutFile $tmpZip -UseBasicParsing
  $ProgressPreference = $old
}
$sizeMb = [math]::Round((Get-Item $tmpZip).Length / 1MB, 1)
Write-Host "      got $sizeMb MB"

# 2) sanity check: it must be a zip
$head = [IO.File]::ReadAllBytes($tmpZip)[0..1]
if (-not ($head[0] -eq 0x50 -and $head[1] -eq 0x4B)) {
  Remove-Item $tmpZip -Force
  throw 'Downloaded file is not a zip. The URL is probably wrong (check the release asset name).'
}

# 3) extract
Write-Host '[2/4] extracting...'
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Expand-Archive -LiteralPath $tmpZip -DestinationPath $Dest -Force
Remove-Item $tmpZip -Force

# zip contains a single top folder; flatten it if so
$top = Get-ChildItem $Dest
if ($top.Count -eq 1 -and $top[0].PSIsContainer) {
  $inner = $top[0].FullName
  Get-ChildItem $inner -Force | Move-Item -Destination $Dest -Force
  Remove-Item $inner -Recurse -Force
}

$exe = Join-Path $Dest 'PokePet.exe'
if (-not (Test-Path $exe)) {
  $candidate = Get-ChildItem $Dest -Filter *.exe -Recurse | Sort-Object Length -Descending | Select-Object -First 1
  if (-not $candidate) { throw 'No exe found after extraction.' }
  $exe = $candidate.FullName
}
Write-Host "      exe: $exe"

# 4) desktop shortcut (name is built from code points to keep this file ASCII)
if (-not $NoShortcut) {
  Write-Host '[3/4] creating desktop shortcut...'
  $name = [string]([char]0x5B9D + [char]0x53EF + [char]0x68A6 + [char]0x684C + [char]0x5BA0)  # "pokemon desktop pet"
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk = Join-Path $desktop ($name + '.lnk')
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = $exe
  $sc.WorkingDirectory = $Dest
  $sc.IconLocation = $exe + ',0'
  $sc.Description = $name
  $sc.Save()
  Write-Host "      $lnk"
} else {
  Write-Host '[3/4] shortcut skipped'
}

# 5) run
if (-not $NoLaunch) {
  Write-Host '[4/4] starting...'
  # some dev machines export this; it would turn the app into a plain node process
  Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath $exe -WorkingDirectory $Dest
} else {
  Write-Host '[4/4] launch skipped'
}

Write-Host ''
Write-Host 'Done. Have fun.' -ForegroundColor Green
Write-Host ''
