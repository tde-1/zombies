<#
  ss-proof.ps1 -- lane SS (client.md Â§15): ENW's own screenshot, end to end, locally, at a REAL
  2560x1440 back buffer.

  The same game as ce-proof.ps1 (a local dedicated server + the REAL host agent `--local` with the
  10 s restart grace + an invisible client under game.lock; the idle player dies, the game ends),
  but the client runs with r_mode 2560x1440 windowed, parked off-screen by launch.ps1
  (ENW_TEST_NO_ACTIVATE=1, -4000,-4000, ENW_BORDERLESS_COVER=0, the private LocalAppData,
  com_maxfps 30), so the back buffer the screenshot grabs is B's size. No synthetic frame.

  F12 is posted to the game window (screenshot_guard.cpp's ENW_SCREENSHOT_KEY_FILE):
    * 8 s after the game is live, and again 200 ms later (the second must be refused: 500 ms limit);
    * 3 s after the game over, inside the host's restart grace (B's F12 was at +5 s).
  -BindOurs puts `+bind F12 enw_screenshot` on the command line (our command, as the launcher's
  config binds it); -BindStock puts WaW's `+bind F12 screenshotJPEG` there, which must reach OUR
  screenshot through the redirect. (A +bind is archived into the copy's profile, so always pass one.) Shots go to ENW_SCREENSHOT_DIR = <out>\pictures -- never B's
  Pictures. -Png sets ENW_SCREENSHOT_FORMAT=png.

  After the run: every file in <out>\pictures (size, dimensions read from the file), and any file
  under C:\Users\b\Documents written since the run started (there must be none).

  powershell -ExecutionPolicy Bypass -File tools\dev\ss-proof.ps1 -Tag ss1 -BindOurs
  powershell -ExecutionPolicy Bypass -File tools\dev\ss-proof.ps1 -Tag ss2 -Map nazi_zombie_ccube
#>
param(
    [string]$Tag = 'ss1',
    [string]$Map = 'nazi_zombie_prototype',
    [string]$From = 'ss',
    [string]$ServerName = 'cls',
    [string]$ClientName = 'clc',
    [int]$LinkPort = 38971,
    [int]$DashPort = 8971,
    [int]$GraceMs = 10000,
    [int]$Watch = 420,
    [string]$Mode = '2560x1440',
    [int]$MaxFps = 30,
    [switch]$BindOurs,
    [switch]$BindStock,
    [switch]$Png
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dev = 'C:\Users\b\ZombiesDev'
$lock = "$dev\locks\game.lock"
$out = "$dev\logs\ss\$Tag"
$pics = "$out\pictures"
New-Item -ItemType Directory -Force -Path $out, "$out\replays", "$out\keys", "$out\spool", "$out\host", $pics | Out-Null
$keyFile = "$out\f12.trigger"
Remove-Item -LiteralPath $keyFile -ErrorAction SilentlyContinue
$match = "m_$Tag"
$notes = "$out\driver.log"
$started = Get-Date
function Note($m) { $l = "[{0:HH:mm:ss.fff}] {1}" -f (Get-Date), $m; Write-Host $l; try { Add-Content -LiteralPath $notes -Value $l -Encoding utf8 } catch {} }

$hostOut = "$out\host.out.log"
$hostArgs = @("$repo\infra\host-agent\host.js", '--local', '--box', 'sslocal', '--link-port', "$LinkPort",
    '--dash-port', "$DashPort", '--restart-grace-ms', "$GraceMs", '--replay-dir', "$out\replays",
    '--log-dir', "$out\host", '--key-dir', "$out\keys", '--spool-dir', "$out\spool")
$hostProc = Start-Process -FilePath node -ArgumentList $hostArgs -RedirectStandardOutput $hostOut `
    -RedirectStandardError "$out\host.err.log" -WindowStyle Hidden -PassThru
Note "host agent PID $($hostProc.Id); map $Map; r_mode $Mode; bind $(if ($BindOurs) { 'F12 enw_screenshot (command line)' } elseif ($BindStock) { 'F12 screenshotJPEG (command line: the stock bind, must reach OURS)' } else { 'whatever the profile holds' }); format $(if ($Png) { 'png' } else { 'jpg' })"
try {
    $ok = $false
    for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
        Start-Sleep -Milliseconds 250
        try {
            $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$DashPort/api/local/expect" -ContentType 'application/json' `
                -Body (@{ instance = $ServerName; match_id = $match; map = $Map } | ConvertTo-Json)
            $ok = $r.ok
        } catch {}
    }
    if (-not $ok) { throw 'the host agent never answered /api/local/expect' }

    $job = Start-Job -ScriptBlock {
        param($repo, $Tag, $From, $ServerName, $ClientName, $Watch, $match, $LinkPort, $Map, $keyFile, $lock, $DashPort, $Mode, $MaxFps, $BindOurs, $Png, $pics, $BindStock)
        $deadline = (Get-Date).AddMinutes(60)
        while ((Get-Date) -lt $deadline) {
            $busy = (Test-Path -LiteralPath $lock) -or @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue).Count -gt 0
            if (-not $busy) { break }
            Start-Sleep -Milliseconds 200
        }
        $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$DashPort/api/local/expect" -ContentType 'application/json' `
            -Body (@{ instance = $ServerName; match_id = $match; map = $Map } | ConvertTo-Json)
        $env:ENW_TEST_NO_ACTIVATE = '1'
        $env:ENW_BORDERLESS_COVER = '0'
        $env:ENW_SCREENSHOT_DIR = $pics
        $env:ENW_SCREENSHOT_KEY_FILE = $keyFile
        $env:ENW_SCREENSHOT_FORMAT = $(if ($Png) { 'png' } else { $null })
        $env:ENW_SCREENSHOT_TEST = $null
        $env:ENW_SCREENSHOT_STOCK = $null
        $env:ENW_SCREENSHOT_GUARD = $null
        $env:ENW_FRAME_CAPTURE = $null
        $env:ENW_CONSOLE_RESTART_FILE = $null
        $env:ENW_CONSOLE_SELFTEST = $null
        $env:ENW_ESC_MENU_SELFTEST = $null
        $env:ENW_CHAT_SELFTEST = $null
        $env:ENW_USE_PRIVATE_LOCALAPPDATA = $null   # launch.ps1's default: the private LocalAppData
        $extra = @('+set', 'com_maxfps', "$MaxFps", '+set', 'r_fullscreen', '0', '+set', 'r_mode', $Mode)
        if ($BindOurs) { $extra += @('+bind', 'F12', 'enw_screenshot') }
        if ($BindStock) { $extra += @('+bind', 'F12', 'screenshotJPEG') }
        & "$repo\tools\dev\jointest.ps1" -Tag $Tag -ServerFrom $From -ClientFrom $From -ServerName $ServerName `
            -ClientName $ClientName -WatchSeconds $Watch -MatchId $match -LinkHost "127.0.0.1:$LinkPort" -Map $Map `
            -ClientExtraArgs $extra *>&1
    } -ArgumentList $repo, $Tag, $From, $ServerName, $ClientName, $Watch, $match, $LinkPort, $Map, $keyFile, $lock, $DashPort, $Mode, $MaxFps, $BindOurs.IsPresent, $Png.IsPresent, $pics, $BindStock.IsPresent

    $count = {
        param($file, $pat)
        if (-not (Test-Path -LiteralPath $file)) { return 0 }
        $t = ''
        try {
            $fs = [IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
            $sr = New-Object IO.StreamReader($fs)
            $t = $sr.ReadToEnd(); $sr.Close()
        } catch { return 0 }
        ([regex]::Matches($t, $pat)).Count
    }
    $liveAt = $null; $liveShot = $false; $spamShot = $false
    $overAt = $null; $endShot = $false
    $killed = $false
    $exe = "$dev\waw-$ServerName\CoDWaW.exe"
    while ($job.State -eq 'Running') {
        Start-Sleep -Milliseconds 50
        if (-not $liveShot) {
            if (-not $liveAt -and (& $count $hostOut 'game live:') -ge 1) { $liveAt = (Get-Date).AddSeconds(8); Note 'game live; F12 in 8 s' }
            if ($liveAt -and (Get-Date) -ge $liveAt) { Set-Content -LiteralPath $keyFile -Value '1' -Encoding ascii; $liveShot = $true; Note 'F12 (mid-game) FIRED' }
        } elseif (-not $spamShot -and (Get-Date) -ge $liveAt.AddMilliseconds(250) -and -not (Test-Path -LiteralPath $keyFile)) {
            Set-Content -LiteralPath $keyFile -Value '1' -Encoding ascii; $spamShot = $true; Note 'F12 again right after (must be refused: 500 ms)'
        }
        if (-not $endShot) {
            if (-not $overAt -and (& $count $hostOut 'restart grace: \d+ ms for') -ge 1) { $overAt = (Get-Date).AddSeconds(3); Note 'game over (restart grace open); F12 in 3 s' }
            if ($overAt -and (Get-Date) -ge $overAt) { Set-Content -LiteralPath $keyFile -Value '1' -Encoding ascii; $endShot = $true; Note 'F12 (after the game over) FIRED' }
        }
        if (-not $killed -and (& $count $hostOut 'disposition: ') -ge 1) {
            $sp = @(Get-Process -Name CoDWaW -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
            foreach ($p in $sp) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Note "disposition: ended our server PID $($p.Id) ($exe), as the box does" }
            $killed = $true
        }
    }
    $res = @()
    try { $res = @(Receive-Job -Job $job -Wait -ErrorAction Stop) } catch { $res += "jointest threw: $_" }
    $res | ForEach-Object { Add-Content -LiteralPath "$out\jointest.log" -Value "$_" -Encoding utf8 }
    Remove-Job -Job $job -Force
    Note 'jointest finished'
} finally {
    if ($hostProc -and -not $hostProc.HasExited) { Stop-Process -Id $hostProc.Id -Force -ErrorAction SilentlyContinue; Note "stopped our host agent PID $($hostProc.Id)" }
    Remove-Item -LiteralPath $keyFile -ErrorAction SilentlyContinue
}
Note 'host lines:'
Select-String -LiteralPath $hostOut -Pattern 'game over|game live|grace|disposition' | ForEach-Object { Note ("  " + $_.Line) }
$cl = "$dev\logs\dedi\$Tag.client.enw.log"
if (Test-Path -LiteralPath $cl) {
    Note 'client lines:'
    Select-String -LiteralPath $cl -Pattern 'screenshot|Com_Error|Hunk_|enw_localappdata|lockdown:|clc.state|end screen|quit' |
        ForEach-Object { Note ("  " + $_.Line) }
}
Note 'pictures:'
Add-Type -AssemblyName System.Drawing
Get-ChildItem -LiteralPath $pics -File | ForEach-Object {
    $dim = '?'
    try { $img = [System.Drawing.Image]::FromFile($_.FullName); $dim = "$($img.Width)x$($img.Height)"; $img.Dispose() } catch {}
    $head = [IO.File]::ReadAllBytes($_.FullName) | Select-Object -First 64
    $exif = ([Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($_.FullName), 0, [Math]::Min(4096, $_.Length))) -match 'Exif'
    Note ("  {0}  {1:N2} MB  {2}  exif={3}" -f $_.Name, ($_.Length / 1MB), $dim, $exif)
}
Note 'Documents written since the run started (must be none):'
$docs = @(Get-ChildItem -LiteralPath 'C:\Users\b\Documents' -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $started -or $_.CreationTime -ge $started })
if ($docs.Count) { $docs | ForEach-Object { Note ("  NEW: " + $_.FullName) } } else { Note '  none' }
