<#
.SYNOPSIS
  A bot soak through the HOST AGENT (lane S2, dedi.md §27): an agent `--dev-god` lease on a fake ID,
  N server-side bots (bots.cpp), box samples every 60 s, a real game over at the end.

.DESCRIPTION
  No client anywhere. The lease is an agent's Custom dev lease (web\tools\lease-cli.js from the MAIN
  checkout, which owns web\data), so the host's boot queue and RAM guard arbitrate with every other
  lease and a real player's lease always evicts it. Bots: `--dev-bots N` when the main lease-cli has
  it, and always `enw_dev_bots.txt` in the slot's game dir (read only while ENW_DEV_KNOBS=1, i.e. only
  by a dev lease). The end: `enw_dev_god.off` -> god off, kills off -> the zombies end the game; then
  the lease is cancelled either way and both files are removed.
  Before the lease: refuses while a real player's lease is live (rule 13).
  Output: ZombiesDev\logs\dedi\s2\<Tag>.csv / .txt / .enw.log / .journal.txt
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Map,
    [int]$Minutes = 30,
    [int]$Bots = 1,
    [string]$Player = '76561198000000003',
    [string[]]$Members = @(),
    [int]$WaitMinutes = 120,
    [string]$MainRepo = 'C:\Users\b\Desktop\Zombies',
    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)
$ErrorActionPreference = 'Continue'
foreach ($p in @($Player) + $Members) { if ($p -notmatch '^765611980000000[0-9]{2}$') { throw "fake IDs only: $p" } }
if ($Bots -lt 1 -or $Bots -gt 4) { throw 'bots 1..4' }
$logDir = Join-Path $DevRoot 'logs\dedi\s2'
New-Item -ItemType Directory -Force $logDir | Out-Null
$txt = Join-Path $logDir "$Tag.txt"; $csv = Join-Path $logDir "$Tag.csv"
function Say($m) { $l = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $m; Write-Host $l; Add-Content -LiteralPath $txt -Value $l -Encoding utf8 }
function Box([string]$cmd) { & ssh -n -o BatchMode=yes -o ConnectTimeout=20 zombies-dev $cmd 2>&1 }
Set-Content -LiteralPath $txt -Value "leasesoak $Tag $Map $Minutes min, $Bots bot(s), $(Get-Date -Format o)" -Encoding utf8

function Get-RealLeases {
    $env:ZM_DATA_DIR = Join-Path $MainRepo 'web\data'
    $js = Join-Path $env:TEMP "leasesoak-live-$PID.cjs"
    Set-Content -LiteralPath $js -Encoding ascii -Value (@(
        "const {db}=require('$($MainRepo.Replace('\','/'))/web/server/db/database');",
        "const r=db.prepare(`"SELECT match_id,map_key,state FROM assignments WHERE state IN ('live') AND (agent IS NULL OR agent=0)`").all();",
        'console.log(JSON.stringify(r))') -join "`n")
    $live = cmd /c "node `"$js`" 2>nul" | Select-Object -Last 1
    Remove-Item -LiteralPath $js -Force -ErrorAction SilentlyContinue
    return $live
}
$until = (Get-Date).AddMinutes($WaitMinutes)
while ($true) {
    $live = Get-RealLeases
    if ($live -eq '[]') { break }
    if ((Get-Date) -gt $until) { Say "gave up: a real player's game stayed live ($live)"; exit 3 }
    Say "waiting: a real player's game is live ($live)"; Start-Sleep -Seconds 120
}

$leaseCli = Join-Path $MainRepo 'web\tools\lease-cli.js'
$hasBots = Select-String -LiteralPath $leaseCli -Pattern 'dev-bots' -Quiet
$largs = @($leaseCli, '--map', $Map, '--player', ((@($Player) + $Members) -join ','), '--dev-god')
if ($hasBots) { $largs += @('--dev-bots', "$Bots") }
$matchId = $null; $slot = $null; $gameDir = $null; $boxLog = $null
try {
    $env:ZM_DATA_DIR = Join-Path $MainRepo 'web\data'
    $out = & node @largs 2>&1
    $out | ForEach-Object { Say "  lease-cli: $_" }
    $info = $out | Where-Object { $_ -match '^\{.*"connect"' } | Select-Object -Last 1 | ConvertFrom-Json
    if (-not $info) { throw 'the lease never became ready' }
    $matchId = $info.match_id
    $port = [int](($info.connect -split ':')[1])
    $slot = 'inst-{0:D2}' -f ((($port - 28960) / 2) + 1)
    $gameDir = "/home/waw/pfx/drive_c/zdev/waw-$slot"
    Box "echo $Bots > $gameDir/enw_dev_bots.txt; chown waw:waw $gameDir/enw_dev_bots.txt; rm -f $gameDir/enw_dev_god.off" | Out-Null
    Say "lease $matchId on $slot ($($info.connect)); bots $Bots (lease-cli --dev-bots: $hasBots)"

    'utc,t_s,cpu_permille,rss_mb,mem_avail_mb,load1,devbots_line,round,escapes,body_hz' | Set-Content -LiteralPath $csv -Encoding ascii
    $probe = @"
p=`$(pgrep -f '^CoDWaW.exe .*homes.$slot' | head -1); [ -z "`$p" ] && { echo GONE; exit; }
a=`$(awk '{print `$14+`$15}' /proc/`$p/stat); sleep 10; b=`$(awk '{print `$14+`$15}' /proc/`$p/stat)
L=`$(ls -t $gameDir/enw-*.log | head -1)
c=`$((b-a)); echo S `$c `$(awk '/VmRSS/{print int(`$2/1024)}' /proc/`$p/status) `$(awk '/MemAvailable/{print int(`$2/1024)}' /proc/meminfo) `$(cut -d' ' -f1 /proc/loadavg) `$L
grep 'dev_bots: bots' `$L | tail -1 | cut -c16-
grep 'referee: ROUND' `$L | tail -1 | grep -oE 'ROUND [0-9]+'
grep -c 'ESCAPED frame' `$L
grep dedi_rate_probe `$L | tail -1 | grep -oE 'Com_Frame-body [0-9.]+'
"@ -replace "`r", ''
    $t0 = Get-Date; $ended = $false
    while (((Get-Date) - $t0).TotalMinutes -lt $Minutes) {
        Start-Sleep -Seconds 50
        $t = [int]((Get-Date) - $t0).TotalSeconds
        $r = @(Box $probe)
        if ($r -contains 'GONE') { Say "t=${t}s the game process is GONE"; $ended = $true; break }
        $s = ($r | Where-Object { $_ -match '^S ' } | Select-Object -First 1) -split ' '
        if ($s.Count -ge 6) { $boxLog = $s[5] }
        $db = ($r | Where-Object { $_ -match 'dev_bots: bots' } | Select-Object -Last 1) -replace ',', ';'
        $round = ($r | Where-Object { $_ -match '^ROUND' } | Select-Object -Last 1) -replace 'ROUND ', ''
        $esc = $r | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1
        $hz = ($r | Where-Object { $_ -match 'Com_Frame-body' } | Select-Object -Last 1) -replace 'Com_Frame-body ', ''
        Add-Content -LiteralPath $csv -Encoding ascii -Value ('{0},{1},{2},{3},{4},{5},"{6}",{7},{8},{9}' -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), $t, $s[1], $s[2], $s[3], $s[4], $db, $round, $esc, $hz)
        if (($t % 600) -lt 60) { Say "t=${t}s cpu $($s[1]) rss $($s[2]) avail $($s[3]) round $round esc $esc hz $hz" }
    }
    if (-not $ended) {
        Say 'END: enw_dev_god.off (god and kills off; the zombies end the game)'
        Box "runuser -u waw -- touch $gameDir/enw_dev_god.off" | Out-Null
        $stop = (Get-Date).AddMinutes(6)
        while ((Get-Date) -lt $stop) {
            Start-Sleep -Seconds 15
            $j = Box "journalctl -u enw-host-agent --since '-3 min' --no-pager -o cat | grep -E '$matchId|$slot' | grep -Ei 'SUMMARY|game over' | tail -2"
            if ($j -match 'SUMMARY|game over') { $j | ForEach-Object { Say "  journal: $_" }; break }
        }
    }
}
finally {
    if ($matchId) {
        $env:ZM_DATA_DIR = Join-Path $MainRepo 'web\data'
        $c = & node $leaseCli --match $matchId --cancel 2>&1
        Say "cancelled $matchId : $c"
        Start-Sleep -Seconds 10
        Box "journalctl -u enw-host-agent --since '-$($Minutes + 30) min' --no-pager -o cat | grep -E '$matchId|$slot'" | Set-Content -LiteralPath (Join-Path $logDir "$Tag.journal.txt") -Encoding utf8
    }
    if ($gameDir) { Box "rm -f $gameDir/enw_dev_god.off $gameDir/enw_dev_bots.txt" | Out-Null }
    if ($boxLog) { & scp -q -o BatchMode=yes "zombies-dev:$boxLog" (Join-Path $logDir "$Tag.enw.log") 2>$null }
    $sum = Box "grep -hE 'referee: (ROUND|GAME OVER)|ESCAPED|escape fault #1|FREEZE' $boxLog | tail -4"
    $sum | ForEach-Object { Say "  log: $_" }
}
