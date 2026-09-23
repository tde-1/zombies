# Mod compatibility: a custom map is a mod, and the player gets exactly what the mod ships

> Lane: **client + launcher** (this file), with one line each in `web/server/lib/mapfiles.js` and
> `tools/dev/jointest.ps1`. Started 2026-09-23 01:45 UK from B's report on Minecraft Village
> Remastered (`nazi_zombie_fear_mc_2`, F3ARxReaper666 / NG Caudle): *"the weapon model seems to be
> stretching all across the screen and completely bugged"* — the first-person **Reapers Colt 16|160**
> drawn as huge stretched polygons, HUD and map otherwise fine.
>
> **The rule this file writes down:** always provide what the mod provides. Byte-identical files on
> the player's PC and on the box, every file the mod ships (not a filtered subset), the mod's own
> dvars left to the mod, and nothing of ours overriding what its scripts and menus set.

## 1. The stretched Reapers Colt — what was proved, and what was not

**Not reproduced.** The same map, the same bytes, the same server script path, B's own renderer
settings and resolution, on this PC, with a local dedicated server + client (the d2+c1 recipe,
`jointest.ps1`, off-screen, `ENW_TEST_NO_ACTIVATE=1`), draws the Reapers Colt correctly every time:

![Reapers Colt, local dedi + client, 2560x1440, B's dvars](ui/mod-compat-reapers-colt-local-dedi.jpg)

Run `mcjoinB3` (01:30 UK): `r_mode 2560x1440`, `r_multiGpu 1`, `cg_fov 65`, `com_maxfps 250`,
picmip 0, aniso 16; four shots fired (**12|160**, not 16|160). `mcjoinB4` added the rest of B's
`config.cfg` differences (`r_specular 0`, `r_distortion 0`, `r_glow_allowed 0`, `r_aaSamples 2`,
`r_picmip_manual 0`, `r_texFilterMipMode Unchanged`) — still correct. `mcjoinB5` opened the chat
overlay the way B did at 00:53:55 (`ENW_CHAT_SELFTEST=2`) — still correct
([picture](ui/mod-compat-reapers-colt-overlay-open.jpg)). Frames come from
`client-dll/components/frame_capture_timer.cpp` (new, §8), transcripts in
`ZombiesDev\logs\dedi\mcjoin*.txt`.

**Each suspect the brief named, with its evidence:**

| # | suspect | verdict | evidence |
|---|---|---|---|
| a | client loaded a different `mod.ff` than the server | **ruled out** | SHA-256 of all 10 files on B's PC (`home\localappdata\Activision\CoDWaW\mods\nazi_zombie_fear_mc_2`) = the box (`/home/waw/waw-en/mods/…`) = the archive. Only `mod.arena` differs, by the 3-byte BOM the launcher strips on purpose (`69466dd5…` → `d1551eb7…`). B's command line had `+set fs_game mods/nazi_zombie_fear_mc_2`, the box's `InitGame` says the same |
| b | an add-on IWD beside the map missing on the client | **ruled out** | both mount `trxture_pack.iwd (64 files)` and `fortress.iwd (1503 files)`; the base `main\iw_*.iwd` set mounted by B's client and by the dev client is identical (31 entries, same file counts) |
| c | `_load`/`_patch` fastfile order | **ruled out** | client and server both: `code_post_gfx`, `mod`, `ui`, `localized_common` (absent, stock), `common`, `patch`, `localized_nazi_zombie_fear_mc_2` (absent — the map ships none), `nazi_zombie_fear_mc_2_patch`, `nazi_zombie_fear_mc_2_load`, `nazi_zombie_fear_mc_2` |
| d | a `cg_`/viewmodel dvar the settings sync overwrites | **ruled out for the stretch; a real bug of its own** (§3) | the launcher sets `cg_fov 65`, which is the mod's own value; B's full renderer set does not reproduce it. The sync *does* steal `monkeytoy` from this mod |
| e | the 2 GB ceiling / partial asset loads | **not seen** | dev client working set 1.37–1.39 GB at 2560x1440 through 110 s; no `Hunk`/`out of memory` lines. Virtual size was not measured, and B's game ran longer |

**What is left, untested because tonight forbids it:** the box's own server (Wine, DLL `6fccc0e0`)
and B-only runtime events. B's client log has one tell: from **00:54:10** the frame rate falls
120 → 75 → 39 fps and stays there, at the moment `focus=no` appears (the screenshot being taken);
huge screen-covering triangles at 2560x1440 would cost exactly that. **There is no engine-side
record of B's run**: his client has written **no `console.log` for any launch since 2026-09-22
18:07** (last file: `home\mods\enw\console.log`), despite `+set logfile 2` on every command line
— so no `Could not load xmodel/xanim`, no device-lost line, nothing. **Fixing that is the first
step for the next report**; the dev client with the same DLL source does write one, so it is
something in B's install, not the engine.
*(Correction 2026-09-23 ~04:00: wrong. B's engine writes `home\mods\<bsp>\console.log` on every
launch — the fear_mc_2 one was last written at 03:42:30, the second his game died — but truncates
it on every launch, and a rewritten file keeps its 09-22 creation time, which is what made it look
stale. The DLL now keeps its own copy per process: `logs\console-<pid>.log`, `client.md`
"2026-09-23 ~04:00".)*

**What the box and a local dedi both do on this map, which is the mod's, not ours:**

```
precacheModel must be called before any wait statements in the level script
: (file 'maps/_loadout.gsc', line 200)   PrecacheModel( viewmodel );
  called from (file 'maps/_loadout.gsc', line 378)  set_player_viewmodel( "fear_viewhands_takeo");
  started from (file 'maps/_load.gsc', line 730)    self waittill( "spawned_player" );
model 'char_jap_impinf_officer_body_zomb' not precached: (file 'character/char_zomb_player_2.gsc', line 4)
precacheMenu must be called before any wait statements …  PrecacheMenu( "menu_special_features" );
```

The mod's `give_model()` re-precaches the character's viewhands at spawn. For a listen-server host
that spawns inside level init that is legal; for **any player who joins a dedicated server** it is
after the first `wait`, so the thread dies there. The four `fear_viewhands_*` models were already
precached by `set_player_specific_viewmodel()`, and the local dedi shows the hands drawn anyway —
so this is **not** proven to be the stretch, but it is the one viewmodel code path that differs
between "solo" (what the author tested) and "joined" (what we always are), and it is where a fix
would go if the box reproduces it (§7).

## 2. What a mod may ship — the contract

Everything below is data, and the player gets **all of it**, byte for byte, in
`<ENW>\home\localappdata\Activision\CoDWaW\mods\<bsp>\` (client) and `/home/waw/waw-en/mods/<bsp>/`
(box, symlinked into every instance's homepath and Wine LocalAppData — `launcher.md` 2026-09-22
evening). Nothing that can execute is ever installed on either side.

| what | where in the mod folder | loaded by | notes |
|---|---|---|---|
| `mod.ff` | root | zone loader, at startup with `code_post_gfx` | weapons, xmodels, xanims, menus, materials, sounds, scripts, localized strings |
| `<bsp>.ff`, `<bsp>_patch.ff`, `<bsp>_load.ff` | root | zone loader at map load, patch → load → map | order is the engine's, not ours |
| other `*.ff` (e.g. `gumball.ff`) | root | only if something names it as a map | Minecraft Village ships `gumball.ff`/`gumball_patch.ff`, a leftover map zone nothing loads — shipped anyway |
| `*.iwd` (map iwd + third-party add-ons) | root | FS search path, **every** `.iwd` in the folder | images, sounds, loose scripts, weapon files. An extra `.iwd` on one side only is a mismatch (§4) |
| loose `images/*.iwi` | `images/` | FS | Futurama ships 146 |
| loose `clientscripts/*.csc`, `maps/*.gsc` | subfolders | FS (whether T4 prefers them to the zone's rawfile is **unmeasured**) | Futurama ships 3 `.csc` |
| loose weapon files | `weapons/sp/<name>` (no extension) | possibly nothing with `useFastFile 1` (**unmeasured**) — shipped because the box has them | Arena ships 65 |
| `*_load.bik` | root | the load screen | we refuse load videos on a join anyway (client.md §7), but ship them |
| `mod.arena` | root | map registration | the one file we change: a UTF-8 BOM is stripped (`library.js repair`) and both hashes recorded |
| `missingasset.csv` | root | nothing (the author's build report) | shipped; it is the list of assets the release itself lacks — `Could not load xanim "ai_flamethrower_*"` on every run is that list, not us |
| `*.files` (UGX/NSIS file list) | root | nothing | the only thing not shipped; the engine never opens it |
| **never** | | | `.exe .dll .bat .cmd .ps1 .scr .com .msi .vbs .js` — refused loudly (dev-box rule 3) |

**Scripts and menus a mod ships run on both sides**: GSC on the server, CSC and menus on the client.
Dvars they set are the mod's (§3).

## 3. Dvars: what we write, and what we must leave to the mod

What the launcher puts on the command line and into `config.cfg` every launch
(`gamecfg.js baselineDvars` + `wawcfg.js WAW_DVARS`/`ACCOUNT_DVARS`): `r_fullscreen r_mode
r_displayRefresh r_aspectRatio r_noborder vid_xpos vid_ypos r_monitor r_vsync com_maxfps cg_fov
sensitivity cg_drawFPS m_filter cl_mouseAccel r_texFilterAnisoMin/Max r_picmip r_picmip_bump
r_picmip_spec r_multiGpu sm_enable cl_maxpackets snaps rate r_autopriority snd_volume` plus the
site's WaW-menu items (`r_aaSamples r_gamma r_specular … monkeytoy cg_mature cg_blood … r_dof_enable
r_glow_allowed`) and binds. After the game exits, `applyReadBack` + `readBackAccount` turn any of
those that changed into the player's saved choice.

**The bug, measured on B's account tonight.** Minecraft Village's anti-cheat
(`maps/anticheat_utility.gsc` "by Uk_ViiPeR", and its menus) runs `set monkeytoy 1;set ufo 0;…;set
sv_cheats 0`, `setClientDvars("monkeytoy","1")` every 0.1 s, and `execOnDvarIntValue "monkeytoy" 0
"quit"`. The engine archived `monkeytoy 1` into `config.cfg`; the read-back saw a changed WaW-menu
dvar and saved it as **B's** choice (`state\settings.json` → `waw: { monkeytoy: "1" }`,
`gameUpdatedAt` 23:55:01Z = the moment that game exited). The 00:53 launch has no `monkeytoy` on its
command line; the 00:55 launch ends `+set cg_drawFPS Simple +set monkeytoy 1` — **and so will every
launch after it, on every map**: the console is disabled for B everywhere until he changes it back.

**The fix (launcher, `modcompat.js`):** per map, the dvars the mod sets itself are found by scanning
its fastfiles (inflated) and loose `.cfg/.gsc/.csc/.menu/.txt` for `set[Client|Saved]Dvar[s]("x"`,
menu `"setdvar" "x"`, `exec "set x …;set y …"` and `set/seta x` lines. Those that are also ours are
**mod-owned**, cached in the map's `.enw-installed.json` as `modDvars.owned`, and the read-back after
a game on that map **drops any change to them** (`launch.js readBackSettings`, with a note naming
them). Minecraft Village: 287 dvar names set by the mod, 4 of them ours — `cg_fov`, `monkeytoy`,
`cg_mature`, `cg_blood`. Nothing about wawSettings changes: the account's own value is still written
at launch, the mod still overrides it at runtime exactly as it would in retail, and the player's
real in-game changes to everything else still stick.

**B's account still holds `monkeytoy 1`.** Not auto-repaired (a player can legitimately choose it):
B, set *Console* back in the site's Settings → Game, or delete `waw.monkeytoy` from
`%LOCALAPPDATA%\ENWZombies\state\settings.json`.

**What our DLL writes at runtime** and must keep off mod-owned dvars: `name` (name_pin),
`enw_token`, `enw_ui`, `enw_pchat` (userinfo, ours by name). None of them is a dvar any archived map
sets. The dedi side must never pass `monkeytoy 0`, `sv_cheats 1` or `con_external 1` to this mod:
its `TMChecker` reads the **server's** dvars and calls `ExitLevel(false)`.

## 4. The pre-launch check: "your files are not the server's"

`main.js ensureMapInstalled` → for an installed map, `matchServer(bsp)`:

1. ask the site for the map's file list (`/api/maps/<bsp>/files`: every file, size, SHA-256 — the
   archive's record, which is what the box was staged from and what §5 checks the box against);
2. `modcompat.checkInstalled(dir, list)`: missing file, wrong size, or wrong bytes → named. A file the
   launcher repaired (`mod.arena`) is compared with the hash we wrote. A file whose size and mtime
   equal the last proven check is trusted (first check of a 600 MB map ~1–2 s, then a stat per file);
3. a stray `.ff`/`.iwd` the server does not have is **removed** (the engine mounts every `.iwd` in
   the folder — a client-only asset set);
4. anything that differs is fetched again through the normal verified download
   (`library.installFromSite(bsp, { only })`), with a toast *"Repairing the map: N files did not
   match the server's"*; the Play waits for it.

No site (offline, dev): the check is skipped and the map is used as installed. Tests:
`launcher/test/modcompat.js` (6/6).

## 5. The 78 maps against the box (read-only, 2026-09-23 01:05 UK)

`sha256sum` of every file under `/home/waw/waw-en/mods/*/` (743 files, `nice`/`ionice`, nothing
written on the box) against the archive's `extract.json`, through the site's and the launcher's
filters: `python tools/maps/modcompat_check.py --box box_sha.txt`.

**No file anywhere had different bytes.** 57 maps have files on the box; 21 archive maps are not on
it (including `cxca` and `nazi_zombie_shore`, whose box folders hold only a `console.log` — staged
and emptied, or never filled). The differences were all **files one side never got**:

| map | before the fix | cause | after |
|---|---|---|---|
| `futurama` | box has 145 files the client never gets (143 `images/*.iwi`, 2 `clientscripts/*.csc`); client also never gets 4 more the box lacks | site filter dropped `.iwi`/`.csc` | **still differs: the box copy is missing 4 archive files** — `images/couch_side.iwi`, `images/mtl_green_tile4_tex.iwi`, `images/~weapon_desert_eagle_gold_spc~f7d5bd11.iwi`, `clientscripts/createfx/futurama_fx.csc`. Re-stage the box copy |
| `nazi_zombie_arena` | 65 `weapons/sp/*` loose weapon files box-only | site filter dropped extension-less files | match |
| `nazi_zombie_fivenights` | `stielhandgranate` (loose weapon file) box-only | same | match |
| `bank_job`, `zm_nuked`, `nazi_zombie_zhunterz` | `<bsp>_load.bik` box-only | site filter dropped `.bik` | match |
| `nazi_zombie_arena`, `futurama`, `nazi_zombie_ils`, `nazi_zombie_pd` | `*.files` box-only | installer list | ignored (never read) |
| `nazi_zombie_fear_mc_2` and 51 others | — | — | match |
| `ugxm_garage`, `shinomori` (not on the box) | `.files` / `_load.bik` never installed | same filters | `.bik` now installed |

**The fix**: `mapfiles.js ALLOWED` and `library.js ALLOWED_EXT` now include `.iwi .csc .bik .menu
.str` and extension-less files. Live only after the site restarts on this code, and the bucket needs
`node tools/s3/sync.js --only maps` (its list is `mapfiles.served()`, so it follows automatically).
Players who already installed Futurama/Arena/Five Nights get the missing files from §4's check on
their next Play.

## 6. fs_game, fs_homepath and `+exec`, per side

| | client, box join | client, Play Local | dedicated server (box) | dev harness |
|---|---|---|---|---|
| `fs_homepath` | `%LOCALAPPDATA%\ENWZombies\home` | same | `C:\zdev\homes\inst-NN` | `ZombiesDev\homes\<copy>` |
| `fs_game` | `mods/<bsp>` from the lease (`bootflow.js` `match.fs_game`) | `mods/<bsp>` | `mods/<bsp>` (`assignments.fs_game`) | `mods/<bsp>` (`-FsGame auto`) |
| mod files | `home\localappdata\Activision\CoDWaW\mods\<bsp>` (the DLL redirects LocalAppData there) | same | `waw-en/mods/<bsp>`, symlinked 3x | junctions to `archive\mods\<bsp>` |
| `+exec` | `enw_auth.cfg` (token) | same | — | — |
| `console.log` | `home\mods\<bsp>\console.log` — **written every launch, truncated every launch** (2026-09-23 correction: the "not written since 18:07" of §1 was a wrong read; the file keeps its 09-22 creation time when it is rewritten). Since `console_tap.cpp`: also `%LOCALAPPDATA%\ENWZombies\logs\console-<pid>.log`, always, per process (`client.md` 2026-09-23 ~04:00) | same | `waw-en/mods/<bsp>/console.log` (shared by all instances) | **one file shared by server and client** — `+set logfile 0` on one side to read the other |

## 7. Other incompatibilities this map shows, and what each needs

1. **Join-time precache** (§1). A mod written for a listen host precaches at spawn; on a dedicated
   server every player spawns after init. Retail would log the same error for a late joiner. If the
   box shows the stretch, the candidate fix is server-side: let `PrecacheModel`/`PrecacheMenu` of an
   **already precached** asset succeed after init (it is a lookup, not a load) — a dedi-lane change,
   not attempted tonight.
2. **The briefing menu stays open on a dev client.** Stock `_load.gsc` opens `briefing` "until all
   players have joined"; the off-screen dev client (no activation) keeps `keyCatchers 0x10`, which the
   pause lane reads as `solo_menu` and **freezes the world** (`[enw] pause: FROZEN 95 s (solo_menu)`).
   A real player closes it; a harness must (`ENW_FRAME_CAPTURE_CMDS="7:closemenu briefing"`).
3. **The mod quits on console dvars** (§3). Never hand this mod `monkeytoy 0`, `con_external 1` or
   `sv_cheats 1` on either side.
4. **Missing assets are the release's own**: 59 `Could not load xmodel`, the `ai_*` xanims and 22
   `image … is missing` errors match its `missingasset.csv` and appear identically on box, local dedi
   and client.
5. **A second launch within seconds fails `EXE_ERR_QPORT`** (B's 00:55 retry): the box still holds
   his previous slot. Referee/dedi lane.

## 8. Tools added

* `client-dll/components/frame_capture_timer.cpp` — off unless `ENW_FRAME_CAPTURE_AT="10,25,45"`
  (seconds after `clc.state` first reaches 10); asks `frame_capture.cpp` for a back-buffer `.bmp`
  each time. `ENW_FRAME_CAPTURE_CMDS="7:closemenu briefing|30:+attack|31:-attack"` runs console
  commands on the same clock (Cbuf_AddText 0x594200). No hooks, rides the frame tick.
* `tools/dev/jointest.ps1 -ClientExtraArgs @('+set','r_mode','2560x1440',…)` — client-only dvars,
  after the harness's own. (Named `ClientExtra…`: PowerShell variables are case-insensitive and
  `$clientArgs` already exists.) Also fixed: the mod-folder `console.log` path dropped the slash
  (`modsnazi_…`), so every custom-map run reported *MISSING console.log*.
* `tools/maps/modcompat_check.py` — §5's table, from the box hashes and the code's own filters.
* `launcher/src/main/modcompat.js` + `launcher/test/modcompat.js` — §3 and §4.

## 9. Unproven

* **The cause of B's stretched Colt.** Everything local is ruled out; the box server and B's own
  session are not. Next: find why B's client writes no `console.log`, then have B reproduce once with
  it on; or a box run with a dev client once leases are safe.
* **The pre-launch check against the live site**: tested with fakes and a real map folder, not
  through a signed-in launcher (the site must be on this code to serve the loose files at all).
* **Mod-owned dvars from scripts inside `.iwd`s** are not scanned (zip). No archived map is known to
  need it; a mod that does would keep the old read-back behaviour for those dvars.

## 10. Invisible zombies on fear_mc_2 (B, 2026-09-23 12:49–12:51 UK) — narrowed, not proven

**What B saw** (`tmp/shot-invisible.png`, launcher 0.2.24, DLL `10ba8544` both sides, match
`m_e0690140`, client pid 5840): from the start, zombies are drawn **only as their sun shadows**
(`sm_enable 1` shadow-map shadows, arms-out Minecraft pose). The counter counts them, they down him,
the replay has them at 30 units from him. No model.

**What that picture already rules out.** A shadow-map shadow with the right shape, pose and position
means the client has the entity, a loaded xmodel, a valid animated pose and a position: the server
sent it, with a model, every snapshot. What is missing is only the **lit (main) pass** of those
models. The engine hides an entity from a client either by not sending it or by EF_NODRAW-style
flags, and both remove the shadow too. The map's scripts never hide zombies per player: the only
`SetInvisibleToPlayer` callers in `mod.ff` and `nazi_zombie_fear_mc_2.ff` are the hacker, perks,
box, betty, `ds.gsc` and the teleporter triggers (inflated both zones and searched).

**Evidence, each checked, not assumed:**

| # | suspect | verdict | evidence |
|---|---|---|---|
| a | map files differ client ↔ box | **ruled out** | SHA-256 of `fortress.iwd` (`704132f9…`), `gumball.ff`, `gumball_patch.ff`, `trxture_pack.iwd`, `_patch.ff` equal on B's PC and the box; `mod.ff` / map `.ff` equal already (brief). B's copies are unchanged since 09-22 17:49 |
| b | a NEW asset error on the client | **ruled out** | every `Error/ERROR/WARNING` line of `logs\console-5840.log` against four of last night's fear_mc_2 client consoles (`final-fear-first`, `mcjoinB1/B5`, `net_fear_25000`): nothing new but our own `[enw]` lines and `enw_auth.cfg`. The `bo1_c_viet_zombie_*` / `c_viet_*` xmodel failures are chronic on both sides |
| c | the Settings tab wrote a render dvar at launch | **ruled out** | `enw-5840.log` has one `settings:` line (schema loaded); no `apply`/`WRITE-THROUGH`. The write-through only runs on a change in the menu |
| d | the launch line changed | **only by (h)** | 0.2.24's line equals last night's 03:41 line except `monkeytoy 1` and `snd_menu_master` for `snd_volume` (02:24 also had `cg_fov 120`). The render part (`r_aaSamples 4 r_specular 1 r_glow_allowed 1`, `sm_enable 1`, `r_multiGpu 1`) is identical; the 00:53 line (the last real sighting) carried none of the three, the profile then held 2 / 0 / 0 |
| e | a new client DLL component touching the scene | **nothing found** | every code patch added since `81086d4` (diff of `client-dll/`): Cbuf text (fps_guard, settings, console), the `LdrLoadDll` detour, the `SCR_DrawScreenField` seam (existed in 0.2.20, now bound for every client), `Com_PrintMessage` tap, `recvfrom` IAT. None touches entities, models or the scene |
| f | server DLL writes into AI entities | **nothing found** | the only new gentity write is soak's FL_GODMODE on **player** slots, and only with `ENW_DEV_KNOBS`; the replay of `m_e0690140` records `enw_dev_knobs 0`. `net_probe` writes `sv_maxRate` and (only with `ENW_NET_FORCE_WAN=1`) two call sites in the send path |
| g | Discord's hook | **not the difference** | `discord_hook.log`: Discord attached at +6–7 s and hooked D3D9 in the good 00:53 and 02:24 sessions exactly as at +9.7 s today |
| h | **B's renderer settings** | **the one change that lines up** | see below |
| i | 2 GB address space | **open, secondary** | `overlay_guard`: largest free block 134.3 MB at +5 s, **5.0 MB of 74.1 MB free at +65 s** (the dev harness without Discord had 34.9 MB at +64 s, `client.md` 2026-09-23 revision). 4x MSAA at 2560x1440 and Discord's 50 MB view both eat into it |

**(h) The timeline.** `infra/host-agent/tools/replay-contact.js` (new) on the box's four fear_mc_2
replays:

| match | when (UK) | closest zombie | verdict |
|---|---|---|---|
| `m_8a0a8e75` | 09-23 00:53 | 43 u, 61 samples < 150 u | **B met zombies** — last confirmed sighting |
| `m_ba9c2775` | 02:24 | 1,644 u | never met a zombie (40 s, then Restart) |
| `m_ee07e7e8` | 03:41 | 96 u, 3 samples at +27 s | B was in the Esc menu typing (03:42:27.9) and Discord crashed the game at 03:42:33 |
| `m_e0690140` | 12:49 | 30 u, 92 samples | invisible |

At 01:34 B's config still had `r_aaSamples 2`, `r_specular 0`, `r_glow_allowed 0` (`mcjoinB4`, §1).
At **01:45** the launcher saved "1 in-game change to the account: waw" (`launcher.log`
00:45:08Z, the bloodsport game), and from the 02:24 launch on the command line carries
`r_aaSamples 4`, `r_specular 1`, `r_glow_allowed 1`. So **no fear_mc_2 game where B looked at a
zombie was ever played with those three settings until today**, and "it worked last night" means
00:53 with 2x AA, no specular, no glow. The DLL changes, `sv_maxRate 25000` (box since 03:04) and
the settings all arrived after that sighting; only the settings act on how a model is drawn.

**Not proven** — nobody may start a game on B's PC today, and a box lease has no rendering client.
The lead is (h); which of the three dvars (or the address space, i) is unknown.

**Repro, step 1 — B, in his own game, two minutes, no build:** play fear_mc_2; when a zombie is
invisible, Esc → Settings → Graphics → quality: **specular map off** (live) → look; **glow off**
(live) → look; **anti-aliasing 2x → Apply** (vid_restart) → look. Whichever step brings the zombies
back is the cause (a vid_restart also frees address space, so an AA-only fix is (h) or (i); step 3
below splits them).

**Repro, step 2 — local, when B's PC is free** (game lock, invisible window, private profile, the
d2+c1 recipe `jointest.ps1` exactly as `mcjoinB3/B4`, 2560x1440, `frame_capture_timer` shots at
90–113 s; zombies reach a player standing at spawn by ~36 s on this map): run A = B's old set
(`r_aaSamples 2 r_specular 0 r_glow_allowed 0`) → expect zombies drawn; run B = `4 / 1 / 1` →
expect invisible. If B reproduces, bisect with one dvar per run. If B does NOT reproduce locally
(a dev client has no Discord and a different address-space picture), step 3.

**Step 3 — address space:** run B again with `ENW_DISCORD_HOOK=refuse` on B's machine (or Settings →
ENW → Discord overlay Off) and read the `overlay_guard: address space` lines.

**The fix, by outcome (not written — it would be a guess today):** if one dvar, the Settings
catalogue gets a per-map override in the launcher's mod-compat layer (`launcher/src/main/modcompat.js`)
that pins it for fear_mc_2 and says so on the Settings row, or a global cap if it reproduces on a
stock map; if address space, lower AA automatically on maps whose largest free block after load is
under a threshold (the `overlay_guard` measurement already exists).

### 10.1 Correction (13:25 UK) — (h) is WRONG; the symptom is broken skinning, not a hidden model

B (13:20): he has **always** played with 4x AA, specular and glow on; the 01:34 `2 / 0 / 0` values
were a harness profile's (`mcjoinB4` read the dev client's config, not his). With the three turned
**off** (`m_b00b9202`, client pid 29660, `r_aaSamples 2 r_specular 0 r_glow_allowed 0` on the command
line) the zombies are drawn but **garbled**: a stock SS zombie body with triangles stretched to
spikes (`tmp/shot-garbled.png`). With them on (`m_e0690140` pid 5840, `m_78666e6c` pid 23396) they
are invisible. That is skinned-mesh / bone-matrix / animation state going wrong on the client (or
the pose data it is fed), and the settings only change how the wrong vertices end up on screen.
The replay-contact timeline in §10 still stands (00:53 is the last real sighting), and so does
B's stretched Reapers Colt at 00:53 (§1: "huge screen-covering triangles"), which now reads as the
**same bug on a viewmodel**, already present with client build Sep 22 23:50 (launcher 0.2.13).

Checked since: the set of xmodels that fail to load is identical (59 names) on today's client, the
box server, and last night's local server and client — so the client and server resolve the same
models; no model-mismatch skeleton swap.

### 10.2 What is and is not new (13:40 UK)

* **`r_multiGpu 1` is not new.** The launcher's `COMMUNITY_FIXES` baseline has pinned it since
  `afc6276` (09-22 04:13, PCGW's stutter fix, `launcher/src/main/gamecfg.js`); the site catalogue
  has `def 0`, `enw 1`. Every B launch since 09-22 04:55 carries it (32 launches listed from
  `enw-*.log`), including the 00:53 fear_mc_2 game where zombies were met (`m_8a0a8e75`) — and
  the stretched Colt of that same game. So it can be a *condition* of the bug, not the thing that
  changed. The harness `mcjoinB3` ran it at 2560x1440 on this PC's GPU and drew the Colt correctly.
  It is still variant R1 below, and B's toggle answer decides it.
* **The huffman bounded decode** (`shared/core/components/huffman_guard.cpp`) is unchanged since
  09-22 and was in the 00:53 game; `ENW_NO_HUFFMAN_GUARD=1` is variant C5.
* **Two games today, same symptom set:** `m_78666e6c` (pid 23396, AA 4/spec/glow on) invisible;
  `m_b00b9202` (pid 29660, off) garbled. Both: Discord's hook ALLOWED at +8.2/+8.6 s, largest free
  block **5.0 MB / 7.8 MB at +65 s**; their `Error/WARNING` sets are identical to pid 5840's.
* **Server side:** the replay records only positions, yaw and health for zombies (`replay.cpp`),
  so it cannot show anim or model fields; there is no server-side evidence to build from it. The
  zombie in the garbled shot holds a coherent upper body at the right place, which a corrupt
  origin/angles would not.

### 10.3 The local A/B (ready, not run — B's PC is in use): `tools/dev/z1-ab.ps1`

One `jointest.ps1` d2+c1 game per variant on fear_mc_2, B's renderer dvars (window dvars left to
the harness: invisible, parked, private profile), `ENW_NET_FORCE_WAN=1` (internet pacing),
frames every 10 s from 30 to 120 s into `ZombiesDev\logs\z1\<tag>\`, an index in
`logs\z1\index.txt`. It checks the two DLLs by hash (`build\jrfinal` = `03b04bc3`; `10ba8544` copied
from the launcher's installed `binkw32.dll` into `build\z1-10ba8544`). Variants, one change each
against V0:

| id | change | id | change |
|---|---|---|---|
| V0 | 0.2.24, AA4/spec/glow (expect invisible) | C5 | `ENW_NO_HUFFMAN_GUARD=1` |
| V0o | 0.2.24, AA2/off/off (expect garbled) | C6 | `ENW_NET_PROBE=0` |
| V1 | DLL `03b04bc3` (0.2.20/0.2.21) | C7 | `ENW_ESC_MENU=0 ENW_CHAT_OVERLAY=0` |
| C1 | `ENW_CONSOLE_TAP=0` | R1 | `r_multiGpu 0` |
| C2 | `ENW_RAW_MOUSE=0` | R2 | `r_sse_skinning 0` |
| C3 | `ENW_MAIN_MENU=1` (lockdown off) | R3 | `r_skinCache 0` |
| C4 | `ENW_OVERLAY_GUARD=0` (no LdrLoadDll detour) | D1 / D2 | `ENW_DISCORD_HOOK=allow` / `refuse` |

`powershell -File tools\dev\z1-ab.ps1` runs all (~15 × 3 min); `-Only V0,V0o,V1` first. **V0 must
reproduce before anything else means anything** — the harness never reproduced the 00:53 Colt. If
V0/V0o draw zombies correctly, the difference is B's environment (Discord actually attaching,
address space, the internet path to the box), and D1 plus a real launcher game with Settings →
ENW → Discord overlay **Off** are the tests; the C-variants are then moot.
