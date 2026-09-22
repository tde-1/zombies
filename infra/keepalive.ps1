<#
.SYNOPSIS
  Keep zombies.enw.gg up: the site process and the Cloudflare tunnel.

.DESCRIPTION
  zombies.enw.gg is two processes on B's PC, and over one night it went down four
  separate times: once when a Start-Process shell exited, twice when an agent freed
  port 3200 to rebuild, once when a background task was killed. Every time, the
  public site answered 502 or 530 and nobody knew until somebody opened it.

  So: one loop that checks both every 30 seconds and restarts whichever is missing.

    - the site      an HTTP request to 127.0.0.1:3200. A 401 is UP (the beta gate is
                    doing its job); only a refused connection or a timeout is down.
    - the tunnel    is a cloudflared process alive. It reconnects on its own once it
                    is running, so liveness is enough.

  It only ever starts processes it cannot find, and it only ever kills processes it
  started itself (dev-box.md rule 4). If B is running the site by hand on 3200, this
  script sees a healthy port and does nothing.

    powershell -ExecutionPolicy Bypass -File infra\keepalive.ps1
    powershell -ExecutionPolicy Bypass -File infra\keepalive.ps1 -Once   # one check, for a test

  Log: infra\keepalive.log
#>
[CmdletBinding()]
param(
    [int]$Port = 3200,
    [string]$Tunnel = 'zombies',
    [int]$IntervalSeconds = 30,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

$repo       = Split-Path -Parent $PSScriptRoot
$webDir     = Join-Path $repo 'web'
$logFile    = Join-Path $PSScriptRoot 'keepalive.log'
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'

# The site's environment lives in infra\site.env (gitignored; see site.env.example).
# There is no dotenv in the server on purpose, so this is the one place that reads it —
# which means a secret cannot be picked up by accident from a stray file in the repo,
# and a restart can never silently lose one.
#
# ZM_PUBLIC_URL here is what Steam sign-in returns to. There is no mock page to fall back
# to any more (web/server/routes/auth.js, 2026-09-22), and ZM_TEST_LOGIN must never be in
# that file: with NODE_ENV=production the server refuses to start with it set.
$envFile = Join-Path $PSScriptRoot 'site.env'
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#') -or ($t -notmatch '=')) { continue }
        $name  = $t.Substring(0, $t.IndexOf('=')).Trim()
        $value = $t.Substring($t.IndexOf('=') + 1).Trim().Trim('"').Trim("'")
        if ($name) { Set-Item -Path "Env:$name" -Value $value }
    }
}

# The beta password. Without it the gate is off and the site would be open to the
# internet, so a restart that loses it is worse than a restart that fails.
if (-not $env:ZM_SITE_PASSWORD) { $env:ZM_SITE_PASSWORD = 'CrazyTime' }

function Write-Log {
    param([string]$Message)
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

function Test-Site {
    # 401 is healthy: it means the closed-beta gate answered. Anything that completes
    # an HTTP exchange means the site is serving. Only a transport failure is "down".
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing `
                                  -TimeoutSec 8 -ErrorAction Stop
        return $true
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($resp) { return $true }     # it answered, with some status. Up.
        return $false
    } catch {
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

function Test-Tunnel {
    return [bool](Get-Process -Name cloudflared -ErrorAction SilentlyContinue)
}

function Start-Site {
    if (-not (Test-Path -LiteralPath (Join-Path $webDir 'server\index.js'))) {
        Write-Log "site: web\server\index.js not found under $webDir -- not starting"
        return
    }
    $p = Start-Process -FilePath 'node' -ArgumentList 'server/index.js' `
                       -WorkingDirectory $webDir -WindowStyle Hidden -PassThru
    Write-Log "site: started node server/index.js (pid $($p.Id)) on port $Port"
}

function Start-Tunnel {
    if (-not (Test-Path -LiteralPath $cloudflared)) {
        Write-Log "tunnel: cloudflared.exe not found at $cloudflared -- not starting"
        return
    }
    $p = Start-Process -FilePath $cloudflared `
                       -ArgumentList 'tunnel','run','--url',"http://127.0.0.1:$Port",$Tunnel `
                       -WindowStyle Hidden -PassThru
    Write-Log "tunnel: started cloudflared run $Tunnel (pid $($p.Id))"
}

Write-Log "keepalive: watching port $Port and tunnel '$Tunnel' every ${IntervalSeconds}s"

# Only log a state change, not every heartbeat -- otherwise the log is useless and
# the disk fills with "still fine".
$lastSite = $null
$lastTunnel = $null

while ($true) {
    $siteUp = Test-Site
    if ($siteUp -ne $lastSite) {
        Write-Log ("site: {0}" -f $(if ($siteUp) { 'up' } else { 'DOWN' }))
        $lastSite = $siteUp
    }
    if (-not $siteUp) { Start-Site; Start-Sleep -Seconds 5; $lastSite = $null }

    $tunnelUp = Test-Tunnel
    if ($tunnelUp -ne $lastTunnel) {
        Write-Log ("tunnel: {0}" -f $(if ($tunnelUp) { 'up' } else { 'DOWN' }))
        $lastTunnel = $tunnelUp
    }
    if (-not $tunnelUp) { Start-Tunnel; Start-Sleep -Seconds 5; $lastTunnel = $null }

    if ($Once) { break }
    Start-Sleep -Seconds $IntervalSeconds
}
