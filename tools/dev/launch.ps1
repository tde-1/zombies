<#
.SYNOPSIS
  Launch one CoDWaW.exe dev instance, windowed / small / muted, with its own logs.

.DESCRIPTION
  Honours docs\dev-box.md:
    * takes C:\Users\b\ZombiesDev\locks\game.lock (stale after 15 min or dead PID);
    * NEVER touches the Steam folder, only C:\Users\b\ZombiesDev\waw-<name>;
    * never launches CoDWaWmp.exe;
    * windowed 800x600, muted, no intro;
    * writes stdout/stderr + the engine console log under ZombiesDev\logs\<name>\.

  Returns the PID (as an int on the pipeline). Kill it with Stop-Process -Id <pid>,
  and delete the lock when you are done (or use -TestSeconds, which does both).

.PARAMETER Name
  Instance name. Picks the game copy (waw-<Name>), the log folder and the
  fs_homepath, unless overridden.

.PARAMETER Role
  server | solo | client. Passed to the DLL as ENW_ROLE (game-link v0).

.PARAMETER GameArgs
  Extra arguments appended verbatim, e.g. '+set fs_game mods/nazi_zombie_ali','+map nazi_zombie_sumpf'.

.PARAMETER HomePath
  'own'     - +set fs_homepath ZombiesDev\homes\<Name>   (per-instance user data)
  'default' - leave it alone (uses %LOCALAPPDATA%\Activision\CoDWaW, B's real profile)

.PARAMETER TestSeconds
  Smoke-test mode: wait this long, print what happened (alive? which image? child
  processes? log tail?), then kill the process we started and release the lock.

.EXAMPLE
  .\launch.ps1 foundation -Role solo -TestSeconds 25
.EXAMPLE
  $pid = .\launch.ps1 foundation -Role solo -GameArgs '+map nazi_zombie_prototype'
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$Name = 'foundation',

    [ValidateSet('server', 'solo', 'client')]
    [string]$Role = 'solo',

    [string[]]$GameArgs = @(),

    [ValidateSet('own', 'default')]
    [string]$HomePath = 'own',

    [string]$EnwHost = '127.0.0.1:28960',
    [string]$Instance = '',

    # Skip the game lock. Only for an experiment you know is concurrent-safe.
    [switch]$NoLock,

    # Steal a lock held by someone else even if it looks fresh. Avoid.
    [switch]$ForceLock,

    [int]$TestSeconds = 0,

    # Print the command line and exit without starting anything.
    [switch]$DryRun,

    [string]$GameDir = '',
    [string]$DevRoot = 'C:\Users\b\ZombiesDev',

    # What this launch is for; goes in the lock file so other agents know.
    [string]$Why = 'foundation test'
)

$ErrorActionPreference = 'Stop'

if (-not $GameDir) { $GameDir = Join-Path $DevRoot "waw-$Name" }
$exe = Join-Path $GameDir 'CoDWaW.exe'
$logDir = Join-Path $DevRoot "logs\$Name"
$homeDir = Join-Path $DevRoot "homes\$Name"
$lockDir = Join-Path $DevRoot 'locks'
$lockFile = Join-Path $lockDir 'game.lock'
if (-not $Instance) { $Instance = $Name }

if (-not (Test-Path -LiteralPath $exe)) {
    throw "No CoDWaW.exe at $exe. Make the copy first: tools\dev\new-copy.ps1 $Name"
}
if ($exe -like 'C:\Program Files (x86)\Steam\*') {
    throw 'Refusing to launch out of the Steam folder (dev-box.md rule 1).'
}
# The engine opens <fs_homepath>\main\console.log very early. If that folder does
# not exist yet we get NO console log at all (observed: the foundation run wrote
# nothing, dedi's identical run wrote 5.8 KB -- dedi had pre-created homes\dedi\main).
New-Item -ItemType Directory -Path $logDir, $homeDir, (Join-Path $homeDir 'main'), $lockDir -Force | Out-Null

# ---------------------------------------------------------- the kill switch --
# Set ENW_LAUNCH_OK=0 (or anything but 1) to stop every agent starting the game,
# without editing scripts. Default is ON.
$launchOk = if ($null -eq $env:ENW_LAUNCH_OK -or $env:ENW_LAUNCH_OK -eq '') { '1' } else { $env:ENW_LAUNCH_OK }
if ($launchOk -ne '1' -and -not $DryRun) {
    Write-Host ''
    Write-Host '  ##########################################################' -ForegroundColor Red
    Write-Host '  #  LAUNCH BLOCKED: ENW_LAUNCH_OK is not 1                #' -ForegroundColor Red
    Write-Host '  #  Game launches are disabled on this box right now.     #' -ForegroundColor Red
    Write-Host '  #  Re-enable with:  $env:ENW_LAUNCH_OK = 1               #' -ForegroundColor Red
    Write-Host '  #  Or re-run with -DryRun to see the command line only.  #' -ForegroundColor Red
    Write-Host '  ##########################################################' -ForegroundColor Red
    Write-Host ''
    throw 'ENW_LAUNCH_OK is not 1 - refusing to start CoDWaW.exe.'
}

# ---------------------------------------------------------------- game lock --
$lockTaken = $false
function Release-GameLock {
    if ($script:lockTaken -and (Test-Path -LiteralPath $lockFile)) {
        Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
        Write-Host 'Released game.lock' -ForegroundColor DarkGray
    }
}
if (-not $NoLock -and -not $DryRun) {
    if (Test-Path -LiteralPath $lockFile) {
        $raw = (Get-Content -LiteralPath $lockFile -Raw).Trim()
        $parts = $raw -split '\s+'
        $stale = $false
        $age = (Get-Date) - (Get-Item -LiteralPath $lockFile).LastWriteTime
        if ($age.TotalMinutes -gt 15) { $stale = $true }
        if ($parts.Count -ge 2 -and $parts[1] -match '^\d+$') {
            if (-not (Get-Process -Id ([int]$parts[1]) -ErrorAction SilentlyContinue)) { $stale = $true }
        }
        if ($stale -or $ForceLock) {
            Write-Host "Taking stale lock (was: $raw)" -ForegroundColor Yellow
        }
        else {
            throw "game.lock held: $raw  (age $([int]$age.TotalMinutes) min). Wait, or -ForceLock if you are sure."
        }
    }
    Set-Content -LiteralPath $lockFile -Value ("{0} starting {1} {2}" -f $Name, (Get-Date -Format o), $Why) -Encoding ascii
    $lockTaken = $true
}

try {
    # ------------------------------------------------- clear blocking dialogs --
    # THE SAFE-MODE MARKER (found by the dedi agent, board 00:37):
    #   %LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW  is a 4-byte file holding the PID
    #   of the running instance. Written at startup, deleted on a clean exit. If it
    #   survives a crash or a Stop-Process, the next launch shows a modal #32770
    #   "Run In Safe Mode?" box BEFORE any logging and blocks forever.
    # It doubles as a single-instance marker, so it is also why two instances are
    # doubtful. We only delete it when the PID inside it is dead - never yank it
    # out from under a live game another agent is running.
    $marker = "$env:LOCALAPPDATA\Activision\CoDWaW\__CoDWaW"
    if (Test-Path -LiteralPath $marker) {
        $stalePid = -1
        try {
            $bytes = [IO.File]::ReadAllBytes($marker)
            if ($bytes.Length -eq 4) { $stalePid = [BitConverter]::ToInt32($bytes, 0) }
        }
        catch {}
        $owner = if ($stalePid -gt 0) { Get-Process -Id $stalePid -ErrorAction SilentlyContinue } else { $null }
        if ($owner -and $owner.ProcessName -like 'CoDWaW*') {
            throw "__CoDWaW marker names LIVE pid $stalePid ($($owner.ProcessName)) - another instance is running. Not launching."
        }
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
        Write-Host "  cleared stale safe-mode marker (dead pid $stalePid)" -ForegroundColor DarkGray
    }
    # Belt and braces: safemode.cfg is what the engine execs instead of config.cfg.
    foreach ($root in @($homeDir, $GameDir, "$env:LOCALAPPDATA\Activision\CoDWaW")) {
        foreach ($rel in @('main\safemode.cfg', 'players\safemode.cfg', 'safemode.cfg')) {
            $p = Join-Path $root $rel
            if (Test-Path -LiteralPath $p) {
                Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
                Write-Host "  cleared $p" -ForegroundColor DarkGray
            }
        }
    }

    # --------------------------------------------------------------- arguments --
    $a = New-Object System.Collections.Generic.List[string]
    if ($HomePath -eq 'own') { $a.Add('+set'); $a.Add('fs_homepath'); $a.Add($homeDir) }

    # dev-box rule 6: windowed, small, muted. Plus: no intro, no first-run wizard,
    # no auto-updates/downloads, console log on.
    $defaults = @(
        '+set', 'r_fullscreen', '0',
        '+set', 'r_mode', '800x600',
        '+set', 'vid_xpos', '20',
        '+set', 'vid_ypos', '20',
        '+set', 'snd_volume', '0',
        '+set', 'snd_menu_master', '0',
        '+set', 'com_introPlayed', '1',
        '+set', 'com_startupIntroPlayed', '1',
        '+set', 'sys_configureGHz', '1',
        '+set', 'ui_autoContinue', '1',
        '+set', 'cl_allowDownload', '0',
        '+set', 'logfile', '2',
        '+set', 'developer', '1',
        '+set', 'con_minicon', '1'
    )
    $defaults | ForEach-Object { $a.Add($_) }
    $GameArgs | Where-Object { $_ -ne '' } | ForEach-Object { $a.Add($_) }

    # ------------------------------------------------------------ environment --
    # game-link v0 hands the DLL its host/instance/role through the environment.
    $env:ENW_HOST = $EnwHost
    $env:ENW_INSTANCE = $Instance
    $env:ENW_ROLE = $Role
    $env:ENW_LOGDIR = $logDir
    # SteamStub (board 00:35, dedi): without these the copy exits(0) after ~1.5 s
    # having written nothing - the stub asks Steam to relaunch app 10090 from the
    # *Steam* folder instead. steam_appid.txt in the copy (new-copy.ps1) as well.
    $env:SteamAppId = '10090'
    $env:SteamGameId = '10090'

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outLog = Join-Path $logDir "$stamp-stdout.log"
    $errLog = Join-Path $logDir "$stamp-stderr.log"

    Write-Host "Launching $exe" -ForegroundColor Cyan
    Write-Host "  role=$Role instance=$Instance host=$EnwHost homepath=$HomePath"
    Write-Host "  args: $($a -join ' ')" -ForegroundColor DarkGray

    if ($DryRun) {
        Write-Host '  (dry run - nothing started)' -ForegroundColor Yellow
        Write-Host ''
        Write-Host ('"{0}" {1}' -f $exe, ($a -join ' '))
        Write-Host ''
        Write-Host "  env ENW_HOST=$EnwHost ENW_INSTANCE=$Instance ENW_ROLE=$Role SteamAppId=10090"
        return
    }

    $before = @(Get-Process CoDWaW -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

    $proc = Start-Process -FilePath $exe -ArgumentList $a -WorkingDirectory $GameDir `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

    Start-Sleep -Milliseconds 1500
    $record = [ordered]@{
        name = $Name; role = $Role; instance = $Instance; pid = $proc.Id
        exe = $exe; args = ($a -join ' '); started = (Get-Date -Format o)
        homepath = $(if ($HomePath -eq 'own') { $homeDir } else { "$env:LOCALAPPDATA\Activision\CoDWaW" })
        stdout = $outLog; stderr = $errLog
        console_log = $(if ($HomePath -eq 'own') { Join-Path $homeDir 'main\console.log' } else { "$env:LOCALAPPDATA\Activision\CoDWaW\main\console.log" })
    }
    ($record | ConvertTo-Json) | Set-Content -LiteralPath (Join-Path $logDir "$stamp-launch.json") -Encoding utf8

    if ($lockTaken) {
        Set-Content -LiteralPath $lockFile -Value ("{0} {1} {2} {3}" -f $Name, $proc.Id, (Get-Date -Format o), $Why) -Encoding ascii
    }

    Write-Host "PID $($proc.Id)  logs: $logDir" -ForegroundColor Green

    if ($TestSeconds -le 0) {
        Write-Output $proc.Id
        return
    }

    # ------------------------------------------------------------ smoke test --
    $deadline = (Get-Date).AddSeconds($TestSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 700
        if ($proc.HasExited) { break }
    }
    $proc.Refresh()

    Write-Host ''
    Write-Host '================ smoke test =================' -ForegroundColor Cyan
    if ($proc.HasExited) {
        Write-Host "our PID $($proc.Id) EXITED after $([int]((Get-Date)-$proc.StartTime).TotalSeconds)s, code $($proc.ExitCode)" -ForegroundColor Yellow
    }
    else {
        Write-Host "our PID $($proc.Id) still ALIVE" -ForegroundColor Green
    }
    $now = Get-Process CoDWaW -ErrorAction SilentlyContinue
    foreach ($p in $now) {
        $tag = if ($before -contains $p.Id) { 'pre-existing' } elseif ($p.Id -eq $proc.Id) { 'OURS' } else { 'NEW (not ours!)' }
        Write-Host ("  CoDWaW pid {0,-6} {1,-16} {2}" -f $p.Id, $tag, $p.Path)
    }
    foreach ($f in @($outLog, $errLog, $record.console_log)) {
        if ((Test-Path -LiteralPath $f) -and (Get-Item -LiteralPath $f).Length -gt 0) {
            Write-Host "--- $f ---" -ForegroundColor DarkGray
            Get-Content -LiteralPath $f -Tail 25 | ForEach-Object { Write-Host "  $_" }
        }
    }
    Write-Host '=============================================' -ForegroundColor Cyan

    if (-not $proc.HasExited) {
        Write-Host "Killing our PID $($proc.Id)" -ForegroundColor DarkGray
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
    }
    Write-Output $proc.Id
}
finally {
    if ($TestSeconds -gt 0) { Release-GameLock }
}
