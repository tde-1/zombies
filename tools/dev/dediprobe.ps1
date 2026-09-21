<#
.SYNOPSIS
  Launch a headless dedicated zombies server and sample it, with optional call probes.

.DESCRIPTION
  A thin, repeatable wrapper over tools\dev\launch.ps1 that sets the environment a
  headless dedicated boot needs (docs/kickstart/dedi.md §0) and then samples the
  process once a second: CPU seconds, RSS, thread count, and UDP endpoints.

  It does NOT take the lock itself -- launch.ps1 does that, and kills only its own PID.

  Diagnostic switches (all off unless asked for):
    -Probe <hex,hex,...>   ENW_DEDI_PROBE: count entries into up to 12 functions
    -WhereIs               ENW_DEDI_WHEREIS: periodic validated stack walk of the main thread

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\dev\dediprobe.ps1 -Tag r01 -Seconds 90 `
      -Probe '59E330,59DCF0,59B630,5FEC60' -WhereIs
#>
[CmdletBinding()]
param(
    [string]$Tag = 'r00',
    [int]$Seconds = 90,
    [string]$Name = 'd2',
    [string]$Map = 'nazi_zombie_prototype',
    [int]$Port = 28960,
    [string]$Probe = '',
    [switch]$WhereIs,
    [string[]]$ExtraArgs = @(),
    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# --- the environment a headless boot needs -----------------------------------
# Without the map-summary suppression the server dies on a spurious empty
# ERR_MAPLOADERRORSUMMARY inside Com_Init (docs/re/t4-sp-map.md).
$env:ENW_DEDI_SUPPRESS_MAPSUMMARY = '1'
if ($Probe)  { $env:ENW_DEDI_PROBE = $Probe }   else { $env:ENW_DEDI_PROBE = $null }
if ($WhereIs) { $env:ENW_DEDI_WHEREIS = '1' }   else { $env:ENW_DEDI_WHEREIS = $null }

$gameArgs = @(
    '+set', 'dedicated', '1',
    '+set', 'zombiemode', '1',
    '+set', 'logfile', '2',
    '+set', 's_volume', '0',
    '+set', 'snd_volume', '0',
    # These three exist only so the DLL can flag them DVAR_SAVED; the engine has
    # to create them first (docs/kickstart/dedi.md §4 site 2).
    '+set', 'con_typewriterColorBase', '1.0 1.0 1.0',
    '+set', 'hud_drawhud', '1',
    '+set', 'ui_campaign', 'american',
    '+set', 'sv_maxclients', '4',
    '+set', 'net_port', "$Port"
) + $ExtraArgs + @('+map', $Map)

$logDir = Join-Path $DevRoot "logs\dedi"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$sampleFile = Join-Path $logDir "$Tag-samples.txt"

Write-Host "dediprobe $Tag : $Seconds s, map $Map, port $Port" -ForegroundColor Cyan
if ($Probe) { Write-Host "  ENW_DEDI_PROBE=$Probe" -ForegroundColor DarkGray }

# launch.ps1 returns the PID when -TestSeconds is 0, and takes the lock for us.
$serverPid = & (Join-Path $PSScriptRoot 'launch.ps1') $Name -Role server -HomePath own `
    -GameArgs $gameArgs -Why "dedi $Tag headless server" | Select-Object -Last 1

if (-not $serverPid) { throw 'launch.ps1 did not return a PID' }
Write-Host "server PID $serverPid" -ForegroundColor Green

# --- sample ------------------------------------------------------------------
$rows = @()
$t0 = Get-Date
try {
    while (((Get-Date) - $t0).TotalSeconds -lt $Seconds) {
        Start-Sleep -Seconds 1
        $p = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
        if (-not $p) { Write-Host "  process gone at $([int]((Get-Date)-$t0).TotalSeconds)s" -ForegroundColor Yellow; break }
        $t = [int]((Get-Date) - $t0).TotalSeconds
        $row = [pscustomobject]@{
            t       = $t
            cpu_s   = [math]::Round($p.CPU, 2)
            rss_mb  = [math]::Round($p.WorkingSet64 / 1MB, 1)
            threads = $p.Threads.Count
            handles = $p.HandleCount
        }
        $rows += $row
        if ($t % 10 -eq 0) {
            Write-Host ("  t={0,4}s cpu={1,7}s rss={2,6} MB threads={3}" -f $row.t, $row.cpu_s, $row.rss_mb, $row.threads)
        }
    }
}
finally {
    $rows | Format-Table -AutoSize | Out-String -Width 200 | Set-Content -LiteralPath $sampleFile -Encoding utf8
    Write-Host "samples -> $sampleFile" -ForegroundColor DarkGray

    $p = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
    if ($p) {
        Write-Host "killing our PID $serverPid" -ForegroundColor DarkGray
        Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
    }
    # Release the lock only if it is ours.
    $lockFile = Join-Path $DevRoot 'locks\game.lock'
    if (Test-Path -LiteralPath $lockFile) {
        $lock = Get-Content -LiteralPath $lockFile -Raw
        if ($lock -match "\b$serverPid\b") {
            Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
            Write-Host 'released game.lock' -ForegroundColor DarkGray
        }
        else {
            Write-Host "  game.lock is not ours ($($lock.Trim())) - left alone" -ForegroundColor Yellow
        }
    }
}

# --- collect -----------------------------------------------------------------
# launch.ps1 points the DLL's log at ZombiesDev\logs\<name>\, not the game copy.
$dllLog = Join-Path $DevRoot "logs\$Name\enw-$serverPid.log"
if (-not (Test-Path -LiteralPath $dllLog)) {
    $dllLog = Join-Path $DevRoot "waw-$Name\enw-$serverPid.log"
}
$consoleLog = Join-Path $DevRoot "homes\$Name\main\console.log"
foreach ($pair in @(@($dllLog, "$Tag.enw.log"), @($consoleLog, "$Tag.console.log"))) {
    if (Test-Path -LiteralPath $pair[0]) {
        Copy-Item -LiteralPath $pair[0] -Destination (Join-Path $logDir $pair[1]) -Force
        Write-Host "  collected $($pair[1])" -ForegroundColor DarkGray
    }
    else { Write-Host "  MISSING $($pair[0])" -ForegroundColor Yellow }
}
Write-Output $serverPid
