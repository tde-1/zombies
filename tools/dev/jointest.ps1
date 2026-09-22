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

    # ---- identity (referee.md 13) -------------------------------------------
    # THE THING THAT MAKES A JOIN RUN COUNT. Without a token the client's userinfo
    # carries no account at all -- a real T4 client sends name/protocol/challenge/
    # invited/qport/bdTicket and nothing else (join87) -- so the roster is attendance
    # and the site refuses to score it. Mint one with
    #   node tools/dev/authhost.mjs mint --match <id> --steamid <id64>
    # and pass BOTH here: the referee refuses a token minted for a different match.
    [string]$AuthToken = '',

    # THE SPOOF (identity lane, 2026-09-23). Puts `+set name <x>` on the CLIENT's own
    # command line, so the client honestly asks to be called something the token does
    # not say. That is the whole of the name-lock proof: the server must ignore it and
    # the scoreboard must show the token's name instead. Empty = no spoof.
    [string]$ClientNameDvar = '',
    [string]$MatchId = '',

    # Where the SERVER's game link dials out to (ENW_HOST). Point it at
    # `authhost.mjs serve` to see player_connect / auth / game_over for real; leave it
    # empty and the link stays off, which is fine for everything except identity.
    [string]$LinkHost = '',

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

# The map's mod folder has to be visible from BOTH homepaths AND from fs_localAppData:
# the engine's map-exists check opens <fs_localAppData>\<fs_game>\<bsp>.ff with
# CreateFileA and ignores the FS search path entirely. mapmount.ps1 carries the proof
# and makes all three junctions. Missing the fs_localAppData one is what produced
# `Can't find map` on Zombie Desert and Project Viking in map01 (dedi.md 12.6).
. (Join-Path $PSScriptRoot 'mapmount.ps1')
if ($FsGame) {
    $modName = Split-Path -Leaf $FsGame
    Mount-EnwMap -Bsp $modName -Homes @($ServerName, $ClientName) -DevRoot $DevRoot `
        -Log { param($m, $c) Say $m $c }
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

# CLEAR THE CONSOLE LOGS FIRST. The engine APPENDS, and `Get-ChildItem -Recurse` does
# not follow directory junctions -- so on a custom-map run the newest console.log it
# could see under homes\<copy> was the one in main\ from some earlier prototype run.
# join80 was read for fifteen minutes as "the client loaded nazi_zombie_prototype"
# before the file turned out to be a week-old prototype log. Delete both, and on a
# custom map delete the one in the mod folder by its explicit path.
foreach ($copy in @($ServerName, $ClientName)) {
    $paths = @((Join-Path $DevRoot "homes\$copy\main\console.log"))
    if ($FsGame) { $paths += (Join-Path $DevRoot ("homes\$copy\" + ($FsGame -replace '/', '') + '\console.log')) }
    foreach ($p in $paths) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }
}
if ($FsGame) {
    Say ("NOTE: on a custom map both homes' mods\<bsp> are junctions onto the SAME " +
         "archive folder, so the server and the client write ONE shared console.log. " +
         "That -- not the path computation -- is why join59's two console logs were " +
         "byte-identical. Both collected copies below come from that one file.") 'Yellow'
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
    $serverExtra = @{}
    if ($MatchId)  { $serverExtra['MatchId'] = $MatchId }
    if ($LinkHost) { $serverExtra['EnwHost'] = $LinkHost }
    if ($MatchId -or $LinkHost) {
        Say "server identity: match=$(if ($MatchId) { $MatchId } else { '(none)' }) link=$(if ($LinkHost) { $LinkHost } else { 'off' })" 'Cyan'
    }
    $serverPid = & (Join-Path $PSScriptRoot 'launch.ps1') $ServerName -Role server -HomePath own `
        -GameArgs $serverArgs -Why "dedi $Tag join test (server + client)" @serverExtra | Select-Object -Last 1
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
    if ($ClientNameDvar) {
        $clientArgs += @('+set', 'name', $ClientNameDvar)
        # AND the env var the client DLL's `name_pin` reads, which re-issues
        # `set name "<x>"` every few seconds. That is what makes this a test of the
        # ONGOING lock rather than only of the connect edge: each re-set sends a fresh
        # `userinfo` command, which is exactly the path name_lock.cpp hooks. Set here
        # and not earlier on purpose -- the server half is already running, so it never
        # sees this variable.
        $env:ENW_PLAYER_NAME = $ClientNameDvar
        Say "client is launching with +set name '$ClientNameDvar' and ENW_PLAYER_NAME='$ClientNameDvar' -- if the token names somebody else, the server must win, repeatedly" 'Yellow'
    }
    # The invite token goes to the CLIENT: launch.ps1 puts it in the environment, the
    # DLL writes `setu enw_token "<t>"` into this instance's own enw_auth.cfg, and the
    # engine carries it in userinfo on the connect packet. Never on a command line.
    $clientExtra = @{}
    if ($AuthToken) {
        $clientExtra['AuthToken'] = $AuthToken
        Say "client carries an invite token ($($AuthToken.Length) chars, not logged)" 'Cyan'
    } else {
        Say 'client carries NO invite token: the roster will be attendance only (identity=none)' 'Yellow'
    }
    $clientPid = & (Join-Path $PSScriptRoot 'launch.ps1') $ClientName -Role client -HomePath own `
        -Companion -GameArgs $clientArgs -EnwHost "127.0.0.1:$Port" @clientExtra | Select-Object -Last 1
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
    foreach ($pair in @(
            @((Join-Path $DevRoot "logs\$ServerName\enw-$serverPid.log"), "$Tag.server.enw.log"),
            @((Join-Path $DevRoot "logs\$ClientName\enw-$clientPid.log"), "$Tag.client.enw.log"))) {
        if (Test-Path -LiteralPath $pair[0]) {
            Copy-Item -LiteralPath $pair[0] -Destination (Join-Path $logDir $pair[1]) -Force
            Say "collected $($pair[1])"
        }
        else { Say "MISSING $($pair[0])" 'Yellow' }
    }

    # THE CONSOLE LOG MOVES, AND join59 COLLECTED THE WRONG ONE. With fs_game set the
    # engine writes console.log under <fs_homepath>\<fs_game>\ rather than main\, and the
    # fixed $conSub this used to build silently produced a <tag>.server.console.log that
    # was byte-identical to the client's -- so the dedicated server's own console output
    # had never actually been read on a custom-map run. Search the whole home, take the
    # newest, and SAY where it came from and which game copy wrote it, so a mislabel is
    # visible in the transcript instead of costing a session.
    $roles = @{ $ServerName = 'server'; $ClientName = 'client' }
    foreach ($copy in $roles.Keys) {
        $who = @($copy, $roles[$copy])
        $homeDir = Join-Path $DevRoot "homes\$($who[0])"
        # Explicit path when fs_game is set: -Recurse does not cross the junction, so
        # the search silently fell back to main\console.log (see the clear-down above).
        $src = $null
        if ($FsGame) {
            $modLog = Join-Path $homeDir (($FsGame -replace '/', '') + '\console.log')
            if (Test-Path -LiteralPath $modLog) { $src = Get-Item -LiteralPath $modLog }
        }
        if (-not $src) {
            $src = Get-ChildItem -LiteralPath $homeDir -Filter console.log -Recurse -File -ErrorAction SilentlyContinue |
                   Sort-Object LastWriteTime -Descending | Select-Object -First 1
        }
        if (-not $src) { Say "MISSING console.log anywhere under $homeDir" 'Yellow'; continue }
        $dst = Join-Path $logDir "$Tag.$($who[1]).console.log"
        Copy-Item -LiteralPath $src.FullName -Destination $dst -Force
        $wd = (Select-String -Path $dst -Pattern 'Working directory:' | Select-Object -First 1).Line
        Say "collected $Tag.$($who[1]).console.log  from $($src.FullName)  [$wd]"
        if ($wd -and $wd -notmatch [regex]::Escape("waw-$($who[0])")) {
            Say "  WARNING: that console log was written by a different game copy than waw-$($who[0])" 'Red'
        }
    }
    Say "transcript: $transcript" 'Cyan'
}
