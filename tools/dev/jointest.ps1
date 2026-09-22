<#
.SYNOPSIS
  Two-process join test: a headless dedicated server, then a client that connects to it.

.DESCRIPTION
  Milestone (d) of docs/kickstart/dedi.md. Takes game.lock ONCE for both processes
  (dev-box.md rule 5 allows that for a server+client experiment), launches the server,
  waits until it actually answers on the wire, then launches the client as a companion
  and watches both. Kills only the two PIDs it started and releases the lock.

  THE READINESS GATE IS AN EXIT CODE, NOT A GREP. The previous session's harness
  matched "REPLY" inside "NO REPLY" and fired a client at a stalled server, producing a
  run that looked like a networking failure and was not. tools\dev\oob.py exits 0 only
  when the server answered, so this gates on $LASTEXITCODE.

  HOW THE CLIENT IS TOLD TO CONNECT: not `+connect`. That is not a client command in
  this exe (docs/re/t4-sp-map.md §5) -- `connect` exists only as the SERVER-side
  out-of-band name. The client half is client-dll/components/connect_local.cpp, which
  calls CL_ConnectLocal 0x641730 from the frame tick when ENW_CLIENT_CONNECT is set.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\dev\jointest.ps1 -Tag join5 -ClientFrom dedi-client
#>
[CmdletBinding()]
param(
    [string]$Tag = 'join1',

    # Game copies. The server and client must be DIFFERENT copies: one binkw32 proxy each.
    [string]$ServerName = 'd2',
    [string]$ClientName = 'c1',

    # build\<name> to deploy each half from. A client-only build keeps referee's hooks
    # out of the client so its crash cannot be mistaken for a networking failure.
    [string]$ServerFrom = 'dedi',
    [string]$ClientFrom = '',

    [string]$Map = 'nazi_zombie_prototype',

    # A CUSTOM MAP IS ITS OWN MOD. The engine loads nazi_zombie_leviathan out of
    # mods\nazi_zombie_leviathan, so fs_game must be that -- not our mods/enw overlay,
    # and not empty. The DLL rides in on the binkw32 proxy, never on fs_game, so there
    # is no "how do both load at once" problem: there is only ever one mod, the map's.
    # Pass 'auto' to use mods/<Map> whenever <Map> is not one of the four stock maps.
    # Note the engine then writes console.log to <fs_homepath>\<fs_game>\, not main\.
    [string]$FsGame = 'auto',
    [int]$Port = 28960,

    # How long to wait for the server to answer on the wire before giving up.
    [int]$ReadySeconds = 60,
    # How long to watch after the client is up.
    [int]$WatchSeconds = 120,

    # Skip deploying; use whatever is already in the copies.
    [switch]$NoDeploy,

    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $DevRoot 'logs\dedi'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$transcript = Join-Path $logDir "$Tag.txt"

function Say($msg, $colour = 'Gray') {
    Write-Host $msg -ForegroundColor $colour
    Add-Content -LiteralPath $transcript -Value ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg) -Encoding utf8
}

$stockMaps = @('nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory')
if ($FsGame -eq 'auto') {
    $FsGame = if ($stockMaps -contains $Map) { '' } else { "mods/$Map" }
}

Set-Content -LiteralPath $transcript -Value "jointest $Tag  $(Get-Date -Format o)" -Encoding utf8
Say "server=waw-$ServerName client=waw-$ClientName map=$Map fs_game='$FsGame' port=$Port" 'Cyan'

# The map's mod folder has to be visible from BOTH homepaths. install_map.py makes a
# directory junction per map, so this costs one filesystem entry, not 500 MB.
if ($FsGame) {
    $modName = Split-Path -Leaf $FsGame
    foreach ($h in @($ServerName, $ClientName)) {
        $dst = Join-Path $DevRoot "homes\$h\mods\$modName"
        if (Test-Path -LiteralPath $dst) { continue }
        $src = Join-Path $DevRoot "archive\mods\$modName"
        if (-not (Test-Path -LiteralPath $src)) {
            Say "NO SUCH MAP: $src -- run archive\install_map.py first" 'Red'
            throw "map $modName is not in the archive at $src"
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
        cmd /c mklink /J "$dst" "$src" | Out-Null
        Say "junctioned $dst -> $src"
    }
}

# ---------------------------------------------------------------------- deploy --
if (-not $NoDeploy) {
    & (Join-Path $PSScriptRoot 'deploy.ps1') $ServerName -From $ServerFrom | Out-Null
    Say "deployed build\$ServerFrom -> waw-$ServerName"
    if ($ClientFrom) {
        & (Join-Path $PSScriptRoot 'deploy.ps1') $ClientName -From $ClientFrom | Out-Null
        Say "deployed build\$ClientFrom -> waw-$ClientName"
    }
    else {
        Say "-ClientFrom not given: leaving waw-$ClientName's DLL alone" 'Yellow'
    }
}

$serverPid = 0
$clientPid = 0
$lockFile = Join-Path $DevRoot 'locks\game.lock'

try {
    # ------------------------------------------------------------- the server --
    $env:ENW_DEDI_SUPPRESS_MAPSUMMARY = '1'
    $env:ENW_CLIENT_CONNECT = $null      # never arm the client half in the server
    $env:ENW_CONNECT_ADDR = $null
    # Both halves: Sys_SendPacket 0x6000B0 routes game traffic through Demonware's
    # bdSocketRouter, which drops every packet with `addrHandle=0` because there is no
    # Demonware session to get a handle from (proven in run join6). The raw sendto path
    # is one byte away -- shared/core/components/raw_sockets.cpp.
    $env:ENW_RAW_SOCKETS = '1'
    # com_maxfps: frame_pacing.cpp nops the branch that made dedicated mode ignore
    # this dvar, but the harness never passed one, so every join run so far measured
    # a server free-running at ~237 Hz and burning a whole core (join13: 111.5 s of
    # CPU in 120 s of wall clock). 60 is 3x sv_fps, the same figure dediprobe.ps1
    # uses. Without it the CPU column of a join run means nothing.
    $serverArgs = @(
        '+set', 'dedicated', '1', '+set', 'zombiemode', '1', '+set', 'logfile', '2',
        '+set', 'com_maxfps', '60',
        '+set', 's_volume', '0', '+set', 'snd_volume', '0',
        '+set', 'con_typewriterColorBase', '1.0 1.0 1.0',
        '+set', 'hud_drawhud', '1', '+set', 'ui_campaign', 'american',
        '+set', 'sv_maxclients', '4', '+set', 'net_port', "$Port"
    )
    # fs_game BEFORE +map: the map fastfile lives inside the mod folder, so the search
    # path has to already include it when the map load runs. (Same ordering bug class as
    # `+map` before `+set net_port`, STATUS.md "Fixed today".)
    if ($FsGame) { $serverArgs += @('+set', 'fs_game', $FsGame) }
    $serverArgs += @('+map', $Map)
    $serverPid = & (Join-Path $PSScriptRoot 'launch.ps1') $ServerName -Role server -HomePath own `
        -GameArgs $serverArgs -Why "dedi $Tag join test (server + client)" | Select-Object -Last 1
    if (-not $serverPid) { throw 'launch.ps1 did not return a server PID' }
    Say "server PID $serverPid" 'Green'

    # ------------------------------------------------- wait for the wire, not a log --
    $ready = $false
    $probe = Join-Path $PSScriptRoot 'oob.py'
    $deadline = (Get-Date).AddSeconds($ReadySeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
            throw "the server exited before it answered (PID $serverPid)"
        }
        $out = & python $probe $Port --timeout 1.0 2>&1
        if ($LASTEXITCODE -eq 0) {
            $ready = $true
            Say "server ANSWERED on udp/$Port after $([int](($ReadySeconds) - ($deadline - (Get-Date)).TotalSeconds))s" 'Green'
            $out | ForEach-Object { Say "    $_" }
            break
        }
    }
    if (-not $ready) {
        Say "server never answered udp/$Port in ${ReadySeconds}s. Last probe:" 'Yellow'
        (& python $probe $Port --timeout 1.0 2>&1) | ForEach-Object { Say "    $_" }
        Say 'Launching the client anyway so the attempt is on the record.' 'Yellow'
    }

    # ------------------------------------------------------------- the client --
    # -Companion: joins the experiment that already holds the lock rather than taking
    # a second one, so the interlock is never bypassed.
    $env:ENW_CLIENT_CONNECT = $Map
    # CL_ConnectLocal hard-codes "localhost", and NET_StringToAdr 0x679520 turns that
    # exact string into NA_LOOPBACK -- the engine's IN-PROCESS ring buffer, with no ip
    # and no port. A second process is unreachable that way (proven in run join5: the
    # server saw 0 packets from the client). shared/core/components/connect_address.cpp
    # rewrites the push operand when this is set.
    $env:ENW_CONNECT_ADDR = "127.0.0.1:$Port"
    $clientArgs = @(
        '+set', 'logfile', '2', '+set', 'zombiemode', '1',
        '+set', 's_volume', '0', '+set', 'snd_volume', '0'
    )
    # The client needs the same mod mounted or it cannot load the map it is sent to.
    if ($FsGame) { $clientArgs += @('+set', 'fs_game', $FsGame) }
    $clientPid = & (Join-Path $PSScriptRoot 'launch.ps1') $ClientName -Role client -HomePath own `
        -Companion -GameArgs $clientArgs -EnwHost "127.0.0.1:$Port" | Select-Object -Last 1
    if (-not $clientPid) { throw 'launch.ps1 did not return a client PID' }
    Say "client PID $clientPid (ENW_CLIENT_CONNECT=$Map)" 'Green'

    # ------------------------------------------------------------------ watch --
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt $WatchSeconds) {
        Start-Sleep -Seconds 5
        $sp = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
        $cp = Get-Process -Id $clientPid -ErrorAction SilentlyContinue
        $t = [int]((Get-Date) - $t0).TotalSeconds
        Say ("t={0,4}s  server {1}  client {2}" -f $t,
            $(if ($sp) { "cpu=$([math]::Round($sp.CPU,1))s rss=$([math]::Round($sp.WorkingSet64/1MB,0))MB" } else { 'GONE' }),
            $(if ($cp) { "cpu=$([math]::Round($cp.CPU,1))s rss=$([math]::Round($cp.WorkingSet64/1MB,0))MB" } else { 'GONE' }))
        if (-not $sp -and -not $cp) { break }
    }
}
finally {
    foreach ($p in @($clientPid, $serverPid)) {
        if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) {
            Say "killing our PID $p"
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
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

    # ------------------------------------------------------------- collect --
    # With fs_game set the engine writes console.log under <fs_homepath>\<fs_game>\,
    # not main\ (launcher.md found this the hard way). Collect whichever exists.
    $conSub = if ($FsGame) { $FsGame -replace '/', '\' } else { 'main' }
    foreach ($pair in @(
            @((Join-Path $DevRoot "logs\$ServerName\enw-$serverPid.log"), "$Tag.server.enw.log"),
            @((Join-Path $DevRoot "logs\$ClientName\enw-$clientPid.log"), "$Tag.client.enw.log"),
            @((Join-Path $DevRoot "homes\$ServerName\$conSub\console.log"), "$Tag.server.console.log"),
            @((Join-Path $DevRoot "homes\$ClientName\$conSub\console.log"), "$Tag.client.console.log"))) {
        if (Test-Path -LiteralPath $pair[0]) {
            Copy-Item -LiteralPath $pair[0] -Destination (Join-Path $logDir $pair[1]) -Force
            Say "collected $($pair[1])"
        }
        else { Say "MISSING $($pair[0])" 'Yellow' }
    }
    Say "transcript: $transcript" 'Cyan'
}
