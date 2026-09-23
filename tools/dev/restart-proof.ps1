<#
  restart-proof.ps1 -- lane RS (esc-menu.md §12): a player's `restart`, end to end, locally.

  A local dedicated server + the REAL host agent (infra/host-agent/host.js --local, with the
  restart grace) + an invisible client (ENW_TEST_NO_ACTIVATE=1, parked at -4000,-4000 by
  launch.ps1, ENW_BORDERLESS_COVER=0, the private LocalAppData), under game.lock (jointest.ps1
  takes and releases it). The console is driven the way a player drives it: the client DLL
  watches ENW_CONSOLE_RESTART_FILE, and when this script drops the file it opens the ENW
  console and types `restart` (N times for spam). This script decides WHEN, from the host's
  own log and the games_mp mirror:

    live   8 s after the game is live                        (the ordinary restart)
    spam   8 s after the map is back: `restart` x3, 400 ms apart
    down   the moment the player goes down (solo: the end_game sequence is ~1 s away)
    end    1.5 s after a game over that nobody restarted     (inside the host's restart grace)

  Logs: ZombiesDev\logs\rs\<Tag>\ (host.out.log, <server>.games_mp.log, replays\) and the
  jointest pair ZombiesDev\logs\dedi\<Tag>.{server,client}.enw.log.

  powershell -ExecutionPolicy Bypass -File tools\dev\restart-proof.ps1 -Tag rs1
  powershell -ExecutionPolicy Bypass -File tools\dev\restart-proof.ps1 -Tag rs2 -Map bridge_zombie -Plan live,spam,end
#>
param(
    [string]$Tag = 'rs1',
    [string]$Map = 'nazi_zombie_prototype',
    [string]$From = 'rs',
    [string]$ServerName = 'nd',
    [string]$ClientName = 'nc',
    [int]$LinkPort = 38961,
    [int]$DashPort = 8961,
    [int]$GraceMs = 10000,
    [int]$Watch = 330,
    [string]$Plan = 'live,spam,down,end'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dev = 'C:\Users\b\ZombiesDev'
$lock = "$dev\locks\game.lock"
$out = "$dev\logs\rs\$Tag"
New-Item -ItemType Directory -Force -Path $out, "$out\replays", "$out\keys", "$out\spool", "$out\host" | Out-Null
$trigger = "$out\restart.trigger"
Remove-Item -LiteralPath $trigger -ErrorAction SilentlyContinue
$match = "m_$Tag"
$notes = "$out\driver.log"
function Note($m) { $l = "[{0:HH:mm:ss.fff}] {1}" -f (Get-Date), $m; Write-Host $l; Add-Content -LiteralPath $notes -Value $l -Encoding utf8 }

function Wait-Lock {
    $deadline = (Get-Date).AddMinutes(60)
    while ((Get-Date) -lt $deadline) {
        $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
        if (-not $busy) {
            Start-Sleep -Milliseconds 1200
            $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
            if (-not $busy) { return }
        }
        Start-Sleep -Milliseconds 700
    }
    throw 'game.lock still held after 60 min'
}

# ---- the host agent (ours; stopped at the end) ---------------------------------------
$hostOut = "$out\host.out.log"
$hostArgs = @("$repo\infra\host-agent\host.js", '--local', '--box', 'rslocal', '--link-port', "$LinkPort",
    '--dash-port', "$DashPort", '--restart-grace-ms', "$GraceMs", '--replay-dir', "$out\replays",
    '--log-dir', "$out\host", '--key-dir', "$out\keys", '--spool-dir', "$out\spool")
$hostProc = Start-Process -FilePath node -ArgumentList $hostArgs -RedirectStandardOutput $hostOut `
    -RedirectStandardError "$out\host.err.log" -WindowStyle Hidden -PassThru
Note "host agent PID $($hostProc.Id) (--local, grace $GraceMs ms, link $LinkPort, dash $DashPort)"
try {
    $ok = $false
    for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
        Start-Sleep -Milliseconds 250
        try {
            $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$DashPort/api/local/expect" -ContentType 'application/json' `
                -Body (@{ instance = $ServerName; match_id = $match; map = $Map } | ConvertTo-Json)
            $ok = $r.ok
        } catch {}
    }
    if (-not $ok) { throw 'the host agent never answered /api/local/expect' }
    Note "registered instance $ServerName as $match ($Map)"

  for ($take = 1; $take -le 8; $take++) {
    Wait-Lock
    # The expectation lasts 10 min; a long wait for the lock outlives it.
    $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$DashPort/api/local/expect" -ContentType 'application/json' `
        -Body (@{ instance = $ServerName; match_id = $match; map = $Map } | ConvertTo-Json)
    Note "game.lock is free; starting jointest (take $take)"
    $job = Start-Job -ScriptBlock {
        param($repo, $Tag, $From, $ServerName, $ClientName, $Watch, $match, $LinkPort, $Map, $trigger)
        $env:ENW_TEST_NO_ACTIVATE = '1'
        $env:ENW_BORDERLESS_COVER = '0'
        $env:ENW_FRAME_CAPTURE = '1'
        $env:ENW_CONSOLE_RESTART_FILE = $trigger
        $env:ENW_CONSOLE_SELFTEST = $null
        $env:ENW_ESC_MENU_SELFTEST = $null
        $env:ENW_CHAT_SELFTEST = $null
        $env:ENW_USE_PRIVATE_LOCALAPPDATA = $null   # launch.ps1's default: the private LocalAppData
        & "$repo\tools\dev\jointest.ps1" -Tag $Tag -ServerFrom $From -ClientFrom $From -ServerName $ServerName `
            -ClientName $ClientName -WatchSeconds $Watch -MatchId $match -LinkHost "127.0.0.1:$LinkPort" -Map $Map *>&1
    } -ArgumentList $repo, $Tag, $From, $ServerName, $ClientName, $Watch, $match, $LinkPort, $Map, $trigger

    $gm = "$out\host\$ServerName.games_mp.log"
    $count = {
        param($file, $pat)
        if (-not (Test-Path -LiteralPath $file)) { return 0 }
        $t = ''
        # Shared read: node (and the host's games_mp mirror) hold these files open for writing,
        # and File.ReadAllText's share mode refuses them (rs2 never fired a step).
        try {
            $fs = [IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
            $sr = New-Object IO.StreamReader($fs)
            $t = $sr.ReadToEnd(); $sr.Close()
        } catch { return 0 }
        ([regex]::Matches($t, $pat)).Count
    }
    $steps = $Plan -split ','
    $si = 0
    $phase = 'wait'
    $at = $null
    $base = @{}
    while ($job.State -eq 'Running') {
        Start-Sleep -Milliseconds 100
        if ($si -ge $steps.Count) { continue }
        $step = $steps[$si]
        $live = & $count $hostOut 'game live:'
        $back = & $count $hostOut 'restart: map back'
        $over = & $count $hostOut 'restart grace: \d+ ms for'
        $down = & $count $gm ';down;'
        if ($phase -eq 'wait') {
            $base = @{ live = $live; back = $back; over = $over; down = $down }
            $phase = 'armed'
            Note "step $step armed (live=$live back=$back grace=$over down=$down)"
            continue
        }
        if ($phase -eq 'armed') {
            $fire = $false; $n = '1'
            switch ($step) {
                'live' { if ($live -ge 1) { if (-not $at) { $at = (Get-Date).AddSeconds(8) } elseif ((Get-Date) -ge $at) { $fire = $true } } }
                'spam' { if ($back -gt 0 -or $live -ge 1) { if (-not $at) { $at = (Get-Date).AddSeconds(8) } elseif ((Get-Date) -ge $at) { $fire = $true; $n = '3' } } }
                'down' { if ($down -gt $base.down) { $fire = $true } }
                'end'  { if ($over -gt $base.over) { if (-not $at) { $at = (Get-Date).AddMilliseconds(1500) } elseif ((Get-Date) -ge $at) { $fire = $true } } }
            }
            if ($fire) {
                Set-Content -LiteralPath $trigger -Value $n -NoNewline -Encoding ascii
                Note "step $step FIRED: restart x$n"
                $phase = 'fired'; $at = $null
            }
            continue
        }
        if ($phase -eq 'fired') {
            if ($back -gt $base.back) {
                Note "step ${step}: the map is back (host: 'restart: map back')"
                $si++; $phase = 'wait'
            } elseif (-not $at) { $at = (Get-Date).AddSeconds(40) }
            elseif ((Get-Date) -ge $at) { Note "step ${step}: NO map back within 40 s"; $si++; $phase = 'wait'; $at = $null }
        }
    }
    $res = @()
    try { $res = @(Receive-Job -Job $job -Wait -ErrorAction Stop) } catch { $res += "jointest threw: $_" }
    $res | ForEach-Object { Add-Content -LiteralPath "$out\jointest.log" -Value "$_" -Encoding utf8 }
    Remove-Job -Job $job -Force
    Note "jointest finished; steps done: $si of $($steps.Count)"
    if ($si -eq 0 -and (($res -join "`n") -match 'game.lock held|already running')) { Note 'another agent took game.lock first; waiting again'; continue }
    break
  }
} finally {
    if ($hostProc -and -not $hostProc.HasExited) { Stop-Process -Id $hostProc.Id -Force -ErrorAction SilentlyContinue; Note "stopped our host agent PID $($hostProc.Id)" }
    Remove-Item -LiteralPath $trigger -ErrorAction SilentlyContinue
}
Note 'host lines:'
Select-String -LiteralPath $hostOut -Pattern 'restart|game over|game live|SUMMARY|grace|disposition' | ForEach-Object { Note ("  " + $_.Line) }
