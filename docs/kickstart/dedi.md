# dedi — Stage C spike: can `CoDWaW.exe` be a headless dedicated zombies server?

Owner: `dedi` agent. Scope: `server/components/dedicated/`, `server/components/net/`, this file.
Everything below was measured on B's PC between 2026-09-20 and 2026-09-22 against a copy of the
Steam build 1.7.1263.
Observation and inference are kept apart, and where I have had to walk a claim back I have said so
rather than quietly editing it.

---

## Verdict up front

**Yes.** The stock World at War **single-player exe already contains a working dedicated mode**, and
with one small DLL it loads and runs a stock zombies map headlessly.

- `+set dedicated 1` boots with no Direct3D, no game window, no front end: a
  `Call of Duty WinConsole` instead, `r_loadForRenderer` already 0, the `ui` fastfile never loaded,
  a UDP socket open, and `--- Common Initialization Complete ---`.
- With our DLL fixing one dvar flag, `+map nazi_zombie_prototype` **loads the map and runs zombies
  GSC** — `Server Initialization`, `sv_running 1`, the 76.85 MB map fastfile, the collision map, then
  script-driven `g_spawnai 1` / `ai_disableSpawn 0` / `dynEnt_spawnedLimit 50`. Log runs to 5,791
  lines and ends clean. **That is milestone (b).**
- Steady state with no players: **~0% CPU ongoing (1.8 s total over 72 s), 186 MB RSS, 8 threads.**

**We are not doing what IW4x and h1-mod did** — building a dedicated server out of a client. Treyarch
left the dedicated path in the SP tree. That is the single most important finding of this spike and
it is the direct answer to `R12 §4c`'s "cheapest decisive experiment": not vestigial, functional.

**Crash sites: 3 cleared, 1 open, 1 retracted** (§4). Predicted total for a complete Stage C:
**12–30, central ~18**. Both the vault's ~110 (from iw4x/h1-mod) and R12's 50–70 (from KisakCOD's
CoD4 SP tree) assume we must author the dedicated branch points. We do not.

**The server now boots, runs frames and reads packets.** Suppressing a spurious
`ERR_MAPLOADERRORSUMMARY` (raised with an empty error list from `SV_SpawnServer+0x3CD`) makes
`Com_Init` return; the frame loop starts and `SV_PacketEvent` / `SV_ConnectionlessPacket` /
`SV_DirectConnect` all fire for the first time.

**The frame loop now runs (2026-09-21).** Two further blockers were cleared after the WinConsole
refusal landed:

- **The server shut itself down because its own local client was refused.** The SP engine connects
  local client 0 after the map comes up; co-op rules refuse a join-in-progress; the resulting
  `ERR_DROP` shuts the server down, drops the process back into *client* init, and it deadlocks in
  the asset-database sync. Fixed by not connecting the local client in dedicated mode (§7b).
  **30,038 frames in 90 s, `SV_Frame` at 20.2 fps, 186 MB flat.**
- The previously recorded diagnosis ("a bounded Sleep(1) pacing loop at 0x59DD90") is **retracted**
  in §7b: that stack is what a *healthy* headless server looks like.

**Next, in order** — *written 2026-09-21; items (1) and (2) are now done, see the update below*:
(1) the `Sys_GetEvent` `GetMessageA` stall (§7c); (2) the loopback join —
`CL_ConnectLocal` 0x641730 and `tools\dev\jointest.ps1`; (3) the 14-map sweep; (4) solo-on-dedicated
co-op rules. The join is cheaper than feared: R14 says T4 SP has no party layer, and CLL's source
confirms no launcher in this scene implements one — Plutonium's `connect ip:port` lives inside
*their* binary, not in stock T4.

**Update 2026-09-22 — milestone (d) is DONE, and the blocker has moved.** A second `CoDWaW.exe`
connects to this headless server and **spawns in**: `Going from CS_CLIENTLOADING to CS_ACTIVE`,
then `referee: ROUND 1 (all_players_connected)`. Reproduced in every join run from `join12` to
`join18` (§7h). §7c's `GetMessageA` stall is fixed; the 14-map sweep and solo-on-dedicated co-op
rules are still owed. **What is open now** is that the server does not survive the spawn: the frame
loop stops about ten seconds later with the CPU pegged — a spin, not a wait — and a second failure
mode raises `exceeded maximum number of script variables` (§7j).

Two corrections that change how you read everything older in this file: **T4 has no `CS_PRIMED`**
(§7h), and **the server was never burning a whole core** — the join harness was passing no
`com_maxfps` (§7j).

**Where the whole project stands is `STATUS.md`.** This file is the dedi lane only.

**One question only B can answer**: whether a game box needs a logged-in Steam client (§8).

---

## 0. Reproduce a headless boot in five minutes

```powershell
# 1. build and deploy the DLL into the dev copy
powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1  -Name dedi
powershell -ExecutionPolicy Bypass -File tools\dev\deploy.ps1 d2 -From dedi

# 2. environment. Without the Steam vars the copy exits(0) in 1.5 s writing nothing;
#    without the suppression the server dies on a spurious map-load error summary.
$env:SteamAppId = "10090"; $env:SteamGameId = "10090"
$env:ENW_DEDI_SUPPRESS_MAPSUMMARY = "1"

# 3. clear the safe-mode marker, or a modal box blocks the launch before any logging
Remove-Item "$env:LOCALAPPDATA\Activision\codwaw\__CoDWaW" -ErrorAction SilentlyContinue

# 4. launch (take ZombiesDev\locks\game.lock first; kill only this PID)
& C:\Users\b\ZombiesDev\waw-d2\CoDWaW.exe `
    +set fs_homepath C:\Users\b\ZombiesDev\homes\dedi `
    +set logfile 2 +set r_fullscreen 0 +set r_mode "800x600" `
    +set s_volume 0 +set snd_volume 0 `
    +set dedicated 1 +set zombiemode 1 `
    +set con_typewriterColorBase "1.0 1.0 1.0" +set hud_drawhud 1 +set ui_campaign american `
    +set sv_maxclients 4 +set net_port 28960 `
    +map nazi_zombie_prototype
```

The `con_typewriterColorBase` / `hud_drawhud` / `ui_campaign` values exist only so our DLL can flag
them `DVAR_SAVED`; the engine has to create them first (§4, site 2).

**What you should see** — in `<fs_homepath>\main\console.log`:

```
Loading fastfile code_post_gfx / localized_common / common / patch     (no 'ui', no D3D)
Opening IP socket: ...
--- Common Initialization Complete ---
------ Server Initialization ------
Server: nazi_zombie_prototype
      dvar set sv_running 1
Loading fastfile 'nazi_zombie_prototype'   used 76.85 MB memory in DB alloc
      dvar set g_spawnai 1                 <- zombiemode GSC running
```

and in the DLL's own `waw-d2\enw-<pid>.log`:

```
dedi_error_trap: ERR_MAPLOADERRORSUMMARY call at 0x0062B7AD short-circuited
dedicated: renderer bring-up 0x005FF4E0 skipped
dedicated: liveness ... frame::count=2  bringup_hits=1
net: ... SV_PacketEvent=1  SV_ConnectionlessPacket=1  SV_DirectConnect=1
```

**And it keeps running.** `dedicated: liveness t=90s frame::count=30038` and
`referee: 2000 frames in 99016 ms (20.2 fps)` — Com_Frame free-runs at 200–500 Hz and `SV_Frame`
ticks at exactly `sv_fps`. Reproduce the whole thing with
`tools\dev\dediprobe.ps1 -Tag rNN -Seconds 90 -WhereIs`, which sets the environment above, takes
and releases `game.lock`, samples CPU/RSS/threads and collects both logs.

**Custom maps**: the mod must be installed in WaW's own mod root,
`%LOCALAPPDATA%\Activision\CoDWaW\mods\<bsp>\`, and nowhere else — then add
`+set fs_game mods/<bsp>` and use `+map <bsp>`. See §6b; getting the location wrong fails silently.

Diagnostic switches, all environment variables, all off by default:

| Variable | Effect |
|---|---|
| `ENW_DEDI_WHEREIS=1` | every 4 s, suspend the main thread, log EIP as `module!export+off` and a **validated** return-address chain |
| `ENW_DEDI_PROBE=<hex,hex,…>` | count entries into up to 12 functions, with first-seen ordinals |
| `ENW_DEDI_SAVED_MASK=<hex>` | override the dvar flag bits our DLL sets |
| `ENW_DEDI_NOWINDOWS_FORCE=1` | re-enable the two window-suppression attempts that **failed** — don't, without new evidence |

`scratchpad/oob.py <port>` pokes a running server with `getstatus` / `getinfo` / `getchallenge` on
localhost and distinguishes "no reply" from "port unreachable".

---

## 1. What the engine already does for us

| Spec item (vault `99 §5.2`) | Reality |
|---|---|
| "a headless CoDWaW.exe" | yes — a `Call of Duty WinConsole`; the `CoD-WaW` window is created but never shown |
| "strip the render init" | already skipped: `Getting Direct3D 9 interface...` never appears in dedicated mode |
| `r_loadForRenderer 0` | already 0 |
| front end | `ui` fastfile is **not loaded** (client mode loads it) |
| "strip the sound init" | no sound-driver init during dedicated boot, **but** sound *assets* still load (`Waited 33 msec for asset 'weap_pickup' of type 'sound'`), so R12's warning about iw7-mod needing a sound-length table does not bite us |
| render-thread sync stubs | no render thread starts, so h1-mod's whole "sync lock/unlock" family looks moot |
| `sv_fps 20`, 4 slots | already the SP defaults |
| networking | `Winsock Initialized`, `Opening IP socket`; the real bind is **`0.0.0.0:<net_port>`** and `+set net_port 28970` works |
| "strip local client 0" | **untested** — no client has connected yet |
| "sleep-based frame pacing" | **unmeasured** — see §4 site 3 |
| "a party/lobby replacement" | the lobby layer exists and runs on shutdown (`Party_StopParty`, `party_host`, `xblive_hostingprivateparty`) and binds **UDP 3074 with no dvar to change it** (it falls forward up to 100 ports when that is taken, and `ENW_LOBBY_PORT` moves it: §19). Per R14 there is **no party system in T4 SP**, so joining is plain `connect <ip>:<port>` |

---

## 2. Method

Harness `dediprobe.ps1` (mine, scratchpad, not in the repo): waits for `game.lock`, takes it, wipes
`fs_homepath`, clears the safe-mode marker, optionally lays an overlay tree, launches the exe,
samples CPU / RSS / thread count / **every window** / **every UDP endpoint** / **per-thread CPU and
wait reason** once a second, auto-answers modal dialogs with IDNO, can post `WM_NULL` to wake a
parked message loop, can fire UDP connectionless probes (`oob.py`, localhost only), kills **by PID**,
releases the lock and copies `console.log` out. `dp2.ps1` waits for every `CoDWaW` to exit, deploys
the DLL and then probes.

Game copies: `waw-dedi` (original), then **`waw-d2`** and **`waw-c1`** built on a repaired data set
(§9.1). `CoDWaWmp.exe` deleted from all of mine. **The Steam install was never written to**, and B's
game profile was never modified.

Logs: `C:\Users\b\ZombiesDev\logs\dedi\<probe>.txt`, `<probe>.console.log`, and the DLL's own
`enw-<pid>.log` in the game copy.

---

## 3. Probe log

| # | What | Result |
|---|---|---|
| p01 | stock exe, no Steam environment | **exits(0) at 1.5 s, writes nothing** |
| p02 | + `SteamAppId`/`SteamGameId` env and `steam_appid.txt` | boots; "Set Optimal Settings?" dialog; first console.log |
| p03 | + `+exec` script | blocked by **"Run In Safe Mode?"**; found the marker file |
| p04 | client mode, dialogs auto-answered | reaches D3D, then hangs — later explained by the corrupt copy (§9.1) |
| p05 | **`+set dedicated 1`** | WinConsole, no D3D, `Com_Init` completes, full dvar dump |
| p06 | + `+map nazi_zombie_prototype` | **map loads**, then a GSC error |
| p07 | + `+set con_typewriterColorBase …` | dvar created but GSC rejects it: needs the SAVED flag |
| p08 | + `seta` in a cfg | same rejection |
| p09 | patched `maps/_load.gsc` in `<homepath>\main\maps` | **ignored**; the fastfile rawfile wins |
| p10 | same file under `fs_game mods/enwdedi` | **used** — GSC error gone; next error is `BG_LoadWeaponDef` (later retracted, §4) |
| p11 | same, against B's real `nazi_zombie_ali` mod | **custom map + `mod.ff` load fine headlessly**; same `BG_LoadWeaponDef` |
| p12 | + `+set net_port 28970` | binds **`0.0.0.0:28970`** and also **`0.0.0.0:3074`** |
| p13 | + 47 loose `weapons/sp/*` in the mod dir | the file warning goes away, the error stays |
| p14 | our DLL as the `binkw32.dll` proxy | **the loader works in a headless process** |
| p15 | dvar work moved to `post_init` | live read of the engine; `com_dedicated` confirmed |
| p16 | dump six dvar_s | **dvar_s layout derived** |
| p17 | set flag bit 0 | write verified by read-back; GSC still refuses → bit 0 is the archive bit |
| p18–19 | derive SAVED from gamer-profile dvars | they are never registered in dedicated mode; derivation impossible |
| p20–21 | force all candidate bits (`0xBDAE`) | **crash site 2 cleared; the map loads and zombies GSC runs** |
| p22 | UDP `getstatus`/`getinfo`/`getchallenge` | **NO REPLY** |
| p23 | `re`'s `DVAR_SAVED = 0x200` alone | **does not work on our build**; the GSC error returns |
| p24 | `0xBDAE` + renderer skip + Com_Frame counter | clean boot, but Com_Frame never fires |
| p25 | + `sp_minplayers 1` | no change |
| p26 | repaired game data + in-DLL liveness thread | `Com_Frame=0`, pumps frozen, per-thread CPU frozen |
| p27 | + `WM_NULL` posted to every window each second | no change — not a blocking `GetMessage` |
| p28 | `dedicated 1`, **no map at all** | `Com_Frame=0` here too |
| p29 | `SV_Frame` + 4 packet-handler counters | **`4 of 4 packet handlers hooked`, all read 0** — packets never reach the engine. My SV_Frame hook lost to `referee`'s (`already created`), so its 0 was meaningless |
| p30 | renderer stub returns 0 instead of 1 | no change; switched to foundation's `enw::frame::subscribe` (installed=yes, count=0) |
| p31 | dump WinMain around the loop | `SetFocus` and `Sleep` are the only things between the stub and the loop top |
| p32 | **`DVAR_SAVED = 0x1000`** from `re` | **works**: `flags 0x4000 -> 0x5000`, zero GSC errors in 5,827 lines. Also `bringup_stub_hits=0` |
| p33 | scan WinMain for call sites | `Com_Init` is called at **0x5FF77E**, two calls before the stub |
| p34 | counter on `0x5FF794 -> 0x594200` too | **both 0 → `Com_Init` never returns**. Site 3 located |

### The turning points, with evidence

**p05 — dedicated mode is real.**
```
[ 2.1s] class='Call of Duty WinConsole' title='Call of Duty® Console'
Loading fastfile code_post_gfx / localized_common / common / patch      (no 'ui')
Opening IP socket: localhost:28960
      dvar set dedicated dedicated LAN server
--- Common Initialization Complete ---
```
Dvar dump: `dedicated "dedicated LAN server"`, `r_loadForRenderer "0"`, `sv_fps "20"`,
`com_maxfps "85"`, `sv_maxclients "4"`, `sv_cheats "0"`, `net_port "28960"`, `zombiemode "0"`.

**p06 — the map loads, one GSC line kills it.**
```
------ Server Initialization ------ / Server: nazi_zombie_prototype
      dvar set sv_running 1
Loading fastfile 'nazi_zombie_prototype'   used 76.85 MB memory in DB alloc
Waited 184 msec for asset 'maps/nazi_zombie_prototype.d3dbsp' of type 'col_map_mp'.
...
SetSavedDvar(): The dvar "con_typewriterColorBase" does not exist.
  (file 'maps/_load.gsc', line 3767) <- :324 SetObjectiveTextColors()
  <- _zombiemode_prototype.gsc:35 <- nazi_zombie_prototype.gsc:17
```
`con_typewriterColorBase` is registered only in client CG-init (`re`: 0x4708C0), which never runs
headless.

**p09 / p10 — how to override stock GSC.** A loose `maps/_load.gsc` in `<fs_homepath>\main\maps` is
**ignored** even though that directory is first on the search path — the `.ff` rawfile wins. The same
file under `<fs_homepath>\mods\<name>\maps\` with `+set fs_game mods/<name>` **is used**. So loose
script override requires an active `fs_game` mod. Useful to `referee`, and it means our scripts never
touch a stock install.

**p16 — dvar_s, derived live.** Six dvars whose properties we already knew from the engine's own
console output were dumped and compared:
```
+0x00  const char* name          (the slot that points back at the name)
+0x04  const char* description
+0x08  uint16 flags | uint16 type
+0x10  current value  (int / float / char* / vec)
+0x20  latched value
```
```
com_maxfps               0x0005'0001  int,    in config.cfg     value +0x10 = 0x55 (85)
logfile                  0x0005'0000  int,    never archived    value +0x10 = 2
dedicated                0x0006'0060  enum,   "read only"       value +0x10 = 1
fs_homepath              0x0007'0210  string, "write protected" value +0x10 = char*
con_typewriterColorBase  0x0007'4000  string, made by +set      value +0x10 = char*
```
Types: int `0x0005`, enum `0x0006`, string `0x0007`. `0x0001` is the config.cfg archive bit,
`0x0040` ROM, `0x4000` external (command-line-created).

**p21 — the map runs.** With the flags forced, no `SetSavedDvar` error, no script runtime error, no
server shutdown, no D3D, no `snddriverglobals`. `------ Server Initialization ------`, the collision
map, then zombies GSC setting `g_spawnai 1`, `ai_disableSpawn 0`, `dynEnt_spawnedLimit 50`,
`g_useholdspawndelay 1`. **72 s at 1.81 s total CPU and 185.9 MB.**

---

## 4. Crash-site table (spike E5)

| # | Where | What it is | Status |
|---|---|---|---|
| 1 | `WinMain` 0x5FF799 → 0x5FF4E0 | the renderer/D3D bring-up is called before the frame loop and is **not** gated by `com_dedicated`; in a headless process it drags a D3D device in | **CLEARED.** `re` found it; our DLL retargets that one call (verified `E8 42 FD FF FF` → 0x5FF4E0, no argument pushes before it, so a naked no-arg stub is safe), and refuses to patch if the target is not what we expect |
| 2 | `maps/_load.gsc:3767` via `:324` | stock GSC calls `SetSavedDvar` on `con_typewriterColorBase`, a client-only dvar. `+set` creates it but without the SAVED flag; `seta` does not help | **CLEARED, but crudely.** Our DLL ORs flag bits into the existing `dvar_s`. See the honesty note below |
| 3 | `ERR_MAPLOADERRORSUMMARY` raised from `SV_SpawnServer+0x3CD` (call at `0x62B7AD`) | The dedicated path tripped the map-load error summary **with an empty accumulated list**, and `Com_Error(7, "")` tail-called `Sys_Error`, which parked the main thread in `win32u!NtUserGetMessage` for ever inside `Com_Init`. Found by suspending the thread and reading its context; confirmed by trapping `Com_Error` | **CLEARED.** Our DLL retargets that one call to a stub that logs and returns. `Com_Init` now returns, the frame loop starts, and the server dispatches packets (`SV_PacketEvent`/`SV_ConnectionlessPacket`/`SV_DirectConnect` all fired) |
| 5 | console text output; repeated validated caller **`0x5B0830`**, plus `0x60594E` in the WinConsole region | after ~2 frames the main thread sits in GDI. A validated stack walk (accepting an address only if a `call` precedes it) shows the EIP **moving between `win32u!NtUserExtTextOutW` and `win32u!NtUserScrollDC`**, so it is **grinding, not deadlocked** — consistent with the console edit control being hammered: each appended line is a synchronous `SendMessage` → wndproc → paint + scroll, quadratic in the text. `0x49414E`, which I reported earlier, is **not** a return address and was a false positive | **OPEN. Two fixes tried, both failed — see below. The address that would unlock it is `0x5B0830`** |
| — | UDP 3074 | the party socket is bound with no dvar to move it | not a crash. ~~blocks several instances per box~~ — **wrong, corrected 2026-09-22**: two headless instances ran at once, A on 3074 and B on **3075**, so the engine falls back rather than failing to bind. `host.md` §10.5; §9.2 item 4 below |

### How site 2 was settled, and what it cost

**`DVAR_SAVED = 0x1000`**, read out of the gate inside the `SetSavedDvar` builtin at 0x516B15
(`test word ptr [dvar+8], 0x1000`). Applied, verified end to end in p32: `con_typewriterColorBase`
goes `flags 0x4000 -> 0x5000`, the console log has zero `SetSavedDvar` errors across 5,827 lines, and
the map loads and runs GSC.

Three wrong answers preceded it and each is worth remembering:

- **My bit-0 guess** (p17). Written and read back; GSC still refused. Bit 0 is the config.cfg archive
  bit, which I had inferred correctly but mislabelled as what GSC tests.
- **T4SP's flag enum**, which calls 0x200 SAVED and 0x1000 CHANGEABLE_RESET. Wrong for this build.
  T4SP has been reliable on struct sizes and wrong on this enum, so treat its constants as
  hypotheses to check against an instruction.
- **My own working mask `0xBDAE`** (p20/p21), which only worked because it happens to contain
  0x1000. It also set about ten other bits, at least one cheat-ish — not something to ship on a
  server that certifies records. Dropped.

The three other flag names in our source (`0x0001` archive, `0x0040` ROM, `0x4000` external) are
**[inferred] from behaviour**, not read from instructions, and are labelled that way in the code.

### Two failed fixes for site 5, kept because the negatives are worth having

Neither is enabled; `headless_windows.cpp` refuses to run without `ENW_DEDI_NOWINDOWS_FORCE`.

- **Suppressing `0x605500` ("WinConsole create") and `0x603D70` ("splash"): no change at all.**
  `0x605500` has exactly one caller, at `0x605804`, so it is a helper *inside* the append path rather
  than the window creator — the wrong target.
- **Suppressing the appends `0x6057F0` (2 call sites) and `0x605870` (3): strictly worse.**
  `Com_Init` stopped returning at all (`bringup_hits` back to 0), no frames, and the UDP socket was
  never bound — the OOB probe got ICMP port-unreachable rather than a timeout. Either those functions
  do more than append text, or my plain-`ret` stub is wrong for their calling convention and I
  corrupted the stack. I patched five sites on a convention I had not verified, which is the mistake
  to learn from: the `add esp` check I wrote is evidence, not proof, and I should have required it.

### Honesty note on the "parked main thread" (superseded, kept for the record)

I claimed on the board that the headless main thread parks. That was an over-claim and I corrected it:

- `pumps` frozen is not proof — foundation's pump is driven by a `Dvar_FindVar` detour and the engine
  caches dvar pointers after init, so it can legitimately stop calling it.
- Per-thread CPU "constant to the millisecond" is not proof either — thread CPU resolution is
  ~15.6 ms and an idle 20 Hz server with no players may burn less than that per window.
- The `Com_Frame` counter reads zero, but p28 shows it reads zero **with no map loaded at all**, when
  WinMain's loop must be turning. With `referee` reporting that the tick which actually fires is
  **`SV_Frame` 0x635CC0**, the simplest reading is that 0x59E330 is not the per-frame function on the
  path I assumed. The DLL now counts both.

What survives is narrower and is site 3: **the server does not answer on the wire.**

---

## 5. The DLL

`server/components/dedicated/{dedicated.hpp,dedicated.cpp}`, built into `enw_t4.dll` and deployed as
the `binkw32.dll` proxy. In a headless boot:

```
enw_t4 build ...   components registered: 9
dedicated: command line asks for dedicated 1
steamstub: .bind present (SteamStub); decrypted after 109 ms (57 polls)
game: Com_Printf @ 0059A2C0 LOOKS OK   game: Dvar_FindVar @ 005EDE30 LOOKS OK
dedicated: Dvar_FindVar("dedicated")=021B1628  com_dedicated=021B1628  (agree)
dedicated: WinMain@0x005FF799 bytes around the renderer call: 00 33 C9 E8 67 4A F9 FF  E8 42 FD FF FF  8B 0D ...
dedicated: renderer bring-up 0x005FF4E0 skipped (call at 0x005FF799 retargeted)
dedicated: 'con_typewriterColorBase' flags 0x4000 -> 0xFDAE (type 0x0007)
enw_t4: ready
```

What it does, all guarded so a wrong address logs instead of jumping into the middle of a function:
detects dedicated mode from the command line at `post_load` (safe before SteamStub decrypts);
at `post_init` verifies `Dvar_FindVar` and cross-checks `com_dedicated`; dumps `dvar_s` for named
dvars; skips the renderer bring-up; hooks `Com_Frame` **and** `SV_Frame` and reports both rates; runs
a liveness thread; and sets the SAVED flag on the dvars stock GSC needs.

Three things it cost me that are worth knowing:

1. **`post_unpack` is too early to touch dvars.** There `Dvar_FindVar("dedicated")` returns
   `00000000` — `Com_Init` has not registered anything. `post_init` is the first phase that works.
2. **The DLL log file is opened without sharing**, so you cannot read it while the game is alive.
3. `re`'s `com_dedicated = 0x212B2F4` is **confirmed live** — that pointer and
   `Dvar_FindVar("dedicated")` return the same `dvar_s*`.

`server/components/net/net.cpp` attacks site 3 directly. It counts entries into the engine's own
packet handlers — `SV_PacketEvent` 0x635540, `SV_ConnectionlessPacket` 0x634E90, `SVC_GetChallenge`
0x62DB60, `SV_DirectConnect` 0x62E3A0 — while `oob.py` fires `getstatus`/`getinfo`/`getchallenge` at
127.0.0.1. That splits the problem cleanly: counters moving means packets reach the engine and the
*reply* is the bug; counters at zero means the engine never reads the socket.

Those detours are **naked and signature-agnostic** on purpose: `pushfd`/`pushad`, call a
no-argument counter, `popad`/`popfd`, then tail-jump to MinHook's trampoline. We do not know these
functions' calling conventions — `SV_ConnectionlessPacket` almost certainly takes a 24-byte
`netadr_s` by value — and a wrong C signature would corrupt the stack. The pattern is correct for
cdecl, stdcall, thiscall and by-value structs alike, and is worth reusing anywhere we want to observe
a function before we understand it.

The client-side direct-connect work (iw4x-sp's `connect_coop` pattern, 22 byte patches) waits until
site 3 is cleared; a connect attempt before then only produces a timeout that teaches us nothing.

---

## 6. Prior art, counted

Repos in `C:\Users\b\ZombiesDev\thirdparty\`: `iw4x-client`, `iw4x-sp` (from `git.alterware.dev` — the
GitHub mirror 404s), `h1-mod`, `CoD4x_Server`, `CoD2rev_Server`, `T4SP-Server-Plugin`.

| Project | Base | SP/MP | Sites in the dedicated module | Elsewhere | Total |
|---|---|---|---|---|---|
| iw4x-client | `iw4mp.exe` | MP | **40** (39 patches + 1 dvar) | 16 | **56** |
| h1-mod | `h1_mp64_ship.exe` | MP | **67** (63 + 4 dvars) | ~12, plus ~23 components skipped | **79** |
| iw4x-sp `connect_coop` | `iw4sp.exe` | SP | 22 byte patches — and it is **not a server** | ~39 | ~61 |
| CoD4x_Server `null_client.cpp` | source rebuild | — | 70 no-op definitions (42 renderer/D3D, 10 sound, 7 CG) | — | leaf-level worst case |

Per subsystem: renderer 6 (iw4x) / 27 (h1-mod); render-thread sync 1 / 5; sound 4 / 8; front-end 3 / 5;
lobby 5 / 3; client-0 2 / 2; frame pacing 3 / 1; console I/O 4 / 1; misc 12 / 15; input 0 / 0 (both
skip the component rather than patch); cinematics 0 / 0.

Mechanisms worth copying: h1-mod replaces `R_SyncGpu` with a stub that sleeps
`com_frameTime - Sys_Milliseconds()`; iw4x replaces `Com_ClampMsec` and uses a hybrid sleep+spin with
`timeBeginPeriod(1)` (*"Select/Sleep resolution is often too coarse (>1ms) … we sleep for the bulk of
the time but spin for the final 2ms"*); CoD4x just empties `R_SyncRenderThread`. For client 0 there is
one verbatim precedent, h1-mod's `nop(…, 4); // allow first slot to be occupied`, plus both projects
killing `CL_CheckForResend`.

**Why the estimate is ~18 and not 110 or 50–70.** Both larger numbers assume the dedicated branch
points must be authored and the renderer/sound/UI init nopped. On T4 SP the engine already skips D3D,
the window, the render thread, the `ui` fastfile and the client console, and `r_loadForRenderer`,
`sv_fps` and `sv_maxclients` are already right. What remains: the wire problem (site 3), lobby/party
(~3–5 including the hardcoded 3074), client 0 (~2–3), frame pacing (~1–3), config (~2–3), and the
category the probes actually found and no prior art measures — **client-only dvars and client-only
state that stock GSC touches** (≥1, plausibly 5–10 across stock and custom maps).

---

## 6b. Custom maps on the server (feature 6)

**They load headless, and the install location is the whole trick.** `water` (Alcatraz) boots in
dedicated mode with `mod.ff` and the map fastfile loading, no errors, peak RSS **377 MB**.

But only when the mod lives in **WaW's own mod root, `%LOCALAPPDATA%\Activision\CoDWaW\mods\<bsp>`**:

| Location | Result |
|---|---|
| `<fs_homepath>\mods\<bsp>` | **fails silently** |
| `<game copy>\mods\<bsp>` | **fails silently** |
| `%LOCALAPPDATA%\Activision\CoDWaW\mods\<bsp>` | **works** |

The failure mode is nasty: the mod's `.iwd` files mount and show up in the printed search path, so it
looks installed, but `Loading fastfile 'mod'` never appears and `+map` never runs — the process falls
through to client init and dies on the `snddriverglobals` singleton. `mod.ff` is a *zone*, not a
filesystem asset, so putting the directory on the search path with `fs_game` is not enough; the zone
loader only looks in the mod root. **That is where the launcher must install maps.**

Method for the sweep, so it is reproducible and safe: each map gets a throwaway directory in the mod
root filled with **hardlinks** to `ZombiesDevrchive\mods\<bsp>\`, which is deleted afterwards.
No writes to the archive, and the game's `console.log` lands in the throwaway. Any map whose name
already exists in the mod root is skipped, so B's installed `nazi_zombie_ali` is never touched.
Harness: `mapboot.ps1`; summaries in `ZombiesDev\logs\dedi\maps\`.

Classification: `Server: <bsp>` + `Loading fastfile '<bsp>'` + a GSC-driven dvar set, with no script
error and no asset-limit error, is a pass. **Caveat found in the first good run**: `g_spawnai` is a
stock-map marker and custom maps do not necessarily set it, so "LOADS (no gsc marker)" is not a
failure — the per-map GSC evidence needs a better signal before these become manifest `health`
values.

---

## 7. Milestone (d): a client connecting

**Not attempted.** The harness is written, both halves build and run, and it is one green server
away from being a real test.

`scratchpad/jointest.ps1` takes the lock once, deploys both halves, launches the headless server,
**polls the OOB port until the server actually answers `getstatus`**, then launches the client with
`+connect 127.0.0.1:28960` and watches both, killing only the two PIDs it started. It needs exactly
two things to become valid:

1. `foundation`'s WinConsole refusal, so the server survives past ~2 frames and can answer at all;
2. `foundation`'s answer on how the client is told to connect — is `+connect` on the command line
   wired to `direct_connect`, or does it need a console command after the menu loads?

Run it as `powershell -File jointest.ps1 -Tag join2 -ClientFrom dedi-client`. **Not core-only**:
`-CoreOnly` drops `direct_connect` and the `getAuthTicket` short-circuit, and `127.0.0.1` is not the
engine's loopback, so that patch is required. `build\dedi-client` is configured with
`-DENW_WITH_CLIENT_COMPONENTS=ON -DENW_WITH_SERVER_COMPONENTS=OFF`, which also keeps `referee`'s
hooks out so their ~70 s crash cannot be mistaken for a networking failure.

**Run `join1` was invalid and should be ignored** — my readiness gate matched `REPLY` inside
`NO REPLY`, so it launched a client against a stalled server. Fixed. What it did show: the client
half loads cleanly (11 components, 498 MB, alive 75 s, no unhandled exception) but gave **no sign of
attempting a connection**, which is why (2) above matters.

What else is known:

- **R14**: there is no party system in T4 single-player. Joining is plain `connect <ip>:<port>` over
  UDP — no lobby negotiation, no Demonware handshake. Plutonium's friends list is a launcher overlay.
  `sp_minplayers N` holds the game until N clients connect; `xpartygo` force-starts; `map_restart`
  re-runs the gate. **Leave `sv_maxclients` at 4** — below 4 hard-locks `wait_network_frame`.
- **Blocked by site 3**: the server answers nothing on 127.0.0.1 yet, so there is nothing to connect
  to. Fix that first; a client attempt before then only produces a timeout that tells us nothing.
- The rendered client also needs the repaired data (§9.1); on the corrupt copy it froze at
  `ERROR: image 'images/sun_flare.iwi' is missing` (p04). `waw-c1` exists for this.
- **When it does connect, test the solo case explicitly.** On a dedicated server the game runs co-op
  rules even with one player (Quick Revive, prices, revives). For a speedrun platform that is the
  difference between a valid and an invalid solo run, and it may force a design decision about how we
  host solo Verified runs.
- Plutonium's seven-year trap list to check before blaming ourselves: wrong water height on dedis,
  static physics objects, a savefile crash when the first player is dead, the last-player-leaves bug
  (kills sound, doors, scripts), `party_maxplayers` at a non-default value timing everyone out on map
  change, custom maps needing bespoke dedicated spawn logic, snapshot corruption, duplicate `qport`s,
  GSC animation desync unless client and server load scripts in the same order, and the string-table
  asset pool needing a bump to 80.

---

## 7b. SOLVED — the server stops because its own local client is dropped

**Status: fixed 2026-09-21.** `server/components/dedicated/local_client.cpp`.

### What the previous session recorded, and why it was wrong

> "The headless server boots, loads the map, runs zombiemode GSC, runs **4-5 frames, and then
> stops**. The main thread sits in `ntdll!NtDelayExecution` (Sleep) with a validated return chain
> of `0x59DDDE -> 0x48DE8C -> 0x59E4DC -> 0x5FF7C2`. … the real behaviour is something outside
> [the bounded sleep loop] re-entering it endlessly."

**Retracted.** Two things were wrong with it:

1. **That stack is a HEALTHY sample, not a stalled one.** `0x59DDDE <- 0x59E4DC <- 0x5FF7C2` is
   the normal 1 ms pacing sleep inside `Com_Frame`. A working headless server lands there
   constantly — it is now the most common sample in a *good* run. Sampling a sleeping thread and
   calling it "stuck" is the trap; `0x48DE8C` in that chain is stale stack data (it validates as
   call-preceded but belongs to `0x48DE40`, a sibling call Com_Frame makes *earlier* in the same
   frame, whose slot the pacing function reuses as a local).
2. **The outer loop cannot stall.** WinMain's loop `0x5FF7B1..0x5FF80B` is unconditional, every
   wait in it is bounded, and `Com_Frame`'s body (`0x59E4CD..0x59E4DC`) is three calls. Read
   statically, there is nowhere in that path for an endless re-entry to live. That should have
   redirected the search, and it does now.

### What the main thread is actually doing when it stops

`ENW_DEDI_WHEREIS=1`, run `r02`, **19 consecutive identical samples over 76 s**:

```
EIP = ntdll!NtWaitForSingleObject+0xC   ESP = 000EEDC4   (byte-identical every sample)
validated return addresses: 005A3363  0059A764  0053002B  007B7353 …
```

`NtWaitForSingleObject` with a **stable ESP** is a real wait, not a sleep and not a grind.

- **`0x5A3320` is the asset-database sync.** It prints `"Database: Assets Sync Started"`
  (0x873A4C), then `edi = 0x70E3A0(); do { 0x5FDBF0(); } while (WaitForSingleObject([0x1FF51C4],
  500) != WAIT_OBJECT_0);`, then prints `"Database: Assets Sync Finished"` (0x873A6C). **0x5A3363
  is the return address inside that do/while** — it waits for ever if the event is never
  signalled. *That* is the outer loop the previous session went looking for. [V]
- **`0x59A6F0` is the error/shutdown path.** `Com_Frame` enters it at `0x59E505` when
  `[0x1F964B4] != 0`, and it calls `0x5A3320` at `0x59A75F`. [V]

### Why we were on the error path at all — the actual bug

From `r02.console.log`, in order:

```
Client connect ignored because join in progress isn't allowed in COOP
[enw] === Com_Error TRAPPED ===  called from 00643D55
        arg1 = 00000001 (ERR_DROP)   arg2 = "%s"   arg3 = "EXE_ERR_CANNOTJOININPROGRESS"
ERROR: Can not join a game in progress
----- Server Shutdown -----          dvar set sv_running 0
Creating Direct3D device...          Loading fastfile ui
Error: Exceeded limit of 1 'snddriverglobals' assets.
Database: Assets Sync Started        <- and never "Finished"
```

**The SP engine connects its own local client after the map comes up, and co-op rules refuse a
join-in-progress.** The chain is:

`SV_SpawnServer` finishes → map-load path `0x631F20` calls `CL_ConnectLocal` `0x641730` at
**`0x6321A2`** → the server refuses the join → it sends the client an `error` OOB packet →
`CL_ConnectionlessPacket` turns it into `Com_Error(ERR_DROP, "%s", "EXE_ERR_CANNOTJOININPROGRESS")`
at **`0x643D50`** → **Server Shutdown** → the engine falls back into **client** init (D3D9, the `ui`
fastfile) → the sound-driver singleton is already taken → a second `Com_Error` → the error path
`0x59A6F0` calls the asset-database sync → **it waits for ever.**

So `dedicated.hpp`'s milestone 1 ("stop the engine falling back into client/renderer init") and
milestone 4 ("keep local client 0 out of the game") were the *same bug*, and the thing that
triggers both is the local client connecting.

### The fix

Retarget the one call at `0x6321A2` to a counting `ret`, dedicated-only:

```
00632192  cmp byte ptr [esp+0x13], 0
00632197  jne 0063222B
0063219D  mov edx, [ebp+0x10]
006321A0  push edx
006321A1  push edi              ; arg1 = map name
006321A2  call 00641730         ; CL_ConnectLocal      <- retargeted
006321A7  add esp, 8            ; THE CALLER CLEANS -> a bare `ret` stub is correct
```

`add esp,8` after the call is **read, not assumed** — the component verifies both the call target
and those three bytes and refuses to patch otherwise. That is the discipline the two failed
console-stub attempts (§4) lacked. `ENW_DEDI_KEEP_LOCAL_CLIENT=1` turns it off for bisecting.

We fix the *client* half rather than relaxing the server's co-op join gate on purpose: a dedicated
server wants **zero** local clients, so slot 0 is free for a real one and `get_players()` does not
size rounds for a player who is not there.

### Result

| | before | after |
|---|---|---|
| frames | 4, then nothing | **30,038 in 90 s** |
| `SV_Frame` | — | **20.2 fps** (`sv_fps 20`, exactly right) |
| CPU | 1.81 s then flat (stopped) | ~6% of one core, climbing steadily |
| RSS | 230 MB (client init had run) | **186 MB, flat** |
| `sv_running` | 0 (Server Shutdown) | **1** |
| D3D / `ui` fastfile / `snddriverglobals` | all present | **none** |

### Three hypotheses tested and dead — do not re-test

| Hypothesis | Test | Result |
|---|---|---|
| The frame limiter dvar | `+set com_maxfps 0` | no change. **Now explained**: `0x59DD2C` reads `com_dedicated` and *skips* the `1000/com_maxfps` computation entirely when dedicated, so the pacing target is hard-coded to 1 ms and the dvar is not consulted |
| Windows' 15.6 ms sleep quantum (iw4x's documented fix for this loop shape) | `timeBeginPeriod(1)`, returned 0 = success | **no change**. Kept as hygiene; the comment in `dedicated.cpp` no longer claims it explains anything |
| The nonsense CPU benchmark feeding the pacing target | the float written directly at `dvar_s+0x10` (`+set` is refused: write-protected); log confirms `0.029753 -> 4.700000 … write landed` | **no change — disproven. The code has been removed**: it hard-coded B's CPU speed and defeated a ROM dvar for no benefit |

And one correction to the record: **we never set `sys_configureGHz` ourselves.** The
`Measured CPU speed is 0.01 GHz` / `Total CPU performance is estimated as 0.03 GHz` figures are the
engine's own broken measurement on a Ryzen 9800X3D. (`tools\dev\launch.ps1` does pass
`+set sys_configureGHz 1`, which the engine refuses as write-protected.)

Worth keeping: `sys_configureGHz` is `flags 0x0011 type 0x0001` — so **dvar type 0x0001 is float**,
a free addition to the type table in §3.

### One thing a 12-slot probe run taught us the hard way

`ENW_DEDI_PROBE` with **twelve** simultaneous MinHook detours
(`59E330,59DCF0,59B630,5FEC60,59DA50,6366C0,636610,503AB0,59DB80,70E3A0,48DE40,52D8E0`) produced an
`Unhandled exception caught` box during boot and a dead main thread. The same run with **no** probes
booted cleanly. The probe stubs save `pushfd/pushad` but **not XMM/FPU state**, and several of these
functions are called from SSE-heavy code. Probe two or three at a time, and prefer
`ENW_DEDI_WHEREIS` — the stack walk cost nothing and is what actually solved this.

---

## 7c. FIXED — intermittent ~5 s stalls in `Sys_GetEvent`'s message pump

With the frame loop running, `r03` shows seven `Hitch warning: 5034 msec frame time` lines in 90 s,
and the frame rate alternates between ~500 Hz and ~170 Hz in 5 s bands. The stack walk catches the
main thread in the slow bands at:

```
EIP = win32u!NtUserGetMessage+0xC   ESP = 000EFD98
validated: 005FED11 <- 0059B64C <- 0059DD95 <- 0059E4DC <- 005FF7C2
```

i.e. `WinMain -> Com_Frame -> pacing loop -> Com_EventLoop(0x59B630) -> Sys_GetEvent(0x5FEC60)`,
blocked in **`GetMessageA`**. `Sys_GetEvent`'s pump is:

```
005FECD6  esi = PeekMessageA                       ; IAT 0x7EB2EC
005FECE9  call esi                                  ; PeekMessageA(&msg, NULL, 0, 0, PM_NOREMOVE)
005FECED  je 005FED44                               ; nothing pending -> Sys_ConsoleInput
005FED00: call [0x7EB2CC]                           ; GetMessageA(&msg, NULL, 0, 0)   <- BLOCKS
005FED13  je 005FEDCD                               ; returned 0 -> WM_QUIT
005FED28  TranslateMessage / DispatchMessageA
005FED3E  call esi ; jne 005FED00                   ; PeekMessageA again -> loop
```

The `PeekMessage(PM_NOREMOVE)` guard is not a guarantee: the loop re-peeks at `0x5FED3E`, and if a
message arrives between that peek and the next `GetMessageA` being reached with an otherwise empty
queue, `GetMessageA` **blocks until the next message of any kind**. In a rendered client the queue
is never empty so this never bites. Headless — and with the WinConsole window refused — the queue is
empty almost always, so the thread parks until one of our own 5 s worker-thread log lines wakes it.
Hence exactly ~5 s.

**Fixed** in `server/components/dedicated/nonblocking_pump.cpp`: hitches went **7 -> 1** in 90 s (the survivor is the 1 s map load) and the frame rate stopped oscillating. The fix hooks `GetMessageA` at the IAT (**0x7EB2CC**), dedicated-only, and make
it non-blocking: `PeekMessageA(msg, NULL, 0, 0, PM_REMOVE)`, and when there is nothing, synthesise
`msg = {hwnd = NULL, message = WM_NULL}` and return **non-zero**. Returning 0 is not an option — the
engine reads 0 as `WM_QUIT` (`0x5FED13`). `DispatchMessageA` on a NULL hwnd is a no-op, and the
re-peek at `0x5FED3E` then returns FALSE and exits the loop cleanly. Same IAT-level technique as
`no_winconsole` and the foreground-app fix, so there is no engine calling convention to guess.

## 7d. Milestone (c): the 10-minute soak, with numbers

`tools\dev\dediprobe.ps1 -Tag soak1 -Seconds 620 -WhereIs`, `waw-d2`, `nazi_zombie_prototype`,
`sv_maxclients 4`, `com_maxfps 60`, no clients connected, Ryzen 9800X3D.

| | at t=1 s | at t=620 s |
|---|---|---|
| `Com_Frame` rate | 51 Hz (still loading) | **60.8 Hz**, and 60.6–61.2 Hz continuously in between |
| frames total | — | **37,875** over 625 s |
| `SV_Frame` | — | **20.0 fps** (`referee: 12000 frames in 598765 ms`) — exactly `sv_fps 20` |
| CPU | 2.17 s | **30.06 s** → **4.85% of one core**, perfectly linear |
| RSS | 183.7 MB | **186.4 MB** — 186.3 MB unchanged from t=10 s to t=620 s |
| threads | 11 | 8–10 |
| handles | 436 | 475 |
| `Hitch warning` | — | **1** in the whole run, the 1,059 ms map load |
| `Com_Error` / `Server Shutdown` / `snddriverglobals` | — | **0 / 0 / 0** |

No leak, no drift, no stall. The remaining handle growth (436 → 475 over ten minutes) is worth a
look on a much longer soak before this hosts anything real, but it is flat over the last several
minutes and is as likely to be our own diagnostics as the engine.

**The frame rate is a knob now.** Stock T4 ignores `com_maxfps` in dedicated mode
(`docs/re/t4-sp-map.md` §6: the branch at `0x59DD35` skips the `1000/com_maxfps` computation), so an
unpatched headless server free-runs. Measured on the same map:

| | frame rate | CPU |
|---|---|---|
| stock dedicated pacing (1 ms target) | **515 Hz**, rock steady | 12.5% of a core |
| `frame_pacing.cpp` + `com_maxfps 60` | **61 Hz** | **4.85%** of a core |

`SV_Frame` paces itself to `sv_fps` either way, so the extra 450 Hz was Com_Frame asking the OS what
time it was. `ENW_DEDI_UNCAPPED=1` restores the stock behaviour, and `+set com_maxfps 0` still means
uncapped because the `jle` at `0x59DD2A` is untouched.

---

## 7e. Milestone (d): the server answers on the wire, and why the client could not reach it

### The wire works. That closes "site 3".

`tools\dev\jointest.ps1 -Tag join5`, with `tools\dev\oob.py` as the readiness gate:

```
getstatus      ANSWERED   674 bytes: statusResponse |
  \fxfrustumCutoff\1000 \g_gameskill\1 \gamename\Call of Duty: World at War
  \mapname\nazi_zombie_prototype \protocol\62 \shortversion\1
  \sv_hostname\CoDWaWHost \sv_maxclients\4 \sv_maxRate\7000 ...
```

A real `statusResponse`, four seconds after launch, from a headless `CoDWaW.exe` with our DLL beside
it. **The dedicated server is a functioning server on UDP.** `getinfo` and `getchallenge` got NO
REPLY, but the server's own counters show `SVC_GetChallenge=1`, so it *ran* the handler — the reply
path for those two is worth a look later and is not on the critical path.

The probe is deliberately exit-code-gated: `oob.py` exits 0 only when something answered. The
previous session's gate matched `REPLY` inside `NO REPLY` and fired a client at a stalled server,
which is how run `join1` became a "networking failure" that was nothing of the kind.

### The client connected to the in-process loopback, so the server never heard it

Run `join5`, client side:

```
[enw] connect_local: calling CL_ConnectLocal("nazi_zombie_prototype", 0) at 0x00641730
      PROFILES: setting server info to 0.0.0.0:0
[enw] connect_local: returned; client state [0x305842C] = 5
```

server side, for the whole 90 s:

```
[enw] net: SV_PacketEvent=3  SV_ConnectionlessPacket=3  SVC_GetChallenge=1  SV_DirectConnect=0
```

and all **three** of those packets were the harness's own `oob.py` probes. **Zero packets from the
client**, despite `clc.state` reaching 5 (connecting).

`0.0.0.0:0` is the tell, and the instructions explain it exactly. `CL_ConnectLocal` takes no address
argument — it hard-codes one:

```
006417E7  push 0x86F0D4          ; "localhost"       (68 D4 F0 86 00)
0064187A  call 00679520          ; NET_StringToAdr(name in EAX, out netadr on the stack)
00641883  call 00642C80          ; CL_SendConnectPacket
```

and `NET_StringToAdr` special-cases that exact string:

```
00679531  edi = 0x86F0D4 ("localhost")
00679538  ecx = 10 ; repe cmpsb
00679541  jne 00679569           ; anything else -> the real parse, splits on ':' (0x84B668)
00679543  zero the 0x18-byte netadr_s
00679555  mov dword ptr [ebx], 2 ; netadr.type = 2 = NA_LOOPBACK
0067955B  return 1               ; and NO ip and NO port are ever written
```

**`NA_LOOPBACK` is the engine's in-process ring buffer**, not 127.0.0.1 — the same value
`direct_connect.cpp`'s auth guard reads at `cmp [0x300FFF8], 2`. So the connect packet goes into a
buffer inside the *client's own* process and no socket is involved. A second process on the same
machine is unreachable through this call, by construction.

This is worth stating plainly because it is the opposite of the natural assumption: the problem is
not that 127.0.0.1 is awkward, it is that **the only connect entry point in the SP exe never uses an
address at all.**

### The fix, one dword

`shared/core/components/connect_address.cpp` rewrites the `imm32` operand of that `push` to point at
a string of ours (`ENW_CONNECT_ADDR=127.0.0.1:28960`). `NET_StringToAdr` then fails the `repe cmpsb`,
takes the branch at `0x679569`, splits on `':'` and resolves a real address and port. The opcode
stays `68`, the instruction stays five bytes, nothing is relocated and there is no calling convention
involved. The five bytes are verified before the write.

It sits beside `direct_connect.cpp` in `shared/core/components/` for the reason that file already
gives: the join test uses a build with `ENW_WITH_SERVER_COMPONENTS=OFF`, and a dedicated server never
executes this path anyway (and `local_client.cpp` stubs the call site out there).

The other `push "localhost"` at `0x641769` is a *comparison* on the `clc.state >= 6` branch ("are we
already on localhost?"). A freshly launched client is at state 0 and takes the `jl` at `0x641767`, so
it never runs; we leave it alone.

**Status: built, wired into `jointest.ps1`, not yet run** — `game.lock` went to the `mvp-client` lane
mid-test. The next run is `jointest.ps1 -Tag join6 -ClientFrom dedi-client`, and the thing to watch
is `SV_DirectConnect` going above 0 on the server.

### Still to expect after that, in order

1. **The connect handshake.** `CL_ConnectLocal` calls `CL_SendConnectPacket` immediately, which sends
   `connect`. The normal Quake order is `getchallenge` → `challengeResponse` → `connect`, and
   `SV_DirectConnect` validates a `challenge` field. If the server rejects the first packet, the
   resend loop (`cl_connectionAttempts 20`, `cl_connectTimeout 200`) is what has to carry it, and
   that loop is the next thing to instrument.
2. **The client's Demonware login spin.** `join5`'s client logged `Failed to log on.` about once a
   second for the whole run, with `Couldn't get profiles instance, are we logged on?`. It did not
   stop the process or the frame loop, and `direct_connect.cpp` already neutralises the
   `getAuthTicket` gate inside `CL_SendConnectPacket`, but it is noise that could hide a real error.
3. **Spawning in**, which is the actual success criterion: `client_s.lastUsercmd` (`+0x11108`)
   changing on the server and `gentity_s.currentOrigin` (`+0x160`) moving.

---

## 7f. The join, walked forward three walls at a time

Each of these was found by running the test, reading the failure, and reading the instruction that
produced it. Every one turned out to be a one- or two-byte fix at a site we could verify first.

| Run | What the server saw | What stopped it |
|---|---|---|
| `join5` | `SV_PacketEvent=3` (all three my own probes), `SV_DirectConnect=0` | `CL_ConnectLocal` hard-codes `"localhost"`, which `NET_StringToAdr` turns into **NA_LOOPBACK** — the in-process ring buffer. No packet ever reached a socket. |
| `join6` | same — still 0 from the client | With a real address, the client produced real 340-byte connect packets, and **the engine threw them away itself**: `DROPPING 340 byte packet because we're still connecting to the remote address (addrHandle=0, socketRouter=1)`, about once a second. |
| `join7` | **`SV_PacketEvent=4`, `SV_ConnectionlessPacket=4`, `SV_DirectConnect=1`** | The connect arrived and the server rejected it: **`ERROR: No or bad challenge for address.`** The client had skipped the challenge handshake. |

### Wall 2 — Demonware's socket router ate every packet

The message is at `0x86F5B8`, printed from **`0x57ED5C`** inside the Demonware send wrapper
`0x57EC90`:

```
0057ECB9  lea ecx, [eax*4 + 0x48886F8]   ; the bdAddrHandle table, stride 0x24, 0x68 entries
0057ECC5  call 005805E0                  ; the handle for this peer  -> esi
0057ECD0  call 0057E2F0 / 0078A430       ; the socket router         -> edi
0057ECE4  je 0057ED5C                    ; !esi -> DROP
0057ECE8  je 0057ED5C                    ; !edi -> DROP
```

`addrHandle=0` means **there is no `bdAddrHandle` for the destination**, and one is only created by
a Demonware-level connect to that peer — a live session with a service that has not existed for
years. No amount of retrying produces one. This is a genuine architectural fact about T4 and is
worth stating plainly: **T4 does not send connected game traffic over a plain socket by default.**

The lever is one byte. `Sys_SendPacket` **0x6000B0** already has a raw path:

```
006000C0  switch (to.type):  3,4 -> socket [0x22BEBD0];  5,6 -> socket [0x22BD9EC]
                             else Com_Error("Sys_SendPacket: bad address type")
00600105  cmp byte ptr [ebp+0x24], 0
00600109  je 0060013F                    ; ZERO -> THE RAW PATH
0060010B..00600132  copy the netadr, call 0057EC90     ; Demonware (drops)
0060013F  call 005FFCD0                  ; NetadrToSockadr
006001B2  push 0x10 / &sockaddr / 0 / data / len
006001C0  push esi ; call sendto         ; a plain Winsock sendto
```

That raw path is how the server's `statusResponse` reached `oob.py` in the first place. So:
`74 34` (`je`) → `EB 34` (`jmp`) at **0x600109**, and every packet goes out as ordinary UDP. Nothing
is relocated, no argument is reinterpreted, the branch target is unchanged — only the condition is
removed. `shared/core/components/raw_sockets.cpp`, armed by `ENW_RAW_SOCKETS=1`.

Result: `SV_DirectConnect` fired for the first time from a real second process.

**This is not a DRM bypass.** SteamStub is the copy protection and we only ever *wait* for it
(`steamstub.cpp`). This routes our traffic between our own processes over a normal socket instead of
through a dead relay, exactly like `direct_connect.cpp`. It is also, very likely, why Plutonium's T4
client cannot be "the stock exe plus a DLL": this has to be done inside the binary.

Two caveats, both untested and both distinguishable if they bite:
- netadr types **5 and 6** use the other socket (`[0x22BD9EC]`) and may be genuinely
  Demonware-routed address kinds. We only ever produce type 4. Watch for
  `Sys_SendPacket: bad address type`.
- the raw path has a second branch at `0x60014B`: when `[0x46E50A8] != 0` and the address is type 4
  it prepends a 10-byte header `{0,0,0,1, ip, port}` from `0x22BDA40`. If the two sides disagree
  about it, packets will **arrive and be rejected as malformed** rather than not arrive — a
  different symptom, so you can tell them apart.

### Wall 3 — the client skipped the challenge handshake

`CL_SendConnectPacket` **0x642C80** is really `CL_CheckForResend`: it runs per frame, rate-limits
itself (3,000 ms normally, 100 ms in state 7) and dispatches on `clc.state` at `0x305842C`:

```
00642D00  sub esi, 4
00642D03  je 00643104        ; state 4 -> send "getchallenge"
00642D09  sub esi, 1
00642D0C  je 00642E4C        ; state 5 -> send "connect" + userinfo
00642D12  sub esi, 2
00642D15  je 00642D31        ; state 7 -> ...
```

`CL_ConnectLocal` hard-sets state **5** at `0x64185F` — "I already have a challenge, send the
connect". Correct for the in-process loopback it was written for, because `SV_DirectConnect` does
not challenge NA_LOOPBACK. Wrong over a socket, and the server says so in as many words.

Fix: the immediate at **0x641865**, `5` → `4`. `CL_ConnectLocal` then leaves the client in
"connecting", its own call sends `getchallenge`, `SVC_GetChallenge` 0x62DB60 answers
`challengeResponse`, `CL_ConnectionlessPacket` 0x643380 stores it, and the connect that follows
carries a challenge. Folded into `connect_address.cpp` behind the same `ENW_CONNECT_ADDR`.

**Status: proven.** Run `join8`: `CHALLENGERESPONSE: Got server licenseid f36072ab308c8331` and
`SVC_GetChallenge` went 1 -> 2. The handshake completes. Two more walls followed (§7g).

### What to check the moment a client does get in

The success criterion is not "connected", it is **spawned and moving**:

- `svs.clients[i]` = `0x2547090 + i*0x58D30`; `client_s.lastUsercmd` at **+0x11108** should change
  every frame the player holds a key.
- `g_entities[i]` = `0x176C6F0 + i*0x378`; `gentity_s.currentOrigin` at **+0x160** should move.
- **Test the solo case explicitly.** On a dedicated server the game runs co-op rules even with one
  player (Quick Revive, prices, revives). For a speedrun platform that is the difference between a
  valid and an invalid solo run.

---

## 7g. A client connects: `CS_FREE -> CS_CONNECTED` on a headless server

**Run `join11`, server console:**

```
Client 0 connecting with 0 challenge ping from 127.0.0.1:28961
Going from CS_FREE to CS_CONNECTED for  (num 0 guid 0)
```

and the counters went from 5 packets to **275**:

| | join5 | join7 | join10 | **join11** |
|---|---|---|---|---|
| `SV_PacketEvent` | 3 (all mine) | 4 | 5 | **275** |
| `SV_ConnectionlessPacket` | 3 | 4 | 5 | **12** |
| `SVC_GetChallenge` | 1 (mine) | 1 | 2 | **2** |
| `SV_DirectConnect` | 0 | 1 | 1 | **1** |
| client got to | nothing sent | bad challenge | bad challenge | **CS_CONNECTED, map loaded** |

**It is client 0.** That slot is free precisely because `local_client.cpp` keeps the engine's own
local client out, which is the thing that was killing the server in the first place.

The client then loaded `nazi_zombie_prototype` (15,000+ console lines of it) and finally:

```
ERROR: Server connection timed out.
```

### Walls 4 and 5, both cleared

**4 — the co-op gate is a dvar, and it is called `party_joinInProgressAllowed`.**
`SV_DirectConnect` reads it twice, at `0x62E9BB` and `0x62EBC4`:

```
0062EBC4  mov eax, [0x339A774]        ; dvar_s*
0062EBC9  cmp byte ptr [eax+0x10], 0
0062EBCD  je 0062F101                 ; ZERO -> "Client connect ignored because join in
                                      ;          progress isn't allowed in COOP" -> refuse
```

We could not recover the name statically — all five references *read* `0x339A774` and none writes
it — so `join_in_progress.cpp` reads the name out of `dvar_s+0x00` at runtime and logs it. It is
**`party_joinInProgressAllowed`**.

**It is not registered at `post_init`.** Run `join9` was wasted proving that: the pointer is still
null when `Com_Init` finishes, because the party/lobby side owns it. The component polls the frame
tick every 16 frames instead, and re-asserts the value because the three other readers (`0x654260`,
`0x654530`, `0x65A5A0`) are party code that may write it back.

**5 — the server validates a Demonware ticket, and the client has not got one.**
Opening the co-op gate routed the connect down the path that checks it, so the error changed from
"Can not join a game in progress" to "No or bad challenge for address". The name is misleading:
`CHALLENGERESPONSE: Got server licenseid f36072ab308c8331` shows this is Demonware's **server
licence** exchange, not the Quake challenge number. The check is:

```
0062ED8A  lea ecx, [esi+0x58D28]      ; the last 0x18 bytes of client_s (sizeof = 0x58D30)
0062ED91  lea edx, [esi+0x58D18]
0062ED98  lea ebp, [esi+0x58D20]
0062EDA5  push ebp / push eax / push edx / push ecx
0062EDA7  call 00582740               ; the Demonware ticket/licence validator
0062EDAC  add esp, 0x10               ; THE CALLER CLEANS
0062EDAF  test al, al
0062EDB1  jne 0062EE0A                ; non-zero -> accept
0062EDE5  mov eax, 0x886DA4           ; "error\nEXE_BAD_CHALLENGE" -> reject
```

`server_auth.cpp` replaces that one call with `mov al,1; nop x3` — **the exact mirror of
`direct_connect.cpp`'s existing client-side patch at `0x642E77`**, and stack-neutral for the same
reason, which the component verifies (`83 C4 10` must follow) rather than assumes. Dedicated only.

There is a **second** `EXE_BAD_CHALLENGE` raise in the same function at `0x62E75D` on an earlier
path. It has not been hit and is not patched; the two are distinguishable because only the one we
patched is preceded by the `0x582740` call.

### What is NOT done, precisely

> **SUPERSEDED 2026-09-22 by §7h — kept, because the reasoning and one wrong name in it are both
> worth reading.** The player *does* spawn now, and nothing new had to be patched to get there.
> Item 1 below is answered: the connection did not "time out after the map loads" — `join11`'s
> `Server connection timed out` was the **client** giving up while the server was fine. The state
> name it sends you looking for, `CS_PRIMED`, **does not exist in T4** (§7h). Item 2 is answered in
> §7j: the server was never burning a core, the harness was passing no `com_maxfps`.

**The player has not spawned.** `CS_CONNECTED` is not `CS_ACTIVE`; the server never logged the
client entering the game, and `client_s.lastUsercmd` (+0x11108) and `gentity_s.currentOrigin`
(+0x160) were never sampled because there was nothing to sample. Connected is not spawned, and the
success criterion is spawned and moving.

Two concrete things for the next session, in order:

1. **Why the connection times out after the map loads.** *(Answered: it did not — see the box
   above.)* The client goes `CS_CONNECTED -> (gamestate) -> CS_PRIMED -> CS_ACTIVE` — **there is
   no `CS_PRIMED` in T4; the middle state is `CS_CLIENTLOADING`, §7h** — and it stalled
   somewhere after loading.
   `SV_PacketEvent` stopped climbing at 275, so the conversation died rather than never started. The
   places to look are the `clc_move`/usercmd path (`0x630BF0`, "Invalid command time %i from
   client") and whether the server ever sends the "entered the game" server command.
2. **The server burns a whole core with a client connected.** *(Answered in §7j, and the guess
   in the parenthesis below was the whole of it — it **was** the frame rate. `jointest.ps1`
   passes `+set com_maxfps 60` now and the server holds a flat 61 Hz.)* Idle it is 4.85% of one
   core; in `join11` it was **62.4 s of CPU in 60 s**. That is not the frame rate (`jointest.ps1`
   does not pass `com_maxfps`, so Com_Frame free-runs) but it is worth measuring properly with the
   cap on before anyone concludes the server is expensive.

Also still true and still untested: on a dedicated server the game runs **co-op rules even with one
player** (Quick Revive, prices, revives). For a speedrun platform that is the difference between a
valid and an invalid solo run, and it may force a design decision about how solo Verified runs are
hosted.

---

## 7h. MILESTONE (d) DONE — a player spawns in, and round 1 starts

**Runs `join12` (00:24), `join13` (00:32), `join14` (00:37) — and then `join15` to `join18`.
2026-09-22, seven for seven.** Every one of `join12`–`join18` has both
`Going from CS_CLIENTLOADING to CS_ACTIVE` and `referee: ROUND 1` in its
`ZombiesDev\logs\dedi\joinNN.server.enw.log`. The spawn is not what varies between those runs;
how the server dies *afterwards* is (§7j).

```
dprint[15] Going from CS_CONNECTED to CS_CLIENTLOADING for %s
dprint[15] Sending %i bytes in gamestate to client: %i
dprint[15] Going from CS_CLIENTLOADING to CS_ACTIVE for %s
join_probe: slot 0 CS_ACTIVE  name="anna-jpg" msgAck=110 gamestateNum=5
            clientSvId=0x00000010 svServerId=0x00000010  gentity=0x0176C6F0
referee: ROUND 1 (all_players_connected)
```

Connect to spawned is **under 3 seconds** once the client has the map (join12 00:24:31.2 to
00:24:34.3; join14 00:37:30 to 00:37:33.1). Nothing new had to be patched to get from §7g's
`CS_CONNECTED` to here — the five walls in §7f/§7g were the whole of it, and `join11`'s
`Server connection timed out` was the client giving up while the server was still fine.

### T4 HAS NO `CS_PRIMED`. Correct this everywhere before reading any older note.

Everything written in this repo before today said the client walks
`CS_CONNECTED -> CS_PRIMED -> CS_ACTIVE`. That is Quake 3 and CoD4. **T4's middle state is
`CS_CLIENTLOADING`**, from the strings in our own dump:

| VA | string |
|---|---|
| `0x887114` | `SV_SendClientGameState() for %s` |
| `0x887138` | `Going from CS_CONNECTED to CS_CLIENTLOADING for %s` |
| `0x88716C` | `Sending %i bytes in gamestate to client: %i` |
| `0x88719C` | `Going from CS_CLIENTLOADING to CS_ACTIVE for %s` |
| `0x88755C` | `%s : dropped gamestate, resending` |

The numeric values are unchanged (FREE 0, ZOMBIE 1, CONNECTED 2, CLIENTLOADING 3, ACTIVE 4) —
`cmp dword ptr [esi], 1` guards the ZOMBIE early-out at `0x6310AB` and `cmp dword ptr [esi], 3`
guards the enter-world call at `0x63101B`. Only the *name* was wrong, and a wrong name sends you
looking for a function that does not exist.

### Addresses recovered, all read off an instruction

| What | Where | Read at |
|---|---|---|
| `SV_SendClientGameState` | `0x62F500` | contains `0x62F602` |
| `SV_ClientEnterWorld` | `0x62FC30` | sets `[client] = 4`, tail-jumps `ClientBegin` `0x67C160` |
| `SV_ClientCommand` | `0x6309D0` | `clientCommand: %i : %s` |
| `SV_UserMove` | `0x630BF0` | `Invalid command time %i from client %s` |
| `svs.clients` base / stride | `0x2547090` / `0x58D30` | `SV_GameSendServerCommand` `0x5A937E` |
| `sv.serverId` | `[0x46E5124]` | `SV_ExecuteClientMessage` `0x630FF5` |
| `sv_pure` dvar_s* | `[0x23D5C24]` | `0x6310C9`, gate on `EXE_UNPURECLIENTDETECTED` |
| `Com_DPrintf(chan, fmt, ...)` | `0x59A310` | developer gate at `[0x1F55288]` |
| `G_WriteGame` | `0x512850` | sole ref to `G_WriteGame '%s' '%s'` |

`client_s` offsets, every one from an instruction rather than a header: `state` +0x00000,
`messageAcknowledge` +0x110FC, `gamestateMessageNum` +0x11100, `lastUsercmd` +0x11108,
`gentity` +0x11544, `name` +0x11548, pure state +0x323F0, the serverId the client echoes +0x52C00.

### The entry to the world is on the near-miss branch, which is worth knowing

`SV_ExecuteClientMessage` `0x630F70` compares the serverId the client echoed (+0x52C00) with
`sv.serverId`:

```
00631008  cmp  eax, ecx          ; equal -> read the message normally, NO enter-world here
0063100A  je   0x631080
00631015  xor  eax, ecx
00631017  test al, 0xF0          ; differs ONLY in the low nibble?
00631019  jne  0x631042          ;   no  -> maybe resend the gamestate
0063101B  cmp  dword ptr [esi], 3;   yes -> CS_CLIENTLOADING?
00631029  call 0x62FC30          ;          SV_ClientEnterWorld
...
00631042  mov  eax, [esi+0x110FC]; messageAcknowledge
00631048  cmp  eax, [esi+0x11100]; gamestateMessageNum
0063104E  jle  0x631031          ; not yet -> say nothing, do nothing
00631067  call 0x62F500          ; SV_SendClientGameState
```

So a client is entered into the world **only** while its serverId is a low-nibble near-miss of the
server's. Get that wrong in either direction and the client sits at `CS_CLIENTLOADING` for ever
with no error printed anywhere.

### Why the server could not narrate any of this

Every interesting line on the connect path is a `Com_DPrintf`, which the engine throws away unless
`developer` is 1 — and we do not set that, because it changes asset handling and script behaviour
and would make anything measured a different game. So
`server/components/dedicated/join_probe.cpp` **mirrors** `Com_DPrintf` (log the format string, jump
straight to the trampoline, the engine still decides for itself whether to print) and polls
`svs.clients` on the frame tick. That is how the table above was read, and it stays in: a state
machine that only tells you where it is when you ask it in the wrong mode is worth instrumenting
once and for all.

## 7i. The level-start autosave hangs a dedicated server (FIXED)

Milestone (d) landed and the server then died, twice, in two different ways with one thing in
common: the last line it ever printed, over and over, was

```
G_WriteGame 'nazi_zombie_prototype-zombie_start' 'AUTOSAVE_LEVELSTART'
```

* **join12** — 31 of them, then `Sys_Error("Internal script stack overflow")`.
* **join13** — 195 of them, then the frame loop **stopped dead**: `frame::count` frozen at 4183 for
  the remaining 110 s while the process burned a whole core. No error, no exit. Just gone.

T4 queues an autosave from script and drains the queue from the server frame, immediately after
`SV_Frame`:

```
00636654  call 0x635CC0        ; SV_Frame
0063666D  call 0x636CC0        ; drain the autosave queue   (and again at 0x636695)
00636D57  call 0x512AC0        ;   ... once per queued request
00512B14  call 0x512850        ;       ... G_WriteGame, which prints the line above
00512B19  add  esp, 4          ; THE CALLER CLEANS -- one stack argument
00512B1C  test al, al
00512B1E  je   0x512AD4        ; failed -> return 0, nothing is marked done
00512B23  call 0x512A80        ; succeeded -> post-save bookkeeping ([0x1F2F6D4] = 1, 0x563FC0)
```

On a headless server there is no player profile, the save never completes, the post-save step never
runs, and whatever is waiting on it asks again next frame — **once per server frame, which is
exactly the 20/s we measured**.

`server/components/dedicated/no_autosave.cpp` retargets `G_WriteGame`'s **one** call site so it
reports every autosave as done without writing one. Dedicated only; a player's own client and a
local solo run keep the stock autosave. Every skipped save is counted and the first few are logged
with the checkpoint name — this is not a silent swallow, and if server-side saves are ever wanted
this is the component to delete. `ENW_DEDI_ALLOW_AUTOSAVE=1` puts the stock behaviour back.

**Result (join14): 1 autosave request instead of 195.** The retry loop is gone.

## 7j. SOLVED — the freeze ~10 s after a player spawns (read the last section first)

> Sections 7j.1-7j.4 below are the hunt, in the order it happened, and several of their readings
> are wrong; they are kept because the wrong turns are the useful part. **The answer is in
> "SOLVED (runs join31-join54)" near the end of this section**, and it is not where any of this
> was looking. The original heading was *OPEN — `exceeded maximum number of script variables`,
> ~18 s after the player spawns*.

join14, with the autosave fixed, still died — at 00:37:51, **18.5 s** after `ROUND 1`. The engine's
own words:

```
******* script runtime error *******
exceeded maximum number of script variables: (file 'maps/_utility.gsc', line 9269)
 players = GetPlayers();
           *
Error: called from:
(file 'maps/nazi_zombie_prototype.gsc', line 352)
  players = get_players();
```

and then it raises the same error **2,150 more times**, dumping the whole script thread list each
time (555,979 console lines), until the operand stack itself overflows at `0x69A8D0`
(`gScrVmPub[0].top` reaches `maxstack`) and `Sys_Error` parks the thread.

**What is NOT happening**, measured across all 2,150 dumps — every one of these is flat, not
climbing:

| | first dump | last dump |
|---|---|---|
| `ent type 'entity'` | count 223, var usage 1606 | count 223, var usage 1606 |
| `ent type 'hudelem'` | count 8, var usage 72 | count 8, var usage 72 |
| `ent type 'pathnode'` | count 12, var usage 24 | count 12, var usage 24 |
| global `var usage` | 688, endon 93 | 629, endon 73 |

So **nothing is leaking entities or variables in any category the engine reports**, and the totals
are tiny — about 2,300 variables. The allocator is refusing at a point where the accounting says
there is plenty. That is the interesting part and it is the next thing to chase: either the pool is
smaller than the accounting suggests in this mode, or its free list is not what it should be.

Two facts to carry into that work, neither of them yet an explanation:

1. **`wait_for_first_player()` is still waiting.** Two threads sit on
   `level waittill("first_player_ready")` (`_utility.gsc:9698`, from `_utility.gsc:9539` and
   `_load.gsc:2256`) for the whole run, *after* the player is `CS_ACTIVE`. Meanwhile
   `all_players_connected` **did** fire — the referee logged round 1 off it. So one of the two
   player-ready signals reaches the level script on a dedicated server and the other does not.
   `local_client.cpp` deliberately keeps the engine's own local client out, and "first player" is
   the kind of thing a single-player engine may well tie to that client. **Unproven. Test it before
   believing it** — this project has lost time twice to a plausible single-signal identification.
2. `maps/_introscreen.gsc:566 flag_wait("introscreen_complete")` is also still waiting, and
   `maps/_autosave.gsc:36 flag_wait("starting final intro screen fadeout")` behind it. A headless
   server has no intro screen.

### Runs join15-join18: what the autosave fix changed, and what it did not

| run | autosave | com_maxfps | outcome |
|---|---|---|---|
| join14 | reported done (wrong) | none | `exceeded maximum number of script variables` x2,151, then `Sys_Error` |
| join15 | reported done (wrong) | none | `Attempting to commit an invalid save buffer`, then the frame loop froze at 4496 |
| join16 | **not patched** - the guard refused | 60 | froze at 1922. Stock behaviour, reproduces join13 |
| join17 | dropped at the drain | 60 | **0 script errors, 0 G_WriteGame, 0 invalid buffers, 1 request dropped** - and still froze, at 1905 |
| join18 | dropped at the drain | 60 | server **crashed outright** with `ENW_DEDI_WHEREIS=1` sampling it |

So the autosave was real, is fixed, and was **not** the frame-loop freeze. With it gone the
server still stops about ten seconds after the player spawns: `frame::count` frozen, CPU
pegged at a whole core. Pegged, not idle - that is a **spin**, not a wait, which rules out the
message-pump class of bug (7c) and points at a loop inside `Com_Frame`.

join16 is worth keeping for a different reason. The component refused to patch and said exactly
why - `expected add esp, 4 (83 C4 04) after the call, found 8B E8 83` - because the caller takes
the return value first and the cleanup is at call+7, not call+5. The guard was right and the
constant was wrong. A patch that had gone in on assumption would have unbalanced the stack and
produced a crash nowhere near the cause.

join18 is a warning about the instrument. `where_is_main.cpp` suspends the main thread to read
its context; with it on, the server did not freeze, it **died**. Seven samples came back before
it went, all in `ntdll!NtDelayExecution` / `NtDeviceIoControlFile` - i.e. sampled while healthy,
never once during the freeze. **The sampler changes the outcome it is meant to observe.** Do not
read anything into those seven samples, and find another way to see inside the freeze: a minidump
taken from outside the process (`tools/re/sample_threads.py`) rather than a suspend from inside.

One more clue, unexplained: the last thing the console holds before every freeze is a run of

```
      dvar set cl_network_warning 0
      dvar set sv_network_warning 0
```

194 pairs in join17, 390 in join15, and then nothing. `cl_network_warning` being written at all
in a server process is odd on its face.

### Runs join19-join30: the spin is LOCATED, and it is a list walk that cannot terminate

**The main thread spins at `0x0068F090`, 150 of 150 samples**, reached through `SV_Frame`. Taken
from **outside** the process, which is what §7j asked for and what `where_is_main.cpp` could not
do. Two tools now do it and both are in `tools/dev/`:

| tool | what it answers |
|---|---|
| `tools/re/sample_threads.py <pid>` | which function every thread's EIP is in (existing, unchanged) |
| `tools/dev/freeze_probe.py <pid>` | the ordered call stack, the spinning frame's arguments, and a walk of the variable list it is stuck on |
| `tools/dev/varpool.py <pid> --watch N` | both script-variable pools, allocated counts and free-list heads, over time |

**How the freeze is detected from outside**, because it cannot be detected from the log: the DLL
opens `enw-<pid>.log` without `FILE_SHARE_READ`, so nothing can follow it live — join19 was lost
to this, every read failing until the process was killed. The signal that does work is
`tools\dev\oob.py getstatus`: it is answered while the frame loop runs and stops being answered
the moment it stops. Three unanswered probes with the process still alive **is** the freeze, and
it lines up with `frame::count` afterwards in every run.

The loop, read off our own dump:

```
0068F3B4  movzx ecx, word ptr [ecx]              ; cur -> childVar[cur].v
0068F3BC  movzx ecx, word ptr [ecx + 0x3974700]  ;     -> childVar[that].id
0068F3C3  mov  [esp+0x18], ecx                   ; the cursor
0068F3CC  movzx ebx, word ptr [ecx + 0x397470C]  ; childVar[cur].v
0068F3D3  cmp  ebx, edx                          ; ... == the id we are removing?
0068F3DB  jne  0x0068F3B4                        ; no -> go round again. For ever.
```

It is a **predecessor search over a circular list of script variables** — find the node whose
`next` is the one being removed — and it never ends because **the id it wants is not in the list
it is searching**. `join24` caught it exactly: target id `0x1534`, name **`'minval'`**; cursor
parked on id `0x347E`, name **`'levels'`**, whose own `v` points at itself — a one-node ring that
can never contain the target. Only two entries in the whole 65,536-entry pool still referenced
`0x1534`. `join22` is the same shape with `'stateid'` as the target.

**`0x0068F090` is also where `exceeded maximum number of script variables` comes from** — sites
`0x0068F235` and `0x0068F301`, the same string at `0x0089A600`. So §7j's two failure modes are
**one function**, and which one a run gets is which branch it reaches first. Six runs:
`join19, join20, join22, join24, join25` spun at `0x0068F090`; `join23` spun in a different chain
walk, `FindVariableIndexInternal 0x0068BC20`; `join21` took the error branch 2,087 times and ended
parked in `Sys_Error 0x005FE8C0`. Every one of them is the same data structure.

The entry point is `0x0068F4A0(instance, ownerId, hashSlot)`, `__cdecl`, three stack arguments,
**and a live `ECX` argument** at one site (`mov ecx,[ebp-0x78]` at `0x00694B1D`; the caller cleans
with `add esp,0xc`). Anything hooking it needs a naked thunk; a typed C++ detour would clobber
`ECX`.

**What that third argument is, and a retraction.** It was first read as "the variable being
removed", and `join28` was written up as *the same id removed twice, a double removal*. **That is
wrong and the correction is kept here rather than the claim deleted.** The two hottest call sites
compute the third argument immediately before pushing it:

```
00694F3C  xor  edx, edx
00694F3E  mov  ecx, 0xfffd
00694F43  div  ecx            ; a hash, mod 65533
00694F4E  add  edx, 1
00694F51  push edx            ; a3 = A HASH SLOT
00694F52  push eax            ; a2 = the owner object, out of gScrVmPub
00694F53  push esi            ; a1 = script instance
00694F54  call 0x0068F4A0
```

So `0x0068F4A0` is **"claim this hash slot for this object"** — the slot-eviction half of
*creating* a variable, not removing one. Two calls with the same `(owner, slot)` are perfectly
ordinary: the same name hashes to the same place every time. What hangs is **evicting whoever is
already sitting in the slot**: `0x0068F090` allocates a replacement node, copies the occupant into
it, and then has to fix up the occupant's sibling ring — and that fix-up is the search that never
ends.

Which gives the mechanism in one sentence, and it is the thing to carry forward:

> **Some childVariables entry is marked in use and occupies a hash slot while not being a member
> of the sibling ring it claims. It sits there harmlessly until something else hashes to its slot,
> and then the eviction spins for ever.**

`join22`'s occupant was `'stateid'`, `join24`'s was `'minval'`, and `join24`'s cursor was parked on
`'levels'` whose `v` points at itself. All three are `level.challengeInfo[...]` keys.

Call chain at the freeze, in stack order, innermost first — **unnamed functions are left as
addresses on purpose**:

```
0x0068F090 <- 0x0068F4A0 <- 0x00693E80 (VM_Execute; the script stack-overflow guard lives here)
  <- 0x006992E0 <- 0x00692565 <- 0x00699640 <- 0x004B5550 <- 0x004E03C0 <- 0x00519F00
  <- 0x0067EB70 <- 0x006903B0 <- 0x0069A610 <- 0x00693E80 <- 0x00419070 <- 0x0068A750
  <- 0x00697BB0 <- 0x006990E0 <- 0x006997E0 <- 0x00503AB0 <- ... <- 0x00635CC0 (SV_Frame)
  <- 0x00636610 / 0x006366C0 (Com_Frame) <- 0x0059DCF0 <- 0x0059E330 <- 0x005FF600
```

### Two hypotheses tested and DEAD. Do not re-test them.

1. **"The variable pool is exhausted."** No. `join25`, measured at the freeze: child pool
   **13,534 of 65,536** allocated with a live free list (head 4,317), parent pool
   **2,672 of 24,576** with a live free list (head 1,558). There are two pools with two free
   lists — `0x0068FCE0` allocates from `parentVariables` (head `0x3914714`) and `0x0068FE20` from
   `childVariables` (head `0x3974704`), and **both raise the same error string** — so "the child
   pool has room" was never an answer on its own. Now both have been measured and both have room.
   The pool is not full; the **links** are wrong.
2. **"It is one of our own components."** No. `join24` ran a DLL built with `referee`, `replay`,
   `chat`, `afk`, `pause` and `knobs` deleted from the source tree — only `dedicated/` and `net/`
   plus `shared/core` — and it froze at `0x0068F090` exactly as before, at the same point after
   the spawn. That also clears the `VM_Notify` hook, which was the obvious suspect because it is
   the one thing of ours that runs inside the script VM.

Also cleared, from the existing record rather than from a new run: `no_autosave.cpp` is not the
cause (`join16` froze with the autosave **unpatched**), and neither is the frame cap (`join13`
and `join14` froze at ~237 Hz with no cap at all).

### What the script was doing

The engine's own dump in `join21` names it: the error fires inside `GetPlayers()`
(`maps/_utility.gsc`, line 9269), called from `maps/nazi_zombie_prototype.gsc:352` inside a
`wait 0.2` poll at line 350. The variable names on the nodes involved — `minval`, `maxval`,
`statid`, `stateid`, `tier`, `reward`, `desc`, `name`, `levels`, about 407 of each — are the
co-op challenge table, `level.challengeInfo[...]` built by `maps/_challenges_coop.gsc` (lines
460-482 write exactly those keys, including the `"levels"` node the walk gets stuck on).

A 0.2 s poll also fits the timing: the freeze lands 8-13 s after `CS_ACTIVE`, which is 40-65
iterations of that loop.

**The unanswered question, stated honestly:** what leaves an entry in a hash slot that is not in
the ring it claims.

The allocator's own error path looked like the answer — at `0x0068F235`, with the free list empty,
the engine prints the error and **carries on with index 0**, writing through it, which is exactly
the shape of damage that would produce an orphan. **It is not the answer for the freeze.**
`exceeded maximum number of script variables` was counted in the console log of all twelve runs (join19-join30)
and appears in **one**:

| run | `CS_ACTIVE` | `exceeded maximum...` | outcome |
|---|---|---|---|
| join19, join20, join22, join24, join25 | yes | **0** | spun in `0x0068F090` |
| join23 | yes | **0** | spun in `0x0068BC20` |
| join21 | yes | **2,087** | error flood, then `Sys_Error` |
| join26-join30 | yes | **0** | spun in `0x0068F090`, with the probe on |

So the orphan exists without the pool ever having been exhausted, and the error flood of `join21`
is a *consequence* of the same broken structure rather than its cause. The two failure modes are
one function and one structure, but neither causes the other.

Next measurements, in order: count entries that occupy a slot without being in the ring they
claim (a sweep of the 65,536-entry pool, from outside, `varpool.py` is the place for it), and
sample it over the spawn to find the frame on which the first orphan appears.

`server/components/dedicated/var_slot_probe.cpp` (`ENW_DEDI_VARPROBE=1`, off by default,
diagnostic only, changes nothing) is the instrument that got this far: it records every call to
`0x0068F4A0` with its call site, keeps the last 128 in a ring plus a per-slot last-claimed table,
and prints them from its own watchdog thread once `frame::count` has not moved for 4 s. It costs
one array write per call, which matters — the engine makes about **5,700 of these calls a second**
(190,297 in 33 s, `join26`). Call-site histogram over the last 128 before a freeze (`join28`):
`0x00694520` 48, `0x00694F59` 39, `0x00695830` 14, `0x0069AAB0` 13, the rest single figures.

### No fix landed *(in that pass — see "SOLVED" below, which supersedes this heading and nothing else)*

There is no fix in this pass, and a bounded-loop patch was considered and **not** taken: it would
cover `0x0068F090` and leave `0x0068BC20` (`join23`) and the error branch (`join21`) untouched, so
it could not produce the two clean 120 s runs that would count as proof — and papering over a
structure the engine is about to use is the mistake §7i already recorded once.

### SOLVED (runs join31-join54): the freeze is a leaked temp-memory frame, not a variable bug

**The spin is real and everything §7j says about it is still true. It is a symptom.** The cause is
one level down and it is not in the script-variable system at all:

> **The server leaks one 0x20000 frame of the engine's temp-memory stack per client message. The
> decode destination that offset controls therefore marches forward through the process 128 KB at a
> time, and when it crosses `gScrVarGlob`'s child-variable pool it writes through it. The next
> variable that hashes to a stomped slot sends `0x0068F090`'s predecessor search into a walk that
> cannot end.**

#### How it works, off the instructions

`SV_ExecuteClientMessage` is at **0x630F70** (not 0x630C70, which is the neighbouring function the
crude function-boundary pass merges it with). It decodes the client's compressed message into temp
memory:

```
00630F78  mov  eax, [0x46E5054]     ; the temp-stack offset
00630F7D  mov  ebp, eax
00630F7F  add  eax, 0x20000         ; one 128 KB frame
00630F8B  mov  [esp+0x10], ebp      ; remember the old offset
00630F91  mov  [0x46E5054], eax     ; push
00630F96  lea  ebp, [ebp+0x212B2F8] ; dst = TEMP_BASE + old offset
00630FC7  push ebp                  ; ... into MSG_ReadBitsCompress 0x6751D0
00630FD0  mov  dword [esp+0x28], 0x20000
00631035  mov  [0x46E5054], edx     ; pop -- and 0x631073, 0x63115C, 0x631182,
                                    ;        0x6311C0, 0x6311D3, one per return path
```

The only reference to 0x630F70 in the whole image is a **tail jump** at `0x6357AA`, out of
`SV_PacketEvent` 0x635540, so the callee takes EAX and ECX and has no stack arguments.

#### The measurements, in the order they were made

| run | what it settled |
|---|---|
| `join31` | baseline reproduced on this session's build: CS_ACTIVE 03:47:11.8, ROUND 1, frozen at frame **1873** between 8 and 13 s later |
| `join33`, `join36`, `join37` | `tools/dev/varcheck.py` sweeps the pool from outside and checks one invariant — every slot whose record is a live chain member must be named by exactly one record's `v.next`. The pool is **clean** while the map runs, then breaks in a **single step ~3 s after CS_ACTIVE**, and never recovers. The freeze follows 4-6 s later |
| `join37` | **the loop is closed by hand**: the hash slot the spin is searching for (`index` = 0x16C0, `[ebp+0x14]`) is one of the slots `varcheck.py` had already flagged |
| `join36` | the byte diff. The damage is 16 bytes written at slot 0x16C0 and again at 0x36C0, 0x56C0, 0x76C0, 0x96C0, 0xB6C0, 0xD6C0 — a stride of exactly **0x2000 entries = 0x20000 bytes = 128 KB** — over three quarters of a megabyte. No hash table does that to itself |
| `join38`, `join39` | `var_watch.cpp` puts hardware write watchpoints on those slots. The writer is a `memcpy` **in our own DLL** reached from `0x00630FF5` — i.e. the return address inside `SV_ExecuteClientMessage`, immediately after `call MSG_ReadBitsCompress`. So the engine's own decode destination is inside the variable pool |
| `join40` | `varcheck.py` starts printing `[0x46E5054]` beside the sweep. It is **0x0 at every one of the 22 samples in the 11 s before the client connects**, then climbs monotonically — and it crossed 0x038AB2F8 → 0x03D0B2F8 in the same half second that 14 slots stopped being chain members. The pool is 0x03974700 - 0x03A74700 |
| `join43`, `join44` | a watchpoint on the offset itself. Before the client, every push has a pop. After, the pushes from `0x630F96` climb 0x60000, 0x80000, 0xA0000, 0xC0000 … one per client message, with every *nested* push/pop balanced and **not one write from any of the five restore sites in between** |
| `join45` | **not `huffman_guard`.** That component hooks the decoder in the middle of this very span, so it had to be ruled out; with `ENW_NO_HUFFMAN_GUARD=1` the leak and the freeze are identical |
| `join54` | **control.** `ENW_DEDI_NO_TEMP_GUARD=1`: offset ran to 0x3A60000, 22 orphans, frozen at frame 2200 |

Not a Com_Error longjmp either: `error_trap.cpp` counted **zero** `Com_Error` and `Sys_Error` calls
across the whole of `join44`.

#### The fix, and exactly how far it goes

`server/components/dedicated/temp_stack_guard.cpp`. At the end of every frame, if the temp-stack
offset is above the baseline the component measured at its own first frame tick, it is put back.

That is safe for a reason we measured rather than assumed: **at a frame boundary nothing holds a
temp frame.** The offset read 0 on every sample for the 11 s before the client connected, the
engine's own code writes it back on every balanced path, and our frame tick runs *after* Com_Frame,
so every packet of the frame has been handled and every block taken during it is dead. The
component reads the baseline itself instead of hard-coding 0, and only ever restores a value it
read. `ENW_DEDI_NO_TEMP_GUARD=1` turns it off.

**Proof** — `jointest.ps1` at 120 s with `oob.py getstatus` polled every 3 s throughout
(`tools\dev\jointest-proof.ps1`, a run passes only if the client reaches CS_ACTIVE, the referee logs ROUND 1,
every getstatus is answered and `frame::count` is still advancing in the last liveness line):

| run | result |
|---|---|
| `join48` | 120 s, `varcheck.py` sweeping the whole time: **0 orphans for the entire run**, offset pinned at 0, ~2,000 frames put back |
| `join49`, `join50` | PASS, PASS |
| `join52`, `join53` | PASS, PASS — the shipping configuration (call wrap off) |

#### Still open, and stated as open

1. **Why the engine's own pop is skipped.** Every return path in 0x630F70 writes the offset back,
   no `Com_Error` is raised, and the function plainly returns. `ENW_DEDI_TEMP_THUNK=1` wraps the
   tail jump at 0x6357AA and corrects the offset across that call; in `join49`-`join51` it counted
   **2,502 wrapped calls and 0 corrections** while the frame reset was putting 2,034 frames back in
   the same run. So `SV_ExecuteClientMessage`'s own frame is *balanced* and the unpopped push is
   reached some other way. The wrap is therefore off by default — it is an instrument, not a fix.
2. **The frame rate.** Before a client, the server holds a flat 61 Hz. Once a player is in it goes
   to ~100 Hz and then, later in the run, to **~5,900 Hz at about 70% of one core**. This is not
   new and it is not the guard: the same ramp (61 → 102 → 123 Hz) is in every pre-fix run, right up
   to the moment it froze. `sv_fps` still paces the simulation and the server answers, spawns and
   referees correctly for the whole 120 s, but a 5,900 Hz `Com_Frame` is not right and nobody has
   looked at it yet.
3. **`wait_for_first_player()`** is unchanged by any of this and still unproven.

#### Two readings retracted in place

- *"A bounded-loop patch is the only lever."* It is not, and it would have been the wrong one: the
  loop is correct code reading damaged data.
- *"The variable pool damage is the bug."* It is the **first thing in the leaked pointer's path
  that the engine reads back**. Anything else in the 68 MB it walked was being corrupted too.

### FIXED: the server did not burn a whole core, the harness was not capping it

join13 measured 111.5 s of CPU in 120 s of wall clock with a client connected, against 4.85% of
one core idle, and the frame loop free-running at about 237 Hz. `frame_pacing.cpp` had already
nopped the branch that made dedicated mode ignore `com_maxfps` -- **nothing was passing one**.
`jointest.ps1` now passes `+set com_maxfps 60`, the same figure `dediprobe.ps1` uses, and the
server holds a flat **61 Hz** (join16 t=20s: 61.2 Hz; join17 t=15s: 60.6 Hz).

And a reading error worth not repeating: **join12's flat CPU line was not a healthy server, it was
a parked one.** The process had hit `Sys_Error` at t=39 s and the remaining 160 s of "low CPU" was
a dead thread. Never read CPU as health without `frame::count` beside it.

## 8. Does a game box need a Steam client?

`CoDWaW.exe` has six sections; the last is **`.bind`** (0x4ABB000, 0x56000 bytes) and the entry point
is `0x4ABB2ED`, inside it. That is Steam's DRM wrapper. Every Steam string is encrypted — `SteamStub`,
`steam_api`, `SteamAppId`, `steamclient`, `steam://`, `CEG` all absent from the raw bytes — and there
is **no `steam_api.dll`** in the install, so the DRM is purely the stub. Without the environment the
exe exits(0) in 1.5 s writing nothing (p01); with `SteamAppId`/`SteamGameId` set and `steam_appid.txt`
present it runs in place. **Steam was running for every successful probe**, and I have not tested with
it closed because nobody but B touches the Steam client.

If a live Steam session is required, the options are: a logged-in account per concurrent box (money
plus Steam's one-session rule); Steam offline mode (still one account per box); or a non-Steam retail
copy of WaW 1.7 for servers (money, and B owns the Steam copy). R12 confirms there is **no** free WaW
dedicated-server app on Steam — that memory was MW3 and BO3, and even BO3's official free dedi cannot
host zombies. Publicly, Plutonium's Linux servers run under Wine with no Steam client and no Xvfb,
which is only consistent with a server binary that is not the SteamStub exe. **No DRM workaround is
being designed; the constraint is the finding.**

---

## 9. Traps for everyone

### 9.1 `waw-base` was corrupt — and it produced errors that point nowhere near the cause

I compared all 333 files of the Steam install against `waw-base`, 8×64 KB sampled blocks each: 305
matched, **28 did not**, including 8 `.iwd`s (`iw_06`, `iw_08`, `iw_14`, `iw_20`, `iw_23`, `iw_27`,
`localized_english_iw03/04`) plus `version.inf`, 14 `DirectX\*.cab`, `installers\pbsvc.exe` and four
`pb\*`. Sizes matched exactly; contents were zeros — `iw_20/23/27` were 100% zero in the copy and
not zero in Steam. `robocopy /MT:16` had reported 5.468 GB copied in **1 second**, which is
block-clone behaviour, not a real copy. The Steam install itself was fine (`StateFlags 4`,
`BytesDownloaded == BytesToDownload`).

**The engine mounts the readable iwds and silently skips the rest**, so the damage surfaces much later
as a missing asset. It explains the frozen rendered client in p04 (`images/sun_flare.iwi` lives in
`iw_08.iwd`) and the `accuracy/aivsai/mp44.accu` warning (in `iw_14.iwd`), and it puts crash site 4
in doubt.

I built `C:\Users\b\ZombiesDev\main-fixed` — hardlinks to every file in `waw-base\main` except the
damaged ones, which are fresh copies from the read-only Steam install (~800 MB, not 5.5 GB). 34 of 35
iwds now open cleanly. `waw-d2` and `waw-c1` junction `main` to it. `referee` has since repaired
`waw-base` itself.

**One file is damaged in the Steam install too**: `main\iw_13.iwd` is byte-identical between Steam and
the copy and neither opens as a zip. Worth B running Steam's "Verify integrity of game files" once.

### 9.2 The rest

1. **SteamStub relaunch.** A copied exe launched directly exits(0) silently. Set `SteamAppId=10090`
   and `SteamGameId=10090` in the environment.
2. **Safe-mode marker.** `%LOCALAPPDATA%\Activision\codwaw\__CoDWaW` is a 4-byte file holding the PID
   of the running instance. If it survives a crash or a kill, the next launch shows a modal
   "Run In Safe Mode?" before any logging. Delete it before every automated launch.
3. Both modal boxes are plain `#32770` and answer to `PostMessage(hwnd, WM_COMMAND, IDNO, 0)`.
4. **Per-instance user data is unsolved.** `fs_homepath` moves `main` and the console log but not the
   profile directory, and `LOCALAPPDATA` is ignored (`SHGetFolderPath`). Several games on one box
   share `%LOCALAPPDATA%\Activision\codwaw` including the single-instance PID marker, ~~and collide
   on **UDP 3074**~~.
   **CORRECTION 2026-09-22, from `hostlane`'s measurement: the UDP 3074 half of that is wrong.**
   Two headless instances ran at the same time on one box, both answering `getstatus` — **A on
   3074, B on 3075**. The engine falls back to the next port; it is not an exclusive bind, and
   neither instance was blocked by the `__CoDWaW` marker. `host.md` §10.5 has the transcript.
   The **shared-profile** half of the item may still hold; it has not been re-tested. And do not
   reach for `ENW_PRIVATE_PROFILE` to fix it: an empty private-profile tree makes the engine raise
   `Exceeded limit of 1 'snddriverglobals' assets` and then answer nothing at all, reproduced three
   times (`host.md` §10.6).
5. **`Measured CPU speed is 0.01 GHz` / `Total CPU performance is estimated as 0.03 GHz`** on a Ryzen
   9800X3D — the engine's CPU benchmark is broken on modern hardware. Do not trust engine-side timing.
6. **`System memory is 1024 MB (capped at 1 GB)`** — a 32-bit process with a hard cap.
7. **Loose GSC override needs `fs_game`** (p09/p10).
8. `post_unpack` is too early for dvars; the DLL log file is opened without sharing.

---

## 10. Milestones and estimate

| Milestone | Status |
|---|---|
| (a) runs with no renderer/window | **done, by the stock exe** |
| (b) loads `nazi_zombie_prototype` and runs script frames | **done** (p21) — map, collision, zombies GSC |
| (c) stable frame rate with sleep-based pacing, CPU and RAM | **done, soaked 10 min** — 61 Hz, `SV_Frame` **20.0 fps**, **4.85% of one core**, **186.3 MB flat**, 1 hitch (the map load). §7d |
| (d) a client connects and spawns in | **DONE** — `Going from CS_CLIENTLOADING to CS_ACTIVE`, then `referee: ROUND 1 (all_players_connected)`. Reproduced in **every** run from `join12` to `join18` — seven out of seven. §7h |
| (e) the server survives the first round | **not yet, and it is the only blocker left.** ~10 s after the player spawns the frame loop stops with the CPU pegged — a spin, not a wait. The autosave fix did not change it. §7j |
| (e2) the script VM stops refusing | **not yet.** A second failure mode, seen twice: `exceeded maximum number of script variables`, raised 2,151 times while every category the engine itself reports stays flat at ~2,300 variables. §7j |

**Estimate for a focused swarm to finish Stage C** — *written 2026-09-20 and kept as written. Read
it against what happened: a client connecting and spawning came in inside two days rather than
2–4, and "several instances per box (3074…)" turned out not to be work at all, because 3074 never
collided (§9.2 item 4). The frame-loop freeze of §7j is not in this estimate, because nobody knew
it existed when the estimate was made.* Assuming `re` keeps supplying addresses and the
Steam question is answered: narrowing the SAVED flag to one bit, hours. Site 3 (the wire), 1–2 days —
this is the real unknown now. Frame pacing, CPU and a soak, 1 day. A client connecting and spawning,
2–4 days, less than I feared before R14 removed the party layer from the problem. Several instances
per box (3074 and the shared profile directory), 1 day. **Total 5–9 working days; 1.5–2 weeks wall
clock with review.** That is unchanged from my first estimate: milestone (b) came in far faster than I
expected, and site 3 appeared to take its place.

---

## 11. 2026-09-22, 05:00-06:30 — the frame rate, and what the frame rate turned out to be

### 11.1 The 5,900 Hz was not a pacing bug. The frame body stops returning.

`next-session.md` listed the frame rate as cosmetic: "the server answers, spawns and referees
correctly for the whole 120 s, but a 5,900 Hz `Com_Frame` is not right and nobody has looked at
it." It is not cosmetic and it is not a frame-rate bug.

`frame_pacing.cpp` gained a read-only probe that prints three counters every five seconds. They
take the question apart on their own:

| counter | incremented at | means |
|---|---|---|
| `ours` | our tick on WinMain's `call Com_Frame` (0x5FF7BD) | `Com_Frame` was called |
| `Com_Frame-body` | `add [0x1F964BC], 1` at **0x59E4DC** | the body call **returned** |
| `frame-body-entered` | `add [0x1F552D4], ebx` at **0x59DD72** | the body was **entered** |
| `com_frameTime` | `[0x1F9648C]`, written at 0x59DDC1 | how far into the body we got |

`join55`, stock `nazi_zombie_prototype`, one real client:

```
t=25s  ours    61.0 Hz | body-returned  61.0 Hz | body-entered    61.0 Hz | com_frameTime 21137
t=45s  ours   111.2 Hz | body-returned  60.6 Hz | body-entered   111.2 Hz | com_frameTime 26136
t=55s  ours   123.4 Hz | body-returned  61.0 Hz | body-entered   123.4 Hz | com_frameTime 31141
t=80s  ours  5236.2 Hz | body-returned   0.0 Hz | body-entered  5236.2 Hz | com_frameTime 54365
t=...   for the remaining 90 s: identical, com_frameTime FROZEN at 54365
```

Read it in three steps.

1. **The body cannot free-run.** The target it computes is clamped to a minimum of 1 ms
   (`test eax,eax` at 0x59DD3F, `mov [esp+0x14], ebx` at 0x59DD47) and `dedicated.cpp` calls
   `timeBeginPeriod(1)`, so the `Sleep(1)` loop bounds the body to about 1,000 Hz whatever
   `com_maxfps` reads. **5,900 Hz was never a number the pacing arithmetic could produce.**
2. **Half the frames stop returning the moment a player is in.** 123 Hz of entries against 61 Hz
   of returns is not a ramp, it is one good frame and one escaped frame alternating. The
   "61 -> 102 -> 123 Hz ramp" in every run since `join13` is that split, and it has been on the
   record all along.
3. **Then all of them do.** `com_frameTime` is written at 0x59DDC1, a few instructions into the
   body. It freezes. So **`SV_Frame` at 0x59DEBF has not run since that moment** — the server is
   spinning, not simulating.

The correct statement of the bug is therefore: *about fifty seconds after a player spawns, the
dedicated frame body stops returning and the engine stops simulating.* The player is dropped about
forty seconds later (`join55`: slot 0 `Going to CS_ZOMBIE` at 05:09:11, the split began 05:08:32) —
the client times out on a server that has stopped sending it anything.

**This overlaps the fixed temp-stack leak and is not the same thing.** Before
`temp_stack_guard.cpp` the server hard-froze; now it keeps ticking. Either way it stops simulating.
`jointest-proof.ps1` cannot tell the difference — all four of its gates (CS_ACTIVE, ROUND 1,
getstatus answered, `frame::count` moving) pass in exactly this state. **That is a gap in the
acceptance test, not a reason to doubt the temp-stack fix**, whose evidence (the `join54` control,
`varcheck.py` orphan counts) is independent of this.

### 11.2 Where the frame leaves, measured

`frame_escape_probe.cpp` (`ENW_DEDI_ESCAPE_PROBE=1`, off by default) retargets the one existing
`call Com_EventLoop` at **0x59DD90** — the call the pacing loop makes from inside itself — and
counts entries against exits.

```
join57  in=7806 out=2004     out frozen from the instant the split starts
join58  in=6872 out=2097     same
```

`Com_EventLoop` **does not return**. The `Sleep(1)` that would apply `1000/com_maxfps` is in the
same loop, after that call, so the cap is not being *ignored*: the instructions that apply it are
being jumped over. That is the whole of the frame-rate question.

**Two explanations ruled out by measurement, so nobody re-derives them:**

- **It is not `longjmp`.** 0x7AD57C (verified — it builds `STATUS_LONGJUMP` 0x80000026) has exactly
  three callers: `Com_Error` 0x59AC50 and `Sys_Error` 0x5FE8C0, both already trapped by
  `error_trap.cpp` and both silent, and **0x693CF0**, the script VM's error path. The probe hooks
  `longjmp` itself. `longjmps=0` through the entire storm, in two runs.
- ~~**It is not an SEH unwind.**~~ **RETRACTED 2026-09-22 07:15 -- it is exactly an SEH
  unwind, and 12.1 has the measurement.** The claim was that a vectored handler saw *only*
  `DBG_PRINTEXCEPTION_C` (0x40010006, i.e. `OutputDebugString`), about one per escaped frame,
  and never an access violation. **The handler logged only its first six exceptions**, and the
  first six of any run are init-time debug prints; the access violations start at exception
  **#124**. Counting by class instead of by budget (`join61`) gives `seh-through` equal to the
  missing frames to the frame. The one-debug-string-per-escaped-frame figure was ours too: the
  ENW logger goes out through `OutputDebugString`, so a handler that logs what it sees feeds
  itself -- in `join60` that killed the server in three milliseconds.

The escaped frames are also **not nesting**: at 5,300 escapes a second the stack would be gone
inside a minute and the process runs for hours. Something resets the stack without a longjmp and
without unwinding, and that is where the next session starts. The probe already records the ESP it
was entered with; compare it across escaped frames.

### 11.3 The fix: pace outside the thing that stops working

The engine's cap lives inside the loop the frame leaves through, so the cap has to *also* live
somewhere a non-local exit cannot skip. There is exactly one such place: WinMain's loop, outside
`Com_Frame`, which is where `enw::frame` already runs.

`frame_pacing.cpp` now tops each frame up to the same `1000/com_maxfps` target, measured across our
own tick, bounded to 50 ms (the same bound as `cmp edi, 0x32` at 0x59DDE1). It is self-correcting
and cannot double-pace: a frame the engine paced properly arrives ~16 ms after the last one and
sleeps 0; an escaped frame arrives in ~0.2 ms and sleeps the remaining ~16.

| | frame rate with a player in | CPU |
|---|---|---|
| before (`join55`, t=75->110 s) | 5,341 Hz | 4.2 s per 5 s wall = **~84% of a core** |
| after (`join57`, t=75->110 s) | **59.4 Hz** | 0.5 s per 35 s wall = **~1.4% of a core** |
| after (`join59`, 10 min, Der Berg) | 59.4 Hz | **10.7 s in 582 s = 1.8% of a core**, RSS flat 345 MB |

`ENW_DEDI_NO_OUTER_PACE=1` brings the spin straight back, which is the control.

**What this does not fix, stated plainly:** `com_frameTime` is still frozen, so `SV_Frame` still
does not run after that moment. The server is now *idle* rather than *spinning*, and it is stopped
either way. This is a CPU fix and an instrument, not a cure — and it is the difference between one
game per box and several, so it is worth having on its own.

### 11.4 Custom maps on the dedicated server

`tools\dev\maptest.ps1` boots a list of maps headless, one at a time, ~80 s each, and reports
alive / answered `getstatus` / the first thing the engine complained about. `jointest.ps1` gained
`-FsGame` (default `auto`).

**A custom map is its own mod, and that settles the "how do both load at once" question: they do
not, and they do not have to.** `fs_game` is `mods/<bsp>` — never our `mods/enw` overlay — and the
ENW DLL rides in on the binkw32 proxy, not on `fs_game`, so there is only ever one mod and it is
the map's. The referee is C++ (`referee.md` 3.1) and needs nothing inside the mod folder. The one
thing that *would* need to live there is the restore-path GSC of `referee.md` 3.3, which is not
built. `getstatus` confirms it end to end: `join59`'s status response carries
`\fs_game\mods/nazi_zombie_derberg`.

Three things had to be right and two of them were ours:

1. **`fs_game` before `+map`**, or the map fastfile is not on the search path when the map loads.
   Same class of bug as `+map` before `+set net_port`.
2. **`+set con_typewriterColorBase "1.0 1.0 1.0"` must be passed.** `jointest.ps1` has always
   passed it; `maptest.ps1`'s first cut did not, and **Der Berg died on exactly that** —
   `script runtime error: SetSavedDvar(): The dvar "con_typewriterColorBase" does not exist`
   (`map02`). Put it back and Der Berg boots (`map03`). A custom map's `_load.gsc` calls
   `SetSavedDvar` on dvars a headless server never registered, and an unregistered one is fatal to
   the script.
3. **The memory reserve.** `big_heap.cpp` raises it 300 MB -> 422 MB, `ENW_DEDI_BIG_HEAP=1`.

**Correction to `shared/t4/addresses.hpp` :: `t4::mem`, for `re`.** That file carries the
*instruction* starts, calls them "the true operand starts", and says the vault's
0x5F5492 / 0x5F54D1 / 0x5F54DB "land mid-instruction on our dump". It is the other way round:

```
0x5F5491  68 00 00 C0 12                 push 0x12C00000
0x5F54CB  C7 05 EC FA 24 02 00 00 C0 12  mov [0x224FAEC], 0x12C00000
0x5F54D5  C7 05 F0 FB 24 02 00 00 C0 12  mov [0x224FBF0], 0x12C00000
```

so the immediates are at **+1, +6, +6**. Reading `t4::mem`'s numbers as operands gives 0xC0000068
and 0xFAEC05C7, which is exactly what `big_heap.cpp` refused to patch and printed (`map02`). **The
vault was right.** `big_heap.cpp` applies the offsets locally rather than editing `re`'s file.

#### Results, runs `map01`-`map03` and `join59`

| Map | bsp | boots headless | answers getstatus | client CS_ACTIVE + ROUND 1 | verdict |
|---|---|---|---|---|---|
| Der Berg | `nazi_zombie_derberg` | **yes** (`map03`) | **yes**, 3 s (`join59`) | **no** (`join59`) | **ours was the boot bug**; the join is blocked by 11.1 |
| Leviathan | `nazi_zombie_leviathan` | no | no | — | **map**: `unknown item 'napalmblob'` |
| MW2 Rust | `mw2rust` | no | no | — | **map**: `undefined is not an array, string, or vector` |
| Clinic of Evil | `sanatorium` | no | no | — | **map**: `undefined is not an array, string, or vector` |
| Zombie Desert | `nazi_zombie_test1` | no | no | — | **ours**: `fs_game is write protected` |
| Project Viking | `nazi_zombie_test` | no | no | — | **ours**: `fs_game is write protected` |

**The failures, exactly, in the Com_Error trap's own words:**

- **Leviathan** — `Com_Error(5, ".script runtime error")`, `unknown item 'napalmblob'`, raised from
  `maps/_loadout::init_loadout()` <- `maps/_load::main()` <- `maps/_zombiemode::main()` <-
  `maps/nazi_zombie_leviathan.gsc:23`. Preceded by ~40 `Could not load xanim` lines, all
  `ai_flamethrower_*` / `ai_bonzai_*`. **The 422 MB reserve did not change it**: `map03` raised all
  three sites and the message is byte-identical to `map01`'s. So the board's 17:12 reading — "the
  classic stock-WaW asset-limit overflow that T4M exists to fix" — **is not supported by this
  measurement**. `napalmblob` is a weapon the precache list asks for and the loaded zones do not
  contain.
- **MW2 Rust** and **Clinic of Evil** — the same `undefined is not an array, string, or vector`,
  in each map's own script. Both already carry `missed-silently` scanner verdicts in `archive.md`
  section 3, i.e. we knew their scripts were unusual before tonight.
- **Zombie Desert** and **Project Viking** — `fs_game is write protected.`, then
  `Can't find map "..."`, then `A mod is required for custom maps`. **This is ours and it is
  stateful**: the engine refused our command-line `fs_game` because it was already set and
  write-protected by the time the command line was applied. Leviathan (first in the same batch),
  Der Berg and Clinic of Evil were all fine in that batch, so it is leftover state in the homepath,
  not a property of these two maps. **Not a broken map, and not yet fixed.** First thing to try:
  clear `<fs_homepath>\main\config.cfg` — which archives `fs_game` — before each launch.

After the terminal error every map behaves the same way: the ERR_DROP drops the server to the front
end, the front end re-inits the renderer and re-loads `mod.ff`, the second load of the same mod
hits `Exceeded limit of 1 'snddriverglobals' assets` -> **`Sys_Error`** -> the main thread parks in
the error message loop and `frame::count` stays 0 forever. So **"Exceeded limit of 1
'snddriverglobals'" is a symptom of the restart and never the first cause** — do not chase it, and
do not read it as the `ENW_PRIVATE_PROFILE` failure it resembles. Read the **first**
`Com_Error TRAPPED` line in `<tag>.<map>.enw.log`; `arg3` is the message.

### 11.5 Soak — `join59`, 10 minutes, Der Berg, honest

One 600 s run: Der Berg headless with the big heap on, the escape probe on, and a real client
process launched at it. Server **10.7 s of CPU in 582 s (1.8% of one core)**, RSS **flat at
345 MB**, no `Sys_Error`, no GSC error, `getstatus` answered in 3 s with
`\fs_game\mods/nazi_zombie_derberg`, process alive at the end and killed by the harness.

**And it is not a clean soak.** `com_frameTime` froze at **5662** — 5.6 s in, before the client
ever connected — so the server spent the whole ten minutes in the state of 11.1, and the client
never reached `CS_ACTIVE`. On a custom map the escape happens almost immediately rather than fifty
seconds after a spawn. What the run does prove is the pacer: 59.4 Hz and 1.8% of a core held flat
for ten minutes in a state that used to cost most of a core.

### 11.6 `wait_for_first_player()` — answered

Still waiting, and now with a mechanism rather than a suspicion. It waits on
`level waittill("first_player_ready")`; nothing raises that notify on a dedicated server, while
`all_players_connected` does fire — the referee's `ROUND 1` comes off it. The two threads parked on
it (`_utility.gsc:9539`, `_load.gsc:2256`) stay parked for the whole of every join run including
`join59`. It does **not** stop round 1 and it does **not** stop the map. It is a real difference
between a listen server and ours, it has never cost us a milestone, and it should not be "fixed" by
faking the notify until something is shown to depend on it.

### 11.7 Round 2 — not attempted, and why

Round detection past round 1 needs `between_round_over` (`referee.md` 2.1), which needs
`round_think()` to complete a round, which needs `SV_Frame` to keep running. 11.1 says it does not,
from about fifty seconds after a spawn. **No dev knob was used and none would have helped**: a
console command or a GSC shortcut that ends the round still has to be executed by a script VM that
the server has stopped ticking. Round 2 is downstream of 11.1 and is blocked on it, not on the
referee.

## 12. 2026-09-22, 06:35-07:20 — the frame body escapes through an access violation in the WATER SIMULATION, and it is fixed

### 12.1 Named: an SEH unwind out of a NULL read, once per frame

Section 11 measured the escape and ruled out `longjmp` (correctly) and an SEH unwind
(**wrongly** — 11.2 is retracted in place). The probe that settles it is three additions to
`frame_escape_probe.cpp`, all under `ENW_DEDI_ESCAPE_PROBE=1`:

- a **logging `__except` filter** around our `Com_EventLoop` wrapper. A filter runs in phase 1
  for every exception that propagates past the frame, so it reports unwinds a vectored handler
  cannot attribute. It returns `EXCEPTION_CONTINUE_SEARCH`, so it changes nothing
  (`ENW_DEDI_CATCH_ESCAPE=1` makes it claim the exception instead — a control, not a fix);
- a wrapper on **Com_EventLoop's own `call Sys_GetEvent`** at 0x59B647, splitting the loop from
  the message pump;
- the **faulting context** — registers plus the stack's `.text` chain — for the first six
  exceptions that are not debug prints.

`join61`, stock `nazi_zombie_prototype`, one real client:

```
Com_EventLoop in=3185 out=1871 MISSING=1314
Sys_GetEvent  in=3185 out=3185 MISSING=0        <- the pump is innocent
longjmps=0    seh-through=1314                  <- EXACTLY the missing frames
exception code=C0000005 at 006F3E6A, once per escaped frame
```

**`seh-through` equals `MISSING` to the frame, in every window of every run since.** So every
escaped frame is an SEH unwind out of an access violation. The landing place is in `Com_Frame`
and it explains the whole shape of the bug:

```
0059E4B0  mov eax, fs:[0x2c]          ; the per-thread abortframe
0059E4C1  call 0x7E1894               ; _setjmp3
0059E4CB  jne 0x59E4E3                ; a non-local return SKIPS the body
0059E4D7  call 0x59DCF0               ; the frame body
0059E4DC  add [0x1F964BC], 1          ; "the body returned" -- only on the straight path
0059E4E3: ...                         ; both paths continue here, and Com_Frame RETURNS
```

That is why `ours` and `frame-body-entered` keep ticking at 59 Hz while `Com_Frame-body` reads
0.0 Hz, and why the process never dies: the engine's own handler swallows the fault, the stack
unwinds past the body, `Com_Frame` returns to WinMain, and everything after the fault —
`com_frameTime`, `SV_Frame`, the whole server — is skipped.

**Two traps in the instrument itself, both paid for:**

- **The ENW logger goes out through `OutputDebugString`.** A vectored handler that logs the
  debug strings it sees logs its own line, sees that, logs again: `join60` produced 28 nested
  copies in three milliseconds and the server never answered. The handler now carries a
  re-entrancy guard and ignores strings that look like ours. That also disposes of 11.2's "one
  debug string per escaped frame", which was never the engine narrating anything.
- **Never budget the log by the first N exceptions.** The first six of any run are init-time
  debug prints. Budget by *class*, or the interesting one is never reached. The access
  violations start at exception **#124**.

### 12.2 The cause: the server samples the water simulation, which only the renderer allocates

`join62` logged the faulting context:

```
FAULT eip=006F3E6A edx=00000000 ecx=00000000
callers: 006F3FB9 0046DA85 0041853C 0041918D 00504380 00415DF8 0041A743
         0041AF32 004E896A 004E8E15 00630C6A 00630F4C

006F3E5D  add edx, 0x4dd0a10       ; edx = i * 0x40E0, i in {0,1}
006F3E63  mov edx, [edx]           ; the buffer pointer -- NULL
006F3E6A  movq xmm0, [edx + ecx]   ; <- read of 0x00000000
```

0x6F3E00 interpolates between two ping-pong buffers at **0x4DD0A10** and **0x4DD4AF0**
(= 0x4DD0A10 + 0x40E0). They are allocated by **0x6F13B0**, which is reached only from
**0x70EC00** — the renderer's dynamic-buffer bring-up, the function that carries `Couldn't
create a %i-byte dynamic index buffer`. `dedicated.cpp` skips renderer bring-up at 0x5FF799 on
purpose, so on a headless server those pointers are NULL for the life of the process.

**It is the water simulation.** 0x6F0D90, in the same unit, registers `r_watersim_enabled`,
`r_watersim_debug`, `r_watersim_flatten`, `r_watersim_waveSeedDelay`, `r_watersim_curlAmount`,
`r_watersim_curlMax`, `r_watersim_curlReduce`. **The `r_` prefix is why nobody looked**, and it
is wrong about ownership: the caller chain comes up through 0x630C70, the server's own
per-client work, reached from Com_EventLoop's packet arm. The server samples the water surface
when a player is in or near water, whatever the renderer is doing. That also explains the two
timings that had looked unrelated — about fifty seconds is how long an idle client takes to end
up in the water on prototype, and a custom map can put something there at once.

### 12.3 The fix, and the proof

`server/components/dedicated/watersim_pool.cpp` calls **0x6F13B0** once, from the first frame,
dedicated only. It is the engine's own allocator for this pool: no arguments, guarded by its own
`cmp byte ptr [0x46E568C], 0` so calling it twice is a no-op, six buffers (0x100080, 0x100080,
0x20080, 0x10080, 0x10080, 0x40080 — about 2.2 MB) each `memset` to zero before use. A zeroed
water field is a flat surface, which is what an unseeded simulation reads as anyway, and nothing
headless ever seeds a wave. The component verifies the function's first seven bytes before
calling it and prints the guard byte and all six pointers before and after:

```
dedi_watersim_pool: before: guard=0 [04DD0A10]=00000000 [04DD4AF0]=00000000 ...
dedi_watersim_pool: after : guard=1 [04DD0A10]=0D59B020 [04DD4AF0]=0D6A9020 ...
```

`ENW_DEDI_NO_WATERSIM_POOL=1` is the off switch and brings the escape straight back.

**It was not done with `r_watersim_enabled 0`** because the sampler faults before any dvar test
on that path, and turning a subsystem off is a guess about what else reads it. Allocating the
memory it was always meant to have cannot change any other answer.

#### The second wall, found the moment the first one came down

With the pool in, `join64` simulated for **121 s** — the first time a headless server has kept
`com_frameTime` moving with a player in — and then the game *ended*, correctly:

```
referee: game over at round 1 (stop_intermission notify)
=== Com_Error TRAPPED === called from 0050E21F   arg2 = "Unable to find save."
ShutdownGame:  ->  slot 0 went back to CS_FREE from CS_ACTIVE -- it was dropped
Com_Error "Exceeded limit of 1 'snddriverglobals' assets."  ->  Sys_Error  ->  parked
```

An idle client gets eaten in round one, and T4's single-player death flow reloads the last
save. `SV_LoadGame` 0x62C0D0 tries two lookups and then raises `ERR_DROP` — and a headless
server never wrote a save, because `no_autosave.cpp` makes sure of it. The last two lines are
the restart chain `next-session.md` already warns about, and are a symptom of the first error.

`server/components/dedicated/no_save_reload.cpp` retargets that one `call G_Error` at
**0x62C10D** to a counting `ret`, dedicated only, verifying both the call target and the
caller's own `add esp, 8` at 0x62C112 first — the verified pattern from `no_autosave.cpp`.
**This is not "game over handled":** it keeps the server, the map and the connected clients
alive through a failed reload. Nothing restarts the round; that is a real feature and it is not
built. `ENW_DEDI_ALLOW_SAVE_RELOAD=1` is the control.

#### Two consecutive clean 300 s runs, five gates each

| | `join65` | `join66` |
|---|---|---|
| `CS_ACTIVE` / `referee: ROUND 1` | yes / yes | yes / yes |
| `getstatus` answered | 76 of 76 | 76 of 76 |
| `frame::count` at the end | 59.0 Hz | 59.2 Hz |
| **`com_frameTime` at the end** | **321,127 ms**, +30,001 over the last 30 s | **321,107 ms**, +30,008 |
| **`Com_Frame-body`** (the body returning) | **59.0 Hz** | **59.2 Hz** |
| client at the end | slot 0 `CS_ACTIVE`, unchanged since 06:58:38 | same |
| CPU | 22.6 s over 320 s; 0.2–0.3 s per 5 s in steady state = **4–6% of a core** | same |
| RSS | flat 188 MB | flat 188 MB |
| verdict | **PASS** | **PASS** |

Both ran through game over and out the other side with the client still connected.

### 12.4 The fifth gate, in the harness

`jointest-proof.ps1` now fails a run whose engine has stopped, which is the gap
`next-session.md` asked for. It reads the **last** `dedi_rate_probe` line and requires

- `Com_Frame-body` > 0 Hz (`[0x1F964BC]` at 0x59E4DC — the counter only a returning body
  reaches), and
- `com_frameTime` to have **advanced across rate-probe lines**.

**Do not gate on the probe's own `delta=` field.** It reads 0 on a perfectly healthy server: it
compares `com_frameTime` with a copy taken in the same breath. The harness compares the last
line with the one six windows (30 s) earlier instead. A failing run now names the gate:
`failed gates: THE ENGINE STOPPED SIMULATING (com_frameTime frozen / frame body not returning)`.

`jointest.ps1`'s log collection was also wrong, and had been for at least a session:
`join59.server.console.log` is **byte-identical to the client's**, because `$conSub` was built
from `fs_game` and the server's console had moved. So the dedicated server's own console output
had never actually been read on a custom-map run. It now searches the whole home for
`console.log`, takes the newest, prints the path it came from and the `Working directory:` line
inside it, and warns in red when that names a different game copy.

### 12.5 Der Berg: the same mechanism, a different fault — named, not fixed *(RETRACTED — see §13.1. The conclusion "a dvar the dedicated server never registered" is wrong: the dvar exists, the engine registers it, and the slot is later overwritten by a GSC local-variable overflow. The measurements below stand; the diagnosis does not.)*

`join67`, Der Berg, 300 s: the pool is allocated (`[04DD0A10] -> 0D5AD020`) and the server
**still** stops, at `com_frameTime=5666`, 5.6 s in, before the client reaches `CS_ACTIVE`. Same
*mechanism* (`join68`: `seh-through` = `MISSING` = 4,383, `Sys_GetEvent` in == out,
`longjmps=0`), **different fault**:

```
FAULT eip=005FFE23 eax=00002733 ecx=00000000
callers: 0059B51A 0059B55F 0059B6EB 0059DD95 0059E4DC 005FF7C2

005FFE1D  mov ecx, [0x3BFD478]       ; a dvar_s* -- NULL
005FFE23  cmp byte ptr [ecx + 0x10], 0
```

0x5FFDB0 is the packet receive, called from Com_EventLoop's tail (0x59B420 and 0x59B4F0, i.e.
past 0x59B6EB). A socket error — `eax` is 10035 / `WSAEWOULDBLOCK`, and the branch above tests
0x2746 = 10054 / `WSAECONNRESET` — takes a path that reads **a dvar the dedicated server never
registered** and dereferences NULL. That is the same class as the three dvars `dedicated.cpp`
already re-flags at startup. The next session should find out which dvar `[0x3BFD478]` is and
register it, rather than patch the read. Stock maps do not reach it in 320 s; Der Berg does in
5.6 s.

`join67` numbers for the record: 7.0 s of CPU over 300 s (**2.3% of a core**), RSS flat 346 MB,
no `Com_Error`, no `Sys_Error`, process alive at the end — a stopped server that is cheap rather
than expensive, exactly as 11.3 said it would be.

## 13. 2026-09-22, 07:20–09:00 — Der Berg is a script-VM overflow, not a dvar; and `Can't find map` was never `fs_game`

### 13.1 RETRACTION, in place: §12.5's "a dvar the dedicated server never registered" is wrong

§12.5 read the Der Berg fault correctly and drew the wrong conclusion from it. The fault is real:

```
005FFE0A  call 0x75A94E                ; WSAGetLastError
005FFE0F  cmp eax, 0x2733              ; 10035 WSAEWOULDBLOCK
005FFE14  je  0x5FFE1D
005FFE1D  mov ecx, [0x3BFD478]         ; a dvar_s*
005FFE23  cmp byte ptr [ecx + 0x10], 0 ; <- the access violation
```

and the dvar was found. The image contains **exactly one** write to that slot — one
`mov [0x3BFD478], eax`, and no indexed form with that base:

```
006ED650  push edi
006ED651  push 0x89FD08              ; "Generate cube maps for reflection probes."
006ED656  push 0                     ; flags
006ED658  xor al, al                 ; value = false
006ED65A  mov edi, 0x89FD34          ; "r_reflectionProbeGenerate"
006ED65F  call 0x5EEE20              ; Dvar_RegisterBool(name@edi, value@al, flags, desc)
006ED664  mov [0x3BFD478], eax
```

So `[0x3BFD478]` is **`r_reflectionProbeGenerate`**, a bool, default false, no flags, registered by
0x6ED650 — a no-argument cdecl reached only from 0x5E3CA0 and 0x70B358, both inside the renderer
bring-up `dedicated.cpp` skips at 0x5FF799. The read is the engine's "are we baking cube maps?"
test, which tolerates a dead socket instead of reporting it.

`server/components/dedicated/reflection_probe_dvars.cpp` calls 0x6ED650, verifying its first eight
bytes first, so the type, default, flags and description are the engine's own. All three dvars
register, the log walks each `dvar_s`'s name pointer back to the string the engine pushed, and all
three say `name OK`.

**`join69` (Der Berg, 300 s, five gates): FAIL.** Identical stop, `com_frameTime` frozen at 5659,
`Com_Frame-body 0.0 Hz`. And the fault register had changed:

| run | ecx at 0x5FFE23 |
|---|---|
| `join68` (before the fix) | `00000000` |
| `join69` (after) | `00000FE9` |
| `join71` | `00000F34` |

A garbage pointer, not a null one — and one that changes between runs. So something **writes** to
that slot, which no static search could find, because nothing in the image does.

### 13.2 The write watch, and the real mechanism

`ENW_DEDI_WATCH_PROBE_SLOT=1` puts a **data breakpoint** on the slot: DR0 = 0x3BFD478, DR7 asking
for a 4-byte write watch, armed from a helper thread that suspends the game thread (you cannot
reliably set your own debug registers), and a vectored handler that reports the faulting EIP — the
instruction *after* the store. `join72`:

```
dedi_reflection_dvars: WRITE #1 to [0x03BFD478] -- the store is just before eip=00697B99.
  eax=0000ECD0 ebx=03BFD478 ecx=03BD4700 esi=00000F34 edi=00000107 ... slot now 00000F34
  bytes: 8B 19 | 03 C2 | C1 E0 04 | 0F B7 B0 00 47 97 03 | 89 33 | 0F B7 80 02 47 97 03
```

and the function it lands in is 0x697B60:

```
00697B71  imul ecx, ecx, 0x4320       ; sizeof(scrVmPub_t) -- verified in t4-sp-map.md
00697B79  lea  ecx, [ecx + 0x3BD4700] ; &gScrVmPub[inst]
00697B7F  imul edx, edx, 0x16000      ; the per-instance variable table stride
00697B86  add  dword ptr [ecx], 4     ; scrVmPub.localVars++      <-- the scratch pointer
00697B89  mov  ebx, dword ptr [ecx]
00697B8D  shl  eax, 4                 ; 16-byte variable rows
00697B90  movzx esi, word ptr [eax + 0x3974700]   ; this child's name id
00697B97  mov  dword ptr [ebx], esi   ; <<< THE STORE. No bound check.
00697B99  movzx eax, word ptr [eax + 0x3974702]   ; next sibling
00697BA5  jne  0x697B86               ; ...and round again
```

0x697B60 walks a script object's **child variables** and pushes each one's name id into
`scrVmPub.localVars`. The loop's only exit is running out of siblings. Der Berg enumerates
something with about **3,900 children** (0xF34 in `join72`, 0xFE9 in `join70` — it varies with the
run, which is what a live object count does), the scratch is sized for a few dozen, and the overrun
walks 0x28D78 bytes past `gScrVmPub` into `.bss`, where the first thing it hits is the
`r_reflectionProbeGenerate` pointer.

**The order of events, then:**

```
a GSC enumeration overflows the VM's local-variable scratch
  -> the overflow writes a count over [0x3BFD478]
    -> the next WSAEWOULDBLOCK in the packet receive dereferences that count
      -> the frame body unwinds (§12.1's mechanism, unchanged)
        -> com_frameTime stops, 5.6 s in
```

The dvar was the **victim**, never the cause. "Find the dvar and register it" could not have
worked, and §12.5 is retracted in place.

**`reflection_probe_dvars.cpp` stays**, because the slot really was NULL at `post_init` in `join69`
and a NULL there is a fault waiting for the first socket error on *any* map — but it must not be
described as the Der Berg fix, and its own header now says so. The Der Berg fix is a bound on
0x697B60's push loop or a larger `localVars`, which is an engine-limit job — the class of thing
T4M exists to raise — and it is not attempted here.

**For `re`**: 0x697B60 is the child-variable enumeration that fills `scrVmPub.localVars`;
`gScrVmPub` is at **0x3BD4700**, stride 0x4320, with `localVars` (or whatever the field is called on
this build) as the **first dword**; the variable table is at **0x3974700**, 16-byte rows, per-script-
instance stride 0x16000, with the name id at +0 and the next-sibling index at +2, both `uint16`.
`Cbuf_AddText` = **0x594200**, `text` in `eax` and `localClient` in `ecx`, nothing on the stack
(`referee.md` §10.4).

### 13.3 `Can't find map` was never about `fs_game`, and the write-protected line is a red herring

§11.4 blamed Zombie Desert's and Project Viking's failure on the line printed just above it:

```
      dvar set fs_game mods/nazi_zombie_test1
fs_game is write protected.
Error: Can't find map "nazi_zombie_test1".
A mod is required for custom maps
```

and proposed clearing `<fs_homepath>\main\config.cfg`. **Both halves are wrong.** There is no
`config.cfg` anywhere under `ZombiesDev\homes` — never has been — and **every** map prints
`fs_game is write protected`, including the ones that boot. It is the engine re-applying our `+set`
block after the dvar dump; `fs_homepath`, `sys_configureGHz` and `dedicated` print the same
complaint in the same block on Der Berg, which boots fine.

The real check is on disk and does not use the FS search path at all:

```
0062B592  cmp byte ptr [eax + 0x10], 0   ; the `useFastFile` dvar at [0x1F552FC] -- 1
0062B607  push 0 / call 0x48FC10         ; <basepath>\zone\<lang>\<bsp>.ff
0062B623  push 1 / call 0x48FC10         ; <fs_localAppData>\<fs_game>\<bsp>.ff
0062B635  push 2 / call 0x48FC10         ; <fs_localAppData>\<fs_game>\usermaps\<bsp>\<bsp>.ff
0062B650  push 0x886374                  ; `Can't find map "%s".\nA mod is required for custom maps`
```

0x48FC10 builds the path with 0x48E3D0 and opens it with `CreateFileA`. Mode 1's first component
comes from the dvar at `[0x2122AF0]`, and that dvar is registered at 0x5DDFD8 as
**`fs_localAppData`** — `%LOCALAPPDATA%\Activision\CoDWaW`. **Not** `fs_homepath`, which is the one
`launch.ps1` redirects per game copy.

So a custom map is only "found" when its fastfile is at
`%LOCALAPPDATA%\Activision\CoDWaW\mods\<bsp>\<bsp>.ff`. Der Berg, Leviathan, Clinic of Evil and
MW2 Rust already had an entry there from an earlier session. Zombie Desert and Project Viking did
not. **That is the entire difference**, and it is ours, not the maps'.

`tools\dev\mapmount.ps1` is the fix, dot-sourced by both `jointest.ps1` and `maptest.ps1`: one
`Mount-EnwMap` that makes *both* junctions — the per-home one the search path needs and the
`fs_localAppData` one the existence check opens — onto `archive\mods\<bsp>`, and then prints the
exact path the check will open, in green if it is there and in red with the error message the
engine is about to print if it is not. Nothing is copied and the archive's own files are never
written by it.

`jointest-proof.ps1` also grew `-Map`, `-BigHeap` and `-Deploy`, because the five-gate proof was
prototype-only and a custom map could never be taken through it.

## 14. 2026-09-22, 09:10–10:30 — the six "broken" maps were not broken by us, and three other customs play

### 14.1 The claim I was sent to break, and the two hypotheses that died

§13 and `next-session.md` left six custom maps marked `status: "broken"`, four of them on the
**same** error — a map script touching `level.flag` before `maps/_load.gsc`'s `flag_init` has run —
and one (Der Berg) on an unbounded push into `scrVmPub.localVars`. One shared cause on *our* side is
a far better prior than five independently broken maps, so two hypotheses were put up:

1. **Ordering / overlay** — our referee GSC overlay, or the way `dedicated.cpp` starts the level,
   runs flag-dependent code before the map's `_load::main()`.
2. **Enumeration** — the replay sampler's `zombies_alive` / kill-from-entity-state read, or the
   referee's per-frame state read, is what walks ~3,900 child variables on Der Berg.

**Both are dead, and they were killed by runs, not by reading.**

### 14.2 Hypothesis 1 is dead: the four maps fail identically on a STOCK exe

`maptest.ps1` grew three arms, because the only honest way to ask "is this ours?" is to take ours
away and run the map again:

| arm | what it does |
|---|---|
| `-NoSamplers` | `ENW_NO_SAMPLERS=1`: the referee does not hook `SV_Frame`, the replay sampler does not arm. The dedicated server still runs. |
| `-Listen` | `dedicated 0`, role `solo` — the engine's own listen-server path, the one the community plays these maps on. |
| `-NoEnw` | `deploy.ps1 -Revert` for the duration: **zero ENW code in the process**. Implies `-Listen`, and the proxy goes back in a `finally`. |

Run **`mapA`** is the control the last three sessions kept asking for and nobody ran: all four maps,
`-NoEnw`, on a stock `CoDWaW.exe` listen server. **All four produce the same script runtime error,
in the same file, at the same line:**

```
mapA  nazi_zombie_test1  common_scripts/utility.gsc:463  while( !level.flag[ msg ] )
                         <- maps/zombie_hitmarker.gsc:38      flag_wait( "all_players_connected" )
                         <- maps/nazi_zombie_test1.gsc:136    thread maps\zombie_hitmarker::main()
                         <- maps/nazi_zombie_test1.gsc:9      main()
mapA  nazi_zombie_test   <- maps/_zombiemode_ai_mech.gsc:38   flag_wait("all_players_connected")
                         <- maps/_zombiemode.gsc:40           level thread ..::mech_init()
mapA  mw2rust           <- maps/mw2rust.gsc:179              flag_wait( "electricity_on" )
                         <- common_scripts/utility.gsc:586    array_thread
                         <- maps/mw2rust.gsc:119              array_thread( end_trig, ::end_game )
mapA  sanatorium        <- maps/_zombiemode_rotating_door.gsc:34  !IsDefined( level.flag[...] )
                         <- maps/_zombiemode_rotating_door.gsc:24  array_thread( rotating_doors, ... )
                         <- maps/sanatorium.gsc:21            maps\_zombiemode_rotating_door::init()
```

There is no ENW DLL in those processes. There is no dedicated server in those processes. **The
maps do this on their own**, and hypothesis 1 is refuted.

**And the shape is one thing, not four.** Every one of these maps' own `main()` starts a
flag-dependent thread **before** it calls `maps\_zombiemode::main()`, and `_zombiemode::main()` is
what calls `maps\_load::main()`, which is where `flag_init( "all_players_connected" )` lives. Read
straight out of the maps' own raw GSC in their IWDs:

```
nazi_zombie_test1.gsc:136  thread maps\zombie_hitmarker::main();   <- the author's own comment
nazi_zombie_test1.gsc:143  maps\_zombiemode::main();                  above line 113 reads
  its _zombiemode.gsc:51   maps\_load::main();                        "FUNCTION CALLS - PRE _Load"
mw2rust.gsc:119            array_thread( end_trig, ::end_game );
mw2rust.gsc:122            maps\_zombiemode::main();
nazi_zombie_test           _zombiemode.gsc:40 threads mech_init; _load.gsc:99 has the flag_init
sanatorium.gsc:21          rotating_door::init() at the top of main()
```

A `thread` in T4 GSC begins executing immediately and runs until it yields; `flag_wait`'s first act
is to index `level.flag`, so it faults before anything can have created the array. **Why the
community plays these maps anyway is still not established** — the most likely answer is that the
archived downloads are repacks (Zombie Desert's `flag_wait` is inside
`zombie_hitmarker_bythesuzho.iwd`, a third-party add-on sitting loose in the mod folder), but that
is inference and it is written down as inference. What is *measured* is that it is not ours.

### 14.3 Hypothesis 2 is dead: Der Berg overflows with our samplers switched off

`ENW_NO_SAMPLERS=1` leaves the engine completely alone — no `SV_Frame` hook, no per-frame entity
read, no replay snap. Run **`mapB`**, Der Berg, dedicated, big heap, held 30 s:

```
mapB  nazi_zombie_derberg  alive=True  getstatus=True
      engine clock: com_frameTime +0 ms over 8 probes (last 5651)
      THE ENGINE STOPPED SIMULATING -- com_frameTime frozen
```

5651 ms, against 5659 / 5662 in `join69` / `join59` with everything on. **Identical stop with
nothing of ours running inside the game loop**, so the ~3,900-child enumeration at 0x697B60 is the
map's script, not our sampler. §13.2's mechanism stands; §13.2's *blame* was never ours to take.

Reading the code says the same thing and should have been said earlier: `referee::zombie_ents()`
walks `g_entities[4..1024]` and reads `gentity_s` fields directly, `scriptvars` has been `no` in
every run this project has ever done, and the `level.*` child-variable probe is opt-in behind
`ENW_LEVELVARS=1` and has been off since it scored zero. **We have never called 0x697B60.**

### 14.4 The mount is confirmed, and the harness already does it

`mapmount.ps1`'s `fs_localAppData` finding is correct and every run above depends on it. `maptest.ps1`
and `jointest.ps1` both dot-source it and call `Mount-EnwMap` unconditionally, so it *is* the default;
the line it prints (`map-exists check will find %LOCALAPPDATA%\Activision\CoDWaW\mods\<bsp>\<bsp>.ff`)
appeared before every boot in `mapA`, `mapB` and `mapC` and no map failed the existence check again.

**One thing it does that is worth knowing**: the junction means `fs_homepath\mods\<bsp>` *is*
`archive\mods\<bsp>`, so the engine writes its `console.log` into the archive folder. Nothing of ours
writes there, but the engine does. Harmless; do not mistake it for the crawler.

### 14.5 Two harness bugs fixed while bisecting

* `maptest.ps1` held a booted map for a fixed 8 s, which is less than Der Berg's 5.6 s stop plus one
  `dedi_rate_probe` window, so a map could "pass" a boot test on a server that had already stopped
  simulating. `-HoldSeconds` (default 8, use 30) and a **fifth-gate readout** — `com_frameTime`
  differenced across the probe lines in the copied `enw` log — are in it now, and the summary prints
  it per map.
* Its "first error" heuristic matched `Sys_Error` **in our own log lines**
  (`dedi_error_trap: Sys_Error trapped at 0x005FE8C0`), so run `mapC` attributed that to all eight
  maps as their first cause. `[enw]` lines are filtered out before the search now. A harness that
  misattributes a cause is worse than one that reports none.

### 14.6 The six-map table, and A CUSTOM MAP FINALLY PASSES THE FIVE GATES

"overlay off" means a stock `CoDWaW.exe` with the proxy reverted and no ENW code at all
(`maptest.ps1 -NoEnw`, which implies `-Listen`). "sampler off" means our dedicated server with
`ENW_NO_SAMPLERS=1`. A cell marked *not run* says so and says why.

| Map | bsp | overlay off | sampler off | both on | verdict |
|---|---|---|---|---|---|
| Zombie Desert | `nazi_zombie_test1` | **same GSC error** (`mapA`) | not run — the map dies at level load, before a sampler frame exists; the stock-exe arm is strictly stronger | same GSC error (`map05`) | **broken, map's own script** |
| Project Viking | `nazi_zombie_test` | **same GSC error** (`mapA`) | as above | same (`map05`) | **broken, map's own script** |
| MW2 Rust | `mw2rust` | **same GSC error** (`mapA`) | as above | same (`map01`) | **broken, map's own script** |
| Clinic of Evil | `sanatorium` | **same GSC error** (`mapA`) | as above | same (`map01`) | **broken, map's own script** |
| Der Berg | `nazi_zombie_derberg` | not run — the stop is inside the script VM 5.6 s in and the sampler-off arm already excludes us | **still stops, `com_frameTime=5651`** (`mapB`) | stops, 5659 / 5662 (`join69` / `join59`) | **broken, map's own script** |
| Leviathan | `nazi_zombie_leviathan` | **not run this session** | not run | `unknown item 'napalmblob'` from its own `_loadout::init_loadout()` (`map01`, `map03`) | **broken on the existing evidence; one `-NoEnw` run would settle it** |

**All six keep `status: "broken"`, and every one of them is broken by the map.** Nothing was
overturned because nothing of ours was ever in the way; what is overturned is the *suspicion*, and
the manifests now carry the run that killed it.

**Then run `mapC` asked the question nobody had asked: are there customs that DO work?** Eight
archived maps that had never been booted, dedicated, big heap, held 30 s:

| Map | bsp | boots | getstatus | engine still simulating | first cause if not |
|---|---|---|---|---|---|
| Minecraft Village Remastered | `nazi_zombie_fear_mc_2` | yes | yes | **yes**, `com_frameTime` +35,027 ms | — |
| ORBIT | `nazi_zombie_orbit` | yes | yes | **yes**, +34,988 ms | — |
| UGX Requiem | `ugx_artemovsk` | yes | yes | **yes**, +35,022 ms | — |
| Water | `water` | no | no | — | `Need 89174697 more bytes of 'main' physical ram` — out of memory **with** the 422 MB reserve |
| Zombie School | `nazi_zombie_school` | no | no | — | `cannot cast undefined to string`, `_zombiemode_weapons.gsc:351` <- `init_weapon_upgrade()` — a weapon spawn with no `target` |
| Hijacked | `nazi_zombie_hijacked` | no | no | — | the same, `_zombiemode_weapons.gsc:412` |
| Octogonal | `nazi_zombie_octogonal` | no | no | — | `Exceeded limit of 1 'snddriverglobals' assets` as the **first** trapped error, not as a restart symptom — its `mod.ff` carries a second singleton |
| DT2 | `nazi_zombie_dt2` | no | no | — | `entity already has linkTo enabled` (already known) |

**`join83`: `nazi_zombie_fear_mc_2`, 300 s, five gates, PASS.** The first custom map ever to do it:

```
join83  CS_ACTIVE=1   referee ROUND 1
        76 of 76 getstatus answered, 0 unanswered after the first
        frame::count +293 in 5 s = 58.6 Hz
        com_frameTime advanced 30031 ms over the last 30 s, Com_Frame-body 58.4 Hz
        server RSS 323 MB flat                                              PASS
```

### 14.7 ORBIT and UGX Requiem: the server is proven, the CLIENT is the blocker

`join80` (ORBIT) and `join81` (UGX Requiem) both went the same way, and it is worth being precise
about which half failed:

```
join80  gates 2-5 PASS over 320 s: 76/76 getstatus, 59.0 Hz, com_frameTime +30,013 ms,
        Com_Frame-body 59.0 Hz, server RSS 353 MB flat
        gate 1 FAIL: CS_ACTIVE=0, ROUND1=0
join81  identical shape: 76/76, 59.4 Hz, +29,996 ms, server RSS 366 MB
```

The server was never the problem. The **client** was:

```
08:29:05  slot 0 CS_CONNECTED      name="anna-jpg"
08:29:06  slot 0 CS_CLIENTLOADING
          client: Loading fastfile 'nazi_zombie_orbit'  (128.38 MB in DB alloc)
          ... and then nothing. CPU flat from t=25 s, RSS 1.62 GB.
08:29:51  slot 0 CS_ZOMBIE -> CS_FREE -- it was dropped
```

Against `nazi_zombie_prototype`, where the client sits at **860 MB and its CPU keeps climbing**.
`nazi_zombie_fear_mc_2` has a client that keeps working and passes, so this is **not** systemic and
it is **not** a property of the dedicated server: it is a 32-bit client and a large custom zone.
`ENW_DEDI_BIG_HEAP` is inherited by the client in a `jointest` run, so the 422 MB reserve was
already in effect and did not help. **Neither map gets `status: "broken"`** — nothing has been
shown to be wrong with either of them. `dedi_status` is `server_ok_client_blocked`, and the next
step is the client lane's, not this one's.

### 14.8 Two more harness bugs, both of which cost time in this session

* **`jointest.ps1` collected a stale client console log.** `Get-ChildItem -Recurse` does not follow
  directory junctions, and a custom map's console log is *behind* one (`homes\<copy>\mods\<bsp>` is
  a junction onto `archive\mods\<bsp>`). So the newest `console.log` it could see under the client
  home was the one in `main\` from an old prototype run — and `join80` was read for fifteen minutes
  as "the client loaded `nazi_zombie_prototype`" before the file turned out to be a week old. Both
  logs are now deleted before the run and the mod-folder one is opened by its explicit path.
* **And the two homes share one console log.** Both `homes\d2\mods\<bsp>` and `homes\c1\mods\<bsp>`
  are junctions onto the *same* archive folder, so the server and the client write the same file.
  **That, and not the path computation, is why `join59`'s two console logs were byte-identical** —
  §11.4's note about that is corrected here. `jointest.ps1` says so out loud at the top of every
  custom-map run. (It also means the engine writes into `archive\mods\<bsp>`; `mapmount.ps1` never
  writes there, but the game does.)
* **`jointest-proof.ps1` threw while waiting for the lock.** `Get-Content $lock -Raw` returns
  `$null` when the holder releases between the `Test-Path` and the read, and `.Trim()` on it killed
  `join84` after it had waited correctly for three minutes — and took its own `Start-Job` and the
  running game down with it, leaving a stale lock behind. The read is guarded now.

## 15. 2026-09-23 — the add-on-IWD theory, and two harness faults that had to be fixed first

Full working in `archive.md` §9; this is what the dedi lane needs to carry.

### 15.1 `launch.ps1` was committed with a parse error, so no harness could run

`tools\dev\launch.ps1` lines 612–614 were in the tree as:

```powershell
    if ( -eq '1') {
         = Join-Path  'localappdata'
    } else {  =  }
```

Every variable reference had been stripped out of the block. That is not a bug that misbehaves, it
is a **PowerShell parse error**: `launch.ps1` would not run at all, and neither would `maptest.ps1`,
`jointest.ps1` or anything else that calls it. Restored from the comment above it and from
`mapmount.ps1`'s matching switch:

```powershell
    if ($env:ENW_USE_PRIVATE_LOCALAPPDATA -eq '1') {
        $env:ENW_LOCALAPPDATA = Join-Path $homeDir 'localappdata'
    } else { $env:ENW_LOCALAPPDATA = $env:LOCALAPPDATA }
```

All five harness scripts are now checked with `[Parser]::ParseFile` and parse clean. **Worth doing
before any session that edits them**; it costs a second and it caught this.

### 15.2 The private-LocalAppData redirect needs `players\profiles` seeded, or no map ever starts

Today's hard rule is that nothing of ours writes into B's `%LOCALAPPDATA%\Activision\CoDWaW`, so
every run in this session used `ENW_USE_PRIVATE_LOCALAPPDATA=1`. Two things had to be true first:

1. **The DLL in the copy must carry `enw_localappdata`.** `build\dedi\enw_t4.dll` did not — the
   component post-dates it — and `mapmount.ps1` warns about exactly this. Rebuilt; the check is a
   string search for `enw_localappdata` in the DLL, and the proof in the run is the line
   `enw_localappdata: SHGetFolderPathA redirected 2 time(s) -> '…\homes\d2\localappdata'`.
2. **The private tree must contain `Activision\CoDWaW\players\profiles`.** With it empty, every
   map — all four tried, listen and dedicated alike — got as far as `Loading fastfile 'mod'`, went
   to the menu, and then re-entered client init: a **second** `code_post_gfx` + `mod` load and
   `Error: Exceeded limit of 1 'snddriverglobals' assets.` at t≈1.6 s, with `frame::count=0`. No
   `------ Server Initialization ------` line at all.

That second symptom is a trap worth naming, because `snddriverglobals` is **also** the restart
symptom that follows a *normal* map failure (§14.6 flagged it for Octogonal). The way to tell them
apart is the `Server Initialization` line: after it, the double load is the map dying and restarting;
before it, the map never started and the error is the harness's. Seeding the profiles directory by
copying B's out — read-only, copy out, never write in — fixed it, and run `addon5` then reproduced
Zombie Desert's known `common_scripts/utility.gsc:463` fault exactly.

### 15.3 The result, in one table

Baseline `addon5`; interventions `addon6` (staged installs) and `addon7` (as shipped). All
dedicated, `-BigHeap`, 20–30 s hold, private LocalAppData verified in effect on every run.

| Map | intervention | outcome |
|---|---|---|
| Zombie Desert `nazi_zombie_test1` | add-on's GSC dropped, its assets kept | **worse**: `Server script compile error / Could not find script 'maps/zombie_hitmarker'` — the map's own script calls into the add-on |
| MW2 Rust `mw2rust` | both third-party IWDs excluded | unchanged: `flag_wait("electricity_on")`, `maps/mw2rust.gsc:179` |
| Clinic of Evil `sanatorium` | five empty (22-byte) IWDs excluded | unchanged: `maps/_zombiemode_rotating_door.gsc:34` |
| Project Viking `nazi_zombie_test` | nothing to exclude — no add-on exists | unchanged |
| Der Berg `nazi_zombie_derberg` | nothing to exclude — no add-on exists | unchanged: `com_frameTime +0 ms, last 5651` (mapB said 5651) |
| Leviathan `nazi_zombie_leviathan` | the missing `<bsp>_patch.ff` supplied | loaded (`Loading fastfile 'nazi_zombie_leviathan_patch'`, was `'default'`); `unknown item 'napalmblob'` unchanged |

**Customs passing the five gates: still one** (`nazi_zombie_fear_mc_2`, `join83`). Nothing here
earned a five-gate run, because nothing got past its load-time error.

### 15.4 One fact that is new and is not about these six maps

`Could not find script 'maps/zombie_hitmarker'` was produced by deleting a `.gsc` **out of an IWD**.
So **stock WaW loads raw GSC from mod-folder IWDs, and that raw copy is the one that executes** —
it is live code, not leftover source the author forgot to strip. Every custom map in the archive
that ships a `maps/` tree inside its IWD is running that tree, which is why the engine's error line
numbers have matched the IWD's raw files exactly in every trace since §13.

## 16. 2026-09-23 — the four `flag_wait` maps are not broken; `+set logfile 2` is

Full working in [`scripts.md`](scripts.md). This is what the dedi lane has to carry.

### 16.1 RETRACTION, in place: §14.2's stock-exe control was not a retail launch

§14.2 ran the four maps on a **stock `CoDWaW.exe`** with the binkw32 proxy reverted, got
the byte-identical script runtime error, and concluded "the maps do this on their own …
nothing in this lane can fix it". The first half is right. The second half is wrong, and
the reason is in the run's own command line:

```
+set dedicated 1 +set zombiemode 1 +set logfile 2 …
```

`maptest.ps1 -NoEnw` removes our DLL and keeps `+set logfile 2`. So does `launch.ps1`,
`jointest.ps1`, `dediprobe.ps1` and `launcher\src\main\launch.js`. Every measurement this
project has ever taken of a custom map was taken with `logfile` on, and **`logfile` is
not a passive dvar**:

```
0059C840  mov eax, [0x1F55288]      ; `developer`
0059C84D  mov ecx, [0x1F552BC]      ; `logfile`
0059C880  mov byte [0x3882B76], al  ; scrVarPub.developer     = developer || logfile
0059C885  mov byte [0x3BD4715], cl  ; scrVmPub.abort_on_error = developer
```

`Com_SetScriptSettings` 0x59C840 puts the script VM into **developer mode** when either
one is set. `Scr_ErrorInternal` 0x693CF0 then promotes an ordinary script runtime error
to `scrVmPub.terminal_error` — the store at **0x693D35**, which is reachable only under
that flag — and `RuntimeError` 0x68B790 turns `terminal_error` into
`Com_Error(5 = ERR_SCRIPT_DROP)`. With both dvars clear, `RuntimeError` returns in
silence at 0x68B7B9, the VM repairs the thread's operand stack at 0x6971D6, and the
thread carries on. `flag_wait` spins until `_load::main()` creates `level.flag`, and the
map plays.

**That is why the community plays these maps**, and §14.2 could not see it because the
control run carried the cause.

### 16.2 The three runs

```
scr01  nazi_zombie_test1, dedicated, logfile 2, ENW_NO_SCRIPT_ERROR_RETAIL=1
       Com_Error TRAPPED  arg1 = 00000005  "undefined is not an array, string, or vector"
       ----- Server Shutdown -----          getstatus never answered

scr02  identical, ONLY `logfile 0`, still no patch of any kind
       alive=True  getstatus=True  com_frameTime +35001 ms over 8 probes

scr03  logfile 2 + shared/core/components/script_error_retail.cpp
       nazi_zombie_test1 +34994 ms   nazi_zombie_test +35007 ms
       mw2rust           +35002 ms   sanatorium       +34994 ms
       all four alive, all four answering getstatus, and the full
       ******* script runtime error ******* trace still in console.log
```

One dvar between `scr01` and `scr02`, and no code change in either. `scr02` is the run
that does not reproduce.

### 16.3 The fix, and why it is seven NOPs and not a dvar change

`script_error_retail.cpp` NOPs the promotion store at 0x693D35 after verifying its bytes
and `RuntimeError`'s prologue. It keeps `scrVarPub.developer` set, so `console.log` still
gets the whole error trace — **we lose the kill and keep the diagnostics**. The other four
writers of `terminal_error` (memory-allocation failure, the two variable-table exhaustion
sites, `Scr_TerminalError`) are untouched, so a genuinely unrecoverable VM state still
ends the game. The store cannot execute on a retail launch, so removing it cannot change
retail behaviour.

It is in `shared/core/components/`, not here, because a listen game and Play Local die in
exactly the same place. `ENW_NO_SCRIPT_ERROR_RETAIL=1` is the control arm, and
`maptest.ps1` gained `-LogFile` and `-NoScriptFix` so both halves reproduce in one command.

### 16.4 What this does NOT reach

Der Berg's `localVars` overrun (§13.2), Octogonal's `snddriverglobals` singleton and
Water's memory reserve are engine-limit failures of the class T4M exists to raise, and
none of them goes through `Scr_Error`. They are unchanged by this and stay unfixed.

### 16.5 A trap for every lane

**`+set logfile` changes engine behaviour, not just output.** It is the second dvar with
that property this project has found, and unlike `+set developer 1` (README rule 5) it
was in every launch line in the repo and in the shipped launcher. If a future bisect
wants a genuinely stock control, it needs `-NoEnw` **and** `-LogFile 0`.

## 17. 2026-09-22, 19:30 — a dedi must never sit behind a MessageBox ("Set Optimal Settings?")

**Incident (box, 19:07 local / 18:07 UTC).** inst-02, booted 2 s after another instance was
retired, raised *"Set Optimal Settings?"*; the main thread never reached the frame loop
(frames=0 for 160 s, `waw-inst-02/enw-1356.log`) while a player dialled it. Invisible under
Xvfb; `xdotool key Escape` freed it at once. The host-agent belt (`watchStartupDialog`, Escape
after 12 s without `map_loaded`) is already on the box; this is the DLL fix.

**The call site** (decrypted 1.7 image, `tools/re/t4map.py`):

| addr | what |
|---|---|
| `0x59C7C0` | if `com_recommendedSet` (dvar ptr `0x1F96490`) is 1 → `call 0x59BCE0; test al,al; je` — **false skips applying `configure.csv`** |
| `0x59BCE0` | checksum = (hash of the `configure.csv` bytes `& 0x0FFFFFFF`) + 1, then `0x5FE410` |
| `0x5FE410` | if saved `sys_configSum` ≠ 0 and ≠ checksum → ask `0x5FE250`; store the new checksum either way |
| `0x5FE250` | `MessageBoxA(GetActiveWindow(), WIN_CONFIGURE_UPDATED_BODY, _TITLE, 0x44 /*MB_YESNO\|MB_ICONINFORMATION*/)`, returns `== IDYES` |

**So IDNO keeps the saved settings** (recommended set not applied, new checksum stored, startup
continues) — the same answer `launch.ps1` has always given. Note the checksum is a hash of
`configure.csv`, **not** of the hardware: `sys_configureGHz` (0.0448 measured) never enters it,
and the command line already passes `+set sys_configureGHz 1` to no effect. The saved value on
inst-02 is `206167614`. Why the recomputed sum differed on a reboot 2 s after a retire is
**unproven**; the likeliest reading is that the `configure.csv` read failed or came back short
under contention (a failed read hashes to 0 → checksum 1).

**The fix: `server/components/dedicated/no_msgbox.cpp`.** IAT hook on USER32 `MessageBoxA`
(IAT `0x7EB33C`, 11 engine call sites; the exe does not import `MessageBoxW` — tried, logged as
"not imported"). Armed only when the command line carries `dedicated 1|2`, in `post_load`; a
player's client is never hooked. Every box is logged (`ENW_WARN` + a `warn` on the game link:
caption, text, flags) and answered at once: YESNO/YESNOCANCEL → **IDNO**, OKCANCEL/RETRYCANCEL →
IDCANCEL, ABORTRETRYIGNORE → IDIGNORE, CANCELTRYCONTINUE → IDCONTINUE, OK → IDOK (a fatal box
then lets the process exit and be replaced instead of hanging). Off: `ENW_NO_MSGBOX_HOOK=1`.

**No dvar route was adopted.** `+set sys_configSum 0` would skip the prompt (the test is
`saved != 0`) only if the command-line value survives the profile config exec — unproven.
`+set com_recommendedSet 0` skips the prompt but re-applies `configure.csv` on every boot, and on
a failed read `0x59BCE0` calls the error path at `0x59AC50` — not safe. The hook is deterministic
and covers every other engine dialog too.

**Build** (`build.ps1 -Name dedi`, from HEAD + this file, `dllmain.cpp` touched so the build
string is fresh): 39 server/client component sources (+13 core), `sha256 680ac0ae…1e34`
(1,605,120 bytes, 19:27:42). Includes everything since the box's `318dfd60…` (player_down,
`script_error_retail.cpp` / `ENW_NO_SCRIPT_ERROR_RETAIL`).

**Unproven at the time of writing:** no local jointest (B was playing: `CoDWaW` pid live,
`game.lock` held by the launcher) and **no box deploy** (a verified lease was live on inst-03).
The DLL is staged at `zombies-dev:/tmp/enw_t4_msgbox.dll` (hash checked). The hook has not yet
answered a real dialog; the first proof is a `no_msgbox: armed` line, then a retire-then-boot.

### 2026-09-22 19:30 — deployed and proven on the box

Installed `680ac0ae…` (build Sep 22 2026 19:27:41) into all seven game copies while the box was
idle, restarted the host agent, then two fake-ID leases 30 s apart (retire-then-boot path). **Both
instances raised "Set Optimal Settings?" / "Your computer appears to have changed…" at boot** — so
the prompt is on every boot on this box, not only beside a retiring instance; before tonight only
the host agent's timing decided whether anyone noticed. `no_msgbox` answered it in ~2 s on both,
`map_loaded` came 6 s after link each time. The host agent's Escape belt stays as a second layer.
Oddity: the journal's `linked (… Sep 20 2026 00:58:12)` build string is stale while the DLL log
says Sep 22 — the hello's `dll_build` is not the build macro the log uses; cosmetic, unfixed.

## 18. 2026-09-22, 20:00 — pause: the dedicated server freezes the world, solo on Esc/typing, co-op when everyone is in the menu

B's spec: solo on a Verified game, Esc (and, with a setting, typing in chat) really pauses; in
co-op typing never pauses and the game pauses when everyone has paused; show it; resume when the
condition clears; a disconnect counts as unpaused; no ceiling on a co-op pause, but log it.
Before tonight `server/components/pause/pause.cpp` froze nothing — it set a flag and wrote a
`level.zombie_vars` entry through `t4_bind`, whose script-variable writers all return `false`.

### 18.1 The engine's own pause cannot serve a remote client — read from the dump

`sv_paused` (ptr `0x1F9645C`) and `cl_paused` (`0x1F552C4`) are registered in `Com_InitDvars`
(0x59CBDA / 0x59CBF6). `0x635BB0` is Q3's `SV_CheckPaused`: if `cl_paused` is 0 it returns 0;
otherwise it walks `svs.clients` (`0x2547090`, stride `0x58D30`, count from `sv_maxclients`
`[0x23D5C30]`) and **any client with state ≥ 2 whose netchan type (+0x24) is not 2 (loopback)
unpauses it**. Its caller `0x6366C0`, when paused, calls `0x6360E0`, which runs no server frame at
all (one forced frame only when `[0x2FCDA04]` is set) — so no snapshots, and a remote client would
hit `cl_timeout`. It is a listen-server feature. Not used.

### 18.2 What we do: gate the one `call G_RunFrame`, hold `svs.time`, keep snapshots flowing

```
SV_Frame 0x636610      residual += msec; while >= frameMsec: svs.time += frameMsec (0x63664E)
  call 0x635CC0        SV_RunGameFrame (t4_bind's MinHook is at its entry; untouched)
    0x635D54  call 0x503AB0   G_RunFrame(eax = svs.time): level.time [0x18F6DC8] = eax; void, `ret`
  call 0x639BD0        SV_SendClientMessages: skip client if svs.time < nextSnapshotTime - 10
                       (nextSnapshotTime = client_s+0x1161C, set at 0x639693 = svs.time + rateMsec)
```

`pause.cpp` retargets the call at **0x635D54** (checked to call `0x503AB0` before patching) to a
naked stub. Not frozen: it records the time and jumps to `G_RunFrame` with `eax` intact. Frozen: it
does not run `G_RunFrame`, writes `svs.time` back to the frozen `level.time`, and pulls every active
client's `nextSnapshotTime` down to it. Consequences, each read from the dump:

* **everything in the world stops**: AI, the script VM (every `wait` — bleedout, powerups, the box,
  `round_spawn_failsafe`), physics, entity think. Nothing needs its deadline pushed forward, which
  was the whole of vault 11 §6's problem with a script pause;
* **level.time == svs.time throughout**, so the first frame after resume is frozen + frameMsec —
  no catch-up burst, nothing expires because a pause happened. (Offsetting `level.time` from
  `svs.time` instead was rejected: `ClientThink_real` clamps a usercmd to `level.time + 200`
  (0x4E8784) and `0x630BF0` validates it against `svs.time`, so the two clocks must agree or every
  input after the first pause is mangled);
* a player can move at most 200 ms before the same clamp holds him; nothing runs that can hurt him,
  so no invulnerability hack;
* snapshots go out every frame with the same serverTime, so no client times out. Q3-lineage
  clients accept equal serverTimes (`<` checks only, KisakCOD `cl_cgame_mp.cpp` /
  `cg_snapshot_mp.cpp`), reset their clock to the snapshot about every 500 ms, and may show the
  stock "Connection Interrupted" banner — **what a real T4 client draws is unproven**.

`sv_paused` is set to 1 while frozen as a **marker** (readable with `get sv_paused`); every engine
reader of it on this path also requires `cl_paused`, which stays 0 on the dedi, so it is inert.

### 18.3 Who asks, and the rule

* **Players**, through userinfo keys `enw_ui` (`paused|typing|clear`) and `enw_pchat` (`1|0`),
  polled from `svs.clients[i].userinfo` at 20 Hz for every slot in state 4 (CS_ACTIVE). The contract
  is `chat-overlay.md` §8. The rule is `server/components/pause/pause_policy.hpp`: none connected →
  run; solo → pause on `paused`, or `typing` with `enw_pchat 1`; two or more → pause only if every
  one is `paused`; typing never pauses co-op. 25 checks in `server/tests/pause_policy_test.cpp`.
* **The host**, with `pause`/`resume` — a hold OR-ed on top that only the host releases (crash
  grace, everyone-AFK, operator).
* On the link: `ui {slot, ui, pchat}` per change and `pause_state {paused, reason, players,
  held_ms?}` per transition (`game-link-v0.md`). That is the visible PAUSED state: the host puts it
  in `state()` (`paused`, `pause_reason`, `pause_source`, `game_pause`, per-player `ui`) for the
  dashboard and the site; referee.md §15 has the accounting.
* No ceiling on a co-op pause. The DLL logs `pause: FROZEN …` every 5 s, a `WARN` every 5 min while
  a 2+ player pause lasts, and `pause: RESUMED after N ms` with the frames held; the host logs every
  resume with its length and player count.
* Off switch: `ENW_NO_PAUSE=1`. Dedicated only — a listen server keeps the engine's own SP pause.

### 18.7 2026-09-23 00:37 box time - DLL c0986e5e (restart_request) + host agent with lib/restart.js

Built by the coordinator from a clean worktree at main `c72190f` (esc-menu merged on top of several-leases). Installed into every waw-*/binkw32.dll (rollback `/home/waw/binkw32.rollback-79d4317d.dll`), host agent redeployed, restarted idle. Proof: fake-ID lease m_2d46c742 on Nacht -> booted inst-01, `lobby_port: bind log armed`, `restart_request: armed`, map_loaded 6 s after boot, cancelled, idle 00:37:53. `ENW_NO_PAUSE=1` and `ENW_DEDI_WATCH_PROBE_SLOT=1` still exported in run-host.sh.

### 18.6 2026-09-23 00:10-01:20 box time - pause OFF on the box, guarded DLL 79d4317d, write probe on

B's solo Nacht m_506fba68 (DLL 6fccc0e0): chat pause 24.5 s, clean resume, then at 00:02:51 `[0x3BFD478]` overwritten (0x5FAD), Com_Frame body 0 Hz from ~00:02:55, client EXE_ERR_SERVER_TIMEOUT 00:03:31. The 23:44 game died the same way (0x1DE3) after 13 pauses. The writer is the script VM's localVars copy at 0x697B97 (dedi 13.2, referee.md 15.4) - not a pause write; whether pausing provokes it is open. Stopgap by the coordinator: `export ENW_NO_PAUSE=1` in /home/waw/run-host.sh (games do not freeze; Esc opens the menu only), and `export ENW_DEDI_WATCH_PROBE_SLOT=1` so the next hit names its writer. Box DLL now `79d4317d1c534889...` (pause write guards + localVars probe; rollback `/home/waw/binkw32.rollback-6fccc0e0.dll`), host agent restarted idle 01:20.

### 18.5 2026-09-22 20:12 box time — superseded by a main-HEAD build (coordinator)

The box now runs `86f12b1274ae7341...` (1,622,016 bytes), built by the coordinator from a clean
worktree at main `65addc6` (`C:/Users/b/ZombiesDev/wt-pause`, `build.ps1 -Name dedi`): the pause below
**plus** the replay lane's `replay.cpp` (view pitch from `cmd_ang`, crouch/prone buttons fixed, kill
counter past entity 255). Rollback copy of `f8a835bb...` at `/home/waw/binkw32.rollback-f8a835bb.dll`.
Proof: fake-ID lease `m_1237dffc` on Nacht -> `map_loaded` 6 s after boot, recording started, cancelled,
journal idle 20:14:51. The archive lane's 60+ map proofs that evening all ran on this build.

### 18.4 Proof

### 2026-09-22 19:58–19:59 box time — deployed and proven on the box

Installed `f8a835bb9fb22372d917026932e1fd61b4e8230cf346a7fe96afe150006efb4c` into all seven
`waw-*/binkw32.dll` (journal idle first; rollback copy of `b36fe140…3174f` kept at
`/home/waw/binkw32.rollback-b36fe140.dll`), restarted the host agent. Fake-ID lease `m_c7fbbd67`
(Nacht, 76561198000000001): inst-01 linked with the new build (Sep 22 2026 20:28:57), `pause: armed …
sv_paused=0`, `map_loaded` 6 s after link. Trigger 12 s: `PAUSED at level.time 11150`, `FROZEN 5 s …
level.time 11150, svs.time 11150, 100 G frame(s) held, sv_paused 1`, `FROZEN 10 s … 11150 … 200
held`; the Com_Frame loop stayed at 52.6 Hz throughout. Removed: `RESUMED after 12356 ms … 247 G
frame(s) held`, `first G frame after resume at level.time 11200 (+50 ms: no catch-up)`. Running
unpaused, level.time went 11200 → 23600 in 12.46 s of wall time (the second trigger's PAUSED
line), i.e. normal speed; second freeze 7 s, resumed at 23650. Process alive throughout, no
error. Lease cancelled; journal `assignment changed: idle` at 19:59:45. With no player in the game
the host was still in `loading`, so correctly accounted nothing (15.2).

Build notes, as staged: **Staged, not deployed** (the box was lent to a demo when this was written): clean build from
`e6be04e` in a detached worktree (the main checkout carries the overlay lane's uncommitted client
components, which a `-Name dedi` build picks up), `sha256 f8a835bb…6efb4c` (1,622,016 bytes), at
`zombies-dev:/tmp/enw_t4_pause.dll`. The box's current `binkw32.dll` is `b36fe140…3174f`.

**How to prove it on the box with no client and no dashboard** (`--dash off`): the operator
trigger. A file `enw_pause.trigger` next to that instance's `CoDWaW.exe` freezes the game for as
long as it exists (checked once a second; reason `operator`, accounted by the host like a players'
pause, so it can never hide paused time). With a fake-ID lease up and `map_loaded`: `touch` it,
expect `pause: operator trigger PRESENT`, `pause: PAUSED (operator…) at level.time T`, then every
5 s `pause: FROZEN … level.time T, svs.time T, N G frame(s) held, sv_paused 1`; `rm` it, expect
`pause: RESUMED after … level.time held at T` and `pause: first G frame after resume at level.time
T+50 (… +50 ms: no catch-up)`.

**Unproven**: a real client's `enw_ui` reaching the server (the client half is not built); what a
remote client draws while frozen; two clients (not possible tonight — B was playing).

## 19. 2026-09-23, 00:30–00:50 UK — three instances on one box: the lobby port was never the limit, and an agent that failed every lease after four

B asked for game servers in reserve, so an agent can test while he plays, and three for now.

### 19.1 The bind site: one hundred ports, not two

Full table in `docs/re/t4-sp-map.md` §10. In short: `bdNetStartParams` (`0x78BF70`) stores the
constant **3074** at `0x78BF9C` (`66 C7 46 02 02 0C`). `bdNetImpl::findFreePort` (`0x78A1E0`)
then tries that port and each next one **up to 100 times** (`cmp edi, 0x64`), binding and closing
a probe socket each time, and the real socket binds the port it found. Every bind in the exe,
Demonware's and NET_IPSocket's, goes through one IAT slot, WSOCK32 #2 at `0x7EB3E8`.

The bind log below backs the call graph: a third instance asking for 3074 gets `WSAEADDRINUSE`
twice and ends up on 3076. `vps.md` §15's "one fallback to 3075" was an inference from a port
table, and it was wrong. §15's third instance, which bound nothing, was most likely stuck behind
the §17 MessageBox. That is inference too: nobody looked for a window on it.

### 19.2 The patch: `server/components/dedicated/lobby_port.cpp`

* **Bind log** (`post_load`, dedicated only): an IAT hook on WSOCK32 #2 logs every AF_INET bind:
  the address, the port, `ok` or `FAILED (WSA n)`, and whether it was the lobby port asked for or
  one it fell forward to. Behaviour is unchanged, and the hook preserves `GetLastError` for
  the engine's `WSAGetLastError`. Off: `ENW_NO_BIND_LOG=1`.
* **`ENW_LOBBY_PORT=n`** (`post_unpack`): rewrites the imm16 at `0x78BFA0` from 3074 to `n`,
  after checking all six instruction bytes. The engine then asks for `n` and still falls forward
  by itself, and it knows which port it really has. A bind-time rewrite (option (a)) would have left
  it believing 3074. **Unset means stock.** The first build patched in `post_load` and found
  SteamStub ciphertext (`FF 24 F8 3A 98 4F`) at the site. It refused to patch, as intended, and the
  patch moved to `post_unpack`.
* Dedicated only (`dedicated 1|2` on the command line), like `no_msgbox`.

The host agent sets `ENW_LOBBY_PORT = --lobby-base (3074) + slot`, so every instance asks for its
own port and two instances that boot together cannot race for the same probe.

### 19.3 The host agent: `{slot}`, and why B's Play failed at 23:27 box time

**The outage.** `run-host.sh` mapped `waw-{id}` to a game copy, and the id counter grows for
the agent's whole life. The archive lane's map proofs made four boots in one agent lifetime, and
every lease after that failed with `no game copy at /home/waw/pfx/drive_c/zdev/waw-inst-05`. The
failures ran from inst-05 to inst-24 between 23:27 and 23:32 box time, with B's own Play among
them. Before tonight only a restart reset the counter.

**The fix** (`lib/instances.js`, `host.js`):

* **`{slot}`** is `inst-01`, `inst-02`, … and comes from the game port, `(port - base) / 2`. The
  manager hands ports out lowest-free-first and takes them back on remove, so a slot is reused
  as soon as its instance is retired. The id still counts up, and only the copy and homepath
  follow the slot. `run-host.sh` and host.js's defaults now use `{slot}`.
* **`checkSlotCopies()`** runs at start. If the copies for slots `0..max-1` are not all there,
  the agent logs an error and caps `max-instances` at the number that exist. A lease can no
  longer map to a missing copy.
* **One game boots at a time.** `boot()` holds the next real game until the previous one reaches
  `map_loaded`, ends, fails, or 90 s have passed. §15 measured that simultaneous starts lose
  instances.
* **`--lobby-base`** (default 3074) → `ENW_LOBBY_PORT`.
* Tests: `test/run-all.js` "game copies by slot": 40 leases in a row with two instances held
  never map past `waw-inst-03`; a retired slot is reused; the cap holds; `--lobby-base`. 61/61
  pass.

### 19.4 Proof on the box (2026-09-22 23:38–23:45 UTC)

The box DLL is **`6fccc0e046eb008cb1df9105f07147821332697872842f3e89a3c024c9b9452c`**
(1,823,744 bytes). It was built from a clean worktree at `257a3da`
(`C:\Users\b\ZombiesDev\wt-pause`, `build.ps1 -Name dedi`) and installed into all seven
`waw-*/binkw32.dll` while the box was idle. The rollback copy of `86f12b12…` is at
`/home/waw/binkw32.rollback-86f12b12.dll`. The pre-change `host.js`, `instances.js` and
`run-host.sh` are at `/home/waw/*.bak-pre-lobby`.

**A lease through the service** (fake ID 76561198000000001, `m_abb67742`): `inst-02` →
`waw-inst-01` (slot 0), `lobby_port: Demonware game socket asks for 3074`, `map_loaded` 6 s after
boot.

**Three at once.** The site allows **one live lease per box**. `assignments.lease()` marks every
other live lease on that box `superseded` whatever its players are
(`web/server/lib/assignments.js`, `UPDATE assignments SET state='superseded' … WHERE box_id=?`),
and the host agent retires the superseded instance. So three leases in a row give one instance,
not three, and a different fake SteamID per lease does not change that. For the proof, the
service instance stayed on its lease. A second, site-less host agent ran the same code from
`/home/waw/enw-test` (`--boot 2 --base-port 28962 --link-port 38710`, copies `waw-tinst-01/02`)
and booted two more beside it. A guard script would have SIGKILLed only the test games if
MemAvailable fell under 120 MB. It never fired.

Round A (`--lobby-base 3075`, the patch doing the choosing):

```
0.0.0.0:28960  pid 220102 (service, slot 0)     0.0.0.0:3074  pid 220102   asked 3074
0.0.0.0:28962  pid 220600 (test, waw-tinst-01)  0.0.0.0:3075  pid 220600   asked 3075, got it
0.0.0.0:28964  pid 220640 (test, waw-tinst-02)  0.0.0.0:3076  pid 220640   asked 3076, got it
map_loaded: 23:40:14, 23:41:32, 23:41:38 (the 2nd test boot waited for the 1st's map_loaded)
oob.py getstatus from B's PC: 28960 ANSWERED, 28962 ANSWERED, 28964 ANSWERED
```

Round B (`--lobby-base 3074`, the stock request, to watch the engine's own fallback): the same
three ports came out, by falling forward. Test 1 asked for 3074 → `FAILED (WSA 10048)` → 3075;
test 2 asked for 3075 → `FAILED` → 3076. Both loaded their maps.

**What three cost** (Nacht, no players, `com_maxfps 60`):

| | RSS | CPU (30 s, `/proc/<pid>/stat`) |
|---|---|---|
| service inst | 304 MB | 0.314 core |
| test 1 | 304 MB | 0.320 core |
| test 2 | 305 MB | 0.336 core |
| **box** | used 3,519 of 3,819 MB, **MemAvailable 292–300 MB** (min over the run) | load 1.52 on 2 cores |

Afterwards the test agent was stopped with SIGINT, which stopped its own two games, and the lease
was cancelled. At 23:44 B pressed Play (m_d2e29686 → m_6d80aa20). His lease retired the leftover
service instance and booted on slot 0 with the new DLL and host code: `map_loaded` 6 s,
`auth slot 0 … ALLOW`, `game live`. B is playing on this build.

### 19.5 What four needs, and what is not done

* **Four instances need about 300 MB more.** Three leave about 300 MB, and the fourth takes about
  305 MB, which puts the box at the OOM edge. Steam's CEF (steamwebhelper, 9 processes) still
  holds about 2.3 GB. Two cheap ways to find the room: run Steam without its browser, or move to a
  bigger box. The bigger box is rule 8, and the Steam restart puts B's login at risk.
  **Untested.** CPU is not the limit: 1.0 of 2 cores for three idle servers, but a full
  four-player late round is unmeasured.
* **The site hands out one game per box.** `max-instances 3` is the box's cap, but until
  `assignments.lease()`/`forBox()` and the host's `onAssignment` carry several live leases per
  box, B pressing Play while an agent's lease is live **supersedes the agent's game**, and the
  reverse is also true. That is the real blocker for "an agent tests while I play". It is the
  site's lane (`web/`), plus a small change in `onAssignment`, which currently retires every
  instance on a different match id.
* **The running agent** is the 23:38 restart. It has the slot fix and `ENW_LOBBY_PORT`, but not
  `checkSlotCopies` or `--lobby-base`. `run-host.sh` already says `--max-instances 3`. Both take
  effect at the next restart, and that restart waits for idle because B is playing. The site's box
  row still says `max_instances 2`.
* `/home/waw/enw-test`, `/home/waw/run-test3.sh`, `waw-tinst-01/02` and `homes\tinst-01/02` are
  left on the box for the next multi-instance test (about 70 MB).
* The `linked (… Sep 22 2026 20:28:57)` build string in the journal is still stale (§17's cosmetic
  note).

### 19.6 Addendum, 2026-09-23 00:12–00:15 UTC: the site now hands out all three slots (host.md §13, web.md)

This closes the §19.5 bullet "the site hands out one game per box". The site leases per party.
A box holds `max_instances` live leases, and zombies-dev is now 3, with 1 slot reserved for
agents. The host agent polls `?v=2`, runs one instance per live lease, and retires only a game
whose own lease has ended. Deployed at 00:12 UTC, when the box was idle.

Proof, with fake IDs only:

* `lease-cli --player …0001` (Nacht) got m_dba99e3b on inst-01, slot 0, lobby port 3074, connect
  `:28960`. `map_loaded` was reached.
* `lease-cli --player …0002` (Verruckt) got m_99ea8a4c on inst-02, slot 1, lobby 3075, connect
  `:28962`. `map_loaded` was reached. **The first game was not retired or superseded.** The
  journal logged `assignment changed: leased 2: m_dba99e3b …, m_99ea8a4c …`. The site status then
  showed both instances `running` with `map_loaded: true`, both leases `ready`, and `protocol 2,
  max_instances 3`. This also proves the old behaviour is gone: a lease for a different player
  retired nothing.
* `lease-cli --player …0003` was refused with `No free server right now`. The third slot is
  the one real players are owed, and agents never take it.
* Cancelling m_dba99e3b retired inst-01 only, and inst-02 kept running. Cancelling m_99ea8a4c
  retired inst-02, and the box went `idle` with no CoDWaW processes left.

Not proven on the box: a real player's lease making an agent lease yield, and three games at once
with players connected. Both are covered by the tests in web/test/run-all.js.

## 20. 2026-09-22 evening / 23 early: the popular 64 on the box, server-side only

The archive lane's popular run (`docs/kickstart/archive.md` §10) booted every one of its 64
installs on this box through the real lease path. It used `archive/box_proof.py`, with a
fake-ID `lease-cli --proof` lease, one map at a time. A pass means `map_loaded`, then
`com_frameTime` advancing at least 15 s over a 35 s hold, with the process alive. Results are
in `ZombiesDev\archive\reports\boxproof.json`, each map's manifest (`box_proof`), and
`web/server/lib/boxProven.json`.

### 20.1 Result: 59 pass, 5 fail

| bsp | zone | result | the engine's first complaint |
|---|---:|---|---|
| `nazi_zombie_shore` (Zombie Revolution Infinite) | < 110 MB | **FAIL**, Com_Error before map_loaded | `Could not load rawfile "animscripts/dog_init.gsc"` (missing script) |
| `cxca` | < 110 MB | **FAIL**, Com_Error before map_loaded | `Could not load rawfile "maps/_zombiemode_dogs.gsc"` (missing script) |
| `shinomori` (Shi No Mori reborn) | 126 MB | **FAIL**, Com_Error before map_loaded | `Need 36283957 more bytes of 'main' physical ram` |
| `dpp` (Desce Pro Play) | 113 MB | **FAIL**, Com_Error before map_loaded | `Need 37230375 more bytes of 'main' physical ram` |
| `nazi_zombie_inferno` | 190 MB | **FAIL**, Com_Error before map_loaded | `Need 81538024 more bytes of 'main' physical ram` |
| `mr_freeze` (Heart of Ice) | 118 MB | **PASS** (reclassified) | map_loaded, `com_frameTime` +35.1 s. The first run was logged as "process exited", but that was another lane's Nacht lease SIGTERMing the instance 44 s after load (22:33:43 box time). |
| the other 58 | | **PASS** | map_loaded, `com_frameTime` +35 to 40 s |

**Passing maps:** `nuketown`, `nacht_reimagined`, `nazi_zombie_poke`, `nazi_zombie_dome_snow`, `nazi_zombie_malibu`, `nazi_zombie_johndoe`, `ut_box_map`, `zm_nuked`, `killhouse`, `cryogenic`, `nazi_zombie_path`, `nazi_zombie_fivenights`, `zombie_town`, `futurama`, `nazi_zombie_zhunterz`, `nazi_zombie_bloodsport`, `nazi_zombie_cargo`, `nightclub`, `bridge_zombie`, `dead_palace`, `hghrise`, `nazi_zombie_lorkeep`, `cube`, `navidad_p_zombie`, `thirty_seven`, `nazi_zombie_arena`, `escape_asylum`, `nazi_zombie_prison`, `nazi_zombie_temple`, `nazi_zombie_hotelv2`, `chal_dual_wield`, `nazi_zombie_beachtown`, `nazi_zombie_bored`, `zm_hospital`, `nazi_zombie_enclosed`, `nazi_zombie_library`, `nazi_zombie_pd`, `nazi_zombie_mine`, `aliendefense`, `battlestar_galactica`, `kingdom_hearts`, `nazi_zombie_legion`, `nazi_zombie_hanoizom`, `nazi_zombie_denial2`, `nazi_zombie_rats`, `nazi_zombie_tank`, `jigsaw`, `mr_freeze`, `nazi_zombie_relax`, `nazi_zombie_dcv2`, `nazi_zombie_snowglobe`, `chal_harambe`, `nazi_zombie_ils`, `bank_job`, `nazi_zombie_forest`, `nazi_zombie_arkham`, `bcast`, `ugxm_garage`, `nazi_zombie_crazyplace`.

**Why the 5 fail after one clean run, not two:** all five die in an engine `Com_Error`, which
waiting longer cannot change. Their second attempts (`--load-wait 300`) were all pre-empted and
are recorded, not counted:
- 23:27–23:33 box time: another lane's instance-slot bug dropped every lease to idle about 3 s
  after it was made, and one run found "no game copy". The host agent was restarted at 23:38.
- From 23:44: B's live Nacht game, then a Minecraft Village game.

The coordinator stopped all box leases for the night at about 23:55. `popular.py --apply` set
`health: "broken"` plus `health_reason` on the five, and `import-archive.js` imported them as
`broken`. The Maps list hides them and a lease refuses them.

**The 'main' physical ram failures are not the zone size alone.** `zombie_town` (201 MB) and
`nazi_zombie_malibu` (190 MB) pass, while `dpp` (113 MB) fails. The shortfall is in the
server's own `'main'` hunk under Wine. Nobody has tried raising it (a `com_hunkmegs`-style
setting on the dedi) yet.

### 20.2 Two traps for anyone leasing the box

1. **Journal `idle` is not a safe signal.** The site expires a lease about 5 min after it is
   created, even while its game is live (a site bug another agent is fixing). At 23:50:11 the
   journal said `idle` in the middle of B's Nacht game (round 2). The archive lane's cxca lease at 23:50:23
   replaced it. Until that is fixed, ask the coordinator before leasing, even when the journal
   says idle.
2. **Anybody's lease replaces yours.** The host runs one assignment and SIGTERMs the old
   instance. `box_proof.py` now records either case as **skipped**, not failed: a foreign
   `assignment changed: leased` line, or our lease going `idle` before we cancel it.
   `--load-wait` sets how long to wait for map_loaded (default 150 s).

### 20.3 What the 59 carry that a client will meet

- **Add-on IWDs** (not the map's own; `*` means the IWD has scripts in it), 51 of the 64. §9.4
  showed these can be hard dependencies, so they are never dropped: `nacht_reimagined` (dlc3_weapons, zombies_tranzit*, zz_sal_chalkmakers); `nazi_zombie_poke` (pokemonwherelegendsbegin*, z_hud); `nazi_zombie_dome_snow` (_bam_bo1_perks_mod*, electric_cherry*); `ut_box_map` (dlc3_weapons); `zm_nuked` (buried*, nuketown*); `killhouse` (nuketown*); `nazi_zombie_path` (thepath*, z_thepath); `nazi_zombie_fivenights` (ugx_mod*, ugxm_guns*, viewhands_m14_patch); `futurama` (ugx_mod*, ugxm_guns*); `nazi_zombie_zhunterz` (^1zhunterz*, electric_cherry*, z_hud); `nazi_zombie_bloodsport` (nuketown_zombies*); `nazi_zombie_cargo` (_bam_bo1_perks_mod*, electric_cherry*, nuketown_zombies*); `nightclub` (BlSt_PanzerSoldat*, fortress*); `dead_palace` (ugx_mod*, ugxm_guns*, viewhands_m14_patch); `hghrise` (die_rise*, highrise*); `nazi_zombie_lorkeep` (electric_cherry*, porter_punch*, vulture_aid*, wunderfizz*, z_hud); `cube` (ascencion_zombies*); `navidad_p_zombie` (electric_cherry*, zombie_hitmarker_bythesuzho*); `thirty_seven` (trem_hintstrings*, ugx_mod*, ugxm_guns*, zom_player_engineer, zom_player_farmgirl, zom_player_robert, zom_player_sarah, zzzbo1_perks_ugx_mod*); `escape_asylum` (z_hud); `nazi_zombie_shore` (images, nazi_zombie_streets, zombierevolutioninfinite*); `nazi_zombie_temple` (harrybo21_bo1_2_3_perks_v5.0.0); `nazi_zombie_hotelv2` (nuketown*); `chal_dual_wield` (ugx_mod*, ugxm_guns*); `nazi_zombie_beachtown` (ugx_mod*, ugxm_guns*); `nazi_zombie_bored` (dlc3_weapons, harrybo21_perks v3.0.6*, zombies_tranzit*); `cxca` (_bam_bo1_perks_mod*, electric_cherry*, motd_zombie_images, nazi_zombie_asylum*, vulture_aid*, wunderfizz*); `nazi_zombie_enclosed` (_bam_bo1_perks_mod*, dlc3_weapons, electric_cherry*); `nazi_zombie_library` (dlc3_weapons, library*); `nazi_zombie_pd` (purpledimension*, z_hud); `battlestar_galactica` (ugx_mod*, ugxm_guns*, viewhands_m14_patch); `kingdom_hearts` (_bam_bo1_perks_mod*, dlc3_weapons, electric_cherry*, lunar_lander*, origins_generators*, porter_punch*, vulture_aid*, wunderfizz*, z_hud); `shinomori` (dlc3_weapons, electric_cherry*, harrybo21_bo1_2_3_perks_v5.0.0); `nazi_zombie_legion` (z_hud); `nazi_zombie_hanoizom` (hanoi*, harrybo21_perks*); `nazi_zombie_rats` (electric_cherry*, vulture_aid*); `nazi_zombie_tank` (z_hud); `jigsaw` (dlc3_weapons, trem_hintstrings*); `mr_freeze` (ugx_mod*, ugxm_guns*); `nazi_zombie_relax` (_bam_bo1_perks_mod*, buried*, electric_cherry*, vulture_aid*, wunderfizz*); `nazi_zombie_dcv2` (nuketown_zombies*); `nazi_zombie_snowglobe` (ugx_mod*, ugxm_guns*); `chal_harambe` (ugx_mod*, ugxm_guns*); `nazi_zombie_ils` (dlc3_weapons); `dpp` (harrybo21_bo1_2_3_perks_v5.0.0); `bank_job` (dlc3_weapons, zz_sal_chalkmakers); `nazi_zombie_forest` (ugx_mod*, ugxm_guns*, viewhands_m14_patch, z_hud); `nazi_zombie_arkham` (dlc3_weapons); `bcast` (_bam_bo1_perks_mod*, dlc3_weapons, electric_cherry*, lunar_lander*, porter_punch*); `ugxm_garage` (ugx_mod*, ugxm_guns*); `nazi_zombie_crazyplace` (mp_rollon_evopro, nuketown_zombies*, thecrazyplace*, trem_hintstrings*).
- **22 map zones are 110 MB or more inflated** and carry `client_memory_risk` (ORBiT, 137 MB,
  parks its client at about 1.6 GB, §14.7): `zombie_town` 201, `nazi_zombie_malibu` 190,
  `nazi_zombie_inferno` 190, `nuketown` 184, `nazi_zombie_ils` 144, `cryogenic` 144,
  `nacht_reimagined` 143, `nazi_zombie_zhunterz` 143, `nazi_zombie_pd` 138,
  `bridge_zombie` 133, `nazi_zombie_arkham` 127, `nazi_zombie_denial2` 127,
  `nazi_zombie_legion` 126, `shinomori` 126, `nazi_zombie_prison` 124,
  `nazi_zombie_hanoizom` 123, `jigsaw` 118, `nazi_zombie_cargo` 118, `mr_freeze` 118,
  `zm_nuked` 113, `dpp` 113, `hghrise` 110 (MB). 19 of them pass on the server, and any
  of those 19 may still hit the 32-bit client's 2 GB ceiling.
- Many passing maps log non-fatal `script runtime error` and missing xmodel/xanim/weapon-file
  warnings (the `first_error` in each manifest). None stopped the server. A client may show
  them.

### 20.4 Unproven

**No client joined any of these games.** Nothing here covers:
- client-side load, including the 2 GB ceiling for the 19 big passing zones
- a mid-game join
- round 2
- game over or a refereed finish

On B's word ("push all the maps that currently work so I can try them out"), the site now
offers the 59 to a party at a second level. `lib/maps.js` `BOX_PROVEN` gives them
`server_level: "box"`, and the site tags them **New** with the caveat on hover.
`SERVER_PROVEN` still means five gates with a real client. The first real player on each
map is the client proof.

## 2026-09-23 — a player's Restart game (`restart_request.cpp`, esc-menu lane)

`server/components/dedicated/restart_request.cpp`: userinfo `enw_req restart.<n>` (the ENW Esc
menu's Restart) is acted on per slot, on a change only; with a host link it becomes
`restart_request` on the game link and the host answers with the referee's own `end`
(`player_restart`) — the run ends as abandoned and a new run id takes over; with no link a solo
player's request is a plain `map_restart`. Proven end to end on local `host2`+`c2` against the
real host agent (`esc-menu.md` §3, §7). **Measured on the way: `level.time` keeps counting across a
`map_restart` on this engine**; the clients re-entering the connect handshake is the signal.

## 21. 2026-09-23 ~02:30–03:00 UK — the join gate no longer depends on timing (`join_in_progress.cpp`)

B, bridge_zombie on the box: *"it said maps cannot be joined mid-game when I tried to join at the
very start."*

### 21.1 The race, read off the box

inst-01 `enw-2460.log`: `01:19:06.822 map_loaded`, `01:19:07.086 SV_DirectConnect()` (B's client),
`01:19:07.227 dedi_join_in_progress: … set 0 -> 1 on frame 16`. The dvar was already registered;
the component only **looked** every 16th frame (`(n & 15) != 0 → return`), and the frame counter
starts when the map load ends. So a connect that was already waiting when the map finished (its
`getchallenge` sat in the socket during the load and was answered in the first frames) reached the
gate while it was still 0 and was refused with `EXE_ERR_CANNOTJOININPROGRESS`. The stock client makes
that `Com_Error(ERR_DROP)` and never asks again (SV_DirectConnect stayed at 1). Before 0.2.17 the
client's ~2.9 s menu wait hid the race; the direct boot (client.md §10) exposed it on every map, worse
on maps that load slowly on the box.

### 21.2 What the engine does with a connect that arrives before `map_loaded`

Nothing bad. The load does not pump the network: packets that arrive during it queue in the UDP
socket and are handled in order in the first frames after it (box: 128 `getchallenge`+`connect`
pairs, sent from the moment of the lease, all answered 35–45 ms after `map_loaded`, before this
component's first frame tick). Before the socket is bound the client's packets are simply lost and
`CL_CheckForResend` sends again (every 3 s stock, every 2 s with `join_retry`). No crash, no wedge,
no "retry" answer needed from the server.

### 21.3 The fix: three layers, none of which waits for a frame

The dvar **is** written at registration after all (t4map missed the store; t4-sp-map.md §9 row 4
corrected): `xor al,al; mov edi,"party_joinInProgressAllowed"; call Dvar_RegisterBool 0x5EEE20;
mov [0x339A774],eax` at `0x654D3C..0x654D48`, in the party dvar block `0x654530` (Com_Init via
`0x5FB560`).

1. **Default on.** `32 C0` → `B0 01` at `0x654D3C` (16 bytes checked). If the dvar is already
   registered at `post_init` (it is locally on today's component order; on the box it was not), the
   value is set to 1 there too.
2. **The branches.** Unless `ENW_JOIN_GATE_STOCK=1`: `SV_DirectConnect`'s two reads become short
   jumps over the pointer load, the compare and the branch, so a NULL dvar cannot be dereferenced
   either: `0x62E9BB` (the reconnect scan, 12 bytes checked) → `EB 0A`, `0x62EBC4` (the gate, 15 bytes
   checked) → `EB 0D` to the password check at `0x62EBD3`. ECX/EAX are dead at both targets.
3. **The poll** runs every frame (was every 16th), as the backstop for party code writing it back.

`ENW_DEDI_NO_JIP=1` still leaves everything stock. **Test only:** `ENW_JOIN_GATE_TEST_CLOSED_MS=<n>`
reproduces the old race on purpose (no patches, dvar held at 0 for n ms after the first frame), which
is how the client half (client.md §11) was proven.

The host lane closed the third layer in the same hour: `46fe734` reports a fresh boot `ready` at
`map_loaded`, so the launcher (which launches on `match.connect`, present only in `ready`/`live`)
starts the client after the map is up. Box lease `m_a9a0e1c9`: `map_loaded` 01:59:30.657,
`ready_at` 01:59:31.445. The launcher needed no change.

### 21.4 Proof

Local (`jointest.ps1` gained `-ClientEarlyMs <ms>` — the server's `launch.ps1` runs in a job and the
client starts that many ms after the server PROCESS appears — and `-ServerLagMs <ms>` — the harness
takes game.lock, the client starts first and the server that much later; the client needs
`-ClientExtraArgs '+set','net_port','28990'` in that mode or it takes 28960 first). Copies `jrd`
(server) + `jrc` (client), DLL `03b04bc3` (the box DLL below), logs `ZombiesDev\logs\dedi\<tag>.*`:

| run | map | how | server | client |
|---|---|---|---|---|
| `early7` | bridge_zombie | client first, server +2.3 s | socket bound 00.511, client `getchallenge` 00.527 (**during the load**), `map_loaded` 01.462, SV_DirectConnect 01.490 = frame 1, accepted | in game 05.556 |
| `final-nacht-first` | Nacht | client first, server +2.6 s | first frame: `value 1 (open from registration)`; connect 0.67 s after `map_loaded` | in game |
| `final-bridge-first` | bridge_zombie | client first, server +2.3 s | same | in game |
| `final-fear-first` | nazi_zombie_fear_mc_2 | client first, server +2.3 s | same | in game |
| `final-nacht-control` | Nacht | old race forced (`TEST_CLOSED_MS=6000`), **`ENW_JOIN_RETRY=0`** | 1 refusal | **B's bug**: `Com_Error EXE_ERR_CANNOTJOININPROGRESS`, never asks again |
| `final-nacht-retry` / `final-bridge-retry` | Nacht / bridge_zombie | old race forced, retry on | 3 refusals, then accepted | in game after 6.2 s (client.md §11) |

**Box** (idle, journal `idle` since 01:41:47, no game process; fake-ID leases, `lease-cli --backup`):
`m_6e9697ae` then `m_a9a0e1c9`, bridge_zombie on inst-01, while `connspam.py` (scratch: `getchallenge` +
`connect "\protocol\62\challenge\<last>\…"` every 100 ms from before the lease) watched the replies.
inst log `enw-2648.log`: the three patches applied, `map_loaded` 01:59:30.626, SV_DirectConnect from
01:59:30.661 (before the first frame tick at 30.794, which read `value 1 (open from registration)` —
on the box the dvar was **not** yet registered at post_init, so the default patch did it). Replies
seen: `challengeResponse`, one `EXE_BAD_CHALLENGE` (the probe's first connect carried challenge 0),
then **`connectResponse mods/bridge_zombie`** 85 ms later. **Never `EXE_ERR_CANNOTJOININPROGRESS`.**
Both leases cancelled, box `idle` 01:59:37. (`m_6e9697ae`'s probe sent a malformed userinfo and only
proves the queueing.)

### 21.5 Box DLL

**`03b04bc3414d12ceb7bb3c65bcb773a4424a438846a4bb3874e8670163e85db5`** (2,012,160 B), built from a clean
worktree at main **`81086d4`** (`C:\Users\b\ZombiesDev\wt-joinretry` — **not** `wt-pause`, which had two
untracked files of another lane, `net_probe.cpp`/`net_probe_client.cpp`, that CMake's glob compiles).
Installed 01:58 UTC into all 9 `waw-*/binkw32.dll`, chowned, host agent restarted idle. **What it
replaced was not `c0986e5e`**: the box had `f920bb39…` (2,001,920 B, installed ~01:35 UTC, = `wt-pause`'s
`build\dedi` of 02:34 UK, which contains that `net_probe` code). Rollback copy:
`/home/waw/binkw32.rollback-f920bb39.dll`. `ENW_NO_PAUSE=1` and `ENW_DEDI_WATCH_PROBE_SLOT=1` still
exported in `run-host.sh`. Whoever owns `net_probe`: rebuild from main ≥ `81086d4`, or this fix goes.

## 22. 2026-09-23 ~02:35–03:15 UK — "extremely laggy on the Minecraft map": `sv_maxRate` was 7000, and no local test could ever see it (`net/net_probe.cpp`)

**Cause.** Stock `sv_maxRate` is **7000 bytes/s**, and the server paces every internet client to it. A
fear_mc_2 snapshot is ~600–1,100 bytes, so B got **10 snapshots a second, dropping to 3/s** once
snapshots passed the 1,164-byte fragment size, instead of 20. At `sv_maxRate 25000` the same map on the
box sends **20.0/s, 0 rate-delayed, 0 fragments**.

### 22.1 The mechanism (read from the decrypted 1.7 image)

| addr | what |
|---|---|
| `0x632B10` (site `0x633040`) | SV_Init registers `sv_maxRate`: default `0x1B58` = **7000**, domain 0..**25000**, dvar ptr `[0x2FCD9C4]` |
| `0x630650` | SV_UserinfoChanged: `client+0x323E8` = userinfo `rate` clamped 1000..90000 (5000 if absent; **99999 if Sys_IsLANAddress**); `client+0x323EC` = 1000/`snaps` (1..30; 50 ms if absent) |
| `0x6392D0` | SV_RateMsec: size clamped to `0x48C` (1164); `(size+64)*1000/min(rate, sv_maxRate)` |
| `0x6393F0` | SV_SendMessageToClient: after Netchan_Transmit `0x678450`: loopback or **Sys_IsLANAddress `0x600280` → nextSnapshotTime = svs.time−1 (no throttle)**; else `msec = max(RateMsec, snapshotMsec)`, `rateDelayed` = `client+0x10`, `nextSnapshotTime` = `client+0x1161C` |
| `0x639BD0` | SV_SendClientMessages: clients `0x2547090` stride `0x58D30`, `svs.time` `0x2547084`, pending fragments `client+0x50` paced the same way |
| `0x5EF390` | Dvar_SetInt by dvar: value in ECX, `[esp+4]` dvar, `[esp+8]` source (caller cleans) |
| client `0x6465BF` / `0x646636` / `0x645E43` | client `rate` 1000..25000 default 25000; `snaps` 1..30 default 20; `cl_maxpackets` 15..100 default 30 |

At 7000 B/s a 20 Hz snapshot can be at most 7000/20 − 64 = **286 bytes**. At 25000 the formula cannot
exceed (1164+64)·1000/25000 = **49.1 ms**, so a 20 Hz client is never rate-delayed; 25000 is also the
most either dvar allows. **Every local harness run ever made connects over 127.0.0.1, which is LAN, which
skips the rate code entirely** — that is why everything "played fine" here.

### 22.2 What changed

- `server/components/net/net_probe.cpp` (new, commit `fd29f8f`): at the first frame, raises `sv_maxRate`
  7000 → 25000 through the engine's setter (`ENW_SV_MAXRATE=<n>`, `0` = stock). Logs `net_probe:` every
  5 s per client: userinfo rate, effective rate, snapshotMsec, messages sent, how many `rateDelayed`, the
  delay chosen; and per destination (IAT hook WSOCK32 #20 `sendto`) packets, bytes, avg/max size,
  fragments (seq bit 31), OOB, time inside `sendto`. `ENW_NET_PROBE=0` silences it.
  **`ENW_NET_FORCE_WAN=1` (test only)** turns the two `call Sys_IsLANAddress` in the send path
  (`0x6395CE`, `0x639C7A`) into `xor eax,eax`, so a 127.0.0.1 client is paced like an internet one.
- `client-dll/components/net_probe_client.cpp` (new, same commit): IAT hook WSOCK32 #17 `recvfrom`;
  `net_probe_client:` every 5 s — packets/s, bytes, fragments, arrival gap avg/max/sd, gaps >100/>250 ms.
- **Box DLL `6b1ccfc5606391c17f8656086342b81f26d36fa3da921daa267ef808eb2a5ddd`**, built from a clean
  worktree (`ZombiesDev\wt-netprobe`) at main **`fd29f8f`** (contains the join fix `81086d4`), installed
  atomically (copy + `mv`) in all 9 `waw-*/binkw32.dll` while idle, 01:59 box time; rollback
  `/home/waw/binkw32.rollback-03b04bc3.dll`. `ENW_NO_PAUSE=1` and `ENW_DEDI_WATCH_PROBE_SLOT=1` untouched,
  host agent not restarted. (`f920bb39`, deployed 01:40, was the same code built from `wt-pause` with the
  files untracked; superseded by `03b04bc3` and then by this.)
  *Handoff check, 03:27 UK over ssh: all 9 `/home/waw/pfx/drive_c/zdev/waw-*/binkw32.dll` hash `6b1ccfc5`,
  file mtime **02:04 UTC** (03:04 UK); the "01:59 box time" above does not match the files and is
  probably the build or copy start — not resolved. `run-host.sh` still exports both switches.*

### 22.3 Measured (fear_mc_2 unless said; steady 5 s windows, player spawned, round 1)

| run | path | sv_maxRate / eff. rate | snapshots/s | rate-delayed | avg / max bytes | frags | client arrival gap avg / max / sd |
|---|---|---|---|---|---|---|---|
| `net_fear_7000` | local, FORCE_WAN | 7000 / 7000 | **10.0** | 50 of 50 | 640 / 700 | 0 | 100 / 145 / 15 ms |
| `net_fear_25000b` | local, FORCE_WAN | 25000 / 25000 | **20.0** | 0 | 415 / 660 | 0 | 50 / 95–112 / 11–18 ms |
| `net_nacht` (control) | local, FORCE_WAN | 25000 | 20.0 | 0 | 38–125 / 60–237 | 0 | — |
| `box_fear_rate7000` | **B's PC → box over the internet**, client `rate 7000` = the stock cap | 25000 / **7000** | 10.0 → **3.0** | all | 600 → **1,080 / 1,174** | **30 of 30** | 100 → 290 ms |
| `box_fear_rate25000` | **B's PC → box over the internet**, client `rate 25000` | 25000 / 25000 | **20.0** | 0–1 | 600–636 / 680–775 | 0 | **50 / 130–159 / 37–43 ms** |

Nacht's snapshots are 40–125 bytes, fear_mc_2's 400–1,100: five to ten times bigger, which is why the
stock cap only bit on the big custom map. In the box 7000 run snapshots grew past 1,164 bytes ~40 s in;
every message then went out as two fragments, each paced separately, and the rate fell to 3/s (delay
310–325 ms) — B's "unplayable". `sendto` under Wine costs 5–20 ms per 5 s window, max ~2.4 ms a call:
not a factor. The box "before" was taken with the client's own `rate 7000` because the fixed DLL was
already deployed; the server clamps min(rate, sv_maxRate), so it is the same pacing as the stock server.
The 25000 box run got ~80 s of data before B's PC crashed at ~03:16 (cause unknown; nothing here points
at this run, unproven either way). Local runs: new copies `waw-nd`/`waw-nc`, invisible, private profiles.
First local 25000 attempt paused itself (`pause: PAUSED solo_menu`) and is discarded; `25000b` ran with
`ENW_NO_PAUSE=1`. The "nacht" run was meant to be 7000 but read 25000 — `sv_maxRate` is archived and the
previous run's 25000 persisted in the copy's config; with ENW_SV_MAXRATE=0 the DLL leaves whatever the
config says.

### 22.4 What the launcher should pass (launcher lane — listed, not done, not published)

`rate 25000`, `snaps 30`, `cl_maxpackets 100` in the gamecfg baseline (`COMMUNITY_FIXES`). The server fix
covers everybody whose `rate` is already 25000 (the stock default, and B's config). A player whose
config.cfg has a lower `rate` (WaW's connection-speed menu writes one) is still capped at his own value,
because the server takes min(client rate, sv_maxRate). `snaps` above 20 costs nothing (the server frame
is 20 Hz); `cl_maxpackets 100` lifts the client→server usercmd rate from 30/s.

### 22.5 Not proven

A real launcher Play on the fixed box (B's session ended); more than one player (four at up to 25 KB/s
each is ~100 KB/s up per game — not measured); `sv_fps 30` (not tried: 20 Hz at 0 delay removes what B
described); socket buffers / `SO_SNDBUF` (nothing in the numbers points there); client delta failures
(not counted).

### 22.6 Box DLL `499b70c1` (2026-09-23 11:45 UK, integrator)

**`499b70c130911f3f1673d988b4491d0d17426ab4972b7b18c32a63a3a89ad474`** (2,272,768 B), built with
`tools\dev\build.ps1 -Name dedi` in the clean detached worktree `C:\Users\b\ZombiesDev\wt-coord2` at main
**`b568f01`** (merges of lanes 10, 14 and 4: the in-game Esc-menu Settings tab and the soak component's
`enw_dev_god.off` trigger). Installed into all 9 `waw-*/binkw32.dll` (copy to a temp name, `mv`, `chown
waw:waw`) with no game running and no live assignment; it replaced **`134a9d0f`** (04:48), rollback
`/home/waw/binkw32.rollback-134a9d0f.dll`. Host agent restarted idle (no host-agent file change). Proof:
agent lease `m_d7ad16e5` (fake …0003, Nacht) → `linked (… Sep 23 2026 11:44:06)` → `map_loaded` in 6 s →
`ready` → cancelled. The build string is the first of two builds (the second relinked only the test fix),
so it is not a hash check; `sha256sum` on the box is. Same binary as launcher 0.2.22.

### 22.7 Box DLL `06a2e1bd` (2026-09-23 12:35 UK, integrator)

**`06a2e1bdb1e564e6302db70d6dc27ae58e5c4f6c20270b631e271f3f2108e4a6`** (2,387,968 B), clean detached
worktree `C:\Users\b\ZombiesDev\wt-coord2` at main **`f8bc2d9`** (lane 1 Discord hook guard, lane 12
menu/console lockdown; `lockdown_test` 73/0, `settings_model_test` 55/0). Installed into all 9 copies
(temp name + `mv`, `chown waw:waw`) while lane 15's agent lease `m_abede789` (fake …0002) ran: a running
game keeps its old DLL. Replaced `499b70c1`, rollback `/home/waw/binkw32.rollback-499b70c1.dll`. **Host
agent not restarted** (no host-agent change since §22.6, and lane 15's agent game was live). Proof: agent
lease `m_2c3cf1b8` (fake …0003, Nacht) booted after the swap → `map_loaded` in 6 s → `ready` → cancelled.
The `linked` build string still reads 11:44:06 (the date TU is not rebuilt incrementally); `sha256sum`
is the check. Same binary as launcher 0.2.23.

### 22.8 Box DLL `10ba8544` (2026-09-23 12:44 UK, integrator)

**`10ba8544df4272fc65cb8028af7cf9ca47b45a009c840addc0bd930104f3a5ff`** (2,387,968 B), clean detached
worktree `C:\Users\b\ZombiesDev\wt-coord2` at main **`ad2ea6b`** (lane 17 WOW64 raw-input fix on top of
§22.7; `mouse_tests` all passed, `settings_model_test` 55/0, `lockdown_test` 73/0). Installed into all
9 copies (temp name + `mv`, `chown waw:waw`) beside lane 15's live agent game; replaced `06a2e1bd`,
rollback `/home/waw/binkw32.rollback-06a2e1bd.dll`. Host agent not restarted (no host change). Proof:
agent lease `m_e7918082` (fake …0003, Nacht) → `map_loaded` in 7 s → `ready` → cancelled. Same binary
as launcher 0.2.24.

### 22.9 Box DLL `974c2e8d` (2026-09-23 13:48 UK, integrator)

**`974c2e8d226576568b5be66bae01c148e1bc9de1cab23f2ca90af3a2a0875bfc`** (2,497,536 B), clean detached
worktree `C:\Users\b\ZombiesDev\wt-coord2` at main **`5696406`** (merge of lane C1 on `59e425d`: 17b,
T1, G1, A1; `settings_model_test` 65/0, `lockdown_test` 196/0, `mouse_tests` all passed). Installed into
all 9 copies (temp name + `mv`, `chown waw:waw`) while B played (his running game keeps its DLL; his
next boot takes this one); replaced `10ba8544`, rollback `/home/waw/binkw32.rollback-10ba8544.dll`.
**Not proven on the box:** no agent lease was run (rule 13: B was in a live instance), host agent not
restarted. Same binary as launcher 0.2.25. Prove with a fake-…0003 Nacht lease once B's game ends.

## 23. 2026-09-23 12:33 UTC — B's fear_mc_2 froze at 4 m 46 s: one escaped frame corrupted the script VM, and the VM then overran `localVars` (lane D1)

B's verified 1p game `m_0c608cd9` (inst-04, Wine pid 4520 / Linux pid 386851, `nazi_zombie_fear_mc_2`,
round 4, box DLL `10ba8544` from §22.8, pause OFF, write probe ON). `com_frameTime` stopped at
285,811 ms; the outer loop kept running at 61.8 Hz; `net_probe` showed `msgs=0` to client 0; B's
client saw the server go silent and quit through the lockdown end screen at 13:33:24 UK. The host
agent saw nothing: its last line for the game is `game live … cap 24.0h`.

**Evidence** (copied before anything else, `zombies-dev:/home/waw/zdev-host/freeze-20260923/` and
`C:\Users\b\ZombiesDev\logs\freeze-20260923\`): `enw-4520.log`, the engine's `console.log`, the
replay `m_0c608cd9.enwr`, the host journal from 12:27, `/proc` status/maps/stack, per-thread
stat/wchan/syscall twice 5 s apart (`snap1/2.txt`), and a Windows-side `winedbg` `bt all`
(`winedbg-bt.txt`; attached and detached, the process lived). No gdb on the box, so no core.

### 23.1 What each source says, in time order

| time (UTC) | source | what |
|---|---|---|
| 12:28:29–12:32:29 | `varpool` every 60 s | `localVars 03BDDE10` every time — that is `localVarsStack - 1`, the VM at rest. `[0x3BFD478] 021C1DF0` (the real dvar). Child pool ≤ 15,737 / 65,536 |
| 12:28:34–12:32:59 | `dedi_rate_probe`, 53 windows | `Com_Frame-body` **equals** `frame-body-entered` in every window: no frame left the body early for 4½ minutes |
| 12:32:59.9–12:33:04.97 | `dedi_rate_probe` | body **40.2** vs entered **40.4** Hz: **exactly one frame escaped**. No `Com_Error TRAPPED`, no `Sys_Error` — so it left through the engine's SEH abortframe (§12.1), i.e. an access violation somewhere inside the frame |
| same window | `console.log` line 211769 | the **first impossible script trace** of the game: gumball's `GetTagOrigin` error printed as *called from* gumball `wait 2`, *called from* `_hud_message::showNotifyMessage`, `_challenges_coop::updateRankAnnounceHUD`, `giveRankXP`, *started from* `self waittill("zom_kill")`. Gumball's flash loop is not called by the HUD code; it is running **on top of the HUD thread's function frames**, which were never popped. The 211,768 lines before it (16,000+ runtime errors, all from the map's own gumball / anticheat / loadout scripts) have correct traces |
| 12:33:05.213, frame 11741 | write probe | `WRITE #1 to [0x03BFD478] … just before eip=00697B99 … esi=0000615B` — the `mov [ebx],esi` in 0x697B60 |
| 12:33:05.257 | `dedi_reflection_dvars` | slot `021C1DF0 → 0000615B` |
| 12:33:09 → | `dedi_rate_probe` | body 2.2 Hz, then **0.0 Hz** for good; entered 61.8 Hz; `com_frameTime=285811` |
| 12:33:29 | `varpool` | `localVars 03BFE2DC` — **33,075 slots** above rest in one go. `localVarsStack` has 2,048 |
| 12:33:29 → | `dedi_temp_guard` | three `0x20000` put-backs, then quiet — a consequence (client messages into a dead frame), not a cause: it counted 0 before 12:33:29 |
| 12:35:49 | `/proc`, 5 s apart | main thread `S`, `do_select`, 25 ticks per 5 s (5 % of a core — the 60 Hz pacing sleep); every other thread idle in `futex_wait`/`pipe_read` |
| 12:37 | `winedbg bt all` | main thread in `recvfrom` ← codwaw **0x5FFDFF** ← 0x59DD95: the packet receive whose `WSAEWOULDBLOCK` branch loads `[0x3BFD478]` at 0x5FFE1D and faults at 0x5FFE23 (§12.5/§13.1). No thread is blocked on a lock or a wait of ours |

### 23.2 The mechanism

0x697B60 is **`Scr_AddLocalVars(inst@eax, localId@edx)`** and 0x697BB0 is **`VM_UnarchiveStack`**
(T4SP-Server-Plugin `cscr_vm.hpp` names both; KisakCOD `scr_vm.cpp:4687` is the IW3 shape). When a
waiting thread resumes, `VM_Resume` → `VM_UnarchiveStack` rebuilds its function frames and, for every
frame, pushes the names of that frame's local variables onto `scrVmPub.localVars` with no bound. The
stack is `gScrVmGlob.localVarsStack[2048]` at 0x3BDDE14 (`gScrVmGlob` = 0x3BDDDF8, T4SP), so rest is
0x3BDDE10. IW asserts (debug builds only) that `function_count == 0` and `localVars == localVarsStack
- 1` on entry to `VM_Resume`.

```
an access violation inside a script builtin / G_RunFrame path (not yet named)
  -> the engine's own abortframe swallows it: the frame body unwinds to Com_Frame's setjmp (§12.1)
     -> the VM is left mid-execution: function_count, function_frame, localVars not popped,
        the HUD thread's frames still on scrVmPub.function_frame_start[]
        -> later threads run on top of those frames (the impossible trace, line 211769)
           and archive them when they wait
           -> the next resume unarchives stale local-variable ids and Scr_AddLocalVars walks them:
              33,075 pushes, 16x the stack, straight through .bss
              -> [0x3BFD478] (r_reflectionProbeGenerate) becomes 0x615B, a name id
                 -> every frame's packet receive faults at 0x5FFE23 on WSAEWOULDBLOCK
                    -> every frame escapes; com_frameTime never moves again
```

**So it is not one of our hooks.** Pause was OFF. `temp_stack_guard`, `varpool`, `join_probe`,
`reflection_probe_dvars` and the rate/net probes are read-only up to the freeze (the guard's first
write is 24 s after it). Nothing of ours calls the VM. **It is also not the §16 NOP**: the store at
0x693D35 is reached only while `scrVmGlob.loading` is set (`cmp [0x3BDDE0C],0` at 0x693D24), and this
game was 4½ minutes past load. It is the engine's own frame-level exception swallowing, which is
harmless in a retail client (it never faults) and lethal to a script VM on a headless server that
does fault now and then (the water simulation in §12.2 was the first such fault; this is another).

This is the same writer as Nacht's two box deaths (§18.6, referee.md §15.4: 0x5FAD and 0x1DE3 at
0x697B97). Those had pauses; this one had none, so **pausing is not the cause**, which settles the
question §18.6 left open. What those games' first escaped frame was is not recoverable: nothing
logged one.

### 23.3 What is still unknown

**Which access violation escaped the frame at ~12:33:00–04.** The escape probe (§12.1,
`ENW_DEDI_ESCAPE_PROBE=1`) was not armed on the box, and it would have logged it. The trace suggests
the zombie-kill → `giveRankXP` → `_hud_message::showNotifyMessage` chain was executing (its frames are
the ones left behind), so a HUD-element or sound builtin that reaches renderer- or client-only data
on a headless server is the first place to look. That is a lead, not a finding.

### 23.4 `<bsp>_load.ff` on a dedicated server (coordinator's question, from lane A1's audit)

**The engine skips it on purpose. It is not our 0x5FF4E0 renderer bypass.** In `SV_SpawnServer` 0x631F20:

```
00631FB1  mov ecx,[0x1F552FC] / cmp byte [ecx+0x10],0 / je 0x632038   ; useFastFile
00631FBF  mov edx,[0x212B2F4] / cmp dword [edx+0x10],0 / jne 0x632038  ; com_dedicated -> skip
00631FCA  cmp byte [esp+0x13],0 / jne 0x632038                         ; map_restart -> skip
...        (usermaps search path, FS bookkeeping)
00632031  call 0x59DFE0     ; sprintf "%s_load"; DB_LoadXAssets(alloc 0x20, free 0x160)
0063203B  call 0x5AA020     ; both paths continue here
```

The `_load` zone is the loading-screen zone and a dedicated server has no screen. But some custom maps
keep game assets there. `ray_chirstmas_map_load.ff` holds its zombie models, so on our server those
zombies had none.

**Fix (cheap, checked, off switch):** `server/components/dedicated/load_zone.cpp` retargets the shared
`call 0x5AA020` at 0x63203B to a stub. The stub calls 0x59DFE0 with the map name first, but only when
`com_dedicated` is set, fastfiles are on, and it is not a map_restart. Those are the same three tests,
read from the same places. The listen path's FS bookkeeping stays skipped. All three sites are
byte-checked before the write. `ENW_DEDI_NO_LOAD_ZONE=1` restores stock.

| run (local, dedicated, 30 s hold) | `Could not load xmodel` | of them `bo2_c_zom_*` | all `Could not load` | simulating |
|---|---|---|---|---|
| `d1lz0` ray_chirstmas_map, `ENW_DEDI_NO_LOAD_ZONE=1` | 86 | 77 | 255 | +35,027 ms / 8 probes |
| `d1lz1` ray_chirstmas_map, patched | **9** | **0** | 178 | +35,017 ms / 8 probes |
| `d1lz2` Nacht, patched | — | — | — | +35,012 ms; `loaded nazi_zombie_prototype_load` |

**Unproven:** a client seeing the models (no client was run), the map_restart path (skipped by
design, not exercised), and memory on the box. The zone is 7.4 MB for this map, and the box runs close
to its limit (§19.5).

### 23.5 The fix: `freeze_watchdog.cpp` (the freeze is detected, reported and ended; its first cause is named next time)

- **The rule** (`freeze_watch.hpp`, pure; `server/tests/freeze_watch_test.cpp` 134/0, including a
  replay of §23.1's numbers):
  - **ESCAPED**: `frame-body-entered` moved and `Com_Frame-body` did not.
  - **FROZEN**: `com_frameTime` has not moved for more than 5 s while at least 30 frames were entered.
    It is armed only after the clock has moved three times, so a booting server does not trip it, and
    one long frame (a load) does not either.
  - **VM at rest**: between frames, `function_count 0`, `function_frame 0x3BD4720`, `localVars
    0x3BDDE10`, `top 0x3BD4A20`.
- **The fault recorder**: a vectored handler that only records, never logs and never handles. For
  error-class exceptions it keeps eip, the address touched, the registers and 48 stack words in an
  8-slot ring. The frame subscriber prints the records, because logging inside a VEH re-enters it
  (§12.1).
- **What it logs**: every escaped frame with its fault and the VM state (the first 20, then 1 in
  1,000; identical faults are collapsed to a count). The VM leaving rest, once per transition. An
  overrun past `localVarsStack`. On FREEZE: the faults, and every other thread's eip, esp and the
  codwaw return addresses on its stack. Nothing is allocated while a thread is suspended.
- **What it does on FREEZE**: `referee::end_game_now("server_freeze", "server_freeze",
  server_alive=false)` (`referee/game_over.hpp`). That sends the same `game_over` the scripts' ending
  sends, plus `flags:["server_freeze"]`. The replay sampler stops. Then `match_end {server_alive:false,
  awaiting:"teardown"}`, so the host signs the replay, posts the result and terminates the process.
  The game link still works on a frozen server, because `core_pump` runs from WinMain.
- **Host**: `lib/referee.js` copies known game flags (`GAME_FLAGS = {server_freeze}`) onto the
  record. The record stays eligible; it is marked, not refused. Run-all has 2 new tests (105/0 after
  the merge). `game-link-v0.md` documents both fields.
- `ENW_DEDI_NO_FREEZE_WATCHDOG=1` turns it off. `ENW_DEDI_FREEZE_MS` changes the 5 s line.
  **`ENW_DEDI_FREEZE_TEST=N`** plants §23's own 0x615B in `[0x3BFD478]` N s after arming. That is for
  proof only.

**Proof (local, Nacht, dedicated; a Node listener stood in for the host and fed each line to the
host's real `Referee`):**

| run | what happened |
|---|---|
| `d1f1` | Plant at `com_frameTime` 21286. `escape fault #1 … eip=005FFE23 reading 0000616B`, callers `0059B51A 0059B55F 005FEDC4 0059B6EB 0059DD95` (the same site and chain as B's game and §12.5). `FREEZE … not moved for 5008 ms while 298 frames entered`. `game_over {"reason":"server_freeze",…,"flags":["server_freeze"]}` + `match_end {"server_alive":false,"awaiting":"teardown"}`. Host summary `flags ["server_freeze"]`, eligible |
| `d1f2` | Same after the log dedupe, at 5004 ms. The freeze dump is now 1 record + 2 count lines |
| `d1h1` | **360 s healthy hold, no trigger**: 73 rate windows, 0 escaped frames, the VM never left rest, no FREEZE, no `game_over` |

**Unproven:**
- Not on the box. It needs this DLL on the box and a host-agent restart for the flag. Before that, an
  older host ignores `flags`. It still posts the result and tears the process down on
  `server_alive:false` (`host.js` disposition), so it is safe to ship the DLL first.
- Not with a real client. What the player sees when the host closes the game (the launcher's end
  screen) is the host and site's existing game-over path, which was not exercised here.
- **The cause**: which access violation escaped B's frame at 12:33:00–04 is still unknown. The next
  occurrence names it, in the `escape fault #1` line.
- **A true fix** (not attempted, needs that name first): stop the abortframe from unwinding out of the
  VM, or repair the VM after an escape. That means killing the stale threads the way
  `VM_Execute`'s infinite-loop path does.

### 22.10 Box DLL `04a3ad6d` + host agent `bde7e19` (2026-09-23 14:06–14:17 UK, integrator)

* **Host agent `dcf0ee7`** (H1 boot queue + RAM guard, T1 telemetry) deployed 14:06 as the whole
  `infra/host-agent` tree minus `test/`, plus `referee/manifests`, `chown -R waw:waw`; two agent leases at
  once: `RAM guard: inst-01 may boot - 967 MB`, `inst-02 … queued to boot, 1 ahead of it`, both
  `map_loaded`; three telemetry bundles reached the site (incidents 1–3) and `logs/` in the bucket.
  974c2e8d (§22.9) booted fine in those leases.
* **`1fda51c5`** (main `5d4d2b1`, D1) 14:10, rollback `binkw32.rollback-974c2e8d.dll`: Nacht `m_a5846b3d`
  `map_loaded`; DLL log `dedi_freeze_watchdog: armed`, `dedi_load_zone: … loads <bsp>_load first`.
  ray_chirstmas_map (hidden; agent lease allowed) `m_d7129f0e` → `map_loaded`; its console has 9
  `Could not load xmodel` (cage lights, subway lamps, one collision model), **no zombie body or head**.
* **`04a3ad6d…`** = `04a3ad6d8c9b43ae3e18a57ce6abe9dec1771f615b29160550a6a3dca2ea7c40` (2,597,376 B), clean
  `wt-coord2` at main **`bde7e19`** (R1 on D1), 14:13, rollback `binkw32.rollback-1fda51c5.dll`. Host
  agent `bde7e19` redeployed 14:14 between two maps of the A1 re-proof queue (rollback
  `host-agent.rollback-20260923T1314Z.tgz`). Proof: Nacht `m_7ce70442` → `map_loaded`; DLL log `replay:
  sampler armed (players 20 Hz, zombies 20 Hz, replay-events v1 …)`; replay header `"replay_events":1`,
  `"snap_hz":20`, `"zombie_hz":20`. Same binary as launcher 0.2.27.
* `freeze_watch_test.cpp` and `replay_events_test.cpp` (`server/tests/`) are not CMake targets, so the
  clean build did not run them.

## 25. 2026-09-23 — lane S1: the §23 freeze is a NULL `snd_errorOnMissing`, reached from `playLocalSound`; fixed (`snd_alias_dvars.cpp`)

### 25.1 The first failure: B's own game, before any soak ran

The soak was waiting for the re-proof queue (32/51 at 14:45 UK). Meanwhile B's verified fear_mc_2 game
`m_68e3fe9e` (inst-24 in `waw-inst-02`, Wine pid 3264, box DLL `04a3ad6d`, pause off) froze at **1 m 18 s**,
round 1, 670 points, 1 kill. The §23.5 watchdog did its job on the box for the first time: `game over:
server_freeze`, `SUMMARY … flags=[server_freeze] eligible=true`, `disposition: TERMINATE`, telemetry bundle
**`a2c82e5d`** (`host/instance_end`, 9 files). Evidence copied to `ZombiesDev\logs\dedi\s1\b24.*`
(`enw-3264.log`, the map's `console.log`, the host journal 13:41–13:47 UTC).

**The watchdog named the first escaped frame:**

```
13:43:40.241 ESCAPED frame (1 in all) com_frameTime 93584. VM NOT AT REST: function_count=5 localVars +10
13:43:40.241 escape fault #1 code=C0000005 eip=004F057E reading 00000010 | eax=00000000 …
             callers: 00695598 00690000 0060E48B 0068A11C
13:43:41.019 localVars is PAST THE END (+2917 slots)
13:43:46.921 ESCAPED #2 … [0x3BFD478]=000008FE, localVars +32168;  fault #2 eip=005FFE23 (the §23 packet read)
13:43:51.910 FREEZE -- com_frameTime 100226 has not moved for 5005 ms … ending the match
```

### 25.2 The cause, read off the decrypted image

```
004F04E0  PlayerCmd_playLocalSound  (builtin table entry at 0x83C278, "playlocalsound")
004F054F  call 0x699F30             ; Scr_GetString(0)
004F056D  call 0x5E5670             ; Com_FindSoundAlias(name)
004F0575  test eax,eax / jne ok
004F0579  mov eax, [0x3BE65DC]      ; snd_errorOnMissing   <- NULL on a dedicated server
004F057E  cmp byte [eax+0x10], 0    ; <- fault: reads 0x00000010
004F0585  push 0x858660             ; "unknown sound alias '%s'" -> Scr_Error
```

`0x695598` (the first caller) is `VM_Execute`'s `call [builtin table]`. `[0x3BE65DC]` is written in exactly
one place: **SND_Init 0x6B47C0** (`mov edi,"snd_errorOnMissing"; call Dvar_RegisterBool 0x5EEE20; mov
[0x3BE65DC],eax`), which a headless server never runs. A retail client has it at 0 and skips a missing alias
silently.

**Which alias:** the stock `_challenges_coop::updateRankAnnounceHUD` sets `notifyData.sound = "mp_level_up"`
(and `"mp_challenge_complete"` for challenges); `_hud_message::showNotifyMessage` does `self
playLocalSound(notifyData.sound)`. `mp_level_up` is a multiplayer alias. §23's impossible trace
(`showNotifyMessage` ← `updateRankAnnounceHUD` ← `giveRankXP` ← `zom_kill`) is this exact chain, so **§23
(12:33, 4 m 46 s) and §25 (13:43, 1 m 18 s) are one bug**: the first rank-up that plays a missing alias. The
Nacht deaths of §18.6 / referee.md §15.4 had the same writer (0x697B97) and are very likely the same thing;
not provable now (nothing logged their first escape).

**The same hazard, everywhere** (`tmp`-sweep of every dvar SND_Init stores, read outside the sound code): two
slots, twelve readers, all `mov reg,[slot]; cmp byte [reg+0x10],…` after a failed alias lookup:

| slot | dvar | readers |
|---|---|---|
| `0x3BE65DC` | `snd_errorOnMissing` | builtins `playLocalSound`, `playSound`/`playSoundAsMaster`, `playLoopSound` (both tables), `stopSounds`, `musicPlay`, `ambientPlay` |
| `0x3BE65D8` | `snd_reportSndAliasErrors` | 0x5C5180, the alias-index helper 0x63B560 (G_* callers), 0x64EBF0 (`"mp_player_join"`), 0x64EC90 |

Any map script that plays a sound alias its zones lack kills a dedicated server the same way.

### 25.3 The fix

`server/components/dedicated/snd_alias_dvars.{hpp,cpp}`: at post_init (main thread, after Com_Init, before
the map), on a dedicated server with the slot NULL, byte-check SND_Init's own `mov edi,<name>` / `mov
[<slot>],eax` and the name string, then call **the engine's `Dvar_RegisterBool` with the engine's own name
and description pointers, flags 0, default 0** — SND_Init's exact call, nothing else of SND_Init (no sound
driver). A frame subscriber re-registers if post_init could not (off-thread), and 5 s after the map starts it
logs whether `mp_level_up` / `mp_challenge_complete` / `mp_player_join` exist in the zones and runs one real
engine reader (0x63B560) on an alias that cannot exist: registered → returns 0, no exception.
`ENW_DEDI_NO_SND_ALIAS_DVARS=1` is the control; `ENW_DEDI_SND_ALIAS_TEST=1` runs the self-test even with the
slot NULL (the AV is caught under `__try` and logged — the mechanism in one line).

The fix removes this cause, not the class: any other AV inside a frame still leaves the VM half-run (§23.5
"true fix"). The watchdog still catches that and ends the match cleanly.

**Test:** `server/tests/snd_alias_dvars_test.cpp` (not a CMake target; command in its header) — 64/0: the
reader model (missing + unregistered = AV; registered at 0 = silent), the decision table, and every address
above checked against `ZombiesDev\dumps\codwaw-1.7-a.exe` (names, descriptions, SND_Init's instructions,
default `xor al,al`, the call target, each reader's load and `+0x10` test). `freeze_watch_test` 134/0.

**DLL** `6b838bdbaef50dcadfffcbf29297ec427889c0726b9befcdcc0c0be8f98e2dbc` (2,605,568 B), `build\s1` at
branch merge `6629c7b` (main `435b114` + `c39701d`); copy at `ZombiesDev\logs\dedi\s1\enw_t4-6b838bdb.dll`.
`loadtest` loads it. **Not on the box yet** (the coordinator deploys); no game was launched on B's PC.

### 25.4 Unproven at this point

- The fix in a running engine: no local run (B's PC is off-limits for games this session). The box proof is
  the DLL log's `registered snd_errorOnMissing -> dvar_s …`, the alias line and the self-test line.
- That a player's rank-up no longer escapes: needs a real player game past the first rank-up on the new DLL.
- The soak itself: see 25.5.

### 25.5 The soak (runs table; updated as runs end)

The god-mode player in `boxsoak.ps1` is a **local client on B's PC** (`launch.ps1`), so it cannot run this
session. The runs are **server-only holds**: an agent `--dev-god` lease on fake `…0003`, nobody joins, box-side
samples over ssh every 60 s, up to 120 min or until the instance dies. With no player the round never starts
(no kills, no rank-ups), so these holds test the idle server — memory, the frame body, the host's handling —
not the §25 path.

| run | map | DLL | start (UTC) | length | ended by | RSS start→end | notes |
|---|---|---|---|---|---|---|---|
| b24 (B's game, not a soak) | fear_mc_2 | 04a3ad6d | 13:42:04 | 1 m 18 s | `server_freeze` (watchdog) | — | fault 0x4F057E, §25.1 |

## 26. 2026-09-23 evening — lane INT: the S1 fix deployed, two more NULL dvars registered, rate scale x4

### 26.1 Why: B's three freezes 14:00–14:27 UTC were the §25 bug through `playSound`

B's `nazi_zombie_lorkeep` (inst-47), `nazi_zombie_ils` (inst-49) and `ut_box_map` (inst-50) all ended
`server_freeze` on box DLL `04a3ad6d`. Their DLL logs (`waw-inst-01/enw-2728.log`, `enw-3944.log`,
`enw-4532.log`) each say `escape fault #1 code=C0000005 eip=0051BC60 reading 00000010 | callers: 0051BDAD …`.
0x51BC5A is `mov ecx,[0x3BE65DC]` in `playSound` (0x51BBF0) — S1's reader table already listed it — so this
is §25's NULL `snd_errorOnMissing`, reached from `playSound` instead of `playLocalSound`. S1's fix registers
the dvar itself, so the slot is non-NULL for **every** reader; it was on main (`a4b0db2`) but never deployed.

### 26.2 More client-only dvars that server code reads (static scan + runtime proof)

A static scan of all 1,957 `Dvar_Register*` call sites (Bool 0x5EEE20, Int 0x5EEEA0, Float 0x5EEF10,
Variant 0x5EED90, Vec3/4, Enum 0x5EF150), 175 registrars, walked from WinMain skipping what a dedicated
server does not take (CL_Init 0x647710, Com_Init's `dedicated==0` block 0x59D5B5–0x59D662, CL_InitRenderer,
SND_Init, CG_Init, UI init), against unguarded `mov reg,[slot]; … [reg+0x10]` readers reachable from
G_RunFrame or the script builtin tables (scripts in the session scratchpad, not the repo). Beyond the two
sound slots:

| slot | dvar | reader | path | registrar that never runs |
|---|---|---|---|---|
| `0x3BFDEBC` | `r_watersim_debug` | 0x4E58AE in 0x4E5810 (bullet impact), when the hit surface type is 0x14 (water, inferred) | G_RunFrame → … → 0x4E5810 | 0x6F0D90 ← R_Init ← CL_InitRenderer |
| `0x16A2060` | `fx_enable` | first instruction of 0x4AD6B0, 0x4AD700, 0x4B2E20 (all unguarded) | G_RunFrame → 0x62A360 → … → 0x570950; physics 0x6A5350 | FX 0x4A4D10 ← CG_Init |

**Runtime proof** (box, `fd3039d2`, every lease): `registered r_watersim_debug … ([0x03BFDEBC] was NULL …)`
and `registered fx_enable … ([0x016A2060] was NULL …)` — both slots really are NULL on the dedicated server.
Both are now registered by the same mechanism (`snd_alias_dvars.{hpp,cpp}`, the table gained per-slot
flags/value: `r_watersim_debug` flags 0x4408 default 0; `fx_enable` flags 0x80, **registered at 0** although
a client has 1 — every reader then returns early, right for a server with no FX system). Lower-ranked, not
registered: `ui_mapname` / `ui_gametype` (party code behind three party-state fields; `ui_gametype` also
faults if someone `+set`s it on the dedi command line — nothing does), SND readers inside the sound engine
(unreachable), `snd_touchStreamFilesOnLoad` (only with `useFastFile 0`). The scan also found one
`snd_errorOnMissing` reader S1 had missed (0x5E5C20, L1 had it) — already covered, now in the table.
**Correction to a premise:** "render-skip" does not mean `r_*` dvars are missing; R_RegisterDvars
(0x707A20, 279 dvars) runs on the dedi through 0x644F40 → 0x6D5740.

The freeze watchdog now names a known fault eip (`fault #1 at 0051BC60 is KNOWN: …`), L1's `fault_name`
moved onto S1's table as `known_fault_name` (one fault eip per reader, 16), and the telemetry rules
(`KNOWN_FAULTS`, L1's `955ae8a`: `server_freeze` P1, `frame_escape`, `asset_limit`, `map_oom`) mirror it.
L1's `snd_dvar_stub.cpp` and F1's `snd_missing_guard.cpp` (two more fixes of the same bug) were dropped.

### 26.3 F1's rate scale x4 (the nazi_zombie_ils lag)

`net_rate.hpp` / `net_probe.cpp` (F1 `16e4a3b`; its `dedi.md` §24 was never written — B's PC rebooted at
15:30 — so the header comment of `net_rate.hpp` is the record): a snapshot bigger than one packet is
fragmented, flushed at once and paced by 0x639360 on its whole size with no clamp, so above ~1,186 bytes
no message goes at 20 Hz on any stock setting (fear_mc_2's ~2,100-byte snapshots went at 10 Hz). The fix
changes the `imul eax,eax,1000` imm32 in SV_RateMsec (0x639323) and 0x639360 (0x6393A6) to 1000/scale,
byte-checked (verified against the dump: `69 C0 E8 03 00 00` at both). `ENW_NET_RATE_SCALE` default 4
(1 = stock, max 8), dedicated only: up to 4,936 bytes at 20 Hz at rate 25000, 100 KB/s per client at most.
Reviewed: no instruction length change, applied in `post_unpack` before any server thread, per-client
bound kept. `net_rate_test` 26/0. Box log: `net_probe: rate scale x4 -- … multiply by 250, not 1000`.
**Unproven with a player**: whether ils's lag and dropped inputs are gone needs B's next internet game.

### 26.4 Deployed

| | |
|---|---|
| **DLL `fd3039d2419e596555021ca986686d6881730b06fde0835b60f66cc7fe2c82f2`** (2,608,640 B) | built clean in `C:\Users\b\ZombiesDev\wt-int` (detached, `git status` empty) at `fa1784f`; DLL source identical to main `645649c`. All 9 copies at 16:00 UTC. Copy `ZombiesDev\logs\dedi\int\enw_t4-fd3039d2.dll`. Launcher 0.2.28 ships the same binary |
| before it: `cc05262410aa19b2…` | 15:51 UTC, same tree at `e1d29f3` (S1 fix + F1 + L1 names, without 26.2's two dvars). Rollback `/home/waw/binkw32.rollback-cc052624.dll` |
| rollback to the pre-INT DLL | `/home/waw/binkw32.rollback-04a3ad6d.dll` |

Proofs — agent leases on fake `76561198000000003`, one at a time, each cancelled after; nobody joins, so no
rank-up or player sound ran (the self-test line runs a real engine reader on a missing alias instead):

| map | lease | DLL | `registered` lines | `map_loaded` (UTC) | survived | escape faults |
|---|---|---|---|---|---|---|
| ut_box_map | `m_ab6ca3c6` | cc052624 | snd ×2, self-test `returned 0 with no exception` | 15:52:10 | 286 s | 0 |
| nazi_zombie_ils | `m_78b1f4d0` | cc052624 | snd ×2, self-test ok | 15:57:30 | 186 s | 0 |
| nazi_zombie_lorkeep | `m_52735961` | **fd3039d2** | snd ×2 + r_watersim_debug + fx_enable, self-test ok | 16:01:22 | 193 s | 0 |
| nazi_zombie_ils | `m_312c3a38` | **fd3039d2** | all four, self-test ok | 16:05:14 | 196 s | 0 |

Every lease also logged `mp_level_up=MISSING mp_challenge_complete=MISSING mp_player_join=present`: the
alias that killed B's games is missing on these maps too, and is now silent.

### 26.5 Still unproven

- A real player's game past its first rank-up / first missing-alias sound on the new DLL (B's next game).
- A bullet into water on the dedi (Shi No Numa-style map, a player shooting) — the reader is inferred to
  be water from the surface-type test; the registration itself is proven.
- ils lag with a real internet client (26.3).

### 26.6 Addendum (lane REL, 2026-09-23 18:17–18:45 UTC): the evening merges on the box

Every DLL built in a clean detached worktree at a main commit (rule 17), each deployed only to production
copies not running a game (`waw-inst-01..04`, `waw-probe`, `waw-stock`, `waw-vps1`; `waw-tinst-*` never
touched), copy-to-temp + `mv`, `chown waw:waw`. No real player was live for any step (B's idle zm_nuked
lease `m_5a28dcbe` ended 18:11; lane MAPS's fake-`…0005` queue ran throughout and was worked around).

| DLL | main / worktree | copies | proof |
|---|---|---|---|
| `2fda99fe` | `43f722f` / `wt-rel4` (CL+UGX+SOC+RV) | 6 of 7, 18:13 | - |
| `884dde5f` | `499e254` / `wt-rel5` (+G2) | 6 of 7, 18:17 | nacht_reimagined `m_018c6208`: `dedi_water_sim_off: post_init: r_gfxopt_water_simulation 1 -> 0`, `map_loaded`, all 4 `dedi_snd_alias_dvars … registered`, `game_mode: bound`, no MISMATCH (no player) |
| `736236c8` | `9589c91` / `wt-rel6` (+S2) | 7 of 7 (inst-01 at 18:27) | - |
| **`3557aaa3`** | `0a03304` / `wt-rel7` (+G2 CLIENT FROZEN) | **7 of 7**, 18:29 + inst-01 18:35 | nacht_reimagined `m_adde3e93`: `map_loaded`, snd dvars registered, **`dedi_water_sim_off: NOT applied: [0x042B721C]=00000000 but Dvar_FindVar(r_gfxopt_water_simulation)=021BAC04`**; nazi_zombie_ils `m_077a1836`: **16.4 % of one core over 60 s, `dedi_rate_probe` 61.0–61.3 Hz** (S2's fix holds), and no `dedi_water_sim_off` line at all |

**Open, for lanes G2 + S2:** the water fix applies on `884dde5f` (G2, no S2) and on G2's own `92b01569`, and
fails on every build with S2 merged (`736236c8`: derberg; `3557aaa3`: nacht_reimagined, and silent on
ILS). S2 added `bots.cpp` (inert without `ENW_DEV_KNOBS`), the `memory.cpp` image fast path, and
`t4_bind`/`structs` fields; `read_raw` itself is unchanged in substance, so the cause is not proven.
The A/B is `ENW_MEMORY_SLOW_READS=1` on one lease. Until then the box has S2's CPU fix but not G2's water
fix; `/home/waw/binkw32.rollback-884dde5f.dll` is the build with the water fix and without S2 (REL did not
roll back: that trade is the coordinator's call).

Host agent: main `9589c91` (UGX `gamemode.js`, the 31 `+`-command guard, S2 `settings.dev.bots`) deployed
18:27 UTC in a gap in MAPS's queue; rollback `/home/waw/host-agent.rollback-20260923T1826Z.tgz`.
Rollbacks for the DLL chain: `binkw32.rollback-{fd3039d2,2fda99fe,884dde5f,736236c8}.dll`.

### 26.7 Addendum (lane REL, 18:50–19:20 UTC): RS + the G2 race fix on the box

Order per lane RS: site (main `c99b346`, 19:52 UK), then host agent `c99b346` + DLL **`1b482aa2`** (clean
`wt-rel8` at `c99b346`) into all 7 production copies in one gap with no game (18:58 UTC; rollbacks
`host-agent.rollback-20260923T1857Z.tgz`, `binkw32.rollback-3557aaa3.dll`), then host `a2c330d` (S2 `3b5ffd8`)
at 19:12 UTC (rollback `host-agent.rollback-20260923T1912Z.tgz`). The §26.6 regression is gone: it was
G2's startup-order race (§28.9), not S2.

* nacht_reimagined `m_35b82cb2`, nazi_zombie_ils `m_4bed9049` (fake …0006): `dedi_water_sim_off: post_init:
  r_gfxopt_water_simulation is already 0 (dvar_s 021BAC04); held at 0`; 0 `solo_parity: MISMATCH` (the one
  grep hit is the `armed` line quoting the word; no player, so no spawn checks); `restart_request: armed`
  and `ui_gametype … slot [0x0208E8E8] was NULL … filled`. CPU over 60 s: nacht_reimagined 17.6 %, ILS
  **17.9 %** of one core; `dedi_rate_probe` 60.9 Hz on both (S2's fast path holds).
* UGX gungame, battlestar_galactica `m_86cc3964`: the host passed `+set enw_game_mode gungame:…` and the DLL
  bound (`game_mode: bound (openMenu 004EF840)`), but no `ENWZombie;game_mode` event: with no client
  connected the map never opens its vote menu, so there is nothing to answer. The answer itself is
  unproven on the box (needs a real or harness client).
* RS restart through the host path: unproven (needs a client sending `enw_req restart.<n>`).
* RS idle auto-close, Nacht `m_07a483ce` left idle from 19:13 UTC: PROVEN: `19:18:02 host/inst-01 IDLE CLOSE: nobody joined within 300 s of the server being ready -- ending lease m_07a483ce (no_players)`; the game process was gone after.

### 26.8 Addendum (lane REL, 19:34 UTC): S2 bot fixes on the box

DLL **`70b28f5b`** (`70b28f5b025bd1edded67db142caa58ece0b121670568d8fa01f796f31e23e5f`), clean `ZombiesDev\wt-rel9`
at local main `d8b580c` (= `1b482aa2`'s source + soc-loopfix (web only) + S2 `533cdae`: bots acknowledge every
snapshot, look at the floor with no target, per-bot position line). Reviewed: every change is in
`think_bots`/`minute_line`, reached only after `post_init` arms the component under `ENW_DEV_KNOBS=1`, so a
player game runs the same code as `1b482aa2`; no launcher release. Deployed to the 7 production copies by
temp + `mv` with no real player live (S2's Nacht soak `m_bd4f87b4`, fake …0003, kept running on its loaded
image; `waw-tinst-*` untouched). Rollback `/home/waw/binkw32.rollback-1b482aa2.dll`. first new game on it pending at 19:34 UTC (the next lease, MAPS zombie_maze, was waiting on the RAM guard).
Commit `d8b580c` is on local branches only (agent pushes blocked); main needs it pushed.

## 28. 2026-09-23 evening — lane G2: the "one-hit downs" are a phantom water surface at z=0 on the dedicated server (`water_sim_off.cpp`), plus a solo-parity self-check (`solo_parity.cpp`)

B, 14:00–14:27 UTC on box DLL `04a3ad6d`: Nuketown down the instant he spawned (game over in 1 s),
nacht_reimagined "not touching the floor, missing inputs, floating", bridge_zombie / battlestar down
on "one hit". Build: branch `worktree-agent-aac675948eb19e877` (main `27026f6` merged).

### 28.1 What the evidence says, per map

| map | B's replay / server log | cause |
|---|---|---|
| zm_nuked `m_89bf26b9` | spawn 72994 ms; `damage by:null hp 75` (+84 ms), `hp 39` (+125), down (+175), `hp 3` | **drowning**: the player spawned ~390 units under a water surface that exists only on the server |
| nacht_reimagined `m_892d6c70` | player z p50 **-50**, zombies at the same x/y **35 units lower** (floor -87.6), all game | **swimming** at that surface (never on the ground) |
| bridge_zombie `m_abe60828` | hit to 39 at 37.1 s, regen to 100 at 39.6 s, hit to 40 at 42.6 s, down 43.3 s | **stock**: two zombie hits (60 each) inside the 2.4 s regen delay |
| battlestar `m_da684190` | hit to 40 at 66.9 s, down 68.4 s | **stock**, as bridge |

A zombie hit is 60 on every map (AI melee 150 × `player_meleeDamageMultiplier` 0.4, which
`_zombiemode`'s turret code confirms: `60 / player_damageMultiplier`), health 100, regen to full
2.4 s after the last hit (`playerHealth_RegularRegenDelay` at frac 0.75), and in solo WaW the lethal
hit is `PlayerLastStand` + `end_game` with no revive. So *one hit takes you to 40 and a second one
inside 2.4 s ends a solo game* — on the box and in a solo listen game alike (28.4). The downs B felt
as "one hit" on bridge/battlestar were two hits 0.7 s / 1.5 s apart. (Aside: bridge's first zombie
had 1,500 health in round 1 while the rest had 150 — the map's own, not investigated.)

### 28.2 The mechanism (read from the decrypted image)

`0x6F3F70` answers "how high is the water here" for pmove (via 0x46DA70), script `getwaterheight`,
missiles and physics. With `r_gfxopt_water_simulation` on (its dvar pointer is `[0x42B721C]`,
registered by R_RegisterDvars at 0x70BB50 — which runs on the dedi), it samples the renderer's
256×256 water-sim window (`0x6F2330` bounds, `0x6F3E00` waves) and adds the window's int16 base
height grid `[0x4DD8BD0]`. The renderer scrolls that window round the viewer and fills it from the
map's static grid (0x6F23C0). A dedicated server never runs that: `watersim_pool.cpp` (§11) makes the
engine allocate the buffers so the server stops faulting — and they stay **zero**, so every point in
the window reads "water surface at z = 0". With the switch off, 0x6F3F70 goes to **0x6F45B0**: the
map's static grid, `-32768` (0x8AF860) where there is no water. Maps with floors above 0 (stock
Nacht ≈ 0, bridge 170, battlestar 16, fear_mc_2 2304) never noticed.

### 28.3 The fix: `server/components/dedicated/water_sim_off.cpp`

Dedicated only: checks the gate bytes at 0x6F3F77 (`A1 1C 72 2B 04 80 78 10 00 57 74 65`) and that
`[0x42B721C]` is `Dvar_FindVar("r_gfxopt_water_simulation")`, sets current and latched to 0 at
post_init, and holds it every second. `ENW_DEDI_WATER_SIM=1` is the control arm. Clients are not
touched (their renderer owns and fills the sim). Every map, not a per-map list.

### 28.4 Proof (local dedi `waw-g2d` + invisible client `waw-g2c`, fake 76561198000000002; solo = listen)

| run | map | build | spawn | on the ground | hits |
|---|---|---|---|---|---|
| g2r1/g2r3 | nacht_reimagined | no fix | **95/100** | **never** (z -46…-54, vel z ±3, 100 % "nothing") | — |
| **g2r4** | nacht_reimagined | **fix** | 100/100 | **yes**: falls to **-87.6**, 100 % world | 60 → 40, second hit 0.41 s later = down → game over |
| g2l2/**g2l3** | nacht_reimagined | solo listen | 100/100 | yes, **-87.6** | 60 → 40, second hit = down |
| g2n3 | zm_nuked | no fix | 95/100, then -16, -4 (drowning, attacker none) | no | — |
| **g2n4** | zm_nuked | **fix** | **100/100, no damage** | **no** — see 28.6 | killed at +45 s by something scripted (100 → 0, no laststand) |
| **g2b1** | bridge_zombie | fix | 100/100 | yes (180.6) | 60 → 40, second hit 0.56 s later = down |
| **g2p3** | nazi_zombie_prototype (control) | fix | 100/100 | yes (1.1) | 61 → 39, second hit 1.5 s later = down |

Every fixed run: `r_gfxopt_water_simulation 0`, `g_gameskill 1`, `player_damageMultiplier 0.3226`
(= solo 100/310), `player_meleeDamageMultiplier 0.400`. Logs `ZombiesDev\logs\dedi\g2*.server.enw.log`,
link transcripts `ZombiesDev\logs\g2\<tag>\link.ndjson`.

### 28.5 The self-check: `solo_parity.cpp` + `solo_parity_rules.hpp` (every map, every game)

Per player, every server frame, read only: spawn health, every health drop with its last attacker,
what the player stands on (`ps.groundEntityNum`), time off the ground. A spawn below full health, a
live PM_NORMAL player off the ground for 5 s, and at +5 s `g_gameskill`, `g_player_maxhealth`,
`player_damageMultiplier` (vs 100 / (310 × co-op scalar)), `player_meleeDamageMultiplier` and, on a
dedi, `r_gfxopt_water_simulation` are checked; a difference is `solo_parity: MISMATCH slot N: …` in the
DLL log and a warn `log` on the link. Telemetry rule **`solo_parity`** (P2) flags it. g2r3 (fix
deliberately not applied) raised all three: `spawned HURT 95 of 100`, `FLOATING`, `water_simulation 1`.
Unit test `server/tests/solo_parity_test.cpp` 27/0 (rules + the six addresses against the dump);
`ENW_NO_SOLO_PARITY=1` turns it off.

### 28.6 Open

- **zm_nuked is still not playable locally with the fix**: the player spawns at the first
  `initial_spawn_points` struct (-6315 160 -388), drops 5 units and stays "on nothing" with vel z
  -87 (stuck), then dies at +45 s without a down. The map's own `coop_player_spawn_placement` dies on
  `"players_" + undefined` (`_zombiemode.gsc:2917`) on the dedi, so who puts the player on that struct
  is unknown; a solo listen reference could not be made (`Hunk_AllocateTempMemoryHigh: failed on
  1435238401 bytes` in a local listen game). The self-check flags it (`FLOATING`).
- **nazi_zombie_ils** lag (B: running/shooting slow, dropped inputs): B's replay has the player at z
  ≈ -5 with parts of the floor at -47 — consistent with the same phantom water, **not run** with the fix.
- The listen reference ran with `r_gfxopt_water_simulation 0` (its profile's value), so a client
  *with* the sim on vs the fixed server is not measured; the sim only adds waves on real water.
- Not on the box (lane INT deploys). The fix and the self-check need a box game on a below-zero map.

### 28.7 Build (not deployed)

`build\g2final\enw_t4.dll` from branch head `f67b11e` (main `27026f6`+ merged, no untracked
sources), 2,677,760 bytes, sha256 **`e7efde2c8002ab9c6f2f858fe7905049d972f560861391b8b975990c75e61e5f`**.
Proven with this exact file: g2r6, nacht_reimagined, spawn 100/100 on the world, stands on -87.6,
one hit 60 → 40, second hit = down, 0 mismatches. It is a box DLL (server components); deploy per
rule 17 from a clean worktree at the merge commit, rollback = the current box DLL `fd3039d2`. The
first box game on a below-zero map should show `dedi_water_sim_off: post_init: r_gfxopt_water_simulation 1 -> 0`
(or nothing, once an instance's config has archived the 0) and `solo_parity: slot 0 SPAWNED … on world`.

### 28.8 Follow-up (19:15–19:30 UK): Nuketown was the client hanging; ILS was never in water

**zm_nuked "stuck, scripted death at +45 s" (28.6) was the test CLIENT freezing, not the map.**
`g2n4.client.enw.log`: `hang_watchdog: the MAIN THREAD … has not ticked for 8000 ms`, stack in
`0x70E370` — the render-lock wait of lane CL's GPU occlusion-query hang (`client.md` §13, sun flare).
With no usercmds the server never moved the player (frozen at vel z -87, "on nothing"), and the
"death" at +45 s was the server dropping a client that had sent nothing for ~40 s. CL's
`gpu_query_guard.cpp` (main, launcher **0.2.29**) fixes it: run **g2n5** (client DLL from main
`07d924a`) — `gpu_query_guard: TRIPPED` on the client, the player spawns 100/100, stands on the world
at -398.3, one zombie hit 61 → 39, the second 1.7 s later is the down → game over. 0 mismatches.
Nothing map-side needed. `solo_parity` now tells the two apart: a player off the ground whose
`lastUsercmd.serverTime` has not moved is `MISMATCH … CLIENT FROZEN`, not `FLOATING`.
(The failed local solo listen of Nuketown is a separate thing: `Hunk_AllocateTempMemoryHigh` on a
1,435,238,401-byte file read in the listen-only script/clientscript load path, 0x689980 → 0x68AED0.)

**nazi_zombie_ils, g2i1 (fix on):** spawn (1588 -835 7) 100/100, drops to **-4.9 on the world** and
stays there — so B's z ≈ -5 is ILS's floor, not water; hit 60 → 40, second hit = down; server
58.4 Hz, `perf` p50 17.1 ms. 0 mismatches. The slowness B felt is not reproducible here (local,
loopback); lane S2 attributes the box's ILS lag to Wine `VirtualQuery` CPU (their fix, not deployed).

DLL at this commit (`build\g2final`, 2,677,760 bytes) sha256
**`92b015691925b463f6eef74a7d712cffc54b3fa94e40023462907f2ecfbab403`** — it adds only the CLIENT
FROZEN wording to `solo_parity`; the water fix is unchanged from `e7efde2c`.

## 27. 2026-09-23 evening — lane S2: soak bots with no client anywhere, and why an idle nazi_zombie_ils server used 0.82 of a core

### 27.1 Bots without B's PC: `server/components/dedicated/bots.cpp`

T4 SP still has IW3's test-client machinery (`client_s.bIsTestClient` +0x52BFC read by
SV_SendClientGameState 0x62F5A7 and SV_AddServerCommand 0x633D35, `sv_botsPressAttackBtn`,
SV_BotUserMove 0x635DF0, the per-server-frame bot loop 0x636070 over every client whose
`netchan.remoteAddress.type` is NA_BOT (0)), but nothing in the image ever sets `bIsTestClient`:
SV_AddTestClient and `addtestclient` are compiled out (no `bot%d`, no connect template). Plutonium's
`addtestclient` (what `t4sp_bot_warfare` uses) is theirs, not the exe's. So `bots.cpp` rebuilds
SV_AddTestClient from the engine's own functions, IW3's shape:

| step | engine function | why it works for a bot |
|---|---|---|
| `connect "\…\protocol\62\challenge\0\qport\<n>\name\enwbot<n>"` | SV_Cmd_TokenizeString 0x594D50 (ecx) | DirectConnect reads `SV_Cmd_Argv(1)` |
| NA_BOT address, unique port | SV_DirectConnect 0x62E3A0 (netadr by value, 0x18 B) | type 0 skips the challenge (0x62E5D0) and the Demonware ticket (0x62ED37); NET_SendPacket drops type 0 (0x679185); ClientConnect 0x67BF40 runs the connect callback |
| | SV_Cmd_EndTokenizedString 0x594D80 | |
| `bIsTestClient = 1` | — | SV_SendClientGameState then writes the zeroed stats + 0x7F marker instead of `EXE_NEEDSTATS` |
| gamestate | SV_SendClientGameState 0x62F500 (cdecl) | CS_CONNECTED → CS_CLIENTLOADING |
| enter world | SV_ClientEnterWorld 0x62FC30 (eax = client, [esp+4] = usercmd) | CS_ACTIVE; tail-jumps ClientBegin 0x67C160 |
| `client_s+4 = 10` | — | the top nibble of every client packet (SV_PacketEvent 0x6356D9) is its load state; `getnumconnectedplayers` 0x52E9E0 counts state 4 **and** this == 10, and `_load.gsc` waits for that count. Without it the bot is in the world and nobody ever spawns (run t1) |

**The brain.** SV_RunFrame's `call 0x636070` at 0x636482 (nothing else hooks it) is retargeted to our
function, so everything below runs **inside** the server frame, where the engine thinks for bots and
where a bot's bullets reach G_Damage anyway: never from a frame subscriber, where a Com_Error longjmp
would land in a dead frame. Each server frame each bot gets a usercmd (svs.time, its current weapon,
view angles to the nearest living axis actor corrected by `ps.delta_angles`, attack on alternate frames
within 1,500 units), `deltaMessage = outgoingSequence - 1`, and SV_ClientThink 0x630BF0. It stands where
the scripts spawned it. The engine's own random walker (`ENW_DEV_BOT_RANDOM=1`) wanders out of the
active zones on a zoned map: on nazi_zombie_ils one zombie spawned and round 1 never ended (run
ab-ils-fast).

**The kills.** A living axis actor with takedamage, older than `ENW_DEV_BOT_KILL_AGE_MS` (8,000,
jittered 0.5–1.5× per zombie, so they reach the bots and hit them), is killed by G_Damage 0x4F5D70 with
the bot as inflictor and attacker, MOD_PISTOL_BULLET, weapon -1 (the bot's own, 0x4F5DBB), hitLoc head:
the call GScr `dodamage` makes (0x51CBD9). At most `ENW_DEV_BOT_KILLS_PER_S` (3) a second. So the
zombie's damage/death scripts, kill points, rank XP (§25's `mp_level_up` path), powerups and the round
counter run as for a player. `enw_dev_god.off` (soak.cpp's end-of-soak switch) also stops the kills,
or the zombies never reach the bots and the game never ends (run t2 kept going to round 13).

**The gate.** `ENW_DEV_KNOBS=1` or nothing is installed. Count: `ENW_DEV_BOTS=N` (1–4) or
`enw_dev_bots.txt` next to CoDWaW.exe (re-read every 5 s, so a run can go from 1 to 4 bots). Host:
`settings.dev.bots` on an agent's Custom lease → `ENW_DEV_BOTS`, and `sv_maxclients` ≥ bots
(`devKnobsFor`/`devBotsFor`, run-all 109/0). `lease-cli --dev-bots N`. The referee treats a test client
as absent (`client_view.bot`, `active=false`; `last_usercmd` none): no roster row, no auth, no kick, no
AFK input. `dev_bots:` once a minute: server-frame gap (between SV_RunFrame calls) p50/p99/max, Com_Frame
gap, level.time against the wall, main-thread CPU %, working set, entities in use, actors alive (max),
kills.

**Runner.** `tools/dev/botrun.sh` runs one game in the box's TEST copy `waw-tinst-01` (never
`waw-inst-*`) with a given DLL, outside the host agent, samples every 60 s into a CSV, and ends through
`enw_dev_god.off`. A guard polls the host journal every 2 s and kills **our** game at the first
`assignment changed: leased` or `RAM guard` line, or when MemAvailable < 250 MB; it refuses to start
under 850 MB (every production slot idle) or within 15 min of a verified non-fake admission.
`tools/dev/botqueue.sh` runs a list, retrying refused starts every 2 min.

### 27.2 The nazi_zombie_ils lag: the server ran its frame at ~24 Hz, and 94% of its CPU was our own guarded reads

**B's ILS game** (14:23 UTC, inst-49, `enw-3944.log`, DLL 04a3ad6d, one internet client, rate 25000):
the rate probe says `Com_Frame-body` **23.5–24.2 Hz** for the whole game against a 60 Hz target (13–15 Hz
while he loaded in), and `net_probe` sends him **~24 messages/s** of 150–230 bytes, no fragments after the
gamestate. A client's usercmds are read once per Com_Frame, so at 24 Hz every input waits up to ~42 ms
before the server even sees it, and snapshots leave at 24 Hz instead of the 30 he asked for. The empty
servers the host booted today show the same thing by map (median `Com_Frame-body` over each log, nobody
connected): ILS **20.6 / 31.8 / 33.1 Hz**, zombie_town 22.2, lorkeep 27.8, fear_mc_2 32.5 (B in it),
nuketown 37.2, … up to 55–57 for the light maps. None reached 60.

**Where the time goes** (`perf record -t <main tid> -F 499`, 15 s, an idle production ILS server,
16:05 UTC): the main thread used **0.82 of a core**; **1.2%** of the samples were CoDWaW.exe's own code.
40% were one loop in Wine's `ntdll.so` (+0x5BDC0: a dword scan xor'ing a replicated byte — Wine's
per-page protection-byte scan, `get_vprot_range_size`), 27% the 32-bit syscall gate in the vdso and
27% the kernel (the two `rt_sigprocmask` of Wine's virtual-memory lock). That is **VirtualQuery**:
`memory::is_readable` calls it before every `memory::read`, and `t4_bind`'s `peek` does the same, so
every dword the referee, the replay sampler, AFK and the probes read each frame cost a scan of the
region it lives in — and CoDWaW.exe's `.data` is one 72.9 MB region (~17,800 page bytes). A map with
more entities is read more, so ILS paid most. On Windows VirtualQuery is cheap, which is why no local
run ever showed it.

**The fix** (`shared/core/memory.cpp`, generic, every map): a range wholly inside the game image is
readable without asking, once a walk of the whole image (every 5 s, ~20 regions) has shown every page
committed and readable; a failed walk turns the fast path off until one passes. Outside the image,
unchanged. `ENW_MEMORY_SLOW_READS=1` is the control. `bots.cpp` writes its `client_s` fields with plain
stores for the same reason (`memory::write` VirtualProtects twice per call).

| same box, same map, DLL | who | main thread | Com_Frame-body |
|---|---|---|---|
| production fd3039d2, ILS, 16:05 | nobody | **0.82 core** | ~33 Hz |
| production fd3039d2, zm_nuked, 16:51 | nobody (B's lease, not joined) | 0.46 core | 53.3 Hz |
| S2 `0c2777bd` (fast path), ILS, 16:32–16:36 | 1 bot | **0.22 core** (main-thread 21–25%) | **61.0 Hz** |
| S2 `add998a5` (fast path), Nacht, 16:18–16:26 | 1 bot, rounds 1→9 | 0.21 core | 61.0 Hz |

### 27.3 Runs (box, `waw-tinst-01`, outside the host agent; updated as runs end)

| run | map | DLL | start (UTC) | length | rounds | ended by | notes |
|---|---|---|---|---|---|---|---|
| t1 | Nacht | fa494e0e | 16:11 | 5 m | — | killed by us | bot seated (state 4, gentity 0176C6F0) but never spawned: load state not 10 (27.1) |
| t2 | Nacht | add998a5 | 16:17 | 12 m | 1 → 13 | time up; god off, but kills went on (fixed) | 0 escapes; main thread 20%, Com_Frame 61 Hz, sv-frame gap p50 49 / p99 65 ms, level.time 1.000 of wall; RSS 308 MB flat; child vars 13.1k → 15.1k |
| ab-ils-fast | ILS | 0c2777bd | 16:31 | 5 m | 1 | the guard (an agent lease) | random-walk bot: 1 zombie then no spawns (zoned map) → the stand-and-aim brain; 0.22 core, 61 Hz, one 2.5 s hitch in minute 2 |

**Blocked from 16:36 UTC:** B's own verified zm_nuked lease `m_5a28dcbe` (state `ready`, nobody joined)
holds ~460 MB, so MemAvailable sits at ~510 MB and every start is refused (floor 850). The queue
(`/home/waw/zdev-test/s2/q2.txt`: ILS A/B fast vs `ENW_MEMORY_SLOW_READS=1`, ILS/ut_box_map/lorkeep 45 min,
Nacht and Der Riese 120 min, DLL `b83ea7fd` = main `27026f6` (INT's four registrations) + S2, copy `ZombiesDevogsdedis2enw_t4-b83ea7fd.dll`) keeps retrying every 2 min and starts by itself;
results append to `/home/waw/zdev-test/s2/queue.log`. Stop it with `pkill -f botqueue.sh` (the guard
still ends a running game on the next lease).

### 27.4 Capacity so far (fast-path DLL; low rounds only — round 20+ is what the queue measures)

| | main thread | RSS |
|---|---|---|
| Nacht, 1 bot, rounds 1–13 | 0.21 core | 308 MB |
| ILS, 1 bot, round 1 | 0.22 core | 386 MB |
| zm_nuked, idle, **production** DLL | 0.46 core | 459 MB |
| ILS, idle, **production** DLL | 0.82 core | 385 MB |
| Steam client + CEF (always) | ~0.1 core | ~2.3 GB |

On the production DLL two ILS-class games already take 1.6 of the 2 vCPUs before anyone plays; with
the fast path they take ~0.45. **RAM, not CPU, is the limit at low rounds**: MemAvailable is ~880 MB
with no game, a game is 300–460 MB, so the third slot only fits a small map (the RAM guard's 700 MB
floor already stops it). Whether 20+ rounds with 4 players changes the CPU picture is open.

### 28.9 Box DLL 3557aaa3 "NOT applied": an ordering race, not S2's memory fast path (fixed, 356fdf8)

The box logged `dedi_water_sim_off: NOT applied: [0x042B721C]=00000000 but Dvar_FindVar(r_gfxopt_water_simulation)=021BAC04`
(nacht_reimagined inst-02 enw-4628, derberg, ccube). S2's `memory.cpp` change only makes image reads
skip VirtualQuery; the read was right — the slot really was NULL. The dvar_s* is stored into
[0x42B721C] by the renderer's registrar (0x70BB50 ← 0x70B358 ← 0x6E2430 ← R_RegisterDvars 0x6D5740),
which on a dedi can run *after* our post_init; the instance's `seta r_gfxopt_water_simulation` had
already created the (unregistered) dvar, so Dvar_FindVar found it. S2's faster startup moved post_init
ahead of the registrar; it is a race either way (locally with S2 merged it now loses too). ILS logged
nothing because it won the race and the value was already 0 (that path was silent).
Fix: bind at post_init if the slot is filled, else on the first frame that has it (the gate at
0x6F3F77 dereferences the slot, so no water query can run before then); write only a registered
**bool** dvar (type byte 0 — a byte into a pre-registration string dvar would corrupt its pointer);
log the already-0 case. `ENW_DEDI_WATER_SIM_LATE=1` (test) forces the late path.
Proof, DLL `build\g2fix` from branch head 356fdf8 (= main b622811 incl. S2 + this commit), sha256
`30de544613225a1fcaa650d3562b2082dce7ae43bb68999399ff998882571795`, nacht_reimagined local dedi + client:
g2w2 (no knob) lost the race → `bound at frame 1`; g2w4 (late, config value 1) → `first frame with the
dvar: r_gfxopt_water_simulation 1 -> 0`; g2w3 (won the race, value 1) → `post_init: 1 -> 0`. Every run:
spawn 100/100, standing on the world at -87.6, 0 mismatches.

### 27.5 First host-lease runs on box DLL `736236c8` (REL: S2 + G2), 18:48–18:58 UTC

| run | map | lease | ended by | rounds | zombies seen | notes |
|---|---|---|---|---|---|---|
| h-ils-1 | ILS | `m_3028baf8` (inst-08, …0003, 1 bot) | **host `game over: empty` at 2 m 00 s** | 1 | 1 (killed), then none | 61 Hz, main thread 20–24%, 0 escapes |
| h-utbox-1 | ut_box_map | `m_6cab59af` | same, 2 m 00 s | 1 | **0** | 61 Hz, main thread 17–21%, 0 escapes |

1. **The host closes a bot game as empty after two minutes**: the DLL's referee hides test clients
   from the roster (27.1), so `lib/referee.js` `tickGrace` sees nobody and calls `finishGame('empty')`.
   Fix (host, commit `3b5ffd8`): `soakBotConfig()` in `lib/instances.js` pushes `emptyCloseMs` to 24 h
   for an agent Custom dev lease with `dev.bots` only; run-all 113/0. **Needs a host deploy** before any
   soak through the host can run longer than 2 minutes.
2. **Custom maps spawn no zombies (or one) for a bot**, while stock Nacht spawns normally (t2). Open;
   the next thing to read is the DLC3-template zone/spawn scripts (`dlc3_code.gsc`, the zone manager's
   player test) against what a test client lacks. Until it is fixed, bot soaks on custom maps test an
   idle-but-live server, not rounds.

### 27.6 Why custom maps spawned nothing for a bot: the engine's `snapacknowledged` is per packet

Two host closes first (both fixed on the host, live since 20:46 UTC as `9e9e86a`): the referee's
**empty close** (2 min, `a2c330d`) and RS's **never-joined idle close** (5 min, `46748e1`, it ended the
Nacht soak `m_bd4f87b4` at round 6) both counted a bot game as empty, because the DLL never reports a
test client as a player. `soakBotConfig()` (agent Custom dev lease with `dev.bots` only) exempts it
from both.

Then the spawns. `/proc/<pid>/mem` on the live ut_box_map game (`botpos.py`, read-only) showed the bot
standing on the world (`ground 1022`) inside the zone volume, and the console showed the zone manager
running its "zone is active" branch every second, so zones were not it. The map scripts (decompressed
from the archive's `mod.ff`) and the stock `common.ff` (copied out of B's install, read-only) say:

```
round_spawning():  while( count < max ) { wait_network_frame(); ... ai = spawn_zombie( spawn_point ); ... wait_network_frame(); }
wait_network_frame():  snapshot_ids = getsnapshotindexarray(); acked = undefined;
                       while (!isdefined(acked)) { level waittill("snapacknowledged"); acked = snapshotacknowledged(snapshot_ids); }
```

`snapacknowledged` is raised **only** in SV_PacketEvent at 0x635760, once per client packet:
Scr_AddConstString 0x69A8D0 (`scr_const.snapacknowledged`, the word at 0x1F33E2A) →
Scr_ExecThread 0x699560 (`CodeCallback_LevelNotify`, the handle at 0x190B5C0, written at 0x514858) →
Scr_FreeThread 0x690040. `snapshotacknowledged` 0x5273B0 then compares each active client's
`client_s+0x110FC` (messageAcknowledge, written only from a packet at 0x635699) with
getsnapshotindexarray's `outgoingSequence + 1`. A bot sends no packets, so every DLC3/UGX spawn loop
waited for ever after its first zombie. Stock Nacht's loop never calls wait_network_frame, which is
why only Nacht ran rounds.

**Fix** (`bots.cpp`, three commits, box DLL **`59577dbe`**): each server frame, for each bot,
`messageAcknowledge = outgoingSequence` (`533cdae`); once per server frame while a bot exists, the same
three engine calls as 0x635760, guarded by the script active/shutdown flags that `game_mode.cpp` uses,
with the site byte-checked before the component arms (`52b2169`). `533cdae` also makes an idle bot look
at the floor (the non-forced DoSpawn does not spawn in a player's view; harmless, kept) and adds a
per-bot position line to the minute log. **Proof**: ut_box_map `s-utbox` on `59577dbe`, rounds
1 → 4 in the first four minutes, kills 6 → 14 a minute (on `70b28f5b`, one zombie in 30 minutes).
