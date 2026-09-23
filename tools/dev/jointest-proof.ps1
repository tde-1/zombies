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
    [switch]$BigHeap,

    # ---- identity (referee.md 13) -------------------------------------------
    # The five gates say the server survived the player. These say WHO the player
    # was. Pass all three together: a token is bound to a match, and the link has to
    # be up for the host's `auth` answer to promote the row to `verified`.
    #   $t = node tools/dev/authhost.mjs mint --match m_x --steamid <id64>
    #   node tools/dev/authhost.mjs serve --match m_x --port 38795 --out <f>
    [string]$AuthToken = '',
    [string]$MatchId = '',
    [string]$LinkHost = '',

    # The name the CLIENT claims, for the name-lock proof (referee.md 14). Passed
    # straight through to jointest.ps1 as `+set name <x>` on the client's command line.
    [string]$ClientNameDvar = '',

    # build\<name> to deploy the SERVER half from. jointest.ps1 has always had this;
    # it simply had no way through from here, so a proof run could only ever test
    # build\dedi. A lane that builds into its own directory (dev-box.md rule 11) needs it.
    [string]$ServerFrom = 'dedi',
    # build\<name> for the CLIENT half. Needed to put the client DLL's `name_pin`
    # component on the client for the name-lock proof.
    [string]$ClientFrom = '',
    # Extra `+set` pairs for the CLIENT only, passed straight through to jointest.ps1's
    # own -ClientExtraArgs (e.g. '+set','com_maxfps','60' -- the harness passes no
    # com_maxfps to the client, and the rule is to always pass one).
    [string[]]$ClientExtraArgs = @()
)
$ErrorActionPreference = 'Stop'
# This checkout, not a hard-coded main: a worktree must run its OWN jointest.ps1 and
# deploy its OWN build\<name> (bug 7, 2026-09-23: the hard-coded path deployed main's
# stale build\dedi over the worktree's freshly deployed DLL).
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dev = 'C:\Users\b\ZombiesDev'
$lock = "$dev\locks\game.lock"
$out = "$dev\logs\dedi\$Tag-proof.txt"

$deadline = (Get-Date).AddMinutes(25)
while ((Test-Path -LiteralPath $lock) -and (Get-Date) -lt $deadline) {
    # The holder can release between Test-Path and the read, and then `Get-Content`
    # returns $null and `.Trim()` throws -- which is how join84 died having waited
    # correctly for three minutes. Read it defensively; losing the wait to a race is
    # not a reason to lose the run.
    $held = $null
    try { $held = Get-Content -LiteralPath $lock -Raw -ErrorAction Stop } catch {}
    if (-not $held) { break }
    Write-Host "waiting for game.lock: $($held.Trim())"
    Start-Sleep -Seconds 5
}
if (Test-Path -LiteralPath $lock) { throw 'game.lock still held' }

if ($BigHeap) { $env:ENW_DEDI_BIG_HEAP = '1' } else { $env:ENW_DEDI_BIG_HEAP = $null }

$job = Start-Job -ScriptBlock {
    param($repo, $tag, $watch, $map, $deploy, $bigHeap, $tok, $match, $link, $spoof, $serverFrom, $clientFrom, $clientExtra)
    Set-Location $repo
    if ($bigHeap) { $env:ENW_DEDI_BIG_HEAP = '1' }
    $a = @('-Tag', $tag, '-WatchSeconds', $watch, '-Map', $map)
    if (-not $deploy) { $a += '-NoDeploy' }
    if ($tok)   { $a += @('-AuthToken', $tok) }
    if ($match) { $a += @('-MatchId', $match) }
    if ($link)  { $a += @('-LinkHost', $link) }
    if ($spoof) { $a += @('-ClientNameDvar', $spoof) }
    if ($serverFrom) { $a += @('-ServerFrom', $serverFrom) }
    if ($clientFrom) { $a += @('-ClientFrom', $clientFrom) }
    if ($clientExtra -and $clientExtra.Count) { $a += '-ClientExtraArgs'; $a += ($clientExtra -join ',') }
    & powershell -ExecutionPolicy Bypass -File "$repo\tools\dev\jointest.ps1" @a 2>&1
} -ArgumentList $repo, $Tag, $Watch, $Map, [bool]$Deploy, [bool]$BigHeap, $AuthToken, $MatchId, $LinkHost, $ClientNameDvar, $ServerFrom, $ClientFrom, $ClientExtraArgs

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

# --- identity, read off the same log (referee.md 13) -----------------------------
# NOT one of the five gates: a run can be a perfectly good proof that the server
# survives a player and still be a Local/dev run that awards nobody anything. It is
# reported because the one thing a join run could never show before is WHO played.
$idLine = (Select-String -Path $enw -Pattern 'referee: player_connect slot').Line | Select-Object -Last 1
$idVerified = (Select-String -Path $enw -Pattern 'identity VERIFIED by the host' -SimpleMatch).Count
$idRefused = (Select-String -Path $enw -Pattern 'REFUSED \(').Count
$lines += "identity: connect='$idLine' verified=$idVerified refused=$idRefused"

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
