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
    [string]$Map = 'nazi_zombie_prototype',
    # Reports per direction: +1 x Block, then -1 x Block (the cursor ends where it began).
    [int]$Block = 1000,
    # Start an arm only after this much desktop idle; give up on the arm after -IdleWaitMinutes.
    [int]$IdleSeconds = 60,
    [int]$IdleWaitMinutes = 20,
    # The first 11:4x bench's injector: normal priority + Sleep(0). Default is a high-priority spin.
    [switch]$Sleep0
)
$ErrorActionPreference = 'Stop'
# `powershell -File` hands "-Arms a,b,c" over as ONE string.
$Arms = @($Arms | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
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

# The game opens its log without read sharing for Select-String; read it the way
# a tail does.
function Read-Shared([string]$Path) {
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite,Delete')
            try { return (New-Object IO.StreamReader($fs)).ReadToEnd() -split "`r?`n" } finally { $fs.Close() }
        } catch { Start-Sleep -Seconds 2 }
    }
    throw "cannot read $Path"
}

# If anything below throws, never leave an orphaned game or a lock behind
# (coordinator, 2026-09-23 04:49: an unlocked CoDWaW.exe blocks every other agent).
# launch.ps1 writes and beats game.lock itself for the whole of -TestSeconds.
function Stop-BenchGame([datetime]$Since) {
    Get-Process CoDWaW -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like "*\waw-$Copy\*" -and $_.StartTime -ge $Since } |
        ForEach-Object { Write-Host "cleanup: stopping bench game pid $($_.Id)"; Stop-Process -Id $_.Id -Force }
    $h = $null; try { $h = Get-Content -LiteralPath $lock -Raw -ErrorAction Stop } catch {}
    if ($h -and $h -match "^$Copy\s" -and $h -match 'mousebench') { Remove-Item -LiteralPath $lock -Force }
}
$benchStart = Get-Date

# B may be at his PC. An arm starts only after the desktop has been idle for
# -IdleSeconds (GetLastInputInfo), never while a CoDWaW.exe that is not ours is
# running, and rawprobe inject aborts itself (exit 3) on the first report from a
# real device -- so the synthetic mouse never fights a person for the cursor.
Add-Type -Namespace EnwBench -Name Idle -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
public static double Seconds() { var l = new LII(); l.cbSize = 8; GetLastInputInfo(ref l);
  return unchecked((uint)System.Environment.TickCount - l.dwTime) / 1000.0; }
'@
function Test-ForeignGame {
    [bool](Get-Process CoDWaW, CoDWaWmp -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -notlike "$dev\*" })   # B's own game: anything outside ZombiesDev
}

$results = @()
try {
foreach ($arm in $Arms) {
    # Queue on the lock like everyone else.
    $deadline = (Get-Date).AddMinutes(30)
    while ((Test-Path -LiteralPath $lock) -and (Get-Date) -lt $deadline) {
        $held = $null; try { $held = Get-Content -LiteralPath $lock -Raw -ErrorAction Stop } catch {}
        if (-not $held) { break }
        Write-Host "waiting for game.lock: $($held.Trim())"; Start-Sleep -Seconds 10
    }
    if (Test-ForeignGame) { Write-Host "B's own game is running: bench ends"; break }
    $idleDeadline = (Get-Date).AddMinutes($IdleWaitMinutes)
    while ([EnwBench.Idle]::Seconds() -lt $IdleSeconds -and (Get-Date) -lt $idleDeadline) {
        Start-Sleep -Seconds 5
    }
    if ([EnwBench.Idle]::Seconds() -lt $IdleSeconds) {
        Write-Host "arm ${arm}: the desktop was never idle for $IdleSeconds s: skipped"
        $results += "=== arm $arm  SKIPPED (desktop in use)"; continue
    }
    # The idle wait can be long: another agent may have taken the lock meanwhile.
    $deadline2 = (Get-Date).AddMinutes(30)
    while ((Test-Path -LiteralPath $lock) -or (Get-Process CoDWaW -ErrorAction SilentlyContinue)) {
        if ((Get-Date) -gt $deadline2) { throw 'game.lock never came free' }
        Write-Host 'lock taken during the idle wait; waiting'; Start-Sleep -Seconds 10
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
    # The DLL's logger opens its file with no read sharing (fopen_s), so the log
    # cannot be read while the game runs. Play-to-in-map is ~3 s (client.md §10c);
    # give it 30 s from the log appearing, then read everything after exit.
    Start-Sleep -Seconds 30
    Write-Host "arm $arm log $($log.Name) injecting at $([int]((Get-Date) - $t0).TotalSeconds) s"
    Start-Sleep -Seconds 11   # one idle frametime window first
    $inj = ''
    $aborted = $false
    if ($arm -ne 'idle') {
        $pace = if ($Sleep0) { 'sleep0' } else { 'spin' }
        $inj = (& $probe.FullName inject $InjectSeconds $Hz $Block $pace) -join ' '
        $aborted = ($LASTEXITCODE -ne 0)
    }
    else { Start-Sleep -Seconds $InjectSeconds }
    Write-Host "  $inj"
    if ($aborted -or (Test-ForeignGame)) {
        # Someone is using the PC: end the game now (launch.ps1's job would hold it
        # for the rest of -TestSeconds) and stop the bench.
        Get-Job | Stop-Job -ErrorAction SilentlyContinue
        Stop-BenchGame $benchStart
        Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
        $results += "=== arm $arm  ABORTED ($inj)"
        Write-Host "arm ${arm}: aborted, bench ends"
        break
    }
    Receive-Job $job -Wait | Out-Null
    Remove-Job $job -Force
    $lines = (Read-Shared $log.FullName) -match 'frametime: window|mouse_jitter: window|GetRawInputBuffer blocks|NOLEGACY is|measured device rate|HARNESS'
    $results += "=== arm $arm  ($($log.FullName))  $inj"
    $results += $lines
}
}
catch {
    Write-Host "bench FAILED: $_" -ForegroundColor Red
    Get-Job | Stop-Job -ErrorAction SilentlyContinue; Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
    Stop-BenchGame $benchStart
    throw
}
foreach ($k in $knobs + 'ENW_TEST_NO_ACTIVATE', 'ENW_BORDERLESS', 'ENW_BORDERLESS_COVER', 'ENW_RAW_MOUSE_INPUTSINK', 'ENW_FRAMETIME') {
    Remove-Item "Env:$k" -ErrorAction SilentlyContinue
}
$out = "$dev\logs\$Copy\mousebench-$(Get-Date -Format yyyyMMdd-HHmmss).txt"
$results | Set-Content -LiteralPath $out -Encoding utf8
Write-Host "results: $out"
$results
