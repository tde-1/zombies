<#
.SYNOPSIS
  Install enw_t4.dll into a dev game copy as the binkw32.dll proxy.

.DESCRIPTION
  CoDWaW.exe statically imports binkw32.dll, so if ours is the one in the folder,
  the Windows loader loads us before the game's entry point ever runs. The real
  Bink is renamed to binkw32_org.dll and all 71 exports are forwarded to it.

  Refuses to write anywhere under the Steam install (dev-box.md rule 1) and keeps
  a pristine copy check so it can never "back up" our own DLL over the real one.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 foundation
  powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 foundation -Revert
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$Name = 'foundation',

    # Which build dir to take enw_t4.dll from (defaults to the same name).
    [string]$From = '',

    # Put the original binkw32.dll back and remove ours.
    [switch]$Revert,

    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $From) { $From = $Name }

$gameDir = Join-Path $DevRoot "waw-$Name"
$proxy = Join-Path $gameDir 'binkw32.dll'
$original = Join-Path $gameDir 'binkw32_org.dll'
$pristine = Join-Path $DevRoot 'waw-base\binkw32.dll'

if ($gameDir -like 'C:\Program Files (x86)\Steam\*') { throw 'Refusing to write into the Steam install.' }
if (-not (Test-Path -LiteralPath $gameDir)) { throw "No game copy at $gameDir (run new-copy.ps1 $Name)" }
if (-not (Test-Path -LiteralPath $pristine)) { throw "No pristine binkw32.dll at $pristine" }

function Get-Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash }
$pristineHash = Get-Sha $pristine

if ($Revert) {
    if (Test-Path -LiteralPath $original) {
        Move-Item -LiteralPath $original -Destination $proxy -Force
        Write-Host "Restored the original binkw32.dll in $gameDir" -ForegroundColor Green
    }
    elseif ((Test-Path -LiteralPath $proxy) -and (Get-Sha $proxy) -ne $pristineHash) {
        Copy-Item -LiteralPath $pristine -Destination $proxy -Force
        Write-Host "Copied a fresh binkw32.dll from waw-base" -ForegroundColor Green
    }
    else {
        Write-Host 'Nothing to revert.' -ForegroundColor Yellow
    }
    return
}

$dll = Join-Path $repo "build\$From\enw_t4.dll"
if (-not (Test-Path -LiteralPath $dll)) {
    throw "No build at $dll. Run: tools\dev\build.ps1 -Name $From"
}

# Is the game running out of this copy right now? Overwriting a loaded DLL fails
# with a sharing violation anyway, but a clear message beats a cryptic one.
$marker = "$env:LOCALAPPDATA\Activision\CoDWaW\__CoDWaW"
if (Test-Path -LiteralPath $marker) {
    $b = [IO.File]::ReadAllBytes($marker)
    if ($b.Length -eq 4) {
        $livePid = [BitConverter]::ToInt32($b, 0)
        $p = Get-Process -Id $livePid -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -like 'CoDWaW*') {
            throw "CoDWaW is running (pid $livePid). Close it before deploying."
        }
    }
}

# Stash the real Bink exactly once, and only if what is there really is the real one.
if (-not (Test-Path -LiteralPath $original)) {
    if ((Test-Path -LiteralPath $proxy) -and (Get-Sha $proxy) -eq $pristineHash) {
        Move-Item -LiteralPath $proxy -Destination $original -Force
        Write-Host 'Renamed the original binkw32.dll -> binkw32_org.dll' -ForegroundColor DarkGray
    }
    else {
        # Either missing, or already ours with no backup. Take a clean one from waw-base.
        Copy-Item -LiteralPath $pristine -Destination $original -Force
        Write-Host 'Took a fresh binkw32_org.dll from waw-base' -ForegroundColor DarkGray
    }
}
elseif ((Get-Sha $original) -ne $pristineHash) {
    throw "binkw32_org.dll in $gameDir is NOT the stock Bink. Refusing to go further; sort it out by hand."
}

Copy-Item -LiteralPath $dll -Destination $proxy -Force
$pdb = Join-Path $repo "build\$From\enw_t4.pdb"
if (Test-Path -LiteralPath $pdb) { Copy-Item -LiteralPath $pdb -Destination (Join-Path $gameDir 'enw_t4.pdb') -Force }

$i = Get-Item -LiteralPath $proxy
Write-Host ("Deployed {0} -> {1} ({2:N0} bytes, built {3})" -f $dll, $proxy, $i.Length, (Get-Item $dll).LastWriteTime) -ForegroundColor Green
Write-Host "  original: $original"
Write-Host "  launch:   powershell -ExecutionPolicy Bypass -File tools\dev\launch.ps1 $Name -Role solo -TestSeconds 30"
