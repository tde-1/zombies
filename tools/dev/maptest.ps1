<#
.SYNOPSIS
  Boot one map headless on the dedicated server and say whether it came up.

.DESCRIPTION
  Triage for docs/kickstart/archive.md section 3's custom maps. Server only -- no
  client -- so one map costs about 60 s instead of 150 s. For each map it answers
  three questions, in this order, and stops at the first "no":

    1. does the process survive the map load?
    2. does it answer `getstatus` on the wire (oob.py exit code, never a grep)?
    3. does its console log carry a GSC runtime error, a Sys_Error, or a
       "Could not load" storm -- and if so, exactly which?

  A CUSTOM MAP IS ITS OWN MOD: the engine loads nazi_zombie_leviathan out of
  mods\nazi_zombie_leviathan, so fs_game is mods/<bsp>, never our mods/enw overlay.
  The ENW DLL rides in on the binkw32 proxy, not on fs_game, so there is no
  "load both mods at once" problem -- there is only ever one mod and it is the map's.

  Honours game.lock through launch.ps1 like everything else, and kills only its
  own PID.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\dev\maptest.ps1 -Tag map01 `
      -Maps nazi_zombie_leviathan,nazi_zombie_derberg,mw2rust
#>
[CmdletBinding()]
param(
    [string]$Tag = 'map1',
    [string[]]$Maps = @('nazi_zombie_leviathan', 'nazi_zombie_derberg', 'mw2rust',
                        'nazi_zombie_test1', 'nazi_zombie_test', 'sanatorium'),
    [string]$ServerName = 'd2',
    [string]$ServerFrom = 'dedi',
    [int]$Port = 28960,
    [int]$ReadySeconds = 90,
    [switch]$NoDeploy,
    # Raise the engine's main memory reserve from 300 MB to 422 MB before the map
    # loads (shared/t4/addresses.hpp :: t4::mem). Off unless asked for.
    [switch]$BigHeap,
    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $DevRoot 'logs\dedi'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$transcript = Join-Path $logDir "$Tag.txt"

function Say($msg, $colour = 'Gray') {
    Write-Host $msg -ForegroundColor $colour
    Add-Content -LiteralPath $transcript -Value ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg) -Encoding utf8
}

Set-Content -LiteralPath $transcript -Value "maptest $Tag  $(Get-Date -Format o)" -Encoding utf8

if (-not $NoDeploy) {
    & (Join-Path $PSScriptRoot 'deploy.ps1') $ServerName -From $ServerFrom | Out-Null
    Say "deployed build\$ServerFrom -> waw-$ServerName"
}

$stock = @('nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory')
$results = @()

foreach ($map in $Maps) {
    Say "" ; Say "=================== $map ===================" 'Cyan'
    $fsGame = if ($stock -contains $map) { '' } else { "mods/$map" }
    $row = [ordered]@{ map = $map; fs_game = $fsGame; alive = $false; answered = $false; error = '' }

    if ($fsGame) {
        $dst = Join-Path $DevRoot "homes\$ServerName\mods\$map"
        $src = Join-Path $DevRoot "archive\mods\$map"
        if (-not (Test-Path -LiteralPath $dst)) {
            if (-not (Test-Path -LiteralPath $src)) {
                Say "NOT INSTALLED: $src" 'Red'
                $row.error = 'not installed in the archive'
                $results += [pscustomobject]$row
                continue
            }
            New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
            cmd /c mklink /J "$dst" "$src" | Out-Null
            Say "junctioned $dst -> $src"
        }
        Get-ChildItem -LiteralPath $dst -Filter *.ff | ForEach-Object {
            Say ("  {0}  {1:N1} MB" -f $_.Name, ($_.Length / 1MB))
        }
    }

    # Start from a clean console.log so a GSC error from the LAST map cannot be
    # read as this one's. The engine appends.
    $conDir = Join-Path $DevRoot ("homes\$ServerName\" + $(if ($fsGame) { $fsGame -replace '/', '\' } else { 'main' }))
    $conLog = Join-Path $conDir 'console.log'
    if (Test-Path -LiteralPath $conLog) { Remove-Item -LiteralPath $conLog -Force -ErrorAction SilentlyContinue }

    $serverPid = 0
    $lockFile = Join-Path $DevRoot 'locks\game.lock'
    try {
        $env:ENW_DEDI_SUPPRESS_MAPSUMMARY = '1'
        $env:ENW_CLIENT_CONNECT = $null
        $env:ENW_CONNECT_ADDR = $null
        $env:ENW_RAW_SOCKETS = '1'
        $env:ENW_DEDI_BIG_HEAP = $(if ($BigHeap) { '1' } else { $null })

        $args = @(
            '+set', 'dedicated', '1', '+set', 'zombiemode', '1', '+set', 'logfile', '2',
            '+set', 'com_maxfps', '60',
            '+set', 's_volume', '0', '+set', 'snd_volume', '0',
            '+set', 'con_typewriterColorBase', '1.0 1.0 1.0',
            '+set', 'hud_drawhud', '1', '+set', 'ui_campaign', 'american',
            '+set', 'sv_maxclients', '4', '+set', 'net_port', "$Port"
        )
        if ($fsGame) { $args += @('+set', 'fs_game', $fsGame) }
        $args += @('+map', $map)

        $serverPid = & (Join-Path $PSScriptRoot 'launch.ps1') $ServerName -Role server -HomePath own `
            -GameArgs $args -Why "dedi $Tag map boot: $map" | Select-Object -Last 1
        if (-not $serverPid) { throw 'launch.ps1 did not return a PID' }
        Say "server PID $serverPid  fs_game='$fsGame'" 'Green'

        $probe = Join-Path $PSScriptRoot 'oob.py'
        $deadline = (Get-Date).AddSeconds($ReadySeconds)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 3
            if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
                Say "the server EXITED before it answered" 'Red'
                break
            }
            $row.alive = $true
            & python $probe $Port --timeout 1.0 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $row.answered = $true; break }
        }
        if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) { $row.alive = $true }
        Say ("alive={0}  answered_getstatus={1}" -f $row.alive, $row.answered) `
            $(if ($row.answered) { 'Green' } else { 'Yellow' })
        # Give a booted server a few more seconds so a GSC error that fires on the
        # first frames lands in the log before we read it.
        if ($row.answered) { Start-Sleep -Seconds 8 }
    }
    catch { Say "EXCEPTION: $_" 'Red'; $row.error = "$_" }
    finally {
        if ($serverPid -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
            Say "killing our PID $serverPid"
            Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 1200
        if (Test-Path -LiteralPath $lockFile) {
            $lock = Get-Content -LiteralPath $lockFile -Raw
            if ($serverPid -and $lock -match "\b$serverPid\b") {
                Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
                Say 'released game.lock'
            }
            else { Say "game.lock is not ours ($($lock.Trim())) - left alone" 'Yellow' }
        }
    }

    foreach ($pair in @(
            @((Join-Path $DevRoot "logs\$ServerName\enw-$serverPid.log"), "$Tag.$map.enw.log"),
            @($conLog, "$Tag.$map.console.log"))) {
        if (Test-Path -LiteralPath $pair[0]) {
            Copy-Item -LiteralPath $pair[0] -Destination (Join-Path $logDir $pair[1]) -Force
        }
        else { Say "MISSING $($pair[0])" 'Yellow' }
    }

    # ---- what did the engine actually say? -------------------------------------
    if (Test-Path -LiteralPath $conLog) {
        $txt = Get-Content -LiteralPath $conLog -ErrorAction SilentlyContinue
        $bad = $txt | Select-String -Pattern '\*\*\*\*|Error:|error:|Sys_Error|ERROR|unknown item|cannot cast|not found|Could not load|Exceeded limit|linkTo|Waited .* frames' |
               Select-Object -First 25
        if ($bad) {
            Say "--- engine complaints ---" 'Yellow'
            $bad | ForEach-Object { Say "    $($_.Line.Trim())" }
            if (-not $row.error) {
                $first = ($txt | Select-String -Pattern '\*\*\*\*|Sys_Error|unknown item|cannot cast|Exceeded limit|linkTo' | Select-Object -First 1)
                if ($first) { $row.error = $first.Line.Trim() }
            }
        }
        $couldnot = ($txt | Select-String -Pattern 'Could not load').Count
        if ($couldnot) { Say "    (`"Could not load`" x $couldnot)" 'Yellow' }
    }
    $results += [pscustomobject]$row
}

Say ""
Say "================= $Tag summary =================" 'Cyan'
foreach ($r in $results) {
    Say ("{0,-24} fs_game={1,-28} alive={2,-5} getstatus={3,-5} {4}" -f
         $r.map, $r.fs_game, $r.alive, $r.answered, $r.error)
}
Say "transcript: $transcript" 'Cyan'
$results | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $logDir "$Tag.json") -Encoding utf8
