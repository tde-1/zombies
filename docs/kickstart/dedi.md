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
| "a party/lobby replacement" | the lobby layer exists and runs on shutdown (`Party_StopParty`, `party_host`, `xblive_hostingprivateparty`) and binds **UDP 3074 with no dvar to change it**. Per R14 there is **no party system in T4 SP**, so joining is plain `connect <ip>:<port>` |

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
