<#
.SYNOPSIS
  Stop Windows Defender Firewall asking about the game, once and for all.

.DESCRIPTION
  Windows raises "Allow an app to communicate on these networks" the first time a
  program binds a listening socket and no firewall rule matches it. That prompt is
  per EXECUTABLE PATH, which is why it keeps coming back here: every dev copy under
  ZombiesDev is a different CoDWaW.exe, so every new copy is a fresh prompt. There
  were nine of them at the time of writing, plus the installed client, plus node.

  What was actually on this machine when this script was written (read, not assumed):

    * allow rules already existed for waw-c1, waw-custom, waw-d2, waw-dedi,
      waw-foundation, waw-host, waw-host2, waw-referee, the Steam install, the
      installed client and node.exe -- B had clicked through all of them;
    * every one of those was scoped to the **Public** profile only;
    * the active network is Public, and there were NO block rules.

  So nothing is being blocked today. The prompt is not a symptom of a broken
  network -- it is Windows asking about a path it has not seen before, and it will
  ask again for the next dev copy, and the one after that.

  This script makes the answer permanent:

    1. an allow rule for every CoDWaW.exe under ZombiesDev, the installed client
       and the launcher, on ALL THREE profiles rather than just the one that
       happened to be active when the box was first clicked;
    2. a port allow for the UDP range our servers use, so a dev copy created
       tomorrow is covered before it ever binds and never raises a prompt.

  Inbound only. Outbound is allowed by default on Windows and this script does not
  touch it. Nothing here opens a port to the internet by itself -- an inbound allow
  rule lets traffic that reaches this machine through to the game, and what reaches
  it is still up to the router.

  EVERY RULE IT CREATES IS NAMED "ENW Zombies - ...", it only ever touches rules
  with that prefix, and -Remove deletes exactly those and nothing else.

.PARAMETER Remove
  Delete every rule this script created and stop.

.EXAMPLE
  # Run once, elevated. One UAC prompt, no more firewall prompts.
  powershell -ExecutionPolicy Bypass -File infra\firewall.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\firewall.ps1 -Remove
#>
[CmdletBinding()]
param(
    [switch]$Remove,
    [string]$DevRoot = 'C:\Users\b\ZombiesDev',
    # The dedicated servers and the join harness live here. 3074 is the port T4
    # itself insists on and collides over (dedi.md 9.2).
    [string]$UdpPorts = '3074,28960-28999'
)

$ErrorActionPreference = 'Stop'
$Prefix = 'ENW Zombies - '

function Assert-Admin {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host ''
        Write-Host 'This needs to run as Administrator -- firewall rules are a system setting.' -ForegroundColor Yellow
        Write-Host 'Right-click PowerShell -> Run as administrator, then run it again. Or:' -ForegroundColor Yellow
        Write-Host ''
        Write-Host "  powershell -Command `"Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-File','$PSCommandPath'`"" -ForegroundColor Cyan
        Write-Host ''
        exit 1
    }
}

Assert-Admin

# ------------------------------------------------------------------- remove --
if ($Remove) {
    $ours = Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like "$Prefix*" }
    if (-not $ours) { Write-Host 'Nothing to remove.' -ForegroundColor DarkGray; exit 0 }
    foreach ($r in $ours) {
        Remove-NetFirewallRule -Name $r.Name
        Write-Host "removed  $($r.DisplayName)" -ForegroundColor DarkGray
    }
    Write-Host "Removed $($ours.Count) rule(s)." -ForegroundColor Green
    Write-Host 'Windows will start asking again the next time one of these binds a socket.' -ForegroundColor DarkGray
    exit 0
}

# ------------------------------------------------------------ what to cover --
# Read the disk rather than hardcode a list: the whole problem is that this set
# grows. NOTE: the Steam install is deliberately NOT in here. We never launch it
# and we never touch it.
$programs = [System.Collections.Generic.List[object]]::new()

Get-ChildItem -LiteralPath $DevRoot -Directory -Filter 'waw-*' -ErrorAction SilentlyContinue |
    ForEach-Object {
        $exe = Join-Path $_.FullName 'CoDWaW.exe'
        if (Test-Path -LiteralPath $exe) { $programs.Add(@{ Name = "game $($_.Name)"; Path = $exe }) }
    }

# The installed client, and the copy inside the Claude desktop app's MSIX
# container -- an agent's writes under %LOCALAPPDATA% are redirected there, so
# that path is real and does bind sockets. See STATUS.md.
foreach ($p in @(
        @{ Name = 'installed client'; Path = "$env:LOCALAPPDATA\ENWZombies\game\CoDWaW.exe" },
        @{ Name = 'installed client (sandboxed)'
           Path = "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\ENWZombies\game\CoDWaW.exe" },
        @{ Name = 'launcher'; Path = "$env:LOCALAPPDATA\Programs\enw-zombies-launcher\ENW Zombies Launcher.exe" },
        @{ Name = 'node'; Path = 'C:\Program Files\nodejs\node.exe' })) {
    if (Test-Path -LiteralPath $p.Path) { $programs.Add($p) }
    else { Write-Host "skip     $($p.Name): not installed ($($p.Path))" -ForegroundColor DarkGray }
}

# ------------------------------------------------------------------ create --
$made = 0
foreach ($p in $programs) {
    $display = "$Prefix$($p.Name)"
    $existing = Get-NetFirewallRule -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -eq $display }
    if ($existing) {
        # Idempotent: keep the rule, make sure it still points where we think and
        # covers all three profiles. A rule that silently drifted is worse than none.
        $existing | Set-NetFirewallRule -Profile Any -Action Allow -Enabled True
        $existing | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $p.Path
        Write-Host "updated  $display" -ForegroundColor DarkGray
        continue
    }
    New-NetFirewallRule -DisplayName $display -Direction Inbound -Action Allow `
        -Program $p.Path -Profile Any -Enabled True `
        -Description 'Created by infra\firewall.ps1 so Windows stops prompting. Remove with -Remove.' | Out-Null
    Write-Host "allowed  $display" -ForegroundColor Green
    Write-Host "         $($p.Path)" -ForegroundColor DarkGray
    $made++
}

# A dev copy made tomorrow is a path this script has never seen. A port rule
# covers it before it exists, so the prompt never appears in the first place.
$portRule = "${Prefix}server ports (UDP $UdpPorts)"
$existingPort = Get-NetFirewallRule -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -eq $portRule }
if ($existingPort) {
    Write-Host "updated  $portRule" -ForegroundColor DarkGray
} else {
    New-NetFirewallRule -DisplayName $portRule -Direction Inbound -Action Allow `
        -Protocol UDP -LocalPort $UdpPorts.Split(',') -Profile Any -Enabled True `
        -Description 'Created by infra\firewall.ps1: covers dev copies that do not exist yet.' | Out-Null
    Write-Host "allowed  $portRule" -ForegroundColor Green
    $made++
}

Write-Host ''
Write-Host "Done. $made new rule(s); $($programs.Count) program(s) covered on Domain, Private and Public." -ForegroundColor Green
Write-Host 'Undo any time with:  powershell -ExecutionPolicy Bypass -File infra\firewall.ps1 -Remove' -ForegroundColor DarkGray
