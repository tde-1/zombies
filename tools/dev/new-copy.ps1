<#
.SYNOPSIS
  Make a per-agent dev copy of the game from C:\Users\b\ZombiesDev\waw-base.

.DESCRIPTION
  A dev copy is a folder that looks like a full WaW install but only costs ~12 MB:
    * the big asset folders (main, zone, DirectX, Docs, installers, pb) are NTFS
      *junctions* back into waw-base  -> treat them as READ-ONLY;
    * the root files (exe, dlls, bmp, ico, txt, inf, vdf) are real copies, so each
      agent can drop its own proxy DLL / configs in without disturbing anyone else.

  Also drops steam_appid.txt (10090), which is what stops SteamStub bouncing the
  launch back to the Steam folder. See docs/kickstart/foundation.md.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\dev\new-copy.ps1 foundation
  powershell -ExecutionPolicy Bypass -File tools\dev\new-copy.ps1 dedi -Force
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$Name,

    # Delete an existing copy of the same name first.
    [switch]$Force,

    [string]$Base = 'C:\Users\b\ZombiesDev\waw-base',
    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)

$ErrorActionPreference = 'Stop'

# Folders that are junctioned (big, read-only, shared)
$LinkDirs = @('main', 'zone', 'DirectX', 'Docs', 'installers', 'pb')

if (-not (Test-Path -LiteralPath $Base)) {
    throw "waw-base not found at $Base. Run the robocopy from the Steam folder first (see docs/kickstart/foundation.md)."
}
if (-not (Test-Path -LiteralPath (Join-Path $Base 'CoDWaW.exe'))) {
    throw "$Base does not look like a WaW install (no CoDWaW.exe)."
}

$dest = Join-Path $DevRoot "waw-$Name"

if (Test-Path -LiteralPath $dest) {
    if (-not $Force) {
        Write-Host "Copy already exists: $dest  (use -Force to recreate)" -ForegroundColor Yellow
        Write-Output $dest
        return
    }
    # Remove junctions first so Remove-Item can never recurse into waw-base.
    foreach ($d in $LinkDirs) {
        $p = Join-Path $dest $d
        if (Test-Path -LiteralPath $p) {
            $item = Get-Item -LiteralPath $p -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                cmd /c rmdir "`"$p`"" | Out-Null
            }
        }
    }
    Remove-Item -LiteralPath $dest -Recurse -Force
}

New-Item -ItemType Directory -Path $dest -Force | Out-Null

# 1. Real copies of every file in the root of waw-base.
Get-ChildItem -LiteralPath $Base -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $dest $_.Name) -Force
}

# 2. Junctions for the big folders.
foreach ($d in $LinkDirs) {
    $src = Join-Path $Base $d
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $link = Join-Path $dest $d
    # mklink /J needs no admin rights (unlike /D symlinks).
    $out = cmd /c mklink /J "`"$link`"" "`"$src`"" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "mklink /J failed for ${d}: $out" }
}

# 3. Anything in waw-base that is a directory but not in $LinkDirs gets copied for real
#    (so a future patch folder is not silently dropped).
Get-ChildItem -LiteralPath $Base -Directory | Where-Object { $LinkDirs -notcontains $_.Name } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $dest $_.Name) -Recurse -Force
    Write-Host "  (copied extra folder $($_.Name) for real)" -ForegroundColor DarkGray
}

# 4. steam_appid.txt: tells the Steam DRM shim not to relaunch through the Steam
#    client from the *installed* folder. Without it the copy exits immediately.
Set-Content -LiteralPath (Join-Path $dest 'steam_appid.txt') -Value '10090' -Encoding ascii -NoNewline

# 5. Per-instance user data folder (fs_homepath target), created here so launch.ps1
#    never has to guess. `main` must exist before launch or the engine writes no
#    console.log at all.
$home_ = Join-Path $DevRoot "homes\$Name"
New-Item -ItemType Directory -Path $home_, (Join-Path $home_ 'main') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $DevRoot "logs\$Name") -Force | Out-Null

# 6. Seed a private profile tree, for ENW_PRIVATE_PROFILE=1.
#    Our DLL can redirect the engine's AppData lookup per instance
#    (shared/core/components/instance_paths.cpp), but redirecting to an EMPTY
#    directory means no profile at all, which drops the game into its first-run
#    profile flow. So we copy B's existing profile in once, here.
#    Layout must match what the engine builds: <appdata>\Activision\CoDWaW\players
$appdata = Join-Path $home_ 'appdata'
$privateProfile = Join-Path $appdata 'Activision\CoDWaW'
$realProfile = Join-Path $env:LOCALAPPDATA 'Activision\CoDWaW\players'
New-Item -ItemType Directory -Path $privateProfile -Force | Out-Null
if (Test-Path -LiteralPath $realProfile) {
    $seeded = Join-Path $privateProfile 'players'
    if (-not (Test-Path -LiteralPath $seeded)) {
        # Config and profile only. Never the mods folder: those are big, they are
        # shared read-only anyway, and one of them contains an unsigned .exe that
        # nothing here should ever be copying around (dev-box.md rule 3).
        Copy-Item -LiteralPath $realProfile -Destination $seeded -Recurse -Force
        $n = (Get-ChildItem -LiteralPath $seeded -Recurse -File | Measure-Object).Count
        Write-Host "  seeded a private profile ($n files) from $realProfile" -ForegroundColor DarkGray
    }
}
else {
    Write-Host "  (no profile at $realProfile to seed from)" -ForegroundColor Yellow
}

$size = (Get-ChildItem -LiteralPath $dest -File | Measure-Object Length -Sum).Sum
Write-Host ("Created {0} ({1:N1} MB of real files + {2} junctions)" -f $dest, ($size / 1MB), $LinkDirs.Count) -ForegroundColor Green
Write-Host "  fs_homepath : $home_"
Write-Host "  logs        : $(Join-Path $DevRoot "logs\$Name")"
Write-Output $dest
