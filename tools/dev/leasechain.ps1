<#
.SYNOPSIS
  Run tools\dev\leasesoak.ps1 for each line of a list, one after another (lane S2).
  Line: <tag> <map> <minutes> <bots> [player] [members,comma,separated]   ('#' comments)
  -AfterPid: wait for that process to exit first. Progress: ZombiesDev\logs\dedi\s2\chain.log
#>
param([Parameter(Mandatory = $true)][string]$List, [int]$AfterPid = 0)
$log = 'C:\Users\b\ZombiesDev\logs\dedi\s2\chain.log'
if ($AfterPid) { while (Get-Process -Id $AfterPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 } }
foreach ($line in Get-Content -LiteralPath $List) {
    $f = ($line.Trim() -split '\s+')
    if (-not $f[0] -or $f[0].StartsWith('#')) { continue }
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'leasesoak.ps1'),
           '-Tag', $f[0], '-Map', $f[1], '-Minutes', $f[2], '-Bots', $f[3])
    if ($f.Count -ge 5) { $a += @('-Player', $f[4]) }
    if ($f.Count -ge 6) { $a += @('-Members', $f[5]) }
    Add-Content -LiteralPath $log -Value ("{0:o} start {1}" -f (Get-Date), $line)
    & powershell @a | Out-Null
    Add-Content -LiteralPath $log -Value ("{0:o} end   {1}" -f (Get-Date), $f[0])
}
