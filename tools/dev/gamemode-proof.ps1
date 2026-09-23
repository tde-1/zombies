<#
  gamemode-proof.ps1 -- a map's own game mode, end to end on this PC (docs/kickstart/game-modes.md).

  One dedicated server + one invisible client on a UGX map (Battlestar Galactica by default).
  The server's command line gets exactly what the host agent would put there for the chosen
  mode: the site's catalogue entry (web/server/lib/gameModes.leaseSpec) through the host's own
  validator (infra/host-agent/lib/gamemode.js gameModeDvars) -- nothing typed by hand. The game
  link goes to authhost.mjs, so every `game_mode` and `notify` event is in a transcript, and the
  client takes timed back-buffer captures (frame_capture_timer.cpp) that log keyCatchers.

    -Mode none      the CONTROL: no mode dvars, so the map's vote menu must appear (and the
                    game sits waiting for a host who never answers)
    -Mode gungame   (or classic, sharpshooter, ...) the menu must never appear, the server's
                    answer and the map's own `ugxm_voting_complete` must be in the transcript

  Rules honoured: waits for game.lock and any CoDWaW.exe (README rule 3), invisible windows
  (rule 11), private LocalAppData (rule 12, launch.ps1's default), fake SteamID (rule 14),
  kills only its own node PID.
#>
param(
    [string]$Mode = 'gungame',
    [string]$Map = 'battlestar_galactica',
    [string]$Tag = '',
    [int]$Watch = 75,
    [string]$From = 'ugx',
    [string]$CaptureAt = '4,12,25,45'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dev = 'C:\Users\b\ZombiesDev'
$lock = "$dev\locks\game.lock"
if (-not $Tag) { $Tag = "gm-$Mode-$(Get-Date -Format HHmmss)" }
$out = Join-Path $dev "logs\gamemode\$Tag"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$match = "m_$($Tag -replace '[^A-Za-z0-9]', '')"
$steamid = '76561198000000001'

# ---- the args, from the real pipeline -----------------------------------------------------
$serverExtra = @()
if ($Mode -ne 'none') {
    $js = @"
const path = require('path');
const gm = require(path.join(process.argv[1], 'web', 'server', 'lib', 'gameModes.js'));
const spec = gm.leaseSpec(process.argv[2], process.argv[3]);
if (!spec) { console.error('no such mode on this map'); process.exit(2) }
import('file://' + path.join(process.argv[1], 'infra', 'host-agent', 'lib', 'gamemode.js').replace(/\\/g, '/')).then((h) => {
  const r = h.gameModeDvars(spec);
  if (r.error) { console.error(r.error); process.exit(3) }
  for (const [k, v] of r.dvars) console.log(k + ' ' + v);
});
"@
    $lines = & node -e $js $repo $Map $Mode
    if ($LASTEXITCODE -ne 0 -or -not $lines) { throw "could not build the mode dvars for $Map/$Mode" }
    foreach ($l in $lines) { $k, $v = $l -split ' ', 2; $serverExtra += @('+set', $k, $v) }
}
"mode $Mode on $Map -> server extra: $($serverExtra -join ' ')" | Tee-Object -FilePath "$out\proof.txt"

# ---- wait for the one game slot on this PC -------------------------------------------------
$deadline = (Get-Date).AddMinutes(60)
while ((Get-Date) -lt $deadline) {
    $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
    if (-not $busy) {
        Start-Sleep -Seconds 5
        $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
        if (-not $busy) { break }
    }
    Start-Sleep -Seconds 5
}
if ((Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count) { throw 'the game slot never came free' }

# ---- the link host and the player's token --------------------------------------------------
$token = (& node "$repo\tools\dev\authhost.mjs" mint --match $match --steamid $steamid).Trim()
$link = Start-Process -FilePath node -ArgumentList @("$repo\tools\dev\authhost.mjs", 'serve', '--match', $match, '--port', '38795', '--out', "$out\link.ndjson") `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput "$out\authhost.out.txt" -RedirectStandardError "$out\authhost.err.txt"
Start-Sleep -Seconds 1

$env:ENW_TEST_NO_ACTIVATE = '1'
$env:ENW_BORDERLESS_COVER = '0'
$env:ENW_FRAME_CAPTURE = '1'
$env:ENW_FRAME_CAPTURE_AT = $CaptureAt
$env:ENW_FRAME_CAPTURE_DIR = $out
$env:ENW_USE_PRIVATE_LOCALAPPDATA = $null
try {
    & "$repo\tools\dev\jointest.ps1" -Tag $Tag -Map $Map -ServerFrom $From -ClientFrom $From -WatchSeconds $Watch `
        -AuthToken $token -MatchId $match -LinkHost '127.0.0.1:38795' `
        -ClientExtraArgs @('+set', 'com_maxfps', '60') -ServerExtraArgs $serverExtra *>&1 |
        Tee-Object -FilePath "$out\jointest.txt" | Out-Null
}
finally {
    if ($link -and -not $link.HasExited) { Stop-Process -Id $link.Id -Force -ErrorAction SilentlyContinue }
}

# ---- what happened ------------------------------------------------------------------------
$sum = @("== $Tag ($Mode on $Map)")
$sum += '-- game link (game_mode events, the vote notifies, the player):'
if (Test-Path "$out\link.ndjson") {
    $sum += Select-String -Path "$out\link.ndjson" -Pattern '"t":"game_mode"|ugxm_voting_complete|voting_complete|ugxm_vote|"t":"player_connect"|"t":"round"' |
        Select-Object -First 30 | ForEach-Object { $_.Line }
}
$logs = "$dev\logs\dedi"
$sum += '-- server DLL (game_mode:):'
$sl = Get-ChildItem "$logs\$Tag.server.enw.log" -ErrorAction SilentlyContinue
if ($sl) { $sum += Select-String -Path $sl.FullName -Pattern 'game_mode' | Select-Object -First 20 | ForEach-Object { $_.Line } }
$sum += '-- client captures (keyCatchers):'
$cl = Get-ChildItem "$logs\$Tag.client.enw.log" -ErrorAction SilentlyContinue
if ($cl) { $sum += Select-String -Path $cl.FullName -Pattern 'frame_capture|keyCatchers' | Select-Object -First 20 | ForEach-Object { $_.Line } }
$sum += '-- files:'
$sum += Get-ChildItem $out -File | ForEach-Object { "$($_.Name) $($_.Length)" }
$sum | Tee-Object -FilePath "$out\proof.txt" -Append
