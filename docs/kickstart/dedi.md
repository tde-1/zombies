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

**Crash sites: 2 cleared, 1 open, 1 retracted** (§4). Predicted total for a complete Stage C:
**12–30, central ~18**. Both the vault's ~110 (from iw4x/h1-mod) and R12's 50–70 (from KisakCOD's
CoD4 SP tree) assume we must author the dedicated branch points. We do not.

**Still unproven and now the top risk: a client connecting.** The server does not yet answer
connectionless packets on localhost (§4, site 3). R14 says there is no party layer to fight, so this
should be tractable, but it is not yet demonstrated.

**One question only B can answer**: whether a game box needs a logged-in Steam client (§8).

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
| p28 | `dedicated 1`, **no map at all** | `Com_Frame=0` here too → 0x59E330 is probably not the tick |

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
| 3 | after the map loads | the headless server **never answers connectionless packets** — `getstatus`, `getinfo`, `getchallenge` on 127.0.0.1 all time out, with and without a map, with and without `sp_minplayers`, and posting `WM_NULL` to its windows does not change it | **OPEN. Top priority** |
| 4 | `BG_LoadWeaponDef` | `Could not find default weapon`, reached only with `fs_game` active | **RETRACTED.** On repaired data `main\iw_14.iwd` holds **220 `weapons/sp/*` and 55 `accuracy/*` files**, and `iw_14.iwd` was one of the zero-filled ones — so those 275 files were simply invisible. Not a dedicated-mode bug and not an `fs_game` bug. Confirmation run pending |
| — | UDP 3074 | the party socket is bound with no dvar to move it | not a crash; blocks several instances per box |

### Honesty note on site 2

`re` read `DVAR_FLAG_SAVED = 0x200` out of the `SetSavedDvar` builtin at 0x516990. **On our build
0x200 alone does not work**: p23 set `con_typewriterColorBase` to `flags 0x4000 → 0x4200`, verified by
read-back, and GSC threw the identical error. What does work is a blunt mask `0xBDAE` — which does
**not** contain 0x200 (bit 9 is clear in `1011 1101 1010 1110`). So the bit GSC actually tests is one
of `0x0002 0x0004 0x0008 0x0020 0x0080 0x0100 0x0400 0x0800 0x1000 0x2000 0x8000`, and setting eleven
flags at once — probably including USERINFO, SERVERINFO and CHEAT — is a hack, not a fix. The DLL
reads `ENW_DEDI_SAVED_MASK` at runtime so the bisect costs a probe and no rebuild. **This must be
narrowed to one bit before anyone calls Stage C done.**

### Honesty note on the "parked main thread"

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

## 7. Milestone (d): a client connecting

Not achieved. What is known:

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
| (c) stable frame rate with sleep-based pacing, CPU and RAM | partial: idle **~0% CPU, 186 MB** measured; frame rate not yet observed (§4 site 3) |
| (d) a client connects and spawns in | **not started** — blocked on site 3 |

**Estimate for a focused swarm to finish Stage C**, assuming `re` keeps supplying addresses and the
Steam question is answered: narrowing the SAVED flag to one bit, hours. Site 3 (the wire), 1–2 days —
this is the real unknown now. Frame pacing, CPU and a soak, 1 day. A client connecting and spawning,
2–4 days, less than I feared before R14 removed the party layer from the problem. Several instances
per box (3074 and the shared profile directory), 1 day. **Total 5–9 working days; 1.5–2 weeks wall
clock with review.** That is unchanged from my first estimate: milestone (b) came in far faster than I
expected, and site 3 appeared to take its place.
