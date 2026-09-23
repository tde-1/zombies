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

.PARAMETER Visible
  Show the game window. OFF BY DEFAULT -- B uses this PC, so launches are parked
  at -4000,-4000 and never take focus. Pass this only when you must watch it.

.PARAMETER KeepDialogs
  Do not answer the modal startup boxes ("Set Optimal Settings?", "Run In Safe
  Mode?"). They block startup forever, so this is off by default.

.PARAMETER PrivateProfile
  Redirect this instance's AppData (profile, mods, the safe-mode marker) into
  ZombiesDev\homes\<name>\appdata. new-copy.ps1 seeds it from B's profile.

.PARAMETER Companion
  Run as the SECOND instance of an experiment that already holds game.lock (a
  server + client test). Requires a live lock; does not take or release one.

.PARAMETER Developer
  Pass `+set developer 1`. Off by default -- it makes missing assets fatal
  ("ERROR: image 'images/sun_flare.iwi' is missing") and stops startup.

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

    # Join an experiment that already holds the lock, instead of taking one.
    # This is the supported way to run a SECOND instance (the client half of a
    # server+client test): it requires a live lock to exist, so it cannot be used
    # to bypass the interlock, and it leaves the lock for the holder to release.
    [switch]$Companion,

    [int]$TestSeconds = 0,

    # Print the command line and exit without starting anything.
    [switch]$DryRun,

    # Show the game window on screen. OFF BY DEFAULT: B uses this PC and our
    # windows interrupt them, so every launch is parked off-screen and never
    # takes focus unless you ask for it.
    [switch]$Visible,

    # Leave the modal startup dialogs alone. OFF BY DEFAULT -- they block startup
    # indefinitely, which is why no solo run ever reached the game. Only useful
    # if you want to inspect one.
    [switch]$KeepDialogs,

    # +set developer 1. OFF BY DEFAULT: it promotes missing-asset warnings to
    # fatal error dialogs, and stock WaW is missing at least one image.
    [switch]$Developer,

    # Give this instance its own profile directory (shared/core/components/
    # instance_paths.cpp). Needs new-copy.ps1 to have seeded it. Safe now that
    # game.lock, not __CoDWaW, is the interlock.
    [switch]$PrivateProfile,

    # Invite token, passed to the game through the environment (never argv).
    [string]$AuthToken = '',

    # The lease this process serves. The host agent sets ENW_MATCH when it starts an
    # instance; the referee uses it to refuse an invite token minted for a DIFFERENT
    # match (referee.md 13). A dev run that mints its own token must pass the same id
    # here or the token is refused with `wrong_match` -- which is the check working.
    [string]$MatchId = '',

    # Comma-separated hostnames the game may resolve; a leading dot is a suffix
    # match. Activision/Demonware are blocked regardless.
    [string]$AllowedHosts = '.enw.gg',

    # Deny any DNS lookup not in -AllowedHosts, rather than only the known-bad.
    [switch]$StrictNet,

    [string]$GameDir = '',
    [string]$DevRoot = 'C:\Users\b\ZombiesDev',

    # The exe to start inside $GameDir. The launcher runs `ENWZombies.exe`, a byte copy
    # of CoDWaW.exe, so Discord's game detection (which matches `codwaw.exe` by file
    # name) does not show "Call of Duty: World at War" over ENW's own presence
    # (launcher.md, "Discord shows ENW Zombies"). Default: the stock name.
    [ValidatePattern('^[A-Za-z0-9_-]+\.exe$')]
    [string]$ExeName = 'CoDWaW.exe',

    # What this launch is for; goes in the lock file so other agents know.
    [string]$Why = 'foundation test'
)

$ErrorActionPreference = 'Stop'

if (-not $GameDir) { $GameDir = Join-Path $DevRoot "waw-$Name" }
if ($ExeName -ieq 'CoDWaWmp.exe') { throw 'Refusing to launch the multiplayer exe (dev-box.md rule 2).' }
$exe = Join-Path $GameDir $ExeName
# Every process name a game of ours can run under, for the "already running" checks.
$gameNames = @('CoDWaW', 'ENWZombies', [IO.Path]::GetFileNameWithoutExtension($ExeName)) | Select-Object -Unique
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

# ------------------------------------------------------- keeping off-screen --
# B works at this machine. A game window popping up and stealing focus in the
# middle of their day is not acceptable, so unless -Visible is passed we park
# every window the process owns far off-screen without ever activating it.
#
# `vid_xpos`/`vid_ypos` handle the main render window, but not the splash
# ("CoD Splash Screen"), the dedicated-server console ("Call of Duty WinConsole")
# or the modal #32770 boxes, so we sweep by PID as well.
# THE TRAP THIS ALREADY FELL INTO ONCE: a plain SetWindowPos is a *synchronous*
# cross-process call. It sends WM_WINDOWPOSCHANGING to the target's UI thread and
# blocks until that thread answers -- and a game that is loading, or sitting on a
# modal dialog, does not answer. The first version of this hung the launcher for
# 703 s with the game still up and the lock still held.
# So: SWP_ASYNCWINDOWPOS (posts, never waits) and ShowWindowAsync, and the
# enumeration is compiled C# rather than a PowerShell scriptblock invoked as a
# native callback once per top-level window.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class EnwWindows
{
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
    // GetWindowText does NOT send WM_GETTEXT across processes -- it reads the
    // cached caption -- so it is safe against a hung target. (Documented.)
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);

    const uint SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010;
    const uint SWP_ASYNCWINDOWPOS = 0x4000;
    const int SW_SHOWNOACTIVATE = 4;
    const uint WM_COMMAND = 0x0111;
    const int IDOK = 1, IDCANCEL = 2, IDNO = 7;

    static string TextOf(IntPtr h)
    {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    // Returns "movedClass,movedClass|dialogCount". Never blocks on the target.
    public static string Park(int pid, int x, int y)
    {
        var moved = new List<string>();
        int dialogs = 0;
        EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid != (uint)pid) return true;

            string cls = ClassOf(h);
            // A modal dialog is Dismiss()'s business, not ours: moving it is
            // pointless and hiding it would only make it harder to answer.
            if (cls == "#32770") { dialogs++; return true; }

            ShowWindowAsync(h, SW_SHOWNOACTIVATE);
            SetWindowPos(h, IntPtr.Zero, x, y, 0, 0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
            if (!moved.Contains(cls)) moved.Add(cls);
            return true;
        }, IntPtr.Zero);
        return string.Join(",", moved.ToArray()) + "|" + dialogs;
    }

    // Answer every #32770 the process owns, choosing the most conservative
    // button available: No, else Cancel, else OK.
    //
    // Both boxes we actually meet want "No": "Set Optimal Settings?" No keeps the
    // settings we passed on the command line, and "Run In Safe Mode?" No starts
    // normally. PostMessage is asynchronous, so a wedged UI thread cannot hang us
    // the way SetWindowPos once did.
    //
    // Returns one line per dialog: "title >> button [buttons seen]".
    public static string Dismiss(int pid)
    {
        var report = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid != (uint)pid) return true;
            if (ClassOf(h) != "#32770") return true;

            string title = TextOf(h);
            var seen = new List<string>();
            bool hasNo = false, hasCancel = false, hasOk = false;

            var body = new List<string>();
            EnumChildWindows(h, delegate(IntPtr c, IntPtr _)
            {
                string ccls = ClassOf(c);
                if (ccls == "Button")
                {
                    int id = GetDlgCtrlID(c);
                    seen.Add(id + ":" + TextOf(c).Replace("&", ""));
                    if (id == IDNO) hasNo = true;
                    if (id == IDCANCEL) hasCancel = true;
                    if (id == IDOK) hasOk = true;
                }
                else if (ccls == "Static")
                {
                    // The message itself. Worth having: the one we hit said
                    // "image 'images/sun_flare.iwi' is missing", which told us
                    // straight away that it was our own +set developer 1.
                    string t = TextOf(c).Replace("\r", " ").Replace("\n", " ").Trim();
                    if (t.Length > 0) body.Add(t);
                }
                return true;
            }, IntPtr.Zero);

            int pick = hasNo ? IDNO : (hasCancel ? IDCANCEL : (hasOk ? IDOK : IDNO));
            string pickName = pick == IDNO ? "No" : (pick == IDCANCEL ? "Cancel" : "OK");
            PostMessage(h, WM_COMMAND, (IntPtr)pick, IntPtr.Zero);

            report.Add("'" + title + "' >> " + pickName +
                       " [" + string.Join(" ", seen.ToArray()) + "]" +
                       (body.Count > 0 ? "  msg: " + string.Join(" / ", body.ToArray()) : ""));
            return true;
        }, IntPtr.Zero);
        return string.Join("\n", report.ToArray());
    }
}
'@ -ErrorAction SilentlyContinue

# Every call into user32 against another process is time-boxed. Two agents lost
# ten minutes to a launcher that blocked here, so if window handling ever takes
# longer than this we give up on it for the rest of the run rather than hold the
# game lock.
$script:windowBudgetMs = 2000
$script:windowHandlingDead = $false

function Invoke-WindowOp {
    param([scriptblock]$Op, [string]$What)
    if ($script:windowHandlingDead) { return $null }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = & $Op
    }
    catch {
        Write-Host "  (window op '$What' failed: $_)" -ForegroundColor Yellow
        return $null
    }
    finally { $sw.Stop() }
    if ($sw.ElapsedMilliseconds -gt $script:windowBudgetMs) {
        $script:windowHandlingDead = $true
        Write-Host ("  WINDOW HANDLING DISABLED: '{0}' took {1} ms (budget {2} ms). The game's UI " -f
            $What, $sw.ElapsedMilliseconds, $script:windowBudgetMs) -ForegroundColor Red
        Write-Host '  thread is not responding; continuing without parking or dismissing.' -ForegroundColor Red
    }
    return $r
}

function Hide-GameWindows {
    param([int]$OwnerPid, [switch]$Report)
    $result = Invoke-WindowOp -What 'park' -Op { [EnwWindows]::Park($OwnerPid, -4000, -4000) }
    if ($null -eq $result) { return 0 }
    $parts = $result -split '\|'
    $classes = if ($parts[0]) { $parts[0] } else { '' }
    $dialogs = [int]$parts[1]
    if ($Report) {
        if ($classes) {
            Write-Host "  parked off-screen: $classes" -ForegroundColor DarkGray
        }
        else {
            Write-Host '  (no windows to park yet)' -ForegroundColor DarkGray
        }
    }
    return $dialogs
}

# Answers "Set Optimal Settings?" and "Run In Safe Mode?" so startup can carry on.
# Until this existed, EVERY solo run sat on one of these and the game never
# reached a playable state.
function Dismiss-GameDialogs {
    param([int]$OwnerPid)
    $report = Invoke-WindowOp -What 'dismiss' -Op { [EnwWindows]::Dismiss($OwnerPid) }
    if ([string]::IsNullOrWhiteSpace($report)) { return 0 }
    $n = 0
    foreach ($line in ($report -split "`n")) {
        if ($line.Trim()) {
            Write-Host "  dialog answered: $line" -ForegroundColor Cyan
            $n++
        }
    }
    return $n
}

# ---------------------------------------------------------------- game lock --
$lockTaken = $false
function Beat-GameLock {
    param([int]$OwnerPid)
    if (-not $script:lockTaken) { return }
    $line = '{0} {1} {2} {3}' -f $Name, $OwnerPid, (Get-Date -Format o), $Why
    try {
        if (Test-Path -LiteralPath $lockFile) {
            # Only ever re-assert OUR OWN lock. If someone else now holds it we
            # leave it completely alone and say so once.
            $cur = (Get-Content -LiteralPath $lockFile -Raw).Trim()
            if ($cur -notmatch "^$([regex]::Escape($Name))\s") {
                if (-not $script:lockStolenWarned) {
                    Write-Host "  WARNING: game.lock now belongs to someone else ($cur); not touching it" -ForegroundColor Yellow
                    $script:lockStolenWarned = $true
                }
                return
            }
            Set-Content -LiteralPath $lockFile -Value $line -Encoding ascii
        }
        else {
            # Gone while we still hold it -- someone deleted it out from under us.
            Set-Content -LiteralPath $lockFile -Value $line -Encoding ascii
            Write-Host '  game.lock had vanished while we held it; restored' -ForegroundColor Yellow
        }
    }
    catch { }
}

$script:lockStolenWarned = $false
function Release-GameLock {
    if ($script:lockTaken -and (Test-Path -LiteralPath $lockFile)) {
        Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
        Write-Host 'Released game.lock' -ForegroundColor DarkGray
    }
}
if ($Companion -and -not $DryRun) {
    # A companion needs a REAL, live experiment to join -- otherwise it is just
    # -NoLock with a nicer name, and the interlock stops meaning anything.
    if (-not (Test-Path -LiteralPath $lockFile)) {
        throw '-Companion needs an experiment already holding game.lock. There is no lock. ' +
              'Start the first instance normally.'
    }
    $held = (Get-Content -LiteralPath $lockFile -Raw).Trim()
    $heldAge = (Get-Date) - (Get-Item -LiteralPath $lockFile).LastWriteTime
    if ($heldAge.TotalMinutes -gt 15) {
        throw "-Companion: the lock is stale ($held, $([int]$heldAge.TotalMinutes) min). " +
              'Clear it and start the experiment again.'
    }
    Write-Host "Joining the experiment holding game.lock: $held" -ForegroundColor Cyan
    Write-Host '  (not taking the lock; the holder releases it)' -ForegroundColor DarkGray
}
elseif (-not $NoLock -and -not $DryRun) {
    # THE INTERLOCK. Until now the real thing stopping two agents launching at
    # once was `__CoDWaW` -- the engine's own single-instance marker -- and
    # game.lock was advisory on top of it. Per-instance profiles
    # (ENW_PRIVATE_PROFILE=1) move that marker into the instance's own AppData,
    # so it stops being machine-wide and that guard silently disappears. This is
    # the replacement, and it does not depend on any engine behaviour:
    #
    #   1. a LIVE CoDWaW process anywhere on the box blocks a launch, found by
    #      enumerating processes rather than by reading a file the game owns;
    #   2. game.lock is acquired ATOMICALLY (CreateNew, which fails if the file
    #      exists) instead of test-then-write, which two launchers could both win.

    # (1) Is the game already running, whoever started it?
    $running = @(Get-Process -Name ($gameNames + 'CoDWaWmp') -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0 -and -not $ForceLock) {
        $who = ($running | ForEach-Object { "$($_.ProcessName):$($_.Id)" }) -join ', '
        throw "CoDWaW is already running ($who). One game at a time (dev-box.md rule 5). " +
              'Wait for it, or -ForceLock if you are certain it is abandoned.'
    }

    # (2) Take the lock atomically, retrying once if we clear a stale one.
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        try {
            $fs = [IO.File]::Open($lockFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
                                  [IO.FileShare]::Read)
            $bytes = [Text.Encoding]::ASCII.GetBytes(
                ('{0} starting {1} {2}' -f $Name, (Get-Date -Format o), $Why))
            $fs.Write($bytes, 0, $bytes.Length)
            $fs.Close()
            $lockTaken = $true
            break
        }
        catch [IO.IOException] {
            # Someone holds it. Decide whether it is stale, then retry ONCE.
            $raw = ''
            try { $raw = (Get-Content -LiteralPath $lockFile -Raw -ErrorAction Stop).Trim() } catch {}
            $parts = $raw -split '\s+'
            $stale = $false
            $age = [TimeSpan]::Zero
            try { $age = (Get-Date) - (Get-Item -LiteralPath $lockFile).LastWriteTime } catch {}
            # A LIVE PID IS NEVER STALE, however old the lock is. dev-box rule 5's
            # 15 minutes was written for short experiments; a referee replay run
            # is hours, and ageing out a lock whose owner is plainly still alive
            # is how two instances end up fighting.
            $ownerAlive = $false
            if ($parts.Count -ge 2 -and $parts[1] -match '^\d+$') {
                $ownerAlive = [bool](Get-Process -Id ([int]$parts[1]) -ErrorAction SilentlyContinue)
                if (-not $ownerAlive) { $stale = $true }
            }
            elseif ($age.TotalMinutes -gt 15) { $stale = $true }
            elseif ($parts.Count -ge 2 -and $parts[1] -eq 'starting' -and $age.TotalMinutes -gt 2) {
                # A launcher that died between taking the lock and writing its PID.
                $stale = $true
            }
            if (($stale -or $ForceLock) -and $attempt -eq 0) {
                Write-Host "Taking stale lock (was: $raw)" -ForegroundColor Yellow
                Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
                continue
            }
            throw "game.lock held: $raw  (age $([int]$age.TotalMinutes) min). Wait, or -ForceLock if you are sure."
        }
    }
    if (-not $lockTaken) { throw 'could not acquire game.lock' }
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
    # With ENW_PRIVATE_PROFILE=1 the engine's AppData is redirected, so the
    # marker moves with it. Clear whichever one this launch will actually use --
    # and the machine-wide one too, since a previous non-private run may have
    # left it behind.
    # A dry run inspects, it never mutates and never refuses: you must be able to
    # ask "what would this launch do?" while someone else has the game.
    $markers = if ($DryRun) { @() } else { @("$env:LOCALAPPDATA\Activision\CoDWaW\__CoDWaW") }
    if ($PrivateProfile) {
        $markers += (Join-Path $homeDir 'appdata\Activision\CoDWaW\__CoDWaW')
    }
    foreach ($marker in $markers) {
        if (-not (Test-Path -LiteralPath $marker)) { continue }
        $stalePid = -1
        try {
            $bytes = [IO.File]::ReadAllBytes($marker)
            if ($bytes.Length -eq 4) { $stalePid = [BitConverter]::ToInt32($bytes, 0) }
        }
        catch {}
        # The interlock is game.lock plus the live-process check above; this is
        # now only about the safe-mode prompt. Still refuse if it names a live
        # game -- belt and braces costs nothing.
        $owner = if ($stalePid -gt 0) { Get-Process -Id $stalePid -ErrorAction SilentlyContinue } else { $null }
        if ($owner -and ($owner.ProcessName -like 'CoDWaW*' -or $gameNames -contains $owner.ProcessName)) {
            if ($Companion) {
                # The first instance of this experiment legitimately owns the
                # marker. Leave it alone -- it is theirs to clean up -- and do not
                # treat it as a collision.
                Write-Host "  (marker belongs to the experiment's first instance, pid $stalePid)" -ForegroundColor DarkGray
                continue
            }
            throw "__CoDWaW marker names LIVE pid $stalePid ($($owner.ProcessName)). Not launching."
        }
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
        Write-Host "  cleared stale safe-mode marker (dead pid $stalePid)" -ForegroundColor DarkGray
    }
    # Belt and braces: safemode.cfg is what the engine execs instead of config.cfg.
    foreach ($root in $(if ($DryRun) { @() } else { @($homeDir, $GameDir, "$env:LOCALAPPDATA\Activision\CoDWaW") })) {
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
        # Off-screen unless -Visible. The engine's own dvars do most of the work;
        # Hide-GameWindows below catches anything that ignores them.
        '+set', 'vid_xpos', $(if ($Visible) { '20' } else { '-4000' }),
        '+set', 'vid_ypos', $(if ($Visible) { '20' } else { '-4000' }),
        '+set', 'snd_volume', '0',
        '+set', 'snd_menu_master', '0',
        '+set', 'com_introPlayed', '1',
        '+set', 'com_startupIntroPlayed', '1',
        '+set', 'sys_configureGHz', '1',
        '+set', 'ui_autoContinue', '1',
        '+set', 'cl_allowDownload', '0',
        '+set', 'logfile', '2',
        # developer 1 turns a missing-asset WARNING into a fatal error dialog.
        # It cost a run: "ERROR: image 'images/sun_flare.iwi' is missing" stopped
        # the game dead just after the D3D device came up. Opt in with -Developer.
        '+set', 'developer', $(if ($Developer) { '1' } else { '0' }),
        '+set', 'con_minicon', '1'
    )
    $defaults | ForEach-Object { $a.Add($_) }
    # The invite token arrives via a one-line config the DLL writes into this
    # instance's own homepath before the engine starts, and deletes straight after.
    # Only the FILENAME is ever in argv.
    if ($AuthToken) { $a.Add('+exec'); $a.Add('enw_auth.cfg') }

    # Be forgiving about how GameArgs arrived. `powershell -File launch.ps1
    # -GameArgs '+map','x'` does NOT evaluate PowerShell syntax, so the whole
    # thing lands as one literal token "+map,x" and the engine then reports
    # `Unknown command "map,nazi_zombie_prototype"`. Cost me a run. Split on
    # commas and whitespace so every calling style works.
    $GameArgs | Where-Object { $_ -ne '' } | ForEach-Object {
        foreach ($piece in ($_ -split '[,\s]+')) {
            if ($piece -ne '') { $a.Add($piece) }
        }
    }

    # ------------------------------------------------------------ environment --
    # game-link v0 hands the DLL its host/instance/role through the environment.
    $env:ENW_HOST = $EnwHost
    $env:ENW_INSTANCE = $Instance
    $env:ENW_ROLE = $Role
    $env:ENW_LOGDIR = $logDir
    # Per-instance profile (shared/core/components/instance_paths.cpp). The DLL
    # only acts on this when ENW_PRIVATE_PROFILE=1; new-copy.ps1 seeds the tree.
    $env:ENW_INSTANCE_APPDATA = Join-Path $homeDir 'appdata'
    # The LocalAppData redirect (client-dll/components/enw_localappdata.cpp), which
    # keeps profiles, saves, the mods list and the engine's own map-exists check out
    # of the BOX OWNER'S %LOCALAPPDATA%\Activision\CoDWaW. OPT-IN here and not in the
    # launcher, for one measured reason: the dev copies are running DLLs built before
    # that component existed, and pointing the mount somewhere the running DLL does
    # not redirect to makes every custom map fail with Can't find map. Set
    # ENW_USE_PRIVATE_LOCALAPPDATA=1 once the copy you are launching carries a DLL
    # from 2026-09-23 or later; mapmount.ps1 reads the same switch.
    # 2026-09-23, archive/dedi: this block was committed with every variable
    # reference stripped out of it (`if ( -eq '1') { = Join-Path 'localappdata' }`),
    # which is a PowerShell PARSE error -- launch.ps1 would not run at all, so no
    # harness that dot-sources or calls it could run either. Restored from the
    # comment above and from mapmount.ps1's matching switch.
    # 2026-09-23 01:35 (coordinator): DEFAULT IS NOW PRIVATE. A harness run at 01:25 wrote
    # snd_menu_master "0" into B's own profile (%LOCALAPPDATA%\Activision\CoDWaW\players    # profiles\<his>\config.cfg) because this was opt-in and the boot-direct lane did not set
    # it. Every dev copy now carries a DLL from 2026-09-22 or later, so the redirect works
    # everywhere; ENW_USE_PRIVATE_LOCALAPPDATA=0 is the opt-OUT, for a deliberately stock run.
    if ($env:ENW_USE_PRIVATE_LOCALAPPDATA -eq '0') {
        $env:ENW_LOCALAPPDATA = $env:LOCALAPPDATA
    } else { $env:ENW_LOCALAPPDATA = Join-Path $homeDir 'localappdata' }
    if ($PrivateProfile) { $env:ENW_PRIVATE_PROFILE = '1' } else { $env:ENW_PRIVATE_PROFILE = '0' }
    # ENW-only networking (client-dll/components/network.cpp). Activision and
    # Demonware are always blocked; strict mode denies everything else too.
    $env:ENW_ALLOWED_HOSTS = $AllowedHosts
    if ($StrictNet) { $env:ENW_NET_STRICT = '1' } else { $env:ENW_NET_STRICT = '0' }
    # The invite token goes in the ENVIRONMENT, never argv: a command line is
    # readable by any process on the box and ends up in logs and crash dumps.
    # The DLL reads it once and clears it (client-dll/components/auth_token.cpp).
    if ($AuthToken) { $env:ENW_AUTH_TOKEN = $AuthToken } else { $env:ENW_AUTH_TOKEN = $null }
    # The lease. Read once at post_load by the referee (server side only).
    if ($MatchId) { $env:ENW_MATCH = $MatchId } else { $env:ENW_MATCH = $null }
    # The DLL writes <fs_homepath>\main\enw_auth.cfg before the engine starts and
    # deletes it straight after; argv carries only the FILENAME, never the token.
    $env:ENW_FS_HOMEPATH = $homeDir
    # SteamStub (board 00:35, dedi): without these the copy exits(0) after ~1.5 s
    # having written nothing - the stub asks Steam to relaunch app 10090 from the
    # *Steam* folder instead. steam_appid.txt in the copy (new-copy.ps1) as well.
    $env:SteamAppId = '10090'
    $env:SteamGameId = '10090'

    # WHERE THE ENGINE PUTS console.log: under <fs_homepath>\<fs_game>\, NOT main\,
    # whenever fs_game is set. The launcher agent found this the hard way -- 12,813
    # lines in the mod folder while we reported main\console.log as 0 bytes.
    # Also: the engine TRUNCATES it on every launch, so anything that tails it must
    # reset to offset 0 when the file shrinks.
    $fsGame = ''
    for ($i = 0; $i -lt $a.Count - 1; $i++) {
        if ($a[$i] -eq 'fs_game') { $fsGame = $a[$i + 1]; break }
    }
    $logRoot = if ($HomePath -eq 'own') { $homeDir } else { "$env:LOCALAPPDATA\Activision\CoDWaW" }
    $consoleLog = if ($fsGame) {
        Join-Path $logRoot ($fsGame.Replace('/', '\') + '\console.log')
    } else {
        Join-Path $logRoot 'main\console.log'
    }
    if ($fsGame) { Write-Host "  fs_game=$fsGame -> console log at $consoleLog" -ForegroundColor DarkGray }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outLog = Join-Path $logDir "$stamp-stdout.log"
    $errLog = Join-Path $logDir "$stamp-stderr.log"

    Write-Host "Launching $exe" -ForegroundColor Cyan
    Write-Host "  role=$Role instance=$Instance host=$EnwHost homepath=$HomePath window=$(if ($Visible) { 'VISIBLE' } else { 'off-screen, no focus' })"
    Write-Host "  args: $($a -join ' ')" -ForegroundColor DarkGray

    if ($DryRun) {
        Write-Host '  (dry run - nothing started)' -ForegroundColor Yellow
        Write-Host ''
        Write-Host ('"{0}" {1}' -f $exe, ($a -join ' '))
        Write-Host ''
        Write-Host "  env ENW_HOST=$EnwHost ENW_INSTANCE=$Instance ENW_ROLE=$Role SteamAppId=10090"
        return
    }

    $before = @(Get-Process -Name $gameNames -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

    $proc = Start-Process -FilePath $exe -ArgumentList $a -WorkingDirectory $GameDir `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

    # Sweep repeatedly for the first few seconds: the splash, the render window
    # and the console each appear at different moments, and we want each one gone
    # the instant it exists rather than after it has flashed at B.
    $script:dialogsAnswered = 0
    $sweepUntil = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $sweepUntil -and -not $proc.HasExited) {
        if (-not $Visible) { [void](Hide-GameWindows -OwnerPid $proc.Id) }
        if (-not $KeepDialogs) {
            $script:dialogsAnswered += (Dismiss-GameDialogs -OwnerPid $proc.Id)
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $Visible) { [void](Hide-GameWindows -OwnerPid $proc.Id -Report) }
    if ($KeepDialogs) {
        Write-Host '  -KeepDialogs: modal boxes left unanswered; startup will block on them' -ForegroundColor Yellow
    }
    elseif ($script:dialogsAnswered -eq 0) {
        Write-Host '  no modal dialogs appeared' -ForegroundColor DarkGray
    }

    $record = [ordered]@{
        name = $Name; role = $Role; instance = $Instance; pid = $proc.Id; visible = [bool]$Visible; dialogs_answered = $script:dialogsAnswered
        exe = $exe; args = ($a -join ' '); started = (Get-Date -Format o)
        homepath = $(if ($HomePath -eq 'own') { $homeDir } else { "$env:LOCALAPPDATA\Activision\CoDWaW" })
        stdout = $outLog; stderr = $errLog
        console_log = $consoleLog
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
    $script:nextBeat = (Get-Date).AddSeconds(60)
    $deadline = (Get-Date).AddSeconds($TestSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 700
        if ($proc.HasExited) { break }
        # Keep sweeping: the render window can be created (or recreated by a
        # vid_restart) long after startup.
        if (-not $Visible) { [void](Hide-GameWindows -OwnerPid $proc.Id) }
        # A dialog can appear later too (vid_restart, a mid-run error box).
        if (-not $KeepDialogs) { [void](Dismiss-GameDialogs -OwnerPid $proc.Id) }
        # Keep our lock's timestamp fresh, and restore it if something deleted it.
        if ((Get-Date) -ge $script:nextBeat) {
            Beat-GameLock -OwnerPid $proc.Id
            $script:nextBeat = (Get-Date).AddSeconds(60)
        }
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
    $now = Get-Process -Name $gameNames -ErrorAction SilentlyContinue
    foreach ($p in $now) {
        $tag = if ($before -contains $p.Id) { 'pre-existing' } elseif ($p.Id -eq $proc.Id) { 'OURS' } else { 'NEW (not ours!)' }
        Write-Host ("  CoDWaW pid {0,-6} {1,-16} {2}" -f $p.Id, $tag, $p.Path)
    }
    foreach ($f in @($outLog, $errLog, $consoleLog)) {
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

    # ------------------------------------------------ did it keep ticking? --
    # A capture that silently stops after a minute is the worst kind of failure:
    # the referee lost two 420 s runs to it and only noticed because both came
    # out at exactly 65.2 s. The DLL logs "heartbeat: still ticking at Ns"; if
    # the last one is far short of the run, say so loudly.
    # THIS RUNS AFTER THE KILL, deliberately. Two earlier versions ran it while
    # the game still held the log open: the first used Select-String (deny-write)
    # and threw under ErrorActionPreference=Stop, which skipped the kill and left
    # the game running with the lock held; the second read share-all and still
    # came back empty, reporting "NO HEARTBEAT" for a run that had seven of them.
    # Reading a file the game has closed is simply the right answer. The whole
    # check is still wrapped, because a diagnostic must never break the run it is
    # diagnosing.
    if ($TestSeconds -ge 30) {
      try {
        $dllLog = Get-ChildItem -LiteralPath $logDir -Filter "enw-$($proc.Id).log" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($dllLog) {
            $text = ''
            try {
                $fs = [IO.File]::Open($dllLog.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read,
                                      [IO.FileShare]::ReadWrite)
                $sr = New-Object IO.StreamReader($fs)
                $text = $sr.ReadToEnd()
                $sr.Close(); $fs.Close()
            }
            catch { Write-Host "  (could not read the DLL log: $_)" -ForegroundColor DarkGray }
            $beats = [regex]::Matches($text, 'still ticking at ([\d.]+) s')
            if ($beats.Count -eq 0) {
                Write-Host '  NO HEARTBEAT AT ALL. The game never reached a frame tick, or the DLL did not load.' -ForegroundColor Red
            }
            else {
                $lastTick = [double]($beats[$beats.Count - 1].Groups[1].Value)
                # Allow for startup before the first frame plus one interval.
                if ($lastTick -lt ($TestSeconds - 25)) {
                    Write-Host "  *** THE GAME STOPPED TICKING ***" -ForegroundColor Red
                    Write-Host ("  last heartbeat at {0:N0} s of a {1} s run. Anything measured after that point is missing." -f $lastTick, $TestSeconds) -ForegroundColor Red
                    Write-Host '  Check focus_guard armed (ENW_FOCUS_GUARD), and see docs/kickstart/foundation.md.' -ForegroundColor Red
                }
                else {
                    Write-Host ("  still ticking at {0:N0} s (of {1} s) - good" -f $lastTick, $TestSeconds) -ForegroundColor Green
                }
            }
        }
      }
      catch { Write-Host "  (heartbeat check failed: $_)" -ForegroundColor DarkGray }
    }

    Write-Output $proc.Id
}
finally {
    if ($TestSeconds -gt 0) { Release-GameLock }
}
