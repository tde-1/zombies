# dedi — Stage C spike: can `CoDWaW.exe` be a headless dedicated zombies server?

Owner: `dedi` agent. Scope: `server/components/dedicated/`, `server/components/net/`, this file.
Everything below was measured on B's PC on 2026-09-20 against a copy of the Steam build 1.7.1263.
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

**Next, in order**: (1) the `Sys_GetEvent` `GetMessageA` stall (§7c); (2) the loopback join —
`CL_ConnectLocal` 0x641730 and `tools\dev\jointest.ps1`; (3) the 14-map sweep; (4) solo-on-dedicated
co-op rules. The join is cheaper than feared: R14 says T4 SP has no party layer, and CLL's source
confirms no launcher in this scene implements one — Plutonium's `connect ip:port` lives inside
*their* binary, not in stock T4.

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
| — | UDP 3074 | the party socket is bound with no dvar to move it | not a crash; blocks several instances per box |

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

**The player has not spawned.** `CS_CONNECTED` is not `CS_ACTIVE`; the server never logged the
client entering the game, and `client_s.lastUsercmd` (+0x11108) and `gentity_s.currentOrigin`
(+0x160) were never sampled because there was nothing to sample. Connected is not spawned, and the
success criterion is spawned and moving.

Two concrete things for the next session, in order:

1. **Why the connection times out after the map loads.** The client goes
   `CS_CONNECTED -> (gamestate) -> CS_PRIMED -> CS_ACTIVE`, and it stalled somewhere after loading.
   `SV_PacketEvent` stopped climbing at 275, so the conversation died rather than never started. The
   places to look are the `clc_move`/usercmd path (`0x630BF0`, "Invalid command time %i from
   client") and whether the server ever sends the "entered the game" server command.
2. **The server burns a whole core with a client connected.** Idle it is 4.85% of one core; in
   `join11` it was **62.4 s of CPU in 60 s**. That is not the frame rate (`jointest.ps1` does not
   pass `com_maxfps`, so Com_Frame free-runs) but it is worth measuring properly with the cap on
   before anyone concludes the server is expensive.

Also still true and still untested: on a dedicated server the game runs **co-op rules even with one
player** (Quick Revive, prices, revives). For a speedrun platform that is the difference between a
valid and an invalid solo run, and it may force a design decision about how solo Verified runs are
hosted.

---

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
   share `%LOCALAPPDATA%\Activision\codwaw` including the single-instance PID marker, and collide on
   **UDP 3074**.
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
| (d) a client connects and spawns in | **connects — `Going from CS_FREE to CS_CONNECTED`, client 0, map loaded** (§7g, run `join11`). Five walls cleared. **Does not spawn**: the connection times out after the map loads |

**Estimate for a focused swarm to finish Stage C**, assuming `re` keeps supplying addresses and the
Steam question is answered: narrowing the SAVED flag to one bit, hours. Site 3 (the wire), 1–2 days —
this is the real unknown now. Frame pacing, CPU and a soak, 1 day. A client connecting and spawning,
2–4 days, less than I feared before R14 removed the party layer from the problem. Several instances
per box (3074 and the shared profile directory), 1 day. **Total 5–9 working days; 1.5–2 weeks wall
clock with review.** That is unchanged from my first estimate: milestone (b) came in far faster than I
expected, and site 3 appeared to take its place.
