<#
  ce-proof.ps1 -- lane CE (client.md §14): F12 at the end of a game, on a 2560x1440-sized
  screenshot, end to end, locally.

  B, 2026-09-23 23:06 UK, Cheese Cube on 0.2.35: he died, the game ended, and 5 s later the client
  dropped with `Hunk_AllocateTempMemory: failed on 11059216 bytes` (the stock F12 bind,
  screenshotJPEG, at 2560x1440). This script plays that game over and presses F12 in it.

  A local dedicated server + the REAL host agent (host.js --local, the 10 s restart grace) + an
  invisible client (ENW_TEST_NO_ACTIVATE=1, parked at -4000,-4000 by launch.ps1,
  ENW_BORDERLESS_COVER=0, the private LocalAppData, 640x480 at com_maxfps 30), under game.lock
  (jointest.ps1 takes and releases it). The idle player is killed by the zombies; the game ends.
  The client DLL's harness switches (screenshot_guard.cpp):
    ENW_SCREENSHOT_TEST=2560x1440  screenshotJPEG writes a synthetic frame of B's size (an
                                   off-screen window cannot grab its back buffer at all)
    ENW_SCREENSHOT_KEY_FILE        this script drops the file; the DLL posts F12 to its window
  F12 is pressed twice: 8 s after the game is live, and 3 s after the game over (inside the
  host's restart grace -- B's was at +5 s). When the host logs its disposition (the box
  terminates the instance there), this script ends OUR server PID (waw-<ServerName>), as the box
  does, so the client meets the silent-server rule and the end screen, then quits on its own.

  -GuardOff runs the same with ENW_SCREENSHOT_GUARD=0: the reproduction of B's drop (use it with
  -NoLiveShot, or the mid-game F12 drops the client before the game over).

  WHERE THE SHOTS GO: the engine writes <Documents>\Activision\CoDWaW\screenshots\ -- B's own
  Documents unless enw_localappdata redirects CSIDL_PERSONAL (client.md §14.5). After a run, check
  that nothing new appeared under C:\Users\b\Documents\Activision.

  Logs: ZombiesDev\logs\ce\<Tag>\ and the jointest pair ZombiesDev\logs\dedi\<Tag>.{server,client}.enw.log.

  powershell -ExecutionPolicy Bypass -File tools\dev\ce-proof.ps1 -Tag ce1 -GuardOff
  powershell -ExecutionPolicy Bypass -File tools\dev\ce-proof.ps1 -Tag ce2
  powershell -ExecutionPolicy Bypass -File tools\dev\ce-proof.ps1 -Tag ce3 -Map nazi_zombie_ccube
#>
param(
    [string]$Tag = 'ce1',
    [string]$Map = 'nazi_zombie_prototype',
    [string]$From = 'ce',
    [string]$ServerName = 'cls',   # lane CL's copies: a FRESH copy's first dedi boot dies in
    [string]$ClientName = 'clc',   # 'snddriverglobals' (ce1, and RS's rs1 on host2)
    [int]$LinkPort = 38971,
    [int]$DashPort = 8971,
    [int]$GraceMs = 10000,
    [int]$Watch = 420,
    [string]$ShotSize = '2560x1440',
    [switch]$GuardOff,
    [switch]$NoLiveShot
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dev = 'C:\Users\b\ZombiesDev'
$lock = "$dev\locks\game.lock"
$out = "$dev\logs\ce\$Tag"
New-Item -ItemType Directory -Force -Path $out, "$out\replays", "$out\keys", "$out\spool", "$out\host" | Out-Null
$keyFile = "$out\f12.trigger"
Remove-Item -LiteralPath $keyFile -ErrorAction SilentlyContinue
$match = "m_$Tag"
$notes = "$out\driver.log"
function Note($m) { $l = "[{0:HH:mm:ss.fff}] {1}" -f (Get-Date), $m; Write-Host $l; try { Add-Content -LiteralPath $notes -Value $l -Encoding utf8 } catch {} }

$hostOut = "$out\host.out.log"
$hostArgs = @("$repo\infra\host-agent\host.js", '--local', '--box', 'celocal', '--link-port', "$LinkPort",
    '--dash-port', "$DashPort", '--restart-grace-ms', "$GraceMs", '--replay-dir', "$out\replays",
    '--log-dir', "$out\host", '--key-dir', "$out\keys", '--spool-dir', "$out\spool")
$hostProc = Start-Process -FilePath node -ArgumentList $hostArgs -RedirectStandardOutput $hostOut `
    -RedirectStandardError "$out\host.err.log" -WindowStyle Hidden -PassThru
Note "host agent PID $($hostProc.Id) (--local, grace $GraceMs ms, link $LinkPort, dash $DashPort); map $Map; guard $(if ($GuardOff) { 'OFF' } else { 'on' })"
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

    $job = Start-Job -ScriptBlock {
        param($repo, $Tag, $From, $ServerName, $ClientName, $Watch, $match, $LinkPort, $Map, $keyFile, $lock, $DashPort, $ShotSize, $GuardOff)
        $deadline = (Get-Date).AddMinutes(60)
        while ((Get-Date) -lt $deadline) {
            $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
            if (-not $busy) { break }
            Start-Sleep -Milliseconds 200
        }
        $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$DashPort/api/local/expect" -ContentType 'application/json' `
            -Body (@{ instance = $ServerName; match_id = $match; map = $Map } | ConvertTo-Json)
        $env:ENW_TEST_NO_ACTIVATE = '1'
        $env:ENW_BORDERLESS_COVER = '0'
        $env:ENW_FRAME_CAPTURE = '1'
        $env:ENW_SCREENSHOT_TEST = $ShotSize
        $env:ENW_SCREENSHOT_KEY_FILE = $keyFile
        $env:ENW_SCREENSHOT_GUARD = $(if ($GuardOff) { '0' } else { $null })
        $env:ENW_CONSOLE_RESTART_FILE = $null
        $env:ENW_CONSOLE_SELFTEST = $null
        $env:ENW_ESC_MENU_SELFTEST = $null
        $env:ENW_CHAT_SELFTEST = $null
        $env:ENW_USE_PRIVATE_LOCALAPPDATA = $null   # launch.ps1's default: the private LocalAppData
        & "$repo\tools\dev\jointest.ps1" -Tag $Tag -ServerFrom $From -ClientFrom $From -ServerName $ServerName `
            -ClientName $ClientName -WatchSeconds $Watch -MatchId $match -LinkHost "127.0.0.1:$LinkPort" -Map $Map `
            -ClientExtraArgs @('+set', 'com_maxfps', '30', '+set', 'r_mode', '640x480') *>&1
    } -ArgumentList $repo, $Tag, $From, $ServerName, $ClientName, $Watch, $match, $LinkPort, $Map, $keyFile, $lock, $DashPort, $ShotSize, $GuardOff.IsPresent

    $count = {
        param($file, $pat)
        if (-not (Test-Path -LiteralPath $file)) { return 0 }
        $t = ''
        try {
            $fs = [IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
            $sr = New-Object IO.StreamReader($fs)
            $t = $sr.ReadToEnd(); $sr.Close()
        } catch { return 0 }
        ([regex]::Matches($t, $pat)).Count
    }
    $liveAt = $null; $liveShot = $NoLiveShot.IsPresent
    $overAt = $null; $endShot = $false
    $killed = $false
    $exe = "$dev\waw-$ServerName\CoDWaW.exe"
    while ($job.State -eq 'Running') {
        Start-Sleep -Milliseconds 100
        if (-not $liveShot) {
            if (-not $liveAt -and (& $count $hostOut 'game live:') -ge 1) { $liveAt = (Get-Date).AddSeconds(8); Note 'game live; F12 in 8 s' }
            if ($liveAt -and (Get-Date) -ge $liveAt) { Set-Content -LiteralPath $keyFile -Value '1' -Encoding ascii; $liveShot = $true; Note 'F12 (mid-game) FIRED' }
        }
        if (-not $endShot) {
            if (-not $overAt -and (& $count $hostOut 'restart grace: \d+ ms for') -ge 1) { $overAt = (Get-Date).AddSeconds(3); Note 'game over (restart grace open); F12 in 3 s' }
            if ($overAt -and (Get-Date) -ge $overAt) { Set-Content -LiteralPath $keyFile -Value '1' -Encoding ascii; $endShot = $true; Note 'F12 (after the game over) FIRED' }
        }
        if (-not $killed -and (& $count $hostOut 'disposition: ') -ge 1) {
            # The box terminates the instance here (--after-game terminate); a --local host never
            # kills a process it did not start, so we end OUR server (waw-$ServerName) ourselves.
            $sp = @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
            foreach ($p in $sp) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Note "disposition: ended our server PID $($p.Id) ($exe), as the box does" }
            $killed = $true
        }
    }
    $res = @()
    try { $res = @(Receive-Job -Job $job -Wait -ErrorAction Stop) } catch { $res += "jointest threw: $_" }
    $res | ForEach-Object { Add-Content -LiteralPath "$out\jointest.log" -Value "$_" -Encoding utf8 }
    Remove-Job -Job $job -Force
    Note 'jointest finished'
} finally {
    if ($hostProc -and -not $hostProc.HasExited) { Stop-Process -Id $hostProc.Id -Force -ErrorAction SilentlyContinue; Note "stopped our host agent PID $($hostProc.Id)" }
    Remove-Item -LiteralPath $keyFile -ErrorAction SilentlyContinue
}
Note 'host lines:'
Select-String -LiteralPath $hostOut -Pattern 'game over|game live|SUMMARY|grace|disposition' | ForEach-Object { Note ("  " + $_.Line) }
$cl = "$dev\logs\dedi\$Tag.client.enw.log"
if (Test-Path -LiteralPath $cl) {
    Note 'client lines:'
    Select-String -LiteralPath $cl -Pattern 'screenshot_guard|Com_Error|Hunk_|lockdown:|clc.state|end screen|quit' |
        ForEach-Object { Note ("  " + $_.Line) }
}
