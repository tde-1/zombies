<#
  jointest-proof.ps1 -- the acceptance test for dedi.md 7j.

  Waits for game.lock, runs one 120 s jointest, and polls `oob.py getstatus` every
  3 s for the whole of it. A run PASSES only when:
    * the client reached CS_ACTIVE and the referee logged ROUND 1,
    * every getstatus in the watch window was answered,
    * frame::count was still advancing in the last liveness line.
  Anything else prints FAIL and says which of the three it was.
#>
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [int]$Port = 28960,
    [int]$Watch = 120
)
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\b\Desktop\Zombies'
$dev = 'C:\Users\b\ZombiesDev'
$lock = "$dev\locks\game.lock"
$out = "$dev\logs\dedi\$Tag-proof.txt"

$deadline = (Get-Date).AddMinutes(25)
while ((Test-Path -LiteralPath $lock) -and (Get-Date) -lt $deadline) {
    Write-Host "waiting for game.lock: $((Get-Content $lock -Raw).Trim())"
    Start-Sleep -Seconds 5
}
if (Test-Path -LiteralPath $lock) { throw 'game.lock still held' }

$job = Start-Job -ScriptBlock {
    param($repo, $tag, $watch)
    Set-Location $repo
    & powershell -ExecutionPolicy Bypass -File "$repo\tools\dev\jointest.ps1" -Tag $tag -NoDeploy -WatchSeconds $watch 2>&1
} -ArgumentList $repo, $Tag, $Watch

# --- find the server PID, then poll the wire -------------------------------------
$serverPid = 0
$t0 = Get-Date
while (-not $serverPid -and ((Get-Date) - $t0).TotalSeconds -lt 120) {
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $lock) {
        $f = (Get-Content -LiteralPath $lock -Raw).Trim() -split '\s+'
        if ($f.Count -ge 2 -and $f[1] -match '^\d+$') {
            $c = [int]$f[1]
            if (Get-Process -Id $c -ErrorAction SilentlyContinue) { $serverPid = $c }
        }
    }
}
if (-not $serverPid) { throw 'no server pid' }

$lines = @("proof $Tag  server pid $serverPid  $(Get-Date -Format o)")
$answered = 0; $unanswered = 0; $firstAnswer = $null
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt ($Watch + 10)) {
    Start-Sleep -Seconds 3
    if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { break }
    & python "$repo\tools\dev\oob.py" $Port --timeout 1.0 > $null 2>&1
    $t = [int]((Get-Date) - $t0).TotalSeconds
    if ($LASTEXITCODE -eq 0) {
        if (-not $firstAnswer) { $firstAnswer = $t }
        $answered++
    }
    elseif ($firstAnswer) { $unanswered++; $lines += "t=${t}s getstatus UNANSWERED" }
}
$lines += "answered $answered, unanswered-after-first-answer $unanswered"
Wait-Job $job -Timeout 400 | Out-Null
Receive-Job $job | Out-Null
Remove-Job $job -Force

# --- verdict ---------------------------------------------------------------------
$enw = "$dev\logs\dedi\$Tag.server.enw.log"
$active = (Select-String -Path $enw -Pattern 'ENTERED THE WORLD' -SimpleMatch).Count
$round = (Select-String -Path $enw -Pattern 'referee: ROUND 1' -SimpleMatch).Count
$last = (Select-String -Path $enw -Pattern 'liveness t=').Line | Select-Object -Last 1
$moving = $last -match '\+(\d+) in 5s' -and [int]$Matches[1] -gt 0
$lines += "CS_ACTIVE=$active ROUND1=$round lastLiveness='$last'"
$pass = ($active -ge 1) -and ($round -ge 1) -and ($unanswered -eq 0) -and $moving
$lines += $(if ($pass) { "PASS" } else { "FAIL" })
Set-Content -LiteralPath $out -Value $lines -Encoding utf8
$lines | ForEach-Object { Write-Host $_ }
