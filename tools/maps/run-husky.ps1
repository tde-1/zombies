<#
.SYNOPSIS
  Drive Husky's GUI to dump the running game's world geometry, without a human.

.DESCRIPTION
  Husky (https://github.com/Scobalula/Husky, GPL-3.0) is the only tool that exports
  a World at War world, and it does it by reading the RUNNING game's memory -- which
  is why tools\maps\export_map.py cannot. Its README says: "run the game, load the
  map you want to extract, and run Husky, then click the paper airplane to export
  the loaded map."

  That paper airplane is the whole problem: Husky is a WinForms GUI with no command
  line. This script clicks it the way tools\dev\launch.ps1 already answers the
  engine's startup dialogs -- enumerate the window's children, pick the control we
  want, PostMessage a click at it. PostMessage is asynchronous, so a wedged UI
  thread cannot hang us, and everything here is time-boxed.

  It does NOT take game.lock and it does NOT launch the game. The caller does both,
  because the caller is the one that has to release the lock.

.PARAMETER Inspect
  Dump the control tree and exit without clicking. Run this first on a new Husky
  version: the button has no text, so it is identified by class and order, and that
  is exactly the kind of thing a new release moves.

.PARAMETER TimeoutSeconds
  How long to wait for the export to finish. Nacht is small; a big map is not.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\maps\run-husky.ps1 -Inspect
  powershell -ExecutionPolicy Bypass -File tools\maps\run-husky.ps1 -OutDir C:\Users\b\ZombiesDev\maps\_work\husky
#>
[CmdletBinding()]
param(
    [string]$HuskyExe = 'C:\Users\b\ZombiesDev\tools\husky\Husky.exe',
    [string]$OutDir = 'C:\Users\b\ZombiesDev\maps\_work\husky',
    [switch]$Inspect,
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@

function Get-WindowsOf([int]$ProcId) {
    $found = New-Object System.Collections.ArrayList
    $cb = [W+EnumProc] {
        param($h, $l)
        $pid2 = 0
        [void][W]::GetWindowThreadProcessId($h, [ref]$pid2)
        if ($pid2 -eq $ProcId -and [W]::IsWindowVisible($h)) { [void]$found.Add($h) }
        return $true
    }
    [void][W]::EnumWindows($cb, [IntPtr]::Zero)
    return $found
}

function Get-Children([IntPtr]$Parent) {
    $kids = New-Object System.Collections.ArrayList
    $cb = [W+EnumProc] { param($h, $l); [void]$kids.Add($h); return $true }
    [void][W]::EnumChildWindows($Parent, $cb, [IntPtr]::Zero)
    return $kids
}

function Describe([IntPtr]$h) {
    $t = New-Object System.Text.StringBuilder 512
    [void][W]::GetWindowTextW($h, $t, 512)
    $c = New-Object System.Text.StringBuilder 512
    [void][W]::GetClassNameW($h, $c, 512)
    $r = New-Object W+RECT
    [void][W]::GetWindowRect($h, [ref]$r)
    [pscustomobject]@{
        Handle = $h; Class = $c.ToString(); Text = $t.ToString(); Id = [W]::GetDlgCtrlID($h)
        X = $r.L; Y = $r.T; W = ($r.R - $r.L); H = ($r.B - $r.T)
    }
}

# The game must already be up: Husky loops over processes and stops at the first
# supported one, so with nothing running it exits immediately and says nothing.
$game = @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue)
if ($game.Count -eq 0) { throw 'no CoDWaW process -- launch the game on the map you want first' }
Write-Host "[husky] game pid $($game[0].Id)"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
# Husky writes beside its own exe (exported_maps\...), so it runs with the working
# directory set to where we want the output.
$before = @(Get-ChildItem -Path $OutDir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)

$p = Start-Process -FilePath $HuskyExe -WorkingDirectory $OutDir -PassThru
Write-Host "[husky] husky pid $($p.Id)"

# Wait for its window.
$win = $null
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { throw "Husky exited immediately (code $($p.ExitCode)) -- it did not recognise the game" }
    $w = Get-WindowsOf $p.Id
    if ($w.Count -gt 0) { $win = $w[0]; break }
    Start-Sleep -Milliseconds 400
}
if (-not $win) { throw 'Husky never showed a window' }

$kids = Get-Children $win
$all = @(Describe $win) + @($kids | ForEach-Object { Describe $_ })
$all | Format-Table Class, Id, Text, X, Y, W, H -AutoSize | Out-String | Write-Host

if ($Inspect) {
    Write-Host '[husky] -Inspect: leaving it open, not clicking. Kill it yourself.'
    return
}

# The export control. Husky's title bar says which game it found; the paper
# airplane is a borderless button with no text, so it is picked by being the
# small square button rather than by a caption that does not exist.
$btns = @($all | Where-Object { $_.Class -like '*BUTTON*' -and $_.Handle -ne $win })
if ($btns.Count -eq 0) { throw 'no button found in the Husky window -- rerun with -Inspect' }
$target = $btns | Sort-Object { $_.W * $_.H } | Select-Object -First 1
Write-Host "[husky] clicking button id=$($target.Id) '$($target.Text)' $($target.W)x$($target.H) at $($target.X),$($target.Y)"

# BM_CLICK, then a WM_COMMAND to the parent as a fallback: a WinForms button
# answers the first, an owner-drawn one sometimes only answers the second.
[void][W]::PostMessageW($target.Handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300
[void][W]::PostMessageW($win, 0x0111, [IntPtr]$target.Id, $target.Handle)

# Wait for files to appear AND stop growing. A half-written 40 MB obj looks
# exactly like a finished one to a directory listing.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$lastSize = -1
$stable = 0
$new = @()
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $now = @(Get-ChildItem -Path $OutDir -Recurse -File -ErrorAction SilentlyContinue)
    $new = @($now | Where-Object { $before -notcontains $_.FullName })
    $size = ($new | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $size) { $size = 0 }
    if ($size -gt 0 -and $size -eq $lastSize) {
        $stable++
        if ($stable -ge 3) { break }
    } else { $stable = 0 }
    $lastSize = $size
    Write-Host ("[husky] {0} new file(s), {1:N1} MB" -f $new.Count, ($size / 1MB))
}

if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }

if ($new.Count -eq 0) { throw "Husky produced nothing in $OutDir" }
Write-Host '[husky] exported:'
$new | ForEach-Object { Write-Host ("  {0}  {1:N2} MB" -f $_.FullName, ($_.Length / 1MB)) }
