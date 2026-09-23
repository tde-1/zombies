<#
.SYNOPSIS
  Long soak on B's PC: a headless dedicated server and one invisible god-mode client, for an hour
  or more, sampled every 30 s, with a drop + rejoin in the middle and a host `end` at the finish
  (dedi.md §23).

.DESCRIPTION
  What it holds and for how long: game.lock, taken atomically by THIS script with the planned end
  time in the lock text, refreshed every minute (launch.ps1 -Companion refuses a lock older than
  15 min), released at the end. Both game processes are companions of it. Only our own PIDs are
  ever killed.

  The server runs with ENW_DEV_KNOBS=1 + ENW_DEV_GOD=1 (dedicated/soak.cpp holds FL_GODMODE on
  the players): a LOCAL, identity-less game, never Verified, nothing posted anywhere. Like the box
  it runs ENW_NO_PAUSE=1 and ENW_DEDI_WATCH_PROBE_SLOT=1 (the localVars write watch). The link goes
  to tools/dev/soaklink.mjs, which records every game->host message (rounds, game_over,
  match_end, the replay stream) and sends the final `end`.

  The client: invisible (ENW_TEST_NO_ACTIVATE=1, -4000,-4000, ENW_BORDERLESS_COVER=0, ENW_BORDERLESS=0),
  private LocalAppData (launch.ps1's default), com_maxfps passed, no developer 1.

  Output, all under ZombiesDev\logs\dedi\<Tag>.*:
    .samples.csv   one row per 30 s
    .link.ndjson   the game link
    .server.enw.log / .client*.enw.log / .server.console.log
    .summary.txt   the verdict lines
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\dev\soak.ps1 -Tag soak01 -Map nazi_zombie_prototype -Minutes 65
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$Map = 'nazi_zombie_prototype',
    [int]$Minutes = 65,
    # Drop the client at this minute and rejoin 30 s later. 0 = never.
    [int]$RejoinAt = 30,
    [string]$ServerName = 'nd',
    [string]$ClientName = 'nc',
    [string]$From = 'soak',
    [switch]$NoDeploy,
    [int]$Port = 28970,
    [int]$ClientPort = 28990,
    [int]$LobbyPort = 3080,
    [int]$LinkPort = 38797,
    [switch]$NoGod,
    [switch]$BigHeap,
    # ENW_NET_FORCE_WAN=1: pace 127.0.0.1 like an internet client (dedi.md §22), so the
    # snapshot rate is the one a remote player gets. On by default.
    [switch]$Lan,
    [int]$WaitMinutes = 60,
    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $DevRoot 'logs\dedi'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$transcript = Join-Path $logDir "$Tag.txt"
$csv = Join-Path $logDir "$Tag.samples.csv"
$linkOut = Join-Path $logDir "$Tag.link.ndjson"
$lockFile = Join-Path $DevRoot 'locks\game.lock'
$launch = Join-Path $PSScriptRoot 'launch.ps1'
$oob = Join-Path $PSScriptRoot 'oob.py'

# The game holds its log open for writing; Get-Content -Tail then fails with a sharing
# violation now and again (soak01 died of it). Read the last 256 KB with FileShare.ReadWrite.
function Read-Tail([string]$path, [int]$bytes = 262144) {
    try {
        $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        try {
            $n = [Math]::Min($fs.Length, $bytes); $null = $fs.Seek(-$n, [IO.SeekOrigin]::End)
            $buf = New-Object byte[] $n; $got = $fs.Read($buf, 0, $n)
            return ([Text.Encoding]::UTF8.GetString($buf, 0, $got) -split "`r?`n")
        } finally { $fs.Close() }
    } catch { return @() }
}
function Say($msg, $colour = 'Gray') {
    Write-Host $msg -ForegroundColor $colour
    Add-Content -LiteralPath $transcript -Value ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg) -Encoding utf8
}
Set-Content -LiteralPath $transcript -Value "soak $Tag  $(Get-Date -Format o)" -Encoding utf8
foreach ($f in @($csv, $linkOut, "$linkOut.end")) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }

$stockMaps = @('nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory')
$fsGame = if ($stockMaps -contains $Map) { '' } else { "mods/$Map" }

# ------------------------------------------------------------------ the lock --
# Other lanes queue on the same lock: wait for it (up to -WaitMinutes), never steal it.
$waitUntil = (Get-Date).AddMinutes($WaitMinutes)
while ((Test-Path -LiteralPath $lockFile) -and (Get-Date) -lt $waitUntil) {
    $held = $null; try { $held = (Get-Content -LiteralPath $lockFile -Raw -ErrorAction Stop).Trim() } catch {}
    if ($held) { Write-Host "waiting for game.lock: $held" }
    Start-Sleep -Seconds 15
}
$endBy = (Get-Date).AddMinutes($Minutes + 4)
$lockText = "soak $PID $(Get-Date -Format o) dedi soak $Tag $Map $Minutes min, holds until ~$($endBy.ToString('HH:mm')) (server $ServerName + client $ClientName, ports $Port/$ClientPort)"
try {
    $fs = [IO.File]::Open($lockFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $b = [Text.Encoding]::ASCII.GetBytes($lockText); $fs.Write($b, 0, $b.Length); $fs.Close()
} catch [IO.IOException] {
    throw "game.lock is held: $((Get-Content -LiteralPath $lockFile -Raw).Trim())"
}
Say "took game.lock: $lockText" 'Cyan'
function Beat-Lock {
    if ((Test-Path -LiteralPath $lockFile) -and ((Get-Content -LiteralPath $lockFile -Raw) -match "^soak $PID ")) {
        (Get-Item -LiteralPath $lockFile).LastWriteTime = Get-Date
    }
}

$serverPid = 0; $clientPid = 0; $linkProc = $null
$clientPids = @()
$incidents = New-Object System.Collections.Generic.List[string]
try {
    if (-not $NoDeploy) {
        foreach ($c in @($ServerName, $ClientName)) {
            & (Join-Path $PSScriptRoot 'deploy.ps1') $c -From $From | Out-Null
            Say "deployed build\$From -> waw-$c"
        }
    }
    $stale = Join-Path $DevRoot "waw-$ServerName\enw_dev_god.off"
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }
    . (Join-Path $PSScriptRoot 'mapmount.ps1')
    if ($fsGame) {
        Mount-EnwMap -Bsp $Map -Homes @($ServerName, $ClientName) -DevRoot $DevRoot -Log { param($m, $c) Say $m $c }
    }
    foreach ($copy in @($ServerName, $ClientName)) {
        $p = @((Join-Path $DevRoot "homes\$copy\main\console.log"))
        if ($fsGame) { $p += (Join-Path $DevRoot ("homes\$copy\" + ($fsGame -replace '/', '\') + '\console.log')) }
        foreach ($x in $p) { if (Test-Path -LiteralPath $x) { Remove-Item -LiteralPath $x -Force -ErrorAction SilentlyContinue } }
    }

    # ------------------------------------------------------------- the link sink --
    $linkProc = Start-Process -FilePath 'node' -ArgumentList @((Join-Path $PSScriptRoot 'soaklink.mjs'), '--port', "$LinkPort", '--out', "`"$linkOut`"") `
        -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 800
    Say "soaklink pid $($linkProc.Id) on 127.0.0.1:$LinkPort"

    # ---------------------------------------------------------------- the server --
    $env:ENW_DEDI_SUPPRESS_MAPSUMMARY = '1'; $env:ENW_RAW_SOCKETS = '1'
    $env:ENW_CLIENT_CONNECT = $null; $env:ENW_CONNECT_ADDR = $null
    $env:ENW_NO_PAUSE = '1'; $env:ENW_DEDI_WATCH_PROBE_SLOT = '1'
    $env:ENW_LOBBY_PORT = "$LobbyPort"
    if ($NoGod) { $env:ENW_DEV_KNOBS = $null; $env:ENW_DEV_GOD = $null } else { $env:ENW_DEV_KNOBS = '1'; $env:ENW_DEV_GOD = '1' }
    if ($Lan) { $env:ENW_NET_FORCE_WAN = $null } else { $env:ENW_NET_FORCE_WAN = '1' }
    if ($BigHeap) { $env:ENW_DEDI_BIG_HEAP = '1' } else { $env:ENW_DEDI_BIG_HEAP = $null }
    $serverArgs = @('+set', 'dedicated', '1', '+set', 'zombiemode', '1', '+set', 'logfile', '2',
        '+set', 'com_maxfps', '60', '+set', 's_volume', '0', '+set', 'snd_volume', '0',
        '+set', 'con_typewriterColorBase', '1.0 1.0 1.0', '+set', 'hud_drawhud', '1', '+set', 'ui_campaign', 'american',
        '+set', 'sv_maxclients', '4', '+set', 'net_port', "$Port")
    if ($fsGame) { $serverArgs += @('+set', 'fs_game', $fsGame) }
    $serverArgs += @('+map', $Map)
    $serverPid = & $launch $ServerName -Role server -HomePath own -Companion -EnwHost "127.0.0.1:$LinkPort" `
        -GameArgs $serverArgs -Why "soak $Tag server" | Select-Object -Last 1
    if (-not $serverPid) { throw 'no server PID' }
    $serverPid = [int]$serverPid
    Say "server PID $serverPid (god=$(-not $NoGod), force_wan=$(-not $Lan))" 'Green'
    foreach ($k in 'ENW_DEV_KNOBS', 'ENW_DEV_GOD', 'ENW_NO_PAUSE', 'ENW_DEDI_WATCH_PROBE_SLOT', 'ENW_NET_FORCE_WAN', 'ENW_DEDI_BIG_HEAP', 'ENW_LOBBY_PORT') {
        Set-Item -Path "env:$k" -Value $null -ErrorAction SilentlyContinue
    }

    $ready = $false
    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { throw "the server exited before it answered" }
        & python $oob $Port --timeout 1.0 > $null 2>&1
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    }
    if (-not $ready) { throw "server never answered udp/$Port" }
    Say "server answers on udp/$Port" 'Green'

    # ---------------------------------------------------------------- the client --
    function Start-Client([string]$why) {
        $env:ENW_CLIENT_CONNECT = $Map
        $env:ENW_CONNECT_ADDR = "127.0.0.1:$Port"
        $env:ENW_TEST_NO_ACTIVATE = '1'; $env:ENW_BORDERLESS_COVER = '0'; $env:ENW_BORDERLESS = '0'
        $a = @('+set', 'logfile', '2', '+set', 'zombiemode', '1', '+set', 's_volume', '0', '+set', 'snd_volume', '0',
               '+set', 'com_maxfps', '60', '+set', 'net_port', "$ClientPort")
        if ($fsGame) { $a += @('+set', 'fs_game', $fsGame) }
        $cp = & $launch $ClientName -Role client -HomePath own -Companion -GameArgs $a -EnwHost "127.0.0.1:$Port" `
            -Why "soak $Tag client ($why)" | Select-Object -Last 1
        foreach ($k in 'ENW_CLIENT_CONNECT', 'ENW_CONNECT_ADDR') { Set-Item -Path "env:$k" -Value $null }
        return [int]$cp
    }
    $clientPid = Start-Client 'first join'
    $clientPids += $clientPid
    Say "client PID $clientPid" 'Green'

    # ------------------------------------------------------------------- sample --
    'utc,t_s,server_rss_mb,server_cpu_s,client_rss_mb,client_cpu_s,link_bytes,body_hz,com_frameTime,snaps_per_s,child_vars,parent_vars,localvars,round,clients' |
        Set-Content -LiteralPath $csv -Encoding ascii
    $enw = Join-Path $DevRoot "logs\$ServerName\enw-$serverPid.log"
    $t0 = Get-Date
    $rejoined = $false
    $nextBeat = (Get-Date).AddSeconds(60)
    $round = 0
    while (((Get-Date) - $t0).TotalMinutes -lt $Minutes) {
        Start-Sleep -Seconds 30
        $t = [int]((Get-Date) - $t0).TotalSeconds
        if ((Get-Date) -ge $nextBeat) { Beat-Lock; $nextBeat = (Get-Date).AddSeconds(60) }
        $sp = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
        $cp = Get-Process -Id $clientPid -ErrorAction SilentlyContinue
        if (-not $sp) { $incidents.Add("t=${t}s SERVER PROCESS GONE"); Say "t=${t}s SERVER GONE" 'Red'; break }
        if (-not $cp -and -not ($RejoinAt -gt 0 -and -not $rejoined -and $t -ge $RejoinAt * 60)) {
            $incidents.Add("t=${t}s client process gone unexpectedly; relaunching")
            Say "t=${t}s client GONE unexpectedly - relaunching" 'Red'
            $clientPid = Start-Client 'relaunch after loss'; $clientPids += $clientPid
            continue
        }
        if ($RejoinAt -gt 0 -and -not $rejoined -and $t -ge $RejoinAt * 60) {
            $rejoined = $true
            Say "t=${t}s DROP: killing our client PID $clientPid (rejoin test)" 'Yellow'
            Stop-Process -Id $clientPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 30
            $clientPid = Start-Client 'rejoin'; $clientPids += $clientPid
            Say "t=${t}s REJOIN: client PID $clientPid" 'Yellow'
            continue
        }
        # the server's own probes, last line of each
        $bodyHz = ''; $ft = ''; $snaps = ''; $child = ''; $parent = ''; $lv = ''; $clients = ''
        if (Test-Path -LiteralPath $enw) {
            $tail = Read-Tail $enw
            $r = $tail | Where-Object { $_ -match 'dedi_rate_probe:' } | Select-Object -Last 1
            if ($r -match 'Com_Frame-body ([0-9.]+) Hz') { $bodyHz = $Matches[1] }
            if ($r -match 'com_frameTime=(\d+)') { $ft = $Matches[1] }
            $n = $tail | Where-Object { $_ -match 'net_probe: [0-9.]+s sv_maxRate' } | Select-Object -Last 1
            if ($n -match 'msgs=\d+ \(([0-9.]+)/s\)') { $snaps = $Matches[1] }
            $clients = ([regex]::Matches([string]$n, 'cl\d st=4')).Count
            $v = $tail | Where-Object { $_ -match 'varpool: child' } | Select-Object -Last 1
            if ($v -match 'child (\d+)/') { $child = $Matches[1] }
            if ($v -match 'parent (\d+)/') { $parent = $Matches[1] }
            if ($v -match 'localVars ([0-9A-F]+)') { $lv = $Matches[1] }
        }
        if (Test-Path -LiteralPath $linkOut) {
            $rl = Read-Tail $linkOut 4194304 | Where-Object { $_ -match '"t":"round"' } | Select-Object -Last 1
            if ($rl) { $rl = [pscustomobject]@{ Line = $rl } }
            if ($rl -and $rl.Line -match '"n":(\d+)') { $round = [int]$Matches[1] }
        }
        $linkBytes = if (Test-Path -LiteralPath $linkOut) { (Get-Item -LiteralPath $linkOut).Length } else { 0 }
        $row = '{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12},{13},{14}' -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), $t,
            [int]($sp.WorkingSet64 / 1MB), [math]::Round($sp.CPU, 1),
            $(if ($cp) { [int]($cp.WorkingSet64 / 1MB) } else { '' }), $(if ($cp) { [math]::Round($cp.CPU, 1) } else { '' }),
            $linkBytes, $bodyHz, $ft, $snaps, $child, $parent, $lv, $round, $clients
        Add-Content -LiteralPath $csv -Value $row -Encoding ascii
        if (($t % 300) -lt 30) { Say "t=${t}s $row" }
        if ($bodyHz -eq '0.0') { $incidents.Add("t=${t}s Com_Frame-body 0.0 Hz (the engine stopped simulating)") }
    }

    # ----------------------------------------------------------- the game over --
    # First the real way: release god mode (dedicated/soak.cpp's trigger file) and let the
    # idle player be eaten, so the game ends itself (end_game -> game_over -> match_end).
    # Only if that has not happened in 5 minutes, the host's own `end` over the link.
    $offFile = Join-Path $DevRoot "waw-$ServerName\enw_dev_god.off"
    $overSeen = $false
    if (-not $NoGod -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
        Say 'END: god mode released (enw_dev_god.off); waiting for the game to end itself' 'Cyan'
        Set-Content -LiteralPath $offFile -Value 'soak end' -Encoding ascii
        $until = (Get-Date).AddMinutes(5)
        while ((Get-Date) -lt $until) {
            Start-Sleep -Seconds 10
            if ((Select-String -LiteralPath $linkOut -Pattern '"t":"match_end"' -SimpleMatch -Quiet)) { $overSeen = $true; break }
            if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { break }
        }
        Beat-Lock
        Say "game ended itself: $overSeen" $(if ($overSeen) { 'Green' } else { 'Yellow' })
    }
    if (-not $overSeen) {
        Say 'END: asking the game to end the match (host end -> game_over, match_end, map_restart)' 'Cyan'
        Set-Content -LiteralPath "$linkOut.end" -Value 'end' -Encoding ascii
    }
    # Either way the server must still be simulating after it (no_save_reload, dedi.md §12).
    Start-Sleep -Seconds 45
    Beat-Lock
    if (Test-Path -LiteralPath $offFile) { Remove-Item -LiteralPath $offFile -Force -ErrorAction SilentlyContinue }
}
finally {
    foreach ($p in @($clientPid, $serverPid)) {
        if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { Say "killing our PID $p"; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    }
    if ($linkProc -and -not $linkProc.HasExited) { Stop-Process -Id $linkProc.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 1500
    if ((Test-Path -LiteralPath $lockFile) -and ((Get-Content -LiteralPath $lockFile -Raw) -match "^soak $PID ")) {
        Remove-Item -LiteralPath $lockFile -Force; Say 'released game.lock'
    }
    else { Say 'game.lock is not ours any more - left alone' 'Yellow' }
    foreach ($env_k in 'ENW_TEST_NO_ACTIVATE', 'ENW_BORDERLESS_COVER', 'ENW_BORDERLESS') { Set-Item -Path "env:$env_k" -Value $null -ErrorAction SilentlyContinue }

    # ------------------------------------------------------------------ collect --
    if ($serverPid) {
        $src = Join-Path $DevRoot "logs\$ServerName\enw-$serverPid.log"
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $logDir "$Tag.server.enw.log") -Force }
    }
    $i = 0
    foreach ($cpid in $clientPids) {
        $i++
        $src = Join-Path $DevRoot "logs\$ClientName\enw-$cpid.log"
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $logDir "$Tag.client$i.enw.log") -Force }
    }
    $con = if ($fsGame) { Join-Path $DevRoot ("homes\$ServerName\" + ($fsGame -replace '/', '\') + '\console.log') } else { Join-Path $DevRoot "homes\$ServerName\main\console.log" }
    if (Test-Path -LiteralPath $con) { Copy-Item -LiteralPath $con -Destination (Join-Path $logDir "$Tag.server.console.log") -Force }

    # ------------------------------------------------------------------ verdict --
    $sum = New-Object System.Collections.Generic.List[string]
    $sum.Add("soak $Tag map=$Map minutes=$Minutes god=$(-not $NoGod) server=$ServerName client=$ClientName")
    $rows = @(if (Test-Path -LiteralPath $csv) { Import-Csv -LiteralPath $csv })
    if ($rows.Count) {
        $f = $rows[0]; $l = $rows[-1]
        $sum.Add("samples $($rows.Count); server RSS $($f.server_rss_mb) -> $($l.server_rss_mb) MB (max $(($rows | Measure-Object server_rss_mb -Maximum).Maximum)); server CPU $($f.server_cpu_s) -> $($l.server_cpu_s) s over $($l.t_s) s = $([math]::Round(([double]$l.server_cpu_s - [double]$f.server_cpu_s) / [math]::Max(1, [double]$l.t_s - [double]$f.t_s), 3)) core")
        $sum.Add("body Hz first/last $($f.body_hz)/$($l.body_hz); com_frameTime $($f.com_frameTime) -> $($l.com_frameTime); snaps/s last $($l.snaps_per_s); child vars $($f.child_vars) -> $($l.child_vars) (max $(($rows | Where-Object child_vars | Measure-Object child_vars -Maximum).Maximum)); parent $($f.parent_vars) -> $($l.parent_vars); round max $(($rows | Measure-Object round -Maximum).Maximum); link bytes $($l.link_bytes)")
    }
    $srvLog = Join-Path $logDir "$Tag.server.enw.log"
    if (Test-Path -LiteralPath $srvLog) {
        $sum.Add("localVars write watch hits: $((Select-String -LiteralPath $srvLog -Pattern 'WRITE #').Count)")
        $sum.Add("dev_god lines: $((Select-String -LiteralPath $srvLog -Pattern 'dev_god: slot').Count)")
        $sum.Add("ERROR lines: $((Select-String -LiteralPath $srvLog -Pattern '\[ERROR\]').Count)")
        $rp = @((Select-String -LiteralPath $srvLog -Pattern 'dedi_rate_probe:').Line | Select-Object -Last 2)
        if ($rp.Count -eq 2 -and $rp[0] -match 'com_frameTime=(\d+)') {
            $a0 = [int64]$Matches[1]; $null = $rp[1] -match 'com_frameTime=(\d+)'; $a1 = [int64]$Matches[1]
            $sum.Add("after the end: com_frameTime $a0 -> $a1 (still simulating: $($a1 -gt $a0)); last: $($rp[1] -replace '^.*dedi_rate_probe: ','')")
        }
    }
    if (Test-Path -LiteralPath $linkOut) {
        foreach ($k in 'player_connect', 'player_disconnect', 'player_spawn', 'round', 'game_over', 'match_end', 'down', 'map_loaded') {
            $sum.Add("link $k : $((Select-String -LiteralPath $linkOut -Pattern ('"t":"' + $k + '"') -SimpleMatch).Count)")
        }
    }
    foreach ($x in $incidents) { $sum.Add("INCIDENT $x") }
    Set-Content -LiteralPath (Join-Path $logDir "$Tag.summary.txt") -Value $sum -Encoding utf8
    $sum | ForEach-Object { Say $_ 'Cyan' }
}
