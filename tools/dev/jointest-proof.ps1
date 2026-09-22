<#
  jointest-proof.ps1 -- the acceptance test for dedi.md 7j.

  Waits for game.lock, runs one 120 s jointest, and polls `oob.py getstatus` every
  3 s for the whole of it. A run PASSES only when:
    * the client reached CS_ACTIVE and the referee logged ROUND 1,
    * every getstatus in the watch window was answered,
    * frame::count was still advancing in the last liveness line,
    * THE ENGINE WAS STILL SIMULATING at the end -- com_frameTime advancing and the
      frame body still returning.
  Anything else prints FAIL and says which of the five it was.

  THE FIFTH GATE IS WHY THIS FILE WAS EDITED. Runs join55-join59 PASSED the first four
  gates on a server that had not simulated a frame in two minutes: `ROUND 1` fires
  seconds after the spawn, `getstatus` is answered on the raw out-of-band path, and
  `frame::count` is OUR tick, which keeps running whatever the engine does. The engine's
  own clock is the only one that can tell. `dedi_rate_probe` (frame_pacing.cpp, on unless
  ENW_DEDI_NO_RATE_PROBE) prints it every five seconds:

    dedi_rate_probe: ... | Com_Frame-body 0.0 Hz | ... com_frameTime=5662 ... delta=0

  `delta` is how far com_frameTime ([0x1F9648C]) moved in the last window and
  `Com_Frame-body` is [0x1F964BC] at 0x59E4DC -- the counter the frame body only reaches
  when it RETURNS. Both must be non-zero in the LAST line of the run. See dedi.md 11.1.
#>
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [int]$Port = 28960,
    [int]$Watch = 120,
    # The proof used to be prototype-only, which meant a custom map could never be
    # taken through the five gates. jointest.ps1 already knows how to do a custom map
    # (fs_game auto = mods/<bsp>); it just had no way through from here.
    [string]$Map = 'nazi_zombie_prototype',
    [switch]$Deploy,
    # Der Berg and friends want the 422 MB reserve (dedi.md 11.4).
    [switch]$BigHeap
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

if ($BigHeap) { $env:ENW_DEDI_BIG_HEAP = '1' } else { $env:ENW_DEDI_BIG_HEAP = $null }

$job = Start-Job -ScriptBlock {
    param($repo, $tag, $watch, $map, $deploy, $bigHeap)
    Set-Location $repo
    if ($bigHeap) { $env:ENW_DEDI_BIG_HEAP = '1' }
    $a = @('-Tag', $tag, '-WatchSeconds', $watch, '-Map', $map)
    if (-not $deploy) { $a += '-NoDeploy' }
    & powershell -ExecutionPolicy Bypass -File "$repo\tools\dev\jointest.ps1" @a 2>&1
} -ArgumentList $repo, $Tag, $Watch, $Map, [bool]$Deploy, [bool]$BigHeap

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
Wait-Job $job -Timeout ($Watch + 200) | Out-Null
Receive-Job $job | Out-Null
Remove-Job $job -Force

# --- verdict ---------------------------------------------------------------------
$enw = "$dev\logs\dedi\$Tag.server.enw.log"
$active = (Select-String -Path $enw -Pattern 'ENTERED THE WORLD' -SimpleMatch).Count
$round = (Select-String -Path $enw -Pattern 'referee: ROUND 1' -SimpleMatch).Count
$last = (Select-String -Path $enw -Pattern 'liveness t=').Line | Select-Object -Last 1
$moving = $last -match '\+(\d+) in 5s' -and [int]$Matches[1] -gt 0
$lines += "CS_ACTIVE=$active ROUND1=$round lastLiveness='$last'"

# --- gate 5: was the ENGINE still simulating? ------------------------------------
# NOTE: the probe's own `delta=` field is always 0 -- it compares com_frameTime with a
# copy read in the same breath. Do not gate on it. Compare com_frameTime ACROSS lines.
$rateLines = @((Select-String -Path $enw -Pattern 'dedi_rate_probe:').Line)
$rate = $rateLines | Select-Object -Last 1
$simulating = $false
$frameTimeDelta = -1
$bodyHz = -1.0
if ($rateLines.Count -ge 2) {
    $ftOf = {
        param($l)
        if ($l -match 'com_frameTime=(\d+)') { [int]$Matches[1] } else { -1 }
    }
    # 30 s earlier where there is that much history, otherwise the first line.
    $back = [Math]::Min(6, $rateLines.Count - 1)
    $ftNow = & $ftOf $rate
    $ftThen = & $ftOf $rateLines[$rateLines.Count - 1 - $back]
    $frameTimeDelta = $ftNow - $ftThen
    if ($rate -match 'Com_Frame-body\s+([0-9.]+)\s*Hz') { $bodyHz = [double]$Matches[1] }
    $simulating = ($frameTimeDelta -gt 0) -and ($bodyHz -gt 0)
}
$lines += "lastRateProbe='$rate'"
$lines += "com_frameTime advanced $frameTimeDelta ms over the last $back rate-probe windows  Com_Frame-body=$bodyHz Hz  simulating=$simulating"
if (-not $rate) {
    $lines += "NO dedi_rate_probe LINE: the fifth gate cannot be evaluated (is ENW_DEDI_NO_RATE_PROBE set?). Treating as FAIL."
}

$pass = ($active -ge 1) -and ($round -ge 1) -and ($unanswered -eq 0) -and $moving -and $simulating
if (-not $pass) {
    $why = @()
    if ($active -lt 1) { $why += 'no CS_ACTIVE' }
    if ($round -lt 1) { $why += 'no ROUND 1' }
    if ($unanswered -ne 0) { $why += "$unanswered unanswered getstatus" }
    if (-not $moving) { $why += 'frame::count not advancing' }
    if (-not $simulating) { $why += 'THE ENGINE STOPPED SIMULATING (com_frameTime frozen / frame body not returning)' }
    $lines += "failed gates: $($why -join '; ')"
}
$lines += $(if ($pass) { "PASS" } else { "FAIL" })
Set-Content -LiteralPath $out -Value $lines -Encoding utf8
$lines | ForEach-Object { Write-Host $_ }
