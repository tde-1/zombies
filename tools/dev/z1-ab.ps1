<#
.SYNOPSIS
  Z1 (mod-compat.md §10): A/B runs for the fear_mc_2 zombie skinning bug (invisible with AA 4x /
  specular / glow on, garbled with them off). One local dedi + client game per variant, same map,
  same renderer dvars as B's launch line, frame captures while zombies are at the player.

.DESCRIPTION
  RUN ONLY WHEN B'S PC IS FREE. jointest.ps1 takes game.lock for the pair and releases it; the
  windows are the harness's invisible ones (launch.ps1 parks them at -4000,-4000, no activation) and
  the profile is the private LocalAppData. Nothing here touches B's install or his profile.

  Each variant changes ONE thing against V0. Read the frames in
  ZombiesDev\logs\z1\<tag>\enwshot-*.bmp (zombies reach a player standing at spawn ~36 s in).

  Before V0 is trusted, it must REPRODUCE: the harness never showed B's stretched Colt at 2560x1440
  (mcjoinB3/B4), so if V0 draws zombies correctly the cause is outside the DLL and the dvars
  (Discord's hook, the address space, the internet path) and variants D1/D2/W0 are the ones that
  matter; the DLL variants are then moot.

.PARAMETER Only
  Comma-separated variant ids to run (default: all, in order).
.PARAMETER Dll10
  build\<dir> holding enw_t4.dll = 10ba8544 (0.2.24). Created from the launcher's installed
  binkw32.dll if missing.
.PARAMETER Dll03
  build\<dir> holding enw_t4.dll = 03b04bc3 (0.2.20/0.2.21, main 81086d4): build\jrfinal.
#>
param(
    [string]$Only = '',
    [string]$Dll10 = 'z1-10ba8544',
    [string]$Dll03 = 'jrfinal',
    [int]$WatchSeconds = 130,
    [string]$DevRoot = 'C:\Users\b\ZombiesDev'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$mainRepo = 'C:\Users\b\Desktop\Zombies'   # build\ lives in the main checkout

function Sha8($p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.Substring(0, 8).ToLower() }

# ---- the two DLLs, checked by hash ----------------------------------------------------------
$d10 = Join-Path $mainRepo "build\$Dll10\enw_t4.dll"
if (-not (Test-Path $d10)) {
    $src = Join-Path $env:LOCALAPPDATA 'ENWZombies\game\binkw32.dll'
    if ((Sha8 $src) -ne '10ba8544') { throw "the launcher's binkw32.dll is not 10ba8544 ($(Sha8 $src)); put 10ba8544 in $d10 by hand" }
    New-Item -ItemType Directory -Force (Split-Path $d10) | Out-Null
    Copy-Item -LiteralPath $src -Destination $d10
}
$d03 = Join-Path $mainRepo "build\$Dll03\enw_t4.dll"
if ((Sha8 $d10) -ne '10ba8544') { throw "$d10 is $(Sha8 $d10), not 10ba8544" }
if ((Sha8 $d03) -ne '03b04bc3') { throw "$d03 is $(Sha8 $d03), not 03b04bc3" }

# ---- B's renderer dvars (enw-29660.log / enw-5840.log launch lines), minus the window ones ----
# vid_xpos/vid_ypos/r_noborder/r_fullscreen/r_monitor are left to launch.ps1 (invisible window).
$bBase = @('+set','r_mode','2560x1440','+set','r_aspectRatio','auto','+set','r_vsync','0',
           '+set','com_maxfps','250','+set','cg_fov','65','+set','r_texFilterAnisoMin','16',
           '+set','r_texFilterAnisoMax','16','+set','r_picmip','0','+set','r_picmip_bump','0',
           '+set','r_picmip_spec','0','+set','r_multiGpu','1','+set','sm_enable','1',
           '+set','cl_maxpackets','100','+set','snaps','30','+set','rate','25000',
           '+set','r_autopriority','1','+set','cg_drawFPS','Simple','+set','monkeytoy','1')
$fxOn  = @('+set','r_aaSamples','4','+set','r_specular','1','+set','r_glow_allowed','1')
$fxOff = @('+set','r_aaSamples','2','+set','r_specular','0','+set','r_glow_allowed','0')

# ---- the variants: exactly one change against V0 each ------------------------------------------
# dll: which build; fx: on (invisible in B's game) / off (garbled); env: extra env; dv: extra dvars
$V = @(
  @{ id='V0';  dll=$Dll10; fx=$fxOn;  env=@{};                             dv=@();  what='0.2.24 as B plays it (must reproduce "invisible")' }
  @{ id='V0o'; dll=$Dll10; fx=$fxOff; env=@{};                             dv=@();  what='0.2.24, AA2/spec0/glow0 (must reproduce "garbled")' }
  @{ id='V1';  dll=$Dll03; fx=$fxOn;  env=@{};                             dv=@();  what='0.2.20/0.2.21 DLL 03b04bc3' }
  @{ id='C1';  dll=$Dll10; fx=$fxOn;  env=@{ ENW_CONSOLE_TAP='0' };        dv=@();  what='no Com_PrintMessage tap' }
  @{ id='C2';  dll=$Dll10; fx=$fxOn;  env=@{ ENW_RAW_MOUSE='0' };          dv=@();  what='no raw-input pump' }
  @{ id='C3';  dll=$Dll10; fx=$fxOn;  env=@{ ENW_MAIN_MENU='1' };          dv=@();  what='menu/console lockdown off' }
  @{ id='C4';  dll=$Dll10; fx=$fxOn;  env=@{ ENW_OVERLAY_GUARD='0' };      dv=@();  what='no LdrLoadDll detour (overlay_guard off)' }
  @{ id='C5';  dll=$Dll10; fx=$fxOn;  env=@{ ENW_NO_HUFFMAN_GUARD='1' };   dv=@();  what='snapshot decoder not bounded (stock MSG_ReadBitsCompress)' }
  @{ id='C6';  dll=$Dll10; fx=$fxOn;  env=@{ ENW_NET_PROBE='0' };          dv=@();  what='no net probes (client recvfrom IAT, server sendto IAT)' }
  @{ id='C7';  dll=$Dll10; fx=$fxOn;  env=@{ ENW_ESC_MENU='0'; ENW_CHAT_OVERLAY='0' }; dv=@(); what='no Esc menu / chat overlay draw' }
  @{ id='R1';  dll=$Dll10; fx=$fxOn;  env=@{};  dv=@('+set','r_multiGpu','0');     what='r_multiGpu 0 (the launcher baseline pins 1)' }
  @{ id='R2';  dll=$Dll10; fx=$fxOn;  env=@{};  dv=@('+set','r_sse_skinning','0');  what='engine SSE skinning off' }
  @{ id='R3';  dll=$Dll10; fx=$fxOn;  env=@{};  dv=@('+set','r_skinCache','0');     what='skinned-vertex cache off' }
  @{ id='D1';  dll=$Dll10; fx=$fxOn;  env=@{ ENW_DISCORD_HOOK='allow' };   dv=@();  what='Discord hook allowed (Discord must be running and attach; check discord_hook.log)' }
  @{ id='D2';  dll=$Dll10; fx=$fxOn;  env=@{ ENW_DISCORD_HOOK='refuse' };  dv=@();  what='Discord hook refused' }
)
if ($Only) { $want = $Only.Split(',') | ForEach-Object { $_.Trim() }; $V = $V | Where-Object { $want -contains $_.id } }

# Every variant: server paces the 127.0.0.1 client like an internet one (dedi.md §22, rule 18),
# frames at 30..120 s after the client is in the map, invisible windows.
$common = @{
    ENW_NET_FORCE_WAN = '1'
    ENW_TEST_NO_ACTIVATE = '1'
    ENW_BORDERLESS_COVER = '0'
    ENW_FRAME_CAPTURE = '1'
    ENW_FRAME_CAPTURE_AT = '30,40,50,60,70,80,90,100,110,120'
}
$stamp = Get-Date -Format 'MMdd-HHmm'
foreach ($v in $V) {
    $tag = "z1-$stamp-$($v.id)"
    $cap = Join-Path $DevRoot "logs\z1\$tag"
    New-Item -ItemType Directory -Force $cap | Out-Null
    $saved = @{}
    $envs = $common.Clone(); foreach ($k in $v.env.Keys) { $envs[$k] = $v.env[$k] }
    $envs['ENW_FRAME_CAPTURE_DIR'] = $cap
    foreach ($k in $envs.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envs[$k]) }
    Write-Host "=== $tag : $($v.what)" -ForegroundColor Cyan
    try {
        & (Join-Path $repo 'tools\dev\jointest.ps1') -Tag $tag -Map 'nazi_zombie_fear_mc_2' `
            -ServerFrom $v.dll -ClientFrom $v.dll -WatchSeconds $WatchSeconds `
            -ClientExtraArgs ($bBase + $v.fx + $v.dv)
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    "$tag  $($v.what)  dll=$($v.dll)  env=$(($v.env.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')  dvars=$($v.dv -join ' ')" |
        Add-Content -Path (Join-Path $DevRoot 'logs\z1\index.txt')
}
Write-Host "frames: $DevRoot\logs\z1\<tag>\enwshot-*.bmp; logs: $DevRoot\logs\dedi\<tag>.*; index: logs\z1\index.txt"
