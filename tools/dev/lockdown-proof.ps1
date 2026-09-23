<#
  lockdown-proof.ps1 -- the lockdown lane's four items in one local join (esc-menu.md §10).

  Before it (the harness does not start them, so their logs are yours):
    node web/test/game-menu.js --serve 3399           a private site: chat pass, feed, /dev/result
    node tools/dev/authhost.mjs mint  --keydir build/authtest-keys --match <M> --steamid 76561198000000201
    node tools/dev/authhost.mjs serve --keydir build/authtest-keys --match <M> --port 38795 `
         --result http://127.0.0.1:3399/dev/result --out ZombiesDev\logs\dedi\<Tag>.link.ndjson

  Then this: waits for game.lock the way settings-proof.ps1 does, and runs jointest.ps1 (local
  dedicated server + client, invisible: ENW_TEST_NO_ACTIVATE=1, parked off-screen by
  launch.ps1, ENW_BORDERLESS_COVER=0, the private LocalAppData) with
    * the chat pass (ENW_CHAT_BASE/_BEARER): the overlay's first poll asks history=1;
    * ENW_CONSOLE_SELFTEST=1: the ENW console driven by posted keys, then the engine's own
      console key sent past the filter (the catcher);
    * timed captures around the expected game over (an idle solo player dies on Nacht at
      ~90 s): the "Your record has been uploaded." line on the HUD;
    * a short cl_timeout and, as a fallback, a timed `disconnect`: the fall-back to the main
      menu, covered and quit (the client should end on its own before jointest kills it).
  Logs: ZombiesDev\logs\dedi\<Tag>.*; captures in the client's log dir (enwshot-*.bmp).
#>
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Match,
    [Parameter(Mandatory = $true)][string]$TokenFile,
    [Parameter(Mandatory = $true)][string]$ChatBase,
    [Parameter(Mandatory = $true)][string]$ChatBearer,
    [string]$From = 'lane12',
    [int]$Watch = 200,
    [string]$CaptureAt = '8,15,92,95,98,101,104,107,110,113',
    [string]$Cmds = '175:disconnect',
    [string]$ClientName = 'c1',
    [string]$ServerName = 'd2',
    # > 0: this many seconds after the client is launched, END THE SERVER (our own PID, from the
    # transcript) -- the box tearing an instance down under a player. The client then times out
    # (cl_timeout 10) and falls back to the main menu, which the lockdown must cover and quit.
    [int]$KillServerAt = 0,
    # `+set monkeytoy 0` on the client: the stock SP console is otherwise disabled by the game
    # itself, so the catcher (the engine's own console key sent past our filter) proves nothing.
    [switch]$MonkeyToyOff,
    # ENW_CONSOLE_SELFTEST: 1 = the console script; 2 = the same, ending in `/quit` for real
    # (lane C1, esc-menu.md §11.6: the client must end on its own after the site quit call).
    [ValidateSet('1', '2')][string]$ConsoleSelftest = '1'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dev = 'C:\Users\b\ZombiesDev'
$lock = "$dev\locks\game.lock"

function Wait-Lock {
    $deadline = (Get-Date).AddMinutes(60)
    while ((Get-Date) -lt $deadline) {
        $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
        if (-not $busy) {
            Start-Sleep -Seconds 4
            $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
            if (-not $busy) { return }
        }
        Write-Host "waiting for game.lock / a CoDWaW.exe that is not ours"
        Start-Sleep -Seconds 5
    }
    throw 'game.lock still held after 60 min'
}

$env:ENW_TEST_NO_ACTIVATE = '1'
$env:ENW_BORDERLESS_COVER = '0'
$env:ENW_FRAME_CAPTURE = '1'
$env:ENW_FRAME_CAPTURE_AT = $CaptureAt
$env:ENW_FRAME_CAPTURE_CMDS = $Cmds
$env:ENW_CONSOLE_SELFTEST = $ConsoleSelftest
$env:ENW_CHAT_BASE = $ChatBase
$env:ENW_CHAT_BEARER = $ChatBearer
$env:ENW_ESC_MENU = $null
$env:ENW_ESC_MENU_SELFTEST = $null
$env:ENW_USE_PRIVATE_LOCALAPPDATA = $null   # launch.ps1's default: the private LocalAppData
$token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()

$clientArgs = @('+set', 'cl_timeout', '10')
if ($MonkeyToyOff) { $clientArgs += @('+set', 'monkeytoy', '0') }

Wait-Lock
for ($try = 1; $try -le 6; $try++) {
    Write-Host "[$(Get-Date -Format HH:mm:ss)] jointest $Tag (take $try)" -ForegroundColor Cyan
    $killer = $null
    if ($KillServerAt -gt 0) {
        # Reads the server PID jointest wrote into game.lock (our experiment's lock: "<copy> <pid> ...",
        # the copy name checked), and ends exactly that PID $after seconds after it appeared.
        # Never the transcript: holding it open made jointest's own writes fail (l12b take 1).
        $killer = Start-Job -ScriptBlock {
            param($lockPath, $copy, $after)
            $deadline = (Get-Date).AddMinutes(6)
            $serverPid = $null; $seen = $null
            while ((Get-Date) -lt $deadline) {
                if (-not $serverPid) {
                    $t = ''
                    try { $t = [IO.File]::ReadAllText($lockPath) } catch {}
                    if ($t -match "^\s*$copy (\d+)") { $serverPid = [int]$Matches[1]; $seen = Get-Date }
                }
                if ($serverPid -and ((Get-Date) - $seen).TotalSeconds -ge $after) {
                    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
                    return "ended our server PID $serverPid at $(Get-Date -Format HH:mm:ss.fff) ($after s after it took the lock)"
                }
                Start-Sleep -Milliseconds 500
            }
            'never ended the server (no PID in game.lock)'
        } -ArgumentList $lock, $ServerName, $KillServerAt
    }
    $out = @()
    try {
        $out = & "$repo\tools\dev\jointest.ps1" -Tag $Tag -ServerFrom $From -ClientFrom $From -ServerName $ServerName `
            -ClientName $ClientName -WatchSeconds $Watch -AuthToken $token -MatchId $Match -LinkHost '127.0.0.1:38795' `
            -ClientExtraArgs $clientArgs *>&1
    } catch { $out += "jointest threw: $_" }
    if ($killer) { $out += "killer: $(Receive-Job -Job $killer -Wait)"; Remove-Job -Job $killer -Force }
    $out | ForEach-Object { Write-Host $_ }
    if (($out -join "`n") -match 'took game.lock|server PID') { break }
    Write-Host 'the lock was taken first; waiting again' -ForegroundColor Yellow
    Wait-Lock
}
