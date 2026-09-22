<#
.SYNOPSIS
  Launch a CLIENT on B's PC that joins the dedicated server running on the Hetzner box.

.DESCRIPTION
  `tools\dev\jointest.ps1` runs BOTH halves on this PC and has no remote-client path. This
  is its client half with the address pointed at `zombies-dev`, so a real player can join
  a server that is not on this machine.

  Start the server first, on the box:

      ssh -o BatchMode=yes zombies-dev 'GAME=/home/waw/waw-en DLL=/tmp/enw_t4_vps.dll \
        NAME=vps1 MAP=nazi_zombie_prototype PORT=28960 SECONDS_TO_RUN=60 bash -s' \
        < infra/vps/05-run-dedi.sh

  NOT `+connect`. That is not a client command in this exe (docs/re/t4-sp-map.md §5); it is
  the SERVER-side out-of-band name and the engine answers `Unknown command`. The client half
  is `client-dll/components/connect_local.cpp`, which calls `CL_ConnectLocal` from the frame
  tick when ENW_CLIENT_CONNECT is set. `CL_ConnectLocal` hard-codes the string "localhost"
  and `NET_StringToAdr` turns that exact string into NA_LOOPBACK — the in-process ring
  buffer, with no ip and no port — so a second MACHINE is unreachable that way.
  `shared/core/components/connect_address.cpp` rewrites the push operand from
  ENW_CONNECT_ADDR, and that is the only route to the box.

  HONOURS THE GAME LOCK. launch.ps1 takes it, and refuses while any CoDWaW is alive — the
  `dedi` lane runs join tests on this PC and waiting is the whole point. This script waits
  for the lock rather than pushing past it, and kills only the PID it started.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\vps\join-remote.ps1 -WatchSeconds 300
#>
param(
    [string]$Addr = '2.28.235.236:28960',
    [string]$Map = 'nazi_zombie_prototype',
    [string]$ClientName = 'c1',
    [string]$From = 'vps',          # build\<this>; NOT build\dedi, which is another lane's
    [int]$WatchSeconds = 300,
    [int]$WaitLockMinutes = 20,
    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$lock = Join-Path $DevRoot 'locks\game.lock'

# ---------------------------------------------------------------- wait, do not barge --
$deadline = (Get-Date).AddMinutes($WaitLockMinutes)
while ((Get-Date) -lt $deadline) {
    $busy = @(Get-Process -Name 'CoDWaW', 'CoDWaWmp' -ErrorAction SilentlyContinue)
    if (-not (Test-Path -LiteralPath $lock) -and $busy.Count -eq 0) { break }
    $who = if (Test-Path -LiteralPath $lock) { (Get-Content -LiteralPath $lock -Raw).Trim() } else { "$($busy.Count) live CoDWaW process(es)" }
    Write-Host "waiting for the game lock: $who" -ForegroundColor Yellow
    Start-Sleep -Seconds 10
}
if ((Test-Path -LiteralPath $lock) -or (Get-Process -Name 'CoDWaW', 'CoDWaWmp' -ErrorAction SilentlyContinue)) {
    throw "game.lock is still held after $WaitLockMinutes min - not launching (kickstart rule 3)."
}

# ------------------------------------------------------------------------- the client --
& (Join-Path $repo 'tools\dev\deploy.ps1') $ClientName -From $From | Out-Null
Write-Host "deployed build\$From -> waw-$ClientName" -ForegroundColor Green

$env:ENW_CLIENT_CONNECT = $Map
$env:ENW_CONNECT_ADDR = $Addr
# Sys_SendPacket routes through Demonware's bdSocketRouter, which drops every packet with
# addrHandle=0 (dedi.md §7f wall 2). Both halves need the raw sendto path.
$env:ENW_RAW_SOCKETS = '1'
$env:ENW_DEDI_SUPPRESS_MAPSUMMARY = $null

# Call launch.ps1 IN-PROCESS. `powershell -File launch.ps1 -GameArgs 'a','b'` does not
# evaluate PowerShell syntax, so the array arrives as loose positional arguments and it
# dies with "A positional parameter cannot be found that accepts argument 'logfile'".
$clientArgs = @('+set', 'logfile', '2', '+set', 'zombiemode', '1',
    '+set', 's_volume', '0', '+set', 'snd_volume', '0')
$clientPid = & (Join-Path $repo 'tools\dev\launch.ps1') $ClientName -Role client -HomePath own `
    -GameArgs $clientArgs -EnwHost $Addr -Why "vps: remote join to $Addr" | Select-Object -Last 1
if (-not $clientPid) { throw 'launch.ps1 did not return a client PID' }
Write-Host "client PID $clientPid -> $Addr ($Map)" -ForegroundColor Green

try {
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt $WatchSeconds) {
        Start-Sleep -Seconds 10
        $p = Get-Process -Id $clientPid -ErrorAction SilentlyContinue
        $t = [int]((Get-Date) - $t0).TotalSeconds
        if (-not $p) { Write-Host "t=${t}s client GONE"; break }
        Write-Host ("t={0,4}s client cpu={1}s rss={2}MB" -f $t, [math]::Round($p.CPU, 1), [math]::Round($p.WorkingSet64 / 1MB, 0))
    }
}
finally {
    if ($clientPid -and (Get-Process -Id $clientPid -ErrorAction SilentlyContinue)) {
        Write-Host "killing our PID $clientPid"
        Stop-Process -Id $clientPid -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 1200
    if (Test-Path -LiteralPath $lock) {
        $l = Get-Content -LiteralPath $lock -Raw
        if ($clientPid -and $l -match "\b$clientPid\b") { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue; Write-Host 'released game.lock' }
        else { Write-Host "game.lock is not ours ($($l.Trim())) - left alone" -ForegroundColor Yellow }
    }
    $cl = Join-Path $DevRoot "logs\$ClientName\enw-$clientPid.log"
    if (Test-Path -LiteralPath $cl) { Write-Host "client DLL log: $cl" }
}
