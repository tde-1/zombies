<#
.SYNOPSIS
  Answer World at War's blocking startup dialogs while it boots, and (in dev) keep its
  windows off-screen. Emits NDJSON on stdout so the launcher can show the player what
  happened.

.DESCRIPTION
  Everything here is knowledge the foundation / dedi / referee agents paid for; see
  docs/kickstart/foundation.md §7 and the board. Three facts drive the whole script:

    * "Set Optimal Settings?" and "Run In Safe Mode?" are Win32 #32770 modals that
      appear BEFORE the game reaches a playable state. Unanswered, the game hangs there
      forever. Both want "No": No keeps the settings we passed on the command line, and
      No starts normally instead of in safe mode.

    * SteamStub can relaunch the game through Steam, so the window can belong to a
      DIFFERENT pid than the one we started (referee, board 01:20). Filtering by our own
      pid alone misses the dialog. We therefore also adopt CoDWaW* processes that
      started after our launch began -- and never touch one that started before it, so
      we can never interfere with another agent's game (dev-box.md rule 4).

    * A plain SetWindowPos on another process BLOCKS until that process's UI thread
      answers, and a game sitting on a modal never answers: it once hung a launcher for
      703 s (foundation, board 01:00). So every cross-process call here is the async
      form, and the whole thing is time-boxed.

.PARAMETER WatchPids
  Process ids we started ourselves.

.PARAMETER SinceUnixMs
  Adopt CoDWaW* processes started at or after this time. Use the moment just before the
  spawn. Without it, only -WatchPids are touched.

.PARAMETER Seconds
  How long to watch. The launcher stops us earlier once the game is in a map.

.PARAMETER Park
  Move the game's windows off-screen and never focus them. DEV ONLY -- a player wants
  to see their game.

.PARAMETER KeepDialogs
  Report the dialogs but do not answer them (for inspecting one).
#>
[CmdletBinding()]
param(
    [int[]]$WatchPids = @(),
    [double]$SinceUnixMs = 0,
    [int]$Seconds = 180,
    [switch]$Park,
    [switch]$KeepDialogs,
    [int]$PollMs = 250
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Emit($obj) {
    $obj['ts'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Write-Output (ConvertTo-Json $obj -Compress)
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class EnwNanny
{
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
    // GetWindowText reads the cached caption across processes -- it does NOT send
    // WM_GETTEXT -- so it is safe against a wedged target. (Documented behaviour.)
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

    const uint SWP_NOSIZE = 0x0001, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_ASYNCWINDOWPOS = 0x4000;
    const int SW_SHOWNOACTIVATE = 4;
    const uint WM_COMMAND = 0x0111;
    const int IDOK = 1, IDCANCEL = 2, IDNO = 7;

    static string TextOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
    static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }

    // Park every non-modal window the pid owns. Modals are Dismiss()'s business.
    public static string Park(int pid, int x, int y)
    {
        var moved = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            uint wpid; GetWindowThreadProcessId(h, out wpid);
            if (wpid != (uint)pid) return true;
            string cls = ClassOf(h);
            if (cls == "#32770") return true;
            ShowWindowAsync(h, SW_SHOWNOACTIVATE);
            SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
            if (!moved.Contains(cls)) moved.Add(cls);
            return true;
        }, IntPtr.Zero);
        return string.Join(",", moved.ToArray());
    }

    // One line per modal: "<title>\t<buttons>\t<picked>". Picks the most conservative
    // button present: No, else Cancel, else OK. PostMessage never blocks.
    public static string Dismiss(int pid, bool answer)
    {
        var report = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            uint wpid; GetWindowThreadProcessId(h, out wpid);
            if (wpid != (uint)pid) return true;
            if (ClassOf(h) != "#32770") return true;
            if (!IsWindowVisible(h)) return true;

            string title = TextOf(h);
            var seen = new List<string>();
            bool hasNo = false, hasCancel = false, hasOk = false;
            EnumChildWindows(h, delegate(IntPtr c, IntPtr _)
            {
                if (ClassOf(c) != "Button") return true;
                int id = GetDlgCtrlID(c);
                seen.Add(id + ":" + TextOf(c).Replace("&", ""));
                if (id == IDNO) hasNo = true;
                if (id == IDCANCEL) hasCancel = true;
                if (id == IDOK) hasOk = true;
                return true;
            }, IntPtr.Zero);

            int pick = hasNo ? IDNO : (hasCancel ? IDCANCEL : (hasOk ? IDOK : IDNO));
            string pickName = pick == IDNO ? "No" : (pick == IDCANCEL ? "Cancel" : "OK");
            if (answer) PostMessage(h, WM_COMMAND, (IntPtr)pick, IntPtr.Zero);
            report.Add(title + "\t" + string.Join(" ", seen.ToArray()) + "\t" + (answer ? pickName : "(left alone)"));
            return true;
        }, IntPtr.Zero);
        return string.Join("\n", report.ToArray());
    }
}
'@ -ErrorAction SilentlyContinue

$since = if ($SinceUnixMs -gt 0) { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$SinceUnixMs).LocalDateTime } else { $null }
$adopted = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($p in $WatchPids) { [void]$adopted.Add($p) }
$reported = New-Object 'System.Collections.Generic.HashSet[string]'
$deadline = (Get-Date).AddSeconds($Seconds)
$budgetBlown = $false

Emit @{ t = 'nanny_up'; watch = $WatchPids; since = $SinceUnixMs; park = [bool]$Park; seconds = $Seconds }

while ((Get-Date) -lt $deadline) {
    # Adopt any CoDWaW* that started after our launch began. Never one that predates it:
    # that would be another agent's (or B's) game.
    if ($since) {
        foreach ($p in @(Get-Process -Name 'CoDWaW*' -ErrorAction SilentlyContinue)) {
            if ($adopted.Contains($p.Id)) { continue }
            $st = $null
            try { $st = $p.StartTime } catch { continue }
            if ($st -ge $since.AddSeconds(-2)) {
                [void]$adopted.Add($p.Id)
                Emit @{ t = 'adopt'; pid = $p.Id; name = $p.ProcessName; started = $st.ToString('o') }
            }
        }
    }

    $live = @()
    foreach ($id in @($adopted)) {
        if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $live += $id }
    }
    if ($live.Count -eq 0 -and $adopted.Count -gt 0) { Emit @{ t = 'all_gone' }; break }

    foreach ($id in $live) {
        if ($budgetBlown) { break }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try {
            if ($Park) {
                $moved = [EnwNanny]::Park($id, -4000, -4000)
                if ($moved) {
                    $key = "park:$id:$moved"
                    if ($reported.Add($key)) { Emit @{ t = 'parked'; pid = $id; classes = $moved } }
                }
            }
            $r = [EnwNanny]::Dismiss($id, (-not $KeepDialogs))
            if ($r) {
                foreach ($line in ($r -split "`n")) {
                    if (-not $line.Trim()) { continue }
                    $f = $line -split "`t"
                    $key = "dlg:$id:$($f[0])"
                    if ($reported.Add($key)) {
                        Emit @{ t = 'dialog'; pid = $id; title = $f[0]; buttons = $f[1]; answered = $f[2] }
                    }
                }
            }
        }
        catch {
            Emit @{ t = 'error'; pid = $id; message = $_.Exception.Message }
        }
        finally { $sw.Stop() }
        # Time-box: if a cross-process call ever takes this long, stop doing them rather
        # than hang the launcher (and, on B's box, the game lock).
        if ($sw.ElapsedMilliseconds -gt 2000) {
            $budgetBlown = $true
            Emit @{ t = 'budget_blown'; pid = $id; ms = $sw.ElapsedMilliseconds }
        }
    }

    Start-Sleep -Milliseconds $PollMs
}

Emit @{ t = 'nanny_done'; adopted = @($adopted) }
