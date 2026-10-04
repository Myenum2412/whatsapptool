<#
.SYNOPSIS
  Installs the MyWhatsapp payload into %LOCALAPPDATA%\Programs\MyWhatsapp (no admin needed).

.DESCRIPTION
  Copies build\windows\MyWhatsapp into the per-user Programs folder, writes Start Menu
  shortcuts ("MyWhatsapp" and "Stop MyWhatsapp") and, with -AutoStart, a Startup-folder entry.
  Existing app\data is preserved across upgrades unless -ResetData is passed.

.PARAMETER Uninstall
  Stops a running instance and removes the installed folder and shortcuts. app\data is
  deleted too - back it up first if the sessions matter.

.PARAMETER NoStart
  Skips the "Start now?" prompt. Use this when running the script unattended (CI, another
  script, a redirected shell) - Read-Host returns nothing there and would otherwise fail.

.PARAMETER ForcePort
  Terminates whatever holds port 2785 when the graceful stop does not free it, instead of only
  warning about it. Only ever targets a MyWhatsapp payload runtime or the launcher itself.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\windows\install.ps1 -AutoStart

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\windows\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$AutoStart,
    [switch]$Uninstall,
    [switch]$ResetData,
    [switch]$NoStart,
    [switch]$ForcePort,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\MyWhatsapp')
)

$ErrorActionPreference = 'Stop'

$Port = 2785

$payload  = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'build\windows\MyWhatsapp'
$launcher = Join-Path $InstallDir 'MyWhatsapp.exe'
$startMen = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$startup  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$dataDir  = Join-Path $InstallDir 'app\data'

$lnk      = Join-Path $startMen 'MyWhatsapp.lnk'
$stopLnk  = Join-Path $startMen 'Stop MyWhatsapp.lnk'
$startupLnk = Join-Path $startup 'MyWhatsapp.lnk'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor DarkGray }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function New-Shortcut([string]$Path, [string]$Target, [string]$Icon, [string]$Args = '') {
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($Path)
    $s.TargetPath = $Target
    if ($Args) { $s.Arguments = $Args }
    $s.IconLocation = $Icon
    $s.WorkingDirectory = $Target
    $s.Description = 'MyWhatsapp'
    $s.Save()
}

function Get-PortOwner {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
             Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return 0
}

function Test-PortBusy { return (Get-PortOwner) -ne 0 }

function Wait-PortFree([int]$Seconds = 15) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PortBusy)) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return -not (Test-PortBusy)
}

function Get-ProcessLabel([int]$ProcessId) {
    $info = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $info) { return "pid $ProcessId" }
    $label = "$($info.Name) (pid $ProcessId)"
    if ($info.ExecutablePath) { $label += " - $($info.ExecutablePath)" }
    elseif ($info.CommandLine) { $label += " - $($info.CommandLine)" }
    else { $label += ' - path unavailable (the process is probably running as administrator)' }
    return $label
}

function Stop-Instance {
    # Processes are terminated directly rather than by shelling out to MyWhatsapp.exe --stop.
    # That call opens a modal message box, which would hang the installer on a window nobody is
    # watching - and on an upgrade the executable being called is the previous version, which may
    # not even understand --quiet yet. The launcher does nothing more than Kill() its child.
    Stop-PayloadRuntimes
    Stop-InstallLaunchers
    Wait-PortFree 15 | Out-Null

    $owner = Get-PortOwner
    if ($owner -ne 0 -and $ForcePort) {
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        if (Wait-PortFree 10) { Ok "force-stopped $(Get-ProcessLabel $owner)" }
    }
}

# Every node.exe that belongs to a MyWhatsapp payload, i.e. one shipped in a <payload>\runtime
# folder running dist\main.js. A developer running `npm run start:dev` uses the system node.exe,
# so this never matches a dev server - only installed or staged copies of this app.
function Stop-PayloadRuntimes {
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        if (-not $proc.ExecutablePath) { continue }
        if ($proc.ExecutablePath -notmatch '[\\/]runtime[\\/]node\.exe$') { continue }
        if ($proc.CommandLine -notmatch 'dist[\\/]main\.js') { continue }
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        Ok "stopped payload runtime: pid $($proc.ProcessId) ($($proc.ExecutablePath))"
    }
}

# The launcher keeps its own image locked for as long as it runs, which is what makes
# Remove-Item fail with "Access to the path ... is denied" on an upgrade.
function Stop-InstallLaunchers {
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='MyWhatsapp.exe'" -ErrorAction SilentlyContinue)) {
        if (-not $proc.ExecutablePath) { continue }
        if (($proc.ExecutablePath -ne $launcher) -and ($proc.ExecutablePath -ne (Join-Path $payload 'MyWhatsapp.exe'))) { continue }
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        Ok "stopped launcher: pid $($proc.ProcessId)"
    }
}

function Report-PortState {
    if (-not (Test-PortBusy)) { return $true }
    $owner = Get-PortOwner
    Warn "port $Port is still held by: $(Get-ProcessLabel $owner)"
    Warn 'MyWhatsapp will not start until that process exits.'
    Warn 'If the path above is missing, the process is running as administrator - reopen'
    Warn 'PowerShell as Administrator and run:  Stop-Process -Id <pid> -Force'
    return $false
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
    Step 'Stopping any running instance'
    Stop-Instance
    Step 'Removing the install'
    foreach ($f in $lnk, $stopLnk, $startupLnk) {
        if (Test-Path $f) { Remove-Item $f -Force }
    }
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
        Ok "removed $InstallDir"
    }
    Write-Host "`nUninstalled. app\data (sessions, API keys, SQLite db) was removed as well." -ForegroundColor Green
    Report-PortState | Out-Null
    return
}

# ---------------------------------------------------------------- install
if (-not (Test-Path (Join-Path $payload 'MyWhatsapp.exe'))) {
    throw "Payload not found at $payload - run packaging\windows\build.ps1 first."
}

Step 'Stopping any running instance'
Stop-Instance

Step "Installing to $InstallDir"
$backup = $null
if (Test-Path $InstallDir) {
    if ($ResetData) {
        Remove-Item $InstallDir -Recurse -Force
    } else {
        # Preserve data across the upgrade by moving it aside, then restoring.
        $backup = Join-Path $env:TEMP ("mywhatsapp-data-" + [guid]::NewGuid().ToString('N'))
        if (Test-Path $dataDir) {
            New-Item -ItemType Directory -Force -Path $backup | Out-Null
            Move-Item $dataDir (Join-Path $backup 'data')
            Ok "preserved app\data to $backup"
        }
        Remove-Item $InstallDir -Recurse -Force
    }
}
Copy-Item $payload $InstallDir -Recurse -Force
if ($backup -and (Test-Path (Join-Path $backup 'data'))) {
    Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item (Join-Path $backup 'data') $dataDir
    Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
    Ok 'app\data restored'
}

Step 'Writing Start Menu shortcuts'
New-Item -ItemType Directory -Force -Path $startMen | Out-Null
New-Shortcut $lnk $launcher $launcher
New-Shortcut $stopLnk $launcher $launcher '--stop'
Ok "$lnk"
Ok "$stopLnk"

if ($AutoStart) {
    New-Item -ItemType Directory -Force -Path $startup | Out-Null
    New-Shortcut $startupLnk $launcher $launcher
    Ok "autostart: $startupLnk"
} elseif (Test-Path $startupLnk) {
    Remove-Item $startupLnk -Force
    Warn 'removed a stale autostart entry (re-run with -AutoStart to enable)'
}

$size = [math]::Round((Get-ChildItem $InstallDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 0)

Write-Host ''
Write-Host "MyWhatsapp installed  ($size MB)" -ForegroundColor Green
Write-Host "    launcher: $launcher"
Write-Host "    data:     $dataDir"
Write-Host "    url:      http://localhost:$Port"
Write-Host ''
Write-Host 'Launch it from the Start Menu ("MyWhatsapp"). The first launch shows the' -ForegroundColor Yellow
Write-Host 'generated admin API key and copies it to your clipboard. On first use of a' -ForegroundColor Yellow
Write-Host 'whatsapp-web.js session, Chromium downloads into app\data\puppeteer.' -ForegroundColor Yellow

$portReady = Report-PortState
if (-not $portReady) { Write-Host '' }

if ($NoStart) { return }

# Read-Host returns $null when stdin is not a console (redirected output, CI, another script).
# Calling .Trim() on that is a null-reference crash, so the null check is load-bearing.
$answer = Read-Host 'Start now? [Y/n]'
$start = ($null -ne $answer) -and ($answer.Trim().ToLower() -ne 'n')
if ($start) {
    Start-Process $launcher
    Ok 'launcher started'
}