<#
.SYNOPSIS
  One map's world shell out of the running game: wait for game.lock, launch the geo dev
  copy off-screen on the map, read the GfxWorld with HuskyLib (no window), kill, release.

.DESCRIPTION
  Called by tools/maps/export_all.py once per map; usable by hand.

  WHY THE GAME AT ALL. A WaW world lives in GfxWorld and no file-based tool writes it
  (replay.md 4). Husky reads it out of the running game's memory, so this step needs the
  game and therefore game.lock. Everything else in the pipeline (OAT unlink, glb build,
  optimise, validate) runs without it.

  NO WINDOW. Husky.exe is a WPF shell over HuskyLib, whose public surface is one call,
  `Husky.HuskyUtil.LoadGame(Action<object> print)`: find the first supported game process,
  read the loaded map, write exported_maps\world_at_war\sp\<map>\<map>.{obj,mtl,map} under
  the CURRENT DIRECTORY. HuskyLib is lifted out of Husky.exe's Costura resource
  (`costura.huskylib.dll.compressed`, a deflate stream) to <HuskyDir>\lib\huskylib.dll and
  invoked by reflection. Nothing is drawn. The game itself is launched by launch.ps1,
  which parks every window at -4000,-4000 without activating it; this script keeps
  parking and keeps answering modal boxes while it waits (launch.ps1 only sweeps for 10 s).

  THE LOCK. launch.ps1 takes game.lock atomically and refuses if any CoDWaW is running.
  This script first WAITS for a held lock (other agents queue on it the same way -- the
  jointest-proof.ps1 pattern), then kills only its own PID and deletes the lock only if the
  lock still names that PID. One map per hold; the lock is free between maps.

  PRIVATE DATA ONLY. The geo copy carries an ENW DLL with enw_localappdata, and launch.ps1
  defaults ENW_USE_PRIVATE_LOCALAPPDATA to private, so LocalAppData is
  ZombiesDev\homes\geo\localappdata. B's Activision\CoDWaW is never opened.

  Prints one JSON line last: {ok, map, obj, seconds, lines[], error}.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\maps\husky-map.ps1 -Map nazi_zombie_factory
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Map,
    [string]$OutDir = 'C:\Users\b\ZombiesDev\maps\_work\husky',
    [string]$CopyName = 'geo',
    [string]$HuskyDir = 'C:\Users\b\ZombiesDev\tools\husky',
    [string]$DevRoot = 'C:\Users\b\ZombiesDev',
    [int]$LoadSeconds = 150,
    [int]$LockWaitMinutes = 30
)
$ErrorActionPreference = 'Stop'
$env:ENW_TEST_NO_ACTIVATE = '1'
$repoTools = Split-Path -Parent $PSScriptRoot           # <repo>\tools
$lockFile = Join-Path $DevRoot 'locks\game.lock'
$stock = @('nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory')
$t0 = Get-Date
$res = [ordered]@{ ok = $false; map = $Map; obj = $null; seconds = 0; lines = @(); error = $null }

function Emit { $res.seconds = [int]((Get-Date) - $t0).TotalSeconds; $res | ConvertTo-Json -Compress -Depth 4 }

# ---- HuskyLib -----------------------------------------------------------------------
$lib = Join-Path $HuskyDir 'lib\huskylib.dll'
if (-not (Test-Path -LiteralPath $lib)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $lib) | Out-Null
    $exe = [Reflection.Assembly]::LoadFile((Join-Path $HuskyDir 'Husky.exe'))
    $s = $exe.GetManifestResourceStream('costura.huskylib.dll.compressed')
    $d = New-Object IO.Compression.DeflateStream($s, [IO.Compression.CompressionMode]::Decompress)
    $f = [IO.File]::Create($lib); $d.CopyTo($f); $f.Close()
}
$util = [Reflection.Assembly]::LoadFile($lib).GetType('Husky.HuskyUtil')
$script:lines = New-Object System.Collections.ArrayList
$cb = [Action[object]] { param($m) [void]$script:lines.Add([string]$m) }

# ---- wait for the lock (queue behind other agents) -----------------------------------
$deadline = (Get-Date).AddMinutes($LockWaitMinutes)
while ((Get-Date) -lt $deadline) {
    $held = $null
    if (Test-Path -LiteralPath $lockFile) { try { $held = Get-Content -LiteralPath $lockFile -Raw -ErrorAction Stop } catch {} }
    $running = @(Get-Process -Name 'CoDWaW', 'CoDWaWmp' -ErrorAction SilentlyContinue)
    if (-not $held -and $running.Count -eq 0) { break }
    Write-Host "[husky-map] waiting: lock='$("$held".Trim())' running=$($running.Count)"
    Start-Sleep -Seconds 10
}

$gamePid = 0
# The engine's "did not quit properly" marker, in the PRIVATE LocalAppData this copy uses.
# launch.ps1 clears the machine-wide one and the -PrivateProfile one, not this one, and a
# Stop-Process always leaves it -- so every second launch raised "Run In Safe Mode?", a
# modal box launch.ps1 answers but does not park. Cleared before and after each map.
$marker = Join-Path $DevRoot "homes\$CopyName\localappdata\Activision\CoDWaW\__CoDWaW"
function Clear-Marker { if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue } }
Clear-Marker
try {
    $fsArgs = @()
    if ($stock -notcontains $Map) {
        . (Join-Path $repoTools 'dev\mapmount.ps1')
        Mount-EnwMap -Bsp $Map -Homes @($CopyName) -DevRoot $DevRoot -Log { param($m, $c) Write-Host "[mount] $m" }
        $fsArgs = @('+set', 'fs_game', "mods/$Map")
    }
    $gameArgs = @('+set', 'zombiemode', '1') + $fsArgs + @('+map', $Map)
    $gamePid = & (Join-Path $repoTools 'dev\launch.ps1') $CopyName -Role solo -HomePath own `
        -GameArgs $gameArgs -Why "replay geometry export (husky, no window): $Map" | Select-Object -Last 1
    if (-not ($gamePid -as [int])) { throw "launch.ps1 returned no pid ($gamePid)" }
    $gamePid = [int]$gamePid

    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    [Environment]::CurrentDirectory = $OutDir
    $obj = Join-Path $OutDir "exported_maps\world_at_war\sp\$Map\$Map.obj"
    $before = if (Test-Path -LiteralPath $obj) { (Get-Item -LiteralPath $obj).LastWriteTimeUtc } else { [datetime]::MinValue }
    $wait = (Get-Date).AddSeconds($LoadSeconds)
    while ((Get-Date) -lt $wait) {
        if (-not (Get-Process -Id $gamePid -ErrorAction SilentlyContinue)) { throw 'the game exited before the map loaded' }
        # launch.ps1's sweep stops after 10 s; a map load can raise a box much later.
        try { [void][EnwWindows]::Park($gamePid, -4000, -4000); $dlg = [EnwWindows]::Dismiss($gamePid)
              if ($dlg) { [void]$script:lines.Add("dialog: $dlg") } } catch {}
        $script:lines.Clear()
        try { [void]$util.GetMethod('LoadGame').Invoke($null, @($cb)) }
        catch { [void]$script:lines.Add("EXCEPTION: $($_.Exception.InnerException.Message)") }
        $txt = $script:lines -join "`n"
        $m = [regex]::Match($txt, 'Loaded Gfx Map\s+-\s+maps/([^\s]+?)\.d3dbsp')
        if ($m.Success -and $m.Groups[1].Value -ieq $Map -and $txt -match 'Converted to OBJ' -and
            (Test-Path -LiteralPath $obj) -and (Get-Item -LiteralPath $obj).LastWriteTimeUtc -gt $before) {
            $res.ok = $true; $res.obj = $obj
            break
        }
        if ($m.Success -and $m.Groups[1].Value -ine $Map) { [void]$script:lines.Add("(loaded map is $($m.Groups[1].Value), waiting for $Map)") }
        Start-Sleep -Seconds 3
    }
    $res.lines = @($script:lines)
    if (-not $res.ok) { $res.error = "no world for $Map after $LoadSeconds s: $($script:lines -join ' | ')" }
}
catch { $res.error = "$_"; $res.lines = @($script:lines) }
finally {
    if ($gamePid -and (Get-Process -Id $gamePid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $gamePid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 1200
    }
    Clear-Marker
    if (Test-Path -LiteralPath $lockFile) {
        $l = ''
        try { $l = Get-Content -LiteralPath $lockFile -Raw -ErrorAction Stop } catch {}
        if ($gamePid -and $l -match "\b$gamePid\b") { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue }
        elseif ($l -match "^$CopyName starting") { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue }
    }
    # The console log names what went wrong when a map would not load; keep it per map.
    $con = Join-Path $DevRoot ("homes\$CopyName\" + $(if ($stock -contains $Map) { 'main' } else { "mods\$Map" }) + '\console.log')
    if (Test-Path -LiteralPath $con) {
        $keep = Join-Path $DevRoot "maps\_work\logs"
        New-Item -ItemType Directory -Force -Path $keep | Out-Null
        Copy-Item -LiteralPath $con -Destination (Join-Path $keep "$Map.console.log") -Force -ErrorAction SilentlyContinue
    }
}
Emit
