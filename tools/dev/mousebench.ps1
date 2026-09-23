<#
.SYNOPSIS
  The synthetic-mouse stutter bench (client.md §1f). One off-screen game per arm,
  a 1000 Hz SendInput mouse, and the DLL's own frametime + mouse_jitter lines.

.DESCRIPTION
  Why this works where §1e's attempt did not: the game registers raw input with
  RIDEV_INPUTSINK when ENW_RAW_MOUSE_INPUTSINK=1 (a harness-only knob), so a
  window that is off-screen and never activated still receives WM_INPUT. SendInput
  MOUSEEVENTF_MOVE at 1000 Hz reaches such a window -- proven first by rawprobe.exe
  (2992 of 2993 injected moves arrived, each identified by its dwExtraInfo marker).

  Every game is invisible: launch.ps1's default -4000,-4000 park, ENW_TEST_NO_ACTIVATE=1,
  ENW_BORDERLESS=0, ENW_BORDERLESS_COVER=0, private LocalAppData (launch.ps1 default),
  com_maxfps passed, never developer 1. The game lock is taken by launch.ps1 itself
  (atomic CreateNew) and released at the end of -TestSeconds.

  WHAT THIS CANNOT MEASURE, by construction: anything DWM does with a visible window
  (composition, the cursor, 250 fps vs a 240 Hz panel), and the legacy WM_MOUSEMOVE
  path -- legacy mouse messages go to the window under the cursor, which is never
  an off-screen game. Those arms are B's, on his screen.

  The injected moves move the real cursor (+1 then -1 in 1000-report blocks, so it
  ends where it started). Only run this when nobody is using the mouse.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\dev\mousebench.ps1 -Arms bug,fix,nobuf
#>
[CmdletBinding()]
param(
    [string[]]$Arms = @('bug', 'fix', 'nobuf'),
    [string]$Copy = 'c2',
    [int]$InjectSeconds = 30,
    [int]$Hz = 1000,
    [string]$Map = 'nazi_zombie_prototype'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dev = 'C:\Users\b\ZombiesDev'
$lock = "$dev\locks\game.lock"
$probe = Get-ChildItem -Path "$repo\build" -Recurse -Filter rawprobe.exe | Select-Object -First 1
if (-not $probe) { throw 'rawprobe.exe not built (tools\dev\build.ps1)' }

$armEnv = @{
    bug   = @{ ENW_RAW_MOUSE_WOW64FIX = '0' }   # 0.2.3-0.2.20: buffered reports read at +16
    fix   = @{}                                  # the default now
    nobuf = @{ ENW_RAW_MOUSE_BUFFER = '0' }      # no bulk read at all
    idle  = @{}                                  # same as fix, but no injection
}
$knobs = 'ENW_RAW_MOUSE_WOW64FIX', 'ENW_RAW_MOUSE_BUFFER', 'ENW_RAW_MOUSE_NOLEGACY', 'ENW_RAW_MOUSE'

$results = @()
foreach ($arm in $Arms) {
    # Queue on the lock like everyone else.
    $deadline = (Get-Date).AddMinutes(30)
    while ((Test-Path -LiteralPath $lock) -and (Get-Date) -lt $deadline) {
        $held = $null; try { $held = Get-Content -LiteralPath $lock -Raw -ErrorAction Stop } catch {}
        if (-not $held) { break }
        Write-Host "waiting for game.lock: $($held.Trim())"; Start-Sleep -Seconds 10
    }
    foreach ($k in $knobs) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
    foreach ($kv in $armEnv[$arm].GetEnumerator()) { Set-Item "Env:$($kv.Key)" $kv.Value }
    $env:ENW_TEST_NO_ACTIVATE = '1'; $env:ENW_BORDERLESS = '0'; $env:ENW_BORDERLESS_COVER = '0'
    $env:ENW_RAW_MOUSE_INPUTSINK = '1'; $env:ENW_FRAMETIME = '1'

    $total = $InjectSeconds + 75
    $job = Start-Job -ScriptBlock {
        param($repo, $copy, $total, $map, $arm)
        & "$repo\tools\dev\launch.ps1" $copy -Role solo -TestSeconds $total -Why "mousebench $arm (client lane, 1000 Hz synthetic mouse)" `
            -GameArgs @('+set', 'com_maxfps', '250', '+set', 'r_vsync', '0', '+map', $map) 2>&1
    } -ArgumentList $repo, $Copy, $total, $Map, $arm

    # Find the game's log: the newest enw-*.log in logs\<copy> after we started.
    $t0 = Get-Date; $log = $null
    while (-not $log -and ((Get-Date) - $t0).TotalSeconds -lt 60) {
        Start-Sleep -Seconds 1
        $log = Get-ChildItem "$dev\logs\$Copy\enw-*.log" -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $t0 } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if (-not $log) { Receive-Job $job -Wait | Select-Object -Last 20; throw "no log for arm $arm" }
    # Wait until the engine owns the mouse (the NOLEGACY flip), i.e. we are in the map.
    $owned = $false
    while (-not $owned -and ((Get-Date) - $t0).TotalSeconds -lt 70) {
        Start-Sleep -Seconds 1
        $owned = [bool](Select-String -LiteralPath $log.FullName -Pattern 'legacy mouse messages OFF' -Quiet)
    }
    Write-Host "arm $arm log $($log.Name) game-owns-mouse=$owned at $([int]((Get-Date) - $t0).TotalSeconds) s"
    Start-Sleep -Seconds 11   # one idle frametime window first
    $inj = ''
    if ($arm -ne 'idle') { $inj = (& $probe.FullName inject $InjectSeconds $Hz 1000) -join ' ' }
    else { Start-Sleep -Seconds $InjectSeconds }
    Write-Host "  $inj"
    Receive-Job $job -Wait | Out-Null
    Remove-Job $job -Force
    $lines = Select-String -LiteralPath $log.FullName -Pattern 'frametime: window|mouse_jitter: window|GetRawInputBuffer blocks|NOLEGACY is|measured device rate' |
        ForEach-Object { $_.Line }
    $results += "=== arm $arm  ($($log.FullName))  $inj"
    $results += $lines
}
foreach ($k in $knobs + 'ENW_TEST_NO_ACTIVATE', 'ENW_BORDERLESS', 'ENW_BORDERLESS_COVER', 'ENW_RAW_MOUSE_INPUTSINK', 'ENW_FRAMETIME') {
    Remove-Item "Env:$k" -ErrorAction SilentlyContinue
}
$out = "$dev\logs\$Copy\mousebench-$(Get-Date -Format yyyyMMdd-HHmmss).txt"
$results | Set-Content -LiteralPath $out -Encoding utf8
Write-Host "results: $out"
$results
