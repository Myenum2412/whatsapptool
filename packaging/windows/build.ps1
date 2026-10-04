<#
.SYNOPSIS
  Builds the MyWhatsapp Windows per-user payload into build\windows\MyWhatsapp.

.DESCRIPTION
  Produces a relocatable folder that install.ps1 copies into
  %LOCALAPPDATA%\Programs\MyWhatsapp:

    MyWhatsapp.exe      launcher (C#), compiled with the Windows .NET Framework csc.exe
    runtime\node.exe    the Node.js runtime the app was built against
    app\dist\           compiled backend
    app\dashboard\dist\ compiled dashboard SPA (served from the same port)
    app\node_modules\   production dependencies incl. prebuilt native addons
    app\.env            bundled local configuration

  The Chromium build for whatsapp-web.js is deliberately NOT bundled: the launcher points
  PUPPETEER_CACHE_DIR at app\data\puppeteer so Puppeteer downloads it on first run.

  No admin rights required. Inno Setup / WiX / NSIS are not used and are not needed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,   # skip `npm ci --omit=dev` and reuse the existing staging node_modules
    [switch]$SkipNative     # skip copying .node binaries (only useful for a dry run)
)

$ErrorActionPreference = 'Stop'

$repo     = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$src      = Join-Path $PSScriptRoot 'Launcher.cs'
$stage    = Join-Path $repo 'build\windows\MyWhatsapp'
$stageApp = Join-Path $stage 'app'
$csc      = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor DarkGray }

Write-Host "MyWhatsapp Windows payload build" -ForegroundColor Green
Write-Host "    repo:   $repo"
Write-Host "    stage:  $stage`n"

# ---------------------------------------------------------------- launcher
if (-not (Test-Path $csc)) {
    # .NET Framework 3.5/4.x feature: an optional Windows component, so it can be absent.
    throw "csc.exe not found at $csc - install the .NET Framework 3.5/4.x developer pack, or compile Launcher.cs with any C# compiler."
}
Step 'Compiling the launcher'
# csc.exe writes its temporary Win32 resource next to the output binary, so the stage has to
# exist before this runs.
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$payloadExe = Join-Path $stage 'MyWhatsapp.exe'
$ico = Join-Path $repo 'dashboard\public\favicon.ico'
$cscArgs = @('/nologo', '/target:winexe', '/optimize+', '/r:System.Windows.Forms.dll')
if (Test-Path $ico) { $cscArgs += "/win32icon:$ico" }
$cscArgs += "/out:$payloadExe"
$cscArgs += $src

function Invoke-Csc {
    $output = & $csc @cscArgs 2>&1 | Out-String
    return @{ Code = $LASTEXITCODE; Output = $output }
}

$compiled = Invoke-Csc
if ($compiled.Code -ne 0 -and $compiled.Output -match 'used by another process') {
    # A running payload holds its own image open, so csc cannot overwrite it. That happens
    # whenever the launcher is started straight out of build\windows instead of from the install
    # folder, and it used to abort the build with a bare CS0016. Terminate the payload directly:
    # MyWhatsapp.exe --stop opens a modal message box, and on an upgrade it would also be the
    # previous build that cannot be trusted to behave.
    Step 'A running instance is holding the payload - stopping it'
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        if ($proc.ExecutablePath -eq (Join-Path $stage 'runtime\node.exe')) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='MyWhatsapp.exe'" -ErrorAction SilentlyContinue)) {
        if ($proc.ExecutablePath -eq $payloadExe) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 2
    $compiled = Invoke-Csc
}
if ($compiled.Code -ne 0) {
    Write-Host $compiled.Output
    throw "csc.exe failed with exit code $($compiled.Code)"
}
Ok "MyWhatsapp.exe  ($([math]::Round((Get-Item $payloadExe).Length/1KB,0)) KB)"

# ---------------------------------------------------------------- runtime
Step 'Copying the Node runtime'
New-Item -ItemType Directory -Force -Path "$stage\runtime" | Out-Null
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe "$stage\runtime\node.exe" -Force
Ok "node.exe  $((node -v))  ($([math]::Round((Get-Item "$stage\runtime\node.exe").Length/1MB,1)) MB)"

# ---------------------------------------------------------------- app files
# NOTE: dashboard\dist is deliberately NOT copied here. The package.json postinstall hook runs
# `npm ci` inside dashboard\ whenever that directory exists, so materialising it before the
# dependency install makes the hook fail on a payload tree that has no dashboard package.json.
# It is copied in a later step, after the install.
Step 'Copying the backend build'
# Copy-Item -Recurse copies INTO an existing directory (dist\dist\...), so the target is cleared
# first. Without this a rebuild silently doubles the payload.
Remove-Item "$stageApp\dist" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $repo 'dist') "$stageApp\dist" -Recurse -Force
Ok "dist: $((Get-ChildItem "$stageApp\dist" -Recurse -File).Count) files"

foreach ($f in 'package.json', 'package-lock.json', 'openapi.json') {
    Copy-Item (Join-Path $repo $f) "$stageApp\$f" -Force
}
# scripts/ is required by the package.json postinstall hook (whatsapp-web.js patchers).
if (Test-Path (Join-Path $repo 'scripts')) {
    Remove-Item "$stageApp\scripts" -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $repo 'scripts') "$stageApp\scripts" -Recurse -Force
}
Copy-Item (Join-Path $PSScriptRoot 'app.env') "$stageApp\.env" -Force
Ok 'manifests + .env + scripts/'

# ---------------------------------------------------------------- dependencies
if (-not $SkipInstall) {
    Step 'Installing production dependencies (npm ci --omit=dev)'
    Push-Location $stageApp
    try {
        # npm 11 warns about install scripts it has not been told to allow. That is fine here:
        # better-sqlite3 13 ships prebuilds/win32-x64.node and declares no install script, so
        # the natives load without compiling. puppeteer's own postinstall (the Chromium download)
        # is intentionally NOT run - the launcher triggers that on first use instead.
        npm ci --omit=dev
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
}
Ok "node_modules: $((Get-ChildItem "$stageApp\node_modules" -Recurse -File -ErrorAction SilentlyContinue).Count) files"

# ---------------------------------------------------------------- dashboard SPA
# Only now does app\dashboard\ get created - see the postinstall note above.
Step 'Copying the dashboard build'
New-Item -ItemType Directory -Force -Path "$stageApp\dashboard" | Out-Null
Remove-Item "$stageApp\dashboard\dist" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $repo 'dashboard\dist') "$stageApp\dashboard\dist" -Recurse -Force
Ok "dashboard/dist: $((Get-ChildItem "$stageApp\dashboard\dist" -Recurse -File).Count) files"

if (-not $SkipNative) {
    Step 'Verifying the native addons load on this runtime'
    Push-Location $stageApp
    try {
        & "$stage\runtime\node.exe" -e "for (const m of ['better-sqlite3','sharp','cpu-features','msgpackr-extract','protobufjs','ssh2','@whiskeysockets/baileys','whatsapp-web.js','puppeteer']) { try { require(m); console.log('    ok   ' + m); } catch (e) { console.error('    FAIL ' + m + ' -> ' + e.message); process.exitCode = 1; } }"
        if ($LASTEXITCODE -ne 0) { throw 'a native module failed to load - see the lines above' }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------- summary
$total = (Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum
Step 'Done'
Write-Host "    payload: $stage"
Write-Host "    size:    $([math]::Round($total/1MB,0)) MB in $((Get-ChildItem $stage -Recurse -File).Count) files"
Write-Host ''
Write-Host 'Next:  powershell -ExecutionPolicy Bypass -File packaging\windows\install.ps1' -ForegroundColor Yellow