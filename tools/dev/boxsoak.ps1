<#
.SYNOPSIS
  Long soak on the BOX (zombies-dev): an agent `--dev-god` lease (Custom, test god mode, fake ID),
  an invisible client from B's PC, box-side samples every 60 s over ssh, a drop + rejoin in the
  middle, and a real game over at the end (dedi.md §23).

.DESCRIPTION
  Before the lease: refuses if the site has a live NON-agent lease (a real player) or the box
  journal shows a verified non-fake player in the last 10 minutes (README rule 13).
  The lease: `web/tools/lease-cli.js --dev-god` from the MAIN checkout (it owns web/data), fake
  ID only (never B's). Custom + agent: the host gives that one game ENW_DEV_KNOBS=1 +
  ENW_DEV_GOD=1; the referee reports enw_dev_knobs 1, so it is never a record.
  The client: invisible, private LocalAppData, com_maxfps 60, the lease's own invite token.
  game.lock: taken here (waits), or with -Companion joined to a running tools\dev\soak.ps1's
  lock (the two runs are one experiment on B's PC).
  The end: `enw_dev_god.off` in the instance's game dir (box DLL >= 0f31e12), wait for the
  game's own game_over; then the lease is cancelled either way.

  Output: ZombiesDev\logs\dedi\<Tag>.box.csv, <Tag>.txt, <Tag>.client*.enw.log, <Tag>.box-enw.log,
  <Tag>.journal.txt, <Tag>.summary.txt
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$Map = 'nazi_zombie_fear_mc_2',
    [int]$Minutes = 65,
    [int]$RejoinAt = 30,
    [string]$Player = '76561198000000003',
    [string]$ClientName = 'c1',
    [string]$From = 'soak',
    [switch]$NoDeploy,
    [int]$ClientPort = 28992,
    [switch]$Companion,
    [int]$WaitMinutes = 60,
    [string]$MainRepo = 'C:\Users\b\Desktop\Zombies',
    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)
# Continue, not Stop: in PowerShell 5.1 any stderr line from ssh/node under `2>&1` becomes a
# terminating NativeCommandError. Every real failure below throws explicitly.
$ErrorActionPreference = 'Continue'
if ($Player -eq '76561198126330106') { throw 'never B''s SteamID' }
if ($Player -notmatch '^7656119800000000[1-9]$') { throw 'fake IDs only (76561198000000001..9)' }
$logDir = Join-Path $DevRoot 'logs\dedi'
$transcript = Join-Path $logDir "$Tag.txt"
$csv = Join-Path $logDir "$Tag.box.csv"
$lockFile = Join-Path $DevRoot 'locks\game.lock'
$launch = Join-Path $PSScriptRoot 'launch.ps1'
function Say($msg, $colour = 'Gray') {
    Write-Host $msg -ForegroundColor $colour
    Add-Content -LiteralPath $transcript -Value ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg) -Encoding utf8
}
function Box([string]$cmd) { & ssh -o BatchMode=yes -o ConnectTimeout=15 zombies-dev $cmd 2>&1 }
Set-Content -LiteralPath $transcript -Value "boxsoak $Tag  $(Get-Date -Format o)" -Encoding utf8
$stockMaps = @('nazi_zombie_prototype', 'nazi_zombie_asylum', 'nazi_zombie_sumpf', 'nazi_zombie_factory')
$fsGame = if ($stockMaps -contains $Map) { '' } else { "mods/$Map" }

# ------------------------------------------------------------- is anyone playing? --
function Test-RealPlayer {
    $env:ZM_DATA_DIR = Join-Path $MainRepo 'web\data'
    # A file, not `node -e`: PowerShell 5.1 strips the double quotes out of a native argument.
    $js = Join-Path $env:TEMP "boxsoak-live-$PID.cjs"
    Set-Content -LiteralPath $js -Encoding ascii -Value (@(
        "const {db}=require('$($MainRepo.Replace('\','/'))/web/server/db/database');",
        "const r=db.prepare(`"SELECT match_id,map_key FROM assignments WHERE state IN ('leased','ready','live') AND (agent IS NULL OR agent=0)`").all();",
        'console.log(JSON.stringify(r))') -join "`n")
    $live = cmd /c "node `"$js`" 2>nul" | Select-Object -Last 1
    Remove-Item -LiteralPath $js -Force -ErrorAction SilentlyContinue
    if ($null -eq $live) { throw 'could not read the site''s live leases' }
    $j = Box "journalctl -u enw-host-agent --since '-10 min' --no-pager | grep 'ALLOW' | grep -v 7656119800000000 | tail -3"
    return @{ live = $live; journal = ($j -join ' | ') }
}
$rp = Test-RealPlayer
Say "site live non-agent leases: $($rp.live); journal verified non-fake (10 min): '$($rp.journal)'"
if ($rp.live -and $rp.live -ne '[]') { throw "a real player's lease is live ($($rp.live)) - not leasing (rule 13)" }
if ($rp.journal -match 'ALLOW') { throw "the journal shows a verified player in the last 10 min - not leasing" }
$mem = Box "grep MemAvailable /proc/meminfo"
Say "box $mem"

# ------------------------------------------------------------------------ lock --
$ownLock = $null
if ($Companion) {
    $held = if (Test-Path -LiteralPath $lockFile) { (Get-Content -LiteralPath $lockFile -Raw).Trim() } else { '' }
    $f = $held -split '\s+'
    if (-not ($f.Count -ge 2 -and $f[0] -eq 'soak' -and (Get-Process -Id ([int]$f[1]) -ErrorAction SilentlyContinue))) {
        throw "-Companion needs a running soak.ps1 holding game.lock; it holds: '$held'"
    }
    Say "joining the soak experiment's lock: $held"
} else {
    $waitUntil = (Get-Date).AddMinutes($WaitMinutes)
    while ((Test-Path -LiteralPath $lockFile) -and (Get-Date) -lt $waitUntil) { Start-Sleep -Seconds 15 }
    $ownLock = "boxsoak $PID $(Get-Date -Format o) dedi box soak $Tag $Map $Minutes min, client only, holds until ~$((Get-Date).AddMinutes($Minutes + 8).ToString('HH:mm'))"
    $fs = [IO.File]::Open($lockFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $b = [Text.Encoding]::ASCII.GetBytes($ownLock); $fs.Write($b, 0, $b.Length); $fs.Close()
    Say "took game.lock: $ownLock" 'Cyan'
}
function Beat-Lock { if ($ownLock -and (Test-Path -LiteralPath $lockFile)) { (Get-Item -LiteralPath $lockFile).LastWriteTime = Get-Date } }

$matchId = $null; $clientPid = 0; $clientPids = @(); $slotName = $null; $incidents = New-Object System.Collections.Generic.List[string]
try {
    # ----------------------------------------------------------------- lease --
    $env:ZM_DATA_DIR = Join-Path $MainRepo 'web\data'
    $out = & node (Join-Path $MainRepo 'web\tools\lease-cli.js') --map $Map --player $Player --dev-god 2>&1
    $out | ForEach-Object { Say "  lease-cli: $_" }
    $info = $out | Where-Object { $_ -match '^\{.*"connect"' } | Select-Object -Last 1 | ConvertFrom-Json
    if (-not $info) { throw 'the lease never became ready' }
    $matchId = $info.match_id
    Say "lease $matchId connect=$($info.connect) mode=$($info.mode)" 'Green'
    $port = [int](($info.connect -split ':')[1])
    $slotName = 'inst-{0:D2}' -f ((($port - 28960) / 2) + 1)

    # ---------------------------------------------------------------- client --
    if (-not $NoDeploy) { & (Join-Path $PSScriptRoot 'deploy.ps1') $ClientName -From $From | Out-Null; Say "deployed build\$From -> waw-$ClientName" }
    . (Join-Path $PSScriptRoot 'mapmount.ps1')
    if ($fsGame) { Mount-EnwMap -Bsp $Map -Homes @($ClientName) -DevRoot $DevRoot -Log { param($m, $c) Say $m $c } }
    function Start-Client([string]$why) {
        $env:ENW_CLIENT_CONNECT = $Map; $env:ENW_CONNECT_ADDR = $info.connect; $env:ENW_RAW_SOCKETS = '1'
        $env:ENW_TEST_NO_ACTIVATE = '1'; $env:ENW_BORDERLESS_COVER = '0'; $env:ENW_BORDERLESS = '0'
        $a = @('+set', 'logfile', '2', '+set', 'zombiemode', '1', '+set', 's_volume', '0', '+set', 'snd_volume', '0',
               '+set', 'com_maxfps', '60', '+set', 'net_port', "$ClientPort", '+set', 'rate', '25000', '+set', 'snaps', '30', '+set', 'cl_maxpackets', '100')
        if ($fsGame) { $a += @('+set', 'fs_game', $fsGame) }
        $cp = & $launch $ClientName -Role client -HomePath own -Companion -GameArgs $a -EnwHost $info.connect `
            -AuthToken $info.token -Why "boxsoak $Tag client ($why)" | Select-Object -Last 1
        foreach ($k in 'ENW_CLIENT_CONNECT', 'ENW_CONNECT_ADDR') { Set-Item -Path "env:$k" -Value $null }
        return [int]$cp
    }
    if ($ownLock) {
        # launch.ps1 -Companion wants a lock; ours says boxsoak, which is fine for it.
    }
    $clientPid = Start-Client 'first join'; $clientPids += $clientPid
    Say "client PID $clientPid -> $($info.connect) ($slotName)" 'Green'

    # ---------------------------------------------------------------- sample --
    'utc,t_s,box_rss_mb,box_cpu_s,mem_avail_mb,host_rss_mb,replay_bytes,body_hz,com_frameTime,snaps_per_s,child_vars,parent_vars,localvars,watch_hits,client_rss_mb,client_alive' |
        Set-Content -LiteralPath $csv -Encoding ascii
    $probe = @"
p=`$(pgrep -f 'CoDWaW.exe.*home[s].$slotName' | head -1); h=`$(systemctl show -p MainPID --value enw-host-agent);
rss=`$(awk '/VmRSS/{print int(`$2/1024)}' /proc/`$p/status 2>/dev/null); cpu=`$(awk '{print (`$14+`$15)/100}' /proc/`$p/stat 2>/dev/null);
mem=`$(awk '/MemAvailable/{print int(`$2/1024)}' /proc/meminfo); hr=`$(awk '/VmRSS/{print int(`$2/1024)}' /proc/`$h/status);
rep=`$(stat -c %s /home/waw/zdev-host/replays/$matchId*.enwr 2>/dev/null | awk '{s+=`$1} END{print s+0}');
log=`$(ls -t /home/waw/pfx/drive_c/zdev/waw-$slotName/enw-*.log | head -1);
echo "S `$rss `$cpu `$mem `$hr `$rep `$log";
tail -n 300 `$log | grep -E 'dedi_rate_probe|net_probe: [0-9.]+s|varpool: child' | tail -n 6;
grep -c 'WRITE #' `$log
"@ -replace "`r", ''
    $t0 = Get-Date; $rejoined = $false; $boxLog = $null
    while (((Get-Date) - $t0).TotalMinutes -lt $Minutes) {
        Start-Sleep -Seconds 60
        Beat-Lock
        $t = [int]((Get-Date) - $t0).TotalSeconds
        $cp = Get-Process -Id $clientPid -ErrorAction SilentlyContinue
        if ($RejoinAt -gt 0 -and -not $rejoined -and $t -ge $RejoinAt * 60) {
            $rejoined = $true
            Say "t=${t}s DROP: killing our client PID $clientPid (rejoin test)" 'Yellow'
            Stop-Process -Id $clientPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 30
            $clientPid = Start-Client 'rejoin'; $clientPids += $clientPid
            Say "t=${t}s REJOIN: client PID $clientPid" 'Yellow'
            continue
        }
        if (-not $cp) {
            $incidents.Add("t=${t}s client process gone unexpectedly; relaunching")
            Say "t=${t}s client GONE - relaunching" 'Red'
            $clientPid = Start-Client 'relaunch after loss'; $clientPids += $clientPid
            continue
        }
        $r = Box $probe
        $s = ($r | Where-Object { $_ -match '^S ' } | Select-Object -First 1) -split ' '
        if ($s.Count -ge 7) { $boxLog = $s[6] }
        $rate = $r | Where-Object { $_ -match 'dedi_rate_probe' } | Select-Object -Last 1
        $net = $r | Where-Object { $_ -match 'net_probe: [0-9.]+s' } | Select-Object -Last 1
        $vp = $r | Where-Object { $_ -match 'varpool: child' } | Select-Object -Last 1
        $hits = $r | Select-Object -Last 1
        $bodyHz = if ($rate -match 'Com_Frame-body ([0-9.]+) Hz') { $Matches[1] } else { '' }
        $ft = if ($rate -match 'com_frameTime=(\d+)') { $Matches[1] } else { '' }
        $snaps = if ($net -match 'msgs=\d+ \(([0-9.]+)/s\)') { $Matches[1] } else { '' }
        $child = if ($vp -match 'child (\d+)/') { $Matches[1] } else { '' }
        $parent = if ($vp -match 'parent (\d+)/') { $Matches[1] } else { '' }
        $lv = if ($vp -match 'localVars ([0-9A-F]+)') { $Matches[1] } else { '' }
        if (-not $s[1]) { $incidents.Add("t=${t}s box instance process not found"); Say "t=${t}s box instance GONE?" 'Red' }
        $row = '{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12},{13},{14},{15}' -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), $t,
            $s[1], $s[2], $s[3], $s[4], $s[5], $bodyHz, $ft, $snaps, $child, $parent, $lv, $hits, [int]($cp.WorkingSet64 / 1MB), 1
        Add-Content -LiteralPath $csv -Value $row -Encoding ascii
        if (($t % 300) -lt 60) { Say "t=${t}s $row" }
        if ($bodyHz -eq '0.0') { $incidents.Add("t=${t}s box Com_Frame-body 0.0 Hz") }
        if ($hits -match '^\d+$' -and [int]$hits -gt 0) { $incidents.Add("t=${t}s localVars write watch fired ($hits)") }
    }

    # ------------------------------------------------------------- the end --
    $gameDir = "/home/waw/pfx/drive_c/zdev/waw-$slotName"
    Say "END: touching $gameDir/enw_dev_god.off (god released; the game should end itself)" 'Cyan'
    Box "touch $gameDir/enw_dev_god.off" | Out-Null
    $until = (Get-Date).AddMinutes(5); $over = $false
    while ((Get-Date) -lt $until) {
        Start-Sleep -Seconds 15
        Beat-Lock
        $j = Box "journalctl -u enw-host-agent --since '-6 min' --no-pager | grep -E '$matchId|$slotName' | grep -Ei 'game over|match_end|disposition' | tail -3"
        if ($j -match 'game over|disposition') { $over = $true; $j | ForEach-Object { Say "  journal: $_" }; break }
    }
    Say "game ended itself: $over" $(if ($over) { 'Green' } else { 'Yellow' })
    Start-Sleep -Seconds 20
}
finally {
    foreach ($p in $clientPids) { if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { Say "killing our PID $p"; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }
    if ($matchId) {
        $env:ZM_DATA_DIR = Join-Path $MainRepo 'web\data'
        $c = & node (Join-Path $MainRepo 'web\tools\lease-cli.js') --match $matchId --cancel 2>&1
        Say "cancelled $matchId : $c"
    }
    if ($slotName) { Box "rm -f /home/waw/pfx/drive_c/zdev/waw-$slotName/enw_dev_god.off" | Out-Null }
    foreach ($k in 'ENW_TEST_NO_ACTIVATE', 'ENW_BORDERLESS_COVER', 'ENW_BORDERLESS', 'ENW_RAW_SOCKETS') { Set-Item -Path "env:$k" -Value $null -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    if ($ownLock -and (Test-Path -LiteralPath $lockFile) -and ((Get-Content -LiteralPath $lockFile -Raw).Trim() -eq $ownLock)) { Remove-Item -LiteralPath $lockFile -Force; Say 'released game.lock' }
    $i = 0
    foreach ($cpid in $clientPids) {
        $i++; $src = Join-Path $DevRoot "logs\$ClientName\enw-$cpid.log"
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $logDir "$Tag.client$i.enw.log") -Force }
    }
    if ($boxLog) { & scp -q -o BatchMode=yes "zombies-dev:$boxLog" (Join-Path $logDir "$Tag.box-enw.log") 2>$null }
    if ($matchId) { Box "journalctl -u enw-host-agent --since '-$($Minutes + 20) min' --no-pager | grep -E '$matchId|$slotName'" | Set-Content -LiteralPath (Join-Path $logDir "$Tag.journal.txt") -Encoding utf8 }
    $sum = New-Object System.Collections.Generic.List[string]
    $sum.Add("boxsoak $Tag map=$Map minutes=$Minutes lease=$matchId slot=$slotName player=$Player")
    $rows = @(if (Test-Path -LiteralPath $csv) { Import-Csv -LiteralPath $csv })
    if ($rows.Count) {
        $f = $rows[0]; $l = $rows[-1]
        $sum.Add("samples $($rows.Count); box RSS $($f.box_rss_mb) -> $($l.box_rss_mb) MB; CPU $($f.box_cpu_s) -> $($l.box_cpu_s) s = $([math]::Round(([double]$l.box_cpu_s - [double]$f.box_cpu_s) / [math]::Max(1, [double]$l.t_s - [double]$f.t_s), 3)) core; MemAvailable min $(($rows | Measure-Object mem_avail_mb -Minimum).Minimum) MB; host agent RSS $($f.host_rss_mb) -> $($l.host_rss_mb) MB")
        $sum.Add("body Hz $($f.body_hz)/$($l.body_hz); com_frameTime $($f.com_frameTime) -> $($l.com_frameTime); snaps/s $($f.snaps_per_s)/$($l.snaps_per_s); child vars $($f.child_vars) -> $($l.child_vars); parent $($f.parent_vars) -> $($l.parent_vars); replay bytes $($f.replay_bytes) -> $($l.replay_bytes); watch hits $($l.watch_hits)")
    }
    foreach ($x in $incidents) { $sum.Add("INCIDENT $x") }
    Set-Content -LiteralPath (Join-Path $logDir "$Tag.summary.txt") -Value $sum -Encoding utf8
    $sum | ForEach-Object { Say $_ 'Cyan' }
}
