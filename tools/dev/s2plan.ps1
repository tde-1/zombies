<#
.SYNOPSIS
  Lane S2's box-sharing schedule (coordinator, 2026-09-23 ~22:40 UK): one bot soak, then a MAPS
  window (10 other games finished on the box, or the box idle of leases for 15 min), then the next.
  Line format as leasechain.ps1. Progress: ZombiesDev\logs\dedi\s2\plan.log
#>
param([Parameter(Mandatory = $true)][string]$List, [int]$AfterPid = 0, [int]$Window = 10)
$log = 'C:\Users\b\ZombiesDev\logs\dedi\s2\plan.log'
function Say($m) { Add-Content -LiteralPath $log -Value ("{0:o} {1}" -f (Get-Date), $m) }
function Box([string]$cmd) { & ssh -n -o BatchMode=yes -o ConnectTimeout=20 zombies-dev $cmd 2>&1 }
if ($AfterPid) { while (Get-Process -Id $AfterPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 } }
foreach ($line in Get-Content -LiteralPath $List) {
    $f = ($line.Trim() -split '\s+')
    if (-not $f[0] -or $f[0].StartsWith('#')) { continue }
    # ---- the MAPS window -------------------------------------------------------------------
    $since = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
    Say "window: waiting for $Window other games to finish (or 15 min with no lease) before $($f[0])"
    while ($true) {
        Start-Sleep -Seconds 60
        $done = [int]((Box "journalctl -u enw-host-agent --since '$since' --no-pager -o cat | grep -c 'SUMMARY'") | Select-Object -Last 1)
        $recent = [int]((Box "journalctl -u enw-host-agent --since '-15 min' --no-pager -o cat | grep -c 'assignment changed: leased'") | Select-Object -Last 1)
        $up = [datetime]::UtcNow - [datetime]::Parse($since)
        if ($done -ge $Window) { Say "window over: $done games finished"; break }
        if ($recent -eq 0 -and $up.TotalMinutes -ge 15) { Say "window over: no lease for 15 min ($done finished)"; break }
    }
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'leasesoak.ps1'),
           '-Tag', $f[0], '-Map', $f[1], '-Minutes', $f[2], '-Bots', $f[3])
    if ($f.Count -ge 5) { $a += @('-Player', $f[4]) }
    if ($f.Count -ge 6) { $a += @('-Members', $f[5]) }
    Say "start $line"
    & powershell @a | Out-Null
    Say "end   $($f[0])"
}
Say 'plan done'
