<#
.SYNOPSIS
  One command: build, deploy, record a real game, analyse it.

.DESCRIPTION
  Everything the replay capture needs, end to end, so a window on game.lock is
  spent recording rather than setting up.

    1. build   tools\dev\build.ps1  -Name referee
    2. deploy  tools\dev\deploy.ps1 referee           (refuses if a game is running)
    3. sink    infra\host-agent\linksink.py           (game-link v0 over TCP -> NDJSON)
    4. game    tools\dev\launch.ps1 in CLIENT mode, modal boxes answered, off-screen
    5. analyse infra\host-agent\analyse_capture.py

  CLIENT mode, not dedicated: a dedicated server with no client connected has no
  player entities and _zombiemode never starts (flag_wait "all_players_connected"),
  so there is nothing to sample.

  Takes game.lock for the duration and releases it, and only ever kills the PID it
  started (docs\dev-box.md rules 4 and 5).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File referee\run-capture.ps1
  powershell -ExecutionPolicy Bypass -File referee\run-capture.ps1 -Seconds 600 -Map nazi_zombie_factory
#>
[CmdletBinding()]
param(
    [int]$Seconds = 480,
    [string]$Map = 'nazi_zombie_prototype',
    [string]$FsGame = '',
    [string]$OutDir = 'C:\Users\b\ZombiesDev\captures',
    [switch]$SkipBuild,
    # Do not push test chat into the game. Injection via SV_GameSendServerCommand
    # is the current prime suspect for the ~68 s crash, so this isolates it.
    [switch]$NoSay
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$lock = 'C:\Users\b\ZombiesDev\locks\game.lock'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $OutDir "$Map-$stamp.ndjson"
$sinkLog = Join-Path $OutDir "$Map-$stamp.sink.log"

if (-not $SkipBuild) {
    Write-Host '== build ==' -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $repo 'tools\dev\build.ps1') -Name referee |
        Select-String -Pattern 'error C|OK ' | ForEach-Object { $_.Line }
    Write-Host '== deploy ==' -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $repo 'tools\dev\deploy.ps1') referee |
        Select-Object -Last 1
}

Write-Host '== sink ==' -ForegroundColor Cyan
$sink = Start-Process -FilePath 'python' -NoNewWindow -PassThru -RedirectStandardOutput $sinkLog `
    -ArgumentList (@((Join-Path $repo 'infra\host-agent\linksink.py'),
                    '--out', $out, '--seconds', ($Seconds + 60)) +
                   $(if ($NoSay) { @('--no-say') } else { @() }))
Start-Sleep -Seconds 2

# --- dialog answering: match on the owning process IMAGE, not the pid we launched.
# SteamStub relaunches the game through Steam, so the window belongs to a different
# pid. We hold game.lock, so any CoDWaW dialog on screen is ours.
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class WD {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
function Answer-Dialogs {
    $script:hit = @()
    [void][WD]::EnumWindows({
        param($h, $l)
        if (-not [WD]::IsWindowVisible($h)) { return $true }
        $c = New-Object Text.StringBuilder 64
        [void][WD]::GetClassName($h, $c, 64)
        if ($c.ToString() -ne '#32770') { return $true }
        $procId = 0; [void][WD]::GetWindowThreadProcessId($h, [ref]$procId)
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $p -or $p.ProcessName -notlike 'CoDWaW*') { return $true }
        $t = New-Object Text.StringBuilder 256
        [void][WD]::GetWindowText($h, $t, 256)
        $script:hit += $t.ToString()
        [void][WD]::PostMessage($h, 0x0111, [IntPtr]7, [IntPtr]::Zero)  # IDNO
        [void][WD]::PostMessage($h, 0x0111, [IntPtr]2, [IntPtr]::Zero)  # IDCANCEL
        return $true
    }, [IntPtr]::Zero)
    return $script:hit
}

# Only ever release a lock we actually took. An earlier version removed it
# unconditionally in `finally`, so a launch that failed for an unrelated reason
# (another agent's game already running) would delete SOMEONE ELSE'S lock.
$tookLock = $false
$gamePid = $null
try {
    Write-Host '== game ==' -ForegroundColor Cyan
    $args = @('+set logfile 2', '+set com_maxfps 60')
    if ($FsGame) { $args += "+set fs_game $FsGame" }
    $args += "+map $Map"
    $gamePid = & (Join-Path $repo 'tools\dev\launch.ps1') referee -Role solo -GameArgs $args `
        -Why "referee replay capture $Map"
    $gamePid = [int]($gamePid | Select-Object -Last 1)
    $tookLock = $true
    Write-Host "  pid $gamePid, recording $Seconds s -> $out"

    $seen = @{}
    $end = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $end) {
        if (-not (Get-Process -Id $gamePid -ErrorAction SilentlyContinue)) {
            Write-Warning 'game exited early'; break
        }
        foreach ($d in (Answer-Dialogs)) {
            if (-not $seen.ContainsKey($d)) { $seen[$d] = 1; Write-Host "  answered dialog: '$d'" }
        }
        Start-Sleep -Milliseconds 300
    }
}
finally {
    if ($gamePid -and (Get-Process -Id $gamePid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $gamePid -Force
        Write-Host "  killed our pid $gamePid"
    }
    Start-Sleep -Seconds 3
    if (-not $sink.HasExited) { Stop-Process -Id $sink.Id -Force -ErrorAction SilentlyContinue }
    if ($tookLock) {
        Remove-Item $lock -ErrorAction SilentlyContinue
        Write-Host '  released game.lock'
    } else {
        Write-Host '  did not take game.lock; leaving it alone'
    }
}

# A DIAGNOSTIC MUST NOT BE ABLE TO BREAK THE RUN IT IS DIAGNOSING.
# `foundation` lost a run to exactly this shape: their log assertion held the
# game's file open, threw, and skipped the kill -- leaving a game running and the
# lock held. Three rules here: every log read happens AFTER the `finally` above has
# killed the game and released the lock; the file is opened FileShare.ReadWrite so
# it can never block the writer; and any failure warns and moves on.
function Read-LogShared([string]$path) {
    try {
        $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
                              ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $sr = New-Object IO.StreamReader $fs
            try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
        } finally { $fs.Dispose() }
    } catch {
        Write-Warning "could not read $path : $($_.Exception.Message)"
        return ''
    }
}

Write-Host "`n== the lines that matter ==" -ForegroundColor Cyan
try {
    $log = Get-ChildItem 'C:\Users\b\ZombiesDev\logs\referee\enw-*.log' -ErrorAction Stop |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($log) {
        (Read-LogShared $log.FullName) -split "`n" |
            Where-Object { $_ -match 'currentOrigin|referee/bind:|levelvars|STOPPED TICKING|level notifies|chat captured|learned level' } |
            Select-Object -Last 28 | ForEach-Object { "  " + $_.TrimEnd() }
    }
} catch { Write-Warning "log summary skipped: $($_.Exception.Message)" }

Write-Host "`n== analysis ==" -ForegroundColor Cyan
if ((Test-Path $out) -and (Get-Item $out).Length -gt 0) {
    & python (Join-Path $repo 'infra\host-agent\analyse_capture.py') $out
} else {
    Write-Warning "no capture at $out - check $sinkLog"
}
