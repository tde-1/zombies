<#
  mapmount.ps1 -- make one archived custom map visible to the engine.

  Dot-source it and call Mount-EnwMap.

  WHY THIS FILE EXISTS. `Can't find map "<bsp>". / A mod is required for custom maps`
  killed Zombie Desert (nazi_zombie_test1) and Project Viking (nazi_zombie_test) in
  run map01, and dedi.md 11.4 blamed the `fs_game is write protected.` line printed
  just above it. THAT WAS WRONG, and it is worth writing down why: every map prints
  that line, including the ones that boot. It is the engine re-applying our `+set`
  block after the dvar dump; `fs_homepath`, `sys_configureGHz` and `dedicated` print
  the same complaint in the same block on Der Berg, which boots fine.

  The real check is on disk and it does not use the FS search path at all. From the
  dump (dedi.md 12.6):

      0062B64B  ...  push 0x886374           ; `Can't find map "%s".\nA mod is required...`
      0062B607  push 0 / call 0x48FC10       ; <basepath>\zone\<lang>\<bsp>.ff
      0062B623  push 1 / call 0x48FC10       ; <fs_localAppData>\<fs_game>\<bsp>.ff
      0062B635  push 2 / call 0x48FC10       ; <fs_localAppData>\<fs_game>\usermaps\<bsp>\<bsp>.ff

  0x48FC10 builds the path with 0x48E3D0 and opens it with CreateFileA. Mode 1 reads
  its first component from the dvar at [0x2122AF0], and that dvar is registered at
  0x5DDFD8 as **`fs_localAppData`** -- `%LOCALAPPDATA%\Activision\CoDWaW`. NOT
  `fs_homepath`, which is the one launch.ps1 redirects per game copy.

  So a custom map is only "found" when its fastfile is under
  `%LOCALAPPDATA%\Activision\CoDWaW\mods\<bsp>\<bsp>.ff`. Der Berg, Leviathan, Clinic
  of Evil and MW2 Rust already had an entry there from an earlier session; Zombie
  Desert and Project Viking did not, and that is the whole difference. (`useFastFile`,
  the dvar at [0x1F552FC] tested at 0x62B592, is 1, which is what selects this branch.)

  Mount-EnwMap makes BOTH mounts: the per-home one the search path needs, and the
  fs_localAppData one the existence check needs. Both are directory junctions onto
  `archive\mods\<bsp>`; nothing is copied and the archive's own files are never
  written by this script.
#>

function Mount-EnwMap {
    [CmdletBinding()]
    param(
        # The bsp / mod folder name, e.g. nazi_zombie_test1.
        [Parameter(Mandatory = $true)][string]$Bsp,
        # Game-copy home names that need it on their search path, e.g. @('d2','c1').
        [string[]]$Homes = @(),
        [string]$DevRoot = 'C:\Users\b\ZombiesDev',
        [scriptblock]$Log = { param($m, $c) Write-Host $m -ForegroundColor $(if ($c) { $c } else { 'Gray' }) }
    )

    # ---------------------------------------------------------------------------
    # STAGED INSTALLS (2026-09-23, archive lane)
    # ---------------------------------------------------------------------------
    # `archive\install_map.py --stage <bsp>` builds `archive\mods-staged\<bsp>\` out of
    # HARD LINKS to `archive\mods\<bsp>\`, minus whatever the map's manifest lists under
    # `install.exclude[]` -- third-party add-on iwds a release dropped into the mod
    # folder beside the map's own files. Costs no bytes and never writes to the
    # originals. If a staged folder exists it is what the engine gets, and this says so
    # out loud, because "which install did that run actually boot" is exactly the kind
    # of thing that silently invalidates a result.
    $staged = Join-Path $DevRoot "archive\mods-staged\$Bsp"
    $src = Join-Path $DevRoot "archive\mods\$Bsp"
    if (Test-Path -LiteralPath $staged) {
        $shipped = @(Get-ChildItem -LiteralPath $src -File -ErrorAction SilentlyContinue).Count
        $kept = @(Get-ChildItem -LiteralPath $staged -File).Count
        $src = $staged
        & $Log "mounting the STAGED install $staged ($kept of $shipped shipped files; install.exclude is in effect)" 'Yellow'
    }
    if (-not (Test-Path -LiteralPath $src)) {
        throw "map $Bsp is not in the archive at $src -- run archive\install_map.py first"
    }

    $targets = @()
    foreach ($h in $Homes) { $targets += (Join-Path $DevRoot "homes\$h\mods\$Bsp") }

    # ---------------------------------------------------------------------------
    # WHERE fs_localAppData POINTS, AND WHY THERE IS A SWITCH (2026-09-23)
    # ---------------------------------------------------------------------------
    # B: "our client must never touch the user's own World at War data." The
    # shipping launcher no longer does -- `client-dll/components/enw_localappdata.cpp`
    # patches the engine's SHGetFolderPathA import so LocalAppData resolves to
    # `<ENW home>\localappdata`, and the launcher installs maps there.
    #
    # THIS HARNESS IS NOT SWITCHED OVER BY DEFAULT, and the reason is a fact, not
    # caution: the redirect lives in a client-dll component, and the DLLs sitting in
    # the dev copies (`build\dedi`, `build\vps`) were built before that component
    # existed. Point the mount at a folder the running DLL does not redirect to and
    # EVERY custom-map run fails with `Can't find map` -- while another lane is in
    # the middle of a join-test session. So:
    #
    #   ENW_USE_PRIVATE_LOCALAPPDATA=1   mount into <home>\localappdata\Activision\
    #                                    CoDWaW\mods, which is what the redirected
    #                                    engine opens. Requires a DLL built from
    #                                    2026-09-23 or later in the copy you launch.
    #   unset (default)                  today's behaviour: the box's own
    #                                    %LOCALAPPDATA%\Activision\CoDWaW\mods.
    #
    # Flip it once the dedi/referee copies are rebuilt; the junctions are the only
    # thing that has to change, and `launch.ps1` already exports ENW_LOCALAPPDATA
    # under the same switch.
    # 2026-09-23 01:20 (coordinator): DEFAULT IS NOW PRIVATE, matching launch.ps1. A mount run
    # without the switch put a mods\mw2rust junction into B's real %LOCALAPPDATA%\Activision\CoDWaW
    # (removed). ENW_USE_PRIVATE_LOCALAPPDATA=0 is the opt-OUT for a deliberately stock run.
    if ($env:ENW_USE_PRIVATE_LOCALAPPDATA -ne '0') {
        $home0 = if ($Homes.Count) { $Homes[0] } else { 'shared' }
        $localAppData = Join-Path $DevRoot "homes\$home0\localappdata\Activision\CoDWaW\mods"
        & $Log "fs_localAppData is REDIRECTED to $localAppData (ENW_USE_PRIVATE_LOCALAPPDATA=1); the DLL in this copy must carry enw_localappdata or the map-exists check will fail" 'Cyan'
    }
    else {
        # Hard-coded to the dvar's own default rather than to $env:LOCALAPPDATA so it
        # cannot drift from what the engine computed.
        $localAppData = Join-Path $env:LOCALAPPDATA 'Activision\CoDWaW\mods'
    }
    $targets += (Join-Path $localAppData $Bsp)

    foreach ($dst in $targets) {
        if (Test-Path -LiteralPath $dst) {
            # A junction left over from a previous run may point at the OTHER install
            # (shipped vs staged). Silently keeping it would mean the run boots files
            # the caller did not ask for, and the log would not say so. Repoint it.
            $item = Get-Item -LiteralPath $dst -Force
            $tgt = $item.Target
            if ($tgt -is [array]) { $tgt = $tgt[0] }
            if ($item.LinkType -and $tgt -and ($tgt.TrimEnd('\') -ne $src.TrimEnd('\'))) {
                & $Log "repointing $dst : was -> $tgt" 'Yellow'
                cmd /c rmdir "$dst" | Out-Null
            }
            elseif ($item.LinkType) { continue }
            else { continue }   # a real directory: someone put files there on purpose
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
        cmd /c mklink /J "$dst" "$src" | Out-Null
        if (-not (Test-Path -LiteralPath $dst)) { throw "could not junction $dst -> $src" }
        & $Log "junctioned $dst -> $src" 'Gray'
    }

    # Say it plainly, every run: the fastfile the existence check opens.
    $ff = Join-Path (Join-Path $localAppData $Bsp) "$Bsp.ff"
    if (Test-Path -LiteralPath $ff) {
        & $Log "map-exists check will find $ff" 'Green'
    }
    else {
        & $Log "NO $ff -- the engine will say: Can't find map `"$Bsp`". / A mod is required for custom maps" 'Red'
    }
}
