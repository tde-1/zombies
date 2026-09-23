<#
  settings-proof.ps1 -- the in-game Settings tab, end to end (esc-menu.md §9).

  1. waits for game.lock the way jointest-proof.ps1 does;
  2. `settings-roundtrip.mjs stamp`: the launcher's per-launch merge into the CLIENT home's
     profile config.cfg (sensitivity 5, FOV 80, show fps off, aspect auto, Use = F);
  3. jointest.ps1: a local dedicated server + client, invisible (ENW_TEST_NO_ACTIVATE=1,
     parked at -4000,-4000 by launch.ps1, ENW_BORDERLESS_COVER=0), the client DLL's
     ENW_ESC_MENU_SELFTEST=5: Esc -> Settings -> FOV slider, Show FPS, aspect ratio, the
     sensitivity slider, rebind Use to G -> Apply (a real vid_restart) -> the menu and Esc
     after it -> the Verified view. jointest KILLS both processes at the end: a crash, as far
     as config.cfg is concerned;
  4. `settings-roundtrip.mjs readback`: the launcher's post-exit read-back of that file and
     what /settings would show;
  5. -Relaunch: a second join with ENW_ESC_MENU_SELFTEST=6, which only opens the tab and logs
     the values the fresh process started with.

  Logs: ZombiesDev\logs\dedi\<Tag>.* (client DLL log <Tag>.client.enw.log, console
  <Tag>.client.console.log); captures in ZombiesDev\logs\c1\enwshot-*.bmp.
#>
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$From = 'esc-settings',
    [int]$Watch = 50,
    [switch]$Relaunch
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dev = 'C:\Users\b\ZombiesDev'
$lock = "$dev\locks\game.lock"
$clientHome = "$dev\homes\c1"

function Wait-Lock {
    $deadline = (Get-Date).AddMinutes(25)
    while ((Get-Date) -lt $deadline) {
        $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
        if (-not $busy) {
            Start-Sleep -Seconds 4   # esc-menu.md §7: start only after 4 s with nothing running
            $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
            if (-not $busy) { return }
        }
        $held = $null
        try { $held = (Get-Content -LiteralPath $lock -Raw -ErrorAction Stop).Trim() } catch {}
        Write-Host "waiting for game.lock: $held"
        Start-Sleep -Seconds 5
    }
    throw 'game.lock still held after 25 min'
}

$env:ENW_TEST_NO_ACTIVATE = '1'
$env:ENW_BORDERLESS_COVER = '0'
$env:ENW_FRAME_CAPTURE = '1'
$env:ENW_ESC_MENU = $null
$env:ENW_SETTINGS_RESTRICTED = $null
$env:ENW_USE_PRIVATE_LOCALAPPDATA = $null   # launch.ps1's default: the private LocalAppData

Wait-Lock
Write-Host "[$(Get-Date -Format HH:mm:ss)] stamp (the launcher's per-launch merge)" -ForegroundColor Cyan
& node "$repo\tools\dev\settings-roundtrip.mjs" stamp --home $clientHome
$env:ENW_ESC_MENU_SELFTEST = '5'
Write-Host "[$(Get-Date -Format HH:mm:ss)] jointest $Tag" -ForegroundColor Cyan
& powershell -ExecutionPolicy Bypass -File "$repo\tools\dev\jointest.ps1" -Tag $Tag -ServerFrom $From -ClientFrom $From `
    -WatchSeconds $Watch -ClientExtraArgs @('+set', 'com_maxfps', '125')
Write-Host "[$(Get-Date -Format HH:mm:ss)] read-back (the launcher, after the game is gone)" -ForegroundColor Cyan
& node "$repo\tools\dev\settings-roundtrip.mjs" readback --home $clientHome | Tee-Object -FilePath "$dev\logs\dedi\$Tag.readback.json"

if ($Relaunch) {
    Wait-Lock
    $env:ENW_ESC_MENU_SELFTEST = '6'
    Write-Host "[$(Get-Date -Format HH:mm:ss)] jointest $Tag-relaunch" -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File "$repo\tools\dev\jointest.ps1" -Tag "$Tag-relaunch" -ServerFrom $From -ClientFrom $From `
        -WatchSeconds 25 -NoDeploy -ClientExtraArgs @('+set', 'com_maxfps', '125')
}
$env:ENW_ESC_MENU_SELFTEST = $null
