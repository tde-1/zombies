# dedi — Stage C spike: can `CoDWaW.exe` be a headless dedicated zombies server?

Owner: `dedi` agent. Scope: `server/components/dedicated/`, `server/components/net/`, this file.
All numbers below are from probes run on B's PC on 2026-09-20 against a copy of the Steam build
1.7.1263. Observation and inference are kept apart.

---

## Verdict up front

**Yes, and it is much less work than the vault assumed.** The stock World at War **single-player exe
already contains a working dedicated mode**. `+set dedicated 1` boots it with no Direct3D, no game
window, no front end and no client console; it opens a UDP socket, finishes `Com_Init`, and
`+map nazi_zombie_prototype` **loads the zombies map and starts the server** (`sv_running 1`,
`Server: nazi_zombie_prototype`, the 76.85 MB map fastfile and its collision map).

We are not doing what IW4x and h1-mod did — building a dedicated server out of a client. We are
clearing a short list of blockers in a dedicated path that already exists.

**Crash sites found so far: 3**, all of them from the stock exe with no code at all. Predicted total
for a complete Stage C: **12–30, central estimate ~18** (§7). The vault's fear — an IW4x-scale,
~110-site crash hunt — is not what this looks like, and neither is R12's 50–70: both assume we have
to build the dedicated branch points, and Treyarch left them in.

Our DLL also now loads and runs inside a headless dedicated process (§5), and from in there it
confirms `re`'s `com_dedicated` address against the live engine.

**The one thing that is not yet answered and is a genuine cost/risk: whether a game box needs a
logged-in Steam client** (§8). That is a question for B, not an engineering problem.

---

## 1. What the engine already does for us

Measured in dedicated mode, all from `console.log`:

| Spec item (vault `99 §5.2`) | Reality |
|---|---|
| "a headless CoDWaW.exe" | yes — a `Call of Duty WinConsole` window, the `CoD-WaW` game window is created but never shown |
| "strip the render init" | already done: `Getting Direct3D 9 interface...` never appears |
| `r_loadForRenderer 0` | already 0 |
| front end | `ui` fastfile is **not loaded** (client mode loads it) |
| "strip the sound init" | no Miles/sound-driver init lines during dedicated boot |
| render-thread sync stubs | no render thread appears to start, so the whole h1-mod "sync lock/unlock" family looks moot |
| `sv_fps 20` | already the default |
| 4 slots | `sv_maxclients 4` is already the SP default |
| networking | `Winsock Initialized`, `Opening IP socket: localhost:28960`; the real bind is **`0.0.0.0:<net_port>`** and `+set net_port 28970` works (p12) |
| "strip local client 0" | **unknown** — never got a client connected |
| "sleep-based frame pacing" | **unmeasured** — the process never survives long enough to run frames |
| "a party/lobby replacement" | the lobby layer is present and runs (`Calling Party_StopParty() on lobby`, `party_host`, `xblive_hostingprivateparty`), and it binds **UDP 3074 with no dvar to change it** |

---

## 2. Method

Harness: `dediprobe.ps1` (mine, scratchpad; not in the repo). Per probe it waits for
`ZombiesDev\locks\game.lock`, takes it, wipes `fs_homepath`, clears the safe-mode marker, optionally
lays an overlay tree into the homepath, launches
`C:\Users\b\ZombiesDev\waw-dedi\CoDWaW.exe`, samples CPU / working set / thread count / **every
top-level window** / **every UDP endpoint** of that PID once a second, auto-answers modal dialogs
with IDNO, kills **by PID**, releases the lock, and copies `console.log` out.

Game copy: `C:\Users\b\ZombiesDev\waw-dedi` — junctions to
`waw-base\{main,zone,DirectX,Docs,installers,pb}` plus copies of the root files. I deleted
`CoDWaWmp.exe` from my copy so it cannot be launched by accident. **The Steam install was never
written to**, and B's game profile was never modified.

Fixed arguments on every probe:
`+set fs_homepath <home> +set logfile 2 +set r_fullscreen 0 +set r_mode 800x600 +set s_volume 0 +set snd_volume 0`

Logs: `C:\Users\b\ZombiesDev\logs\dedi\<probe>.txt` (harness) and `<probe>.console.log` (the game's).

---

## 3. Probe log

| # | What | Result |
|---|---|---|
| p01 | stock exe, no Steam environment | **exits(0) at 1.5 s, writes nothing** |
| p02 | + `SteamAppId`/`SteamGameId` env and `steam_appid.txt` | boots; "Set Optimal Settings?" dialog; first console.log |
| p03 | + `+exec` script | blocked by **"Run In Safe Mode?"**; found the marker file |
| p04 | client mode, dialogs auto-answered | reaches D3D device + window, then **hangs at 0 % CPU** |
| p05 | **`+set dedicated 1`** | WinConsole, no D3D, `Com_Init` completes, full dvar dump |
| p06 | `dedicated 1` + `zombiemode 1` + `+map nazi_zombie_prototype` | **map loads**, then a GSC error |
| p07 | + `+set con_typewriterColorBase "1.0 1.0 1.0"` | dvar created but GSC rejects it: needs the SAVED flag |
| p08 | + `seta` in a cfg instead | same rejection — `seta` does not set the flag either |
| p09 | patched `maps/_load.gsc` in `<homepath>\main\maps` | **ignored**; the fastfile rawfile wins |
| p10 | same file under `fs_game mods/enwdedi` | **used** — GSC error gone; next error is `BG_LoadWeaponDef` |
| p11 | same, against B's real `nazi_zombie_ali` mod | custom map + `mod.ff` load fine; same `BG_LoadWeaponDef` |
| p12 | + `+set net_port 28970` | binds **`0.0.0.0:28970`** and also **`0.0.0.0:3074`** |
| p13 | + all 47 `weapons/sp/*` extracted loose into the mod dir | the "could not load weapon file" warning goes away, `BG_LoadWeaponDef: Could not find default weapon` stays |
| p14 | our `enw_t4.dll` deployed as the `binkw32.dll` proxy, dedicated + map | the DLL loads in a headless process; see §5 |
| p15 | same, dvar work moved to `post_init` | see §5 |

### p01 — no Steam environment
```
pid=23592
[  1.1s] cpu=0.13s ws=89.7MB thr=4 wins=3   (splash only)
[  2.1s] EXITED code=0
--- files written under homepath ---   (none)
```
**Inference:** the SteamStub wrapper asks the Steam client to relaunch app 10090 from the *Steam*
folder and exits. Steam was running at the time. Fix that worked: environment
`SteamAppId=10090`, `SteamGameId=10090`, `SteamClientLaunch=1`, plus `steam_appid.txt` in the copy.
I did not isolate which of the two was sufficient.

### p02 — first boot, and the profile-directory trap
```
Current search path:
C:\Users\b\ZombiesDev\homes\dedi/main                  <- fs_homepath honoured
...
C:\Users\b\AppData\Local\Activision\CoDWaW/players     <- profile dir NOT redirected
      dvar set com_playerProfile anna-jpg
      dvar set sys_configureGHz 0.0298146
      dvar set sys_sysMB 1024
      dvar set sys_gpu AMD Radeon RX 9070 XT
```
`fs_homepath` moves `main` and the console log but **not** the player-profile directory, and setting
the `LOCALAPPDATA` environment variable does not move it either (p03 tried) — so it is
`SHGetFolderPath`, not `getenv`.

### p03 — the safe-mode trap, identified
```
hwnd=0xB077E vis=True class='#32770' title='Run In Safe Mode?'
```
The marker is **`%LOCALAPPDATA%\Activision\codwaw\__CoDWaW`**, a 4-byte file containing the **PID** of
the running instance (`B0 26 00 00` = 9904 = p02's pid). Written at startup, deleted on a clean exit.
If it survives a crash or a kill, the next launch shows that modal box *before any logging* and blocks
forever. Delete it before every automated launch. It is also a plausible single-instance guard.

### p04 — the client path, for contrast
Dialog answered headlessly:
```
!! DIALOG: [Button:&Yes][Button:&No][Static:Your computer appears to have changed since the last
   time you ran Call of Duty: World at War. ...]   -> PostMessage WM_COMMAND IDNO
Getting Direct3D 9 interface... / Game window successfully created. / Creating Direct3D device...
Loading fastfile code_post_gfx / ui / localized_common / common / patch
Creating Direct3D queries...
ERROR: image 'images/sun_flare.iwi' is missing
```
then **froze**: CPU pinned at exactly 0.55 s for 30+ s (zero CPU, not a spin), 24 threads, 9 suspended,
main window created but never shown, no dialog. Killed by PID. This is the render path we are deleting,
so I did not chase it — but note the rendered client is not reliably automatable on this box.

### p05 — `+set dedicated 1`
```
[ 2.1s] class='Call of Duty WinConsole' title='Call of Duty® Console'
[ 3.1s] + class='CoD-WaW' (created, never visible)
[ 5.1s]…[30.3s] cpu flat at 2.34 s, ws 190 MB      <- 0 % CPU, idle
```
```
Loading fastfile code_post_gfx / localized_common / common / patch      (no 'ui')
CPU name is "AMD Ryzen 7 9800X3D 8-Core Processor"
Measured CPU speed is 0.01 GHz
Total CPU performance is estimated as 0.03 GHz
System memory is 1024 MB (capped at 1 GB)
      dvar set sv_maxclients 4
Winsock Initialized
Opening IP socket: localhost:28960
----- Initializing Renderer ----            <- printed, but no device is created
      dvar set dedicated dedicated LAN server
--- Common Initialization Complete ---
```
From the dvar dump: `dedicated "dedicated LAN server"`, `r_loadForRenderer "0"`, `r_norefresh "0"`,
`sv_fps "20"`, `com_maxfps "85"`, `sv_maxclients "4"`, `sv_running "0"`, `sv_cheats "0"`,
`sv_pure "0"`, `net_ip "localhost"`, `net_port "28960"`, `zombiemode "0"`, `g_gametype "cmp"`.

With no map to run it then re-entered client init (D3D9 device, window, a second `code_post_gfx`
load) and died — see crash site 1.

### p06 — the map loads
```
------ Server Initialization ------
Server: nazi_zombie_prototype
      dvar set sv_maxclients 4
      dvar set sv_running 1
Loading fastfile 'nazi_zombie_prototype'
used 76.85 MB memory in DB alloc
Waited 184 msec for asset 'maps/nazi_zombie_prototype.d3dbsp' of type 'col_map_mp'.
```
then, from GSC:
```
******* script runtime error *******
SetSavedDvar(): The dvar "con_typewriterColorBase" does not exist.: (file 'maps/_load.gsc', line 3767)
Error: called from: (file 'maps/_load.gsc', line 324)          SetObjectiveTextColors();
Error: called from: (file 'maps/_zombiemode_prototype.gsc', line 35)
Error: started from: (file 'maps/nazi_zombie_prototype.gsc', line 5)
ERROR: script runtime error
----- Server Shutdown -----
```
`con_typewriterColorBase` is registered by the *client* console code, which dedicated mode never runs.
Its siblings `con_typewriterColorGlow*` **are** present in the dedicated dvar dump — only the base
colour is client-side.

### p07 / p08 — the command line cannot fix it
`+set con_typewriterColorBase "1.0 1.0 1.0"` does create the dvar (it appears in the dump), but GSC
then says:
```
SetSavedDvar can only be called on dvars with the SAVED flag set
```
`seta` in an exec'd cfg produces the same. **Only a native `Dvar_Register*(..., DVAR_SAVED)` works** —
which needs the DLL and an address from `re`.

### p09 / p10 — how to override stock GSC (useful to `referee`)
A loose `maps/_load.gsc` in `<fs_homepath>\main\maps` is **ignored**, even though `<fs_homepath>/main`
is first on the search path: the rawfile inside the `.ff` wins. The identical file under
`<fs_homepath>\mods\enwdedi\maps\` with `+set fs_game mods/enwdedi` **is used** — the script error
disappears. **Loose-script override requires an active `fs_game` mod.**

### p11 — a custom map loads headlessly
`+set fs_game mods/nazi_zombie_ali +map nazi_zombie_ali` against B's real mod:
`Loading fastfile mod` / `Loading fastfile 'nazi_zombie_ali'` / `Server: nazi_zombie_ali`. So
**vault feature 6 (custom maps load on the server) works in dedicated mode**, at least to this depth.
The mod's own `mod.ff` loads. (I never ran `gift.exe`; it is data we ignore.)

Both p10 and p11 then stop at the same place:
```
WARNING: Could not load ai weapon accuracy file 'accuracy/aivsai/mp44.accu'
WARNING: Could not load weapon file 'weapons/sp/defaultweapon'
ERROR: BG_LoadWeaponDef: Could not find default weapon
----- Server Shutdown -----
```

### p12 — the socket is real
```
udp: 0.0.0.0:28970, 0.0.0.0:3074
```
`net_port` is honoured, the bind is wildcard (not localhost-only as the dvar suggests), and the
lobby/party layer opens **UDP 3074**, for which there is **no dvar** in the dump. Two instances on one
box will collide there.

---

## 4. Crash-site table (spike E5)

One row per distinct thing that must be patched, stubbed or registered.

| # | Where | What it is | Fix | Status |
|---|---|---|---|---|
| 1 | after `Com_Init` / after `----- Server Shutdown -----` | the engine re-enters client+renderer init in a dedicated process: creates a D3D9 device and a window, reloads `code_post_gfx`, dies `Error: Exceeded limit of 1 'snddriverglobals' assets. / singleton` | stop the client-init call in dedicated mode (iw4x `// R_Init caller`, h1-mod `// dont load ui gametype stuff` are the analogues) | **needs an address from `re`** |
| 2 | `maps/_load.gsc:3767` via `:324` | stock GSC calls `SetSavedDvar("con_typewriterColorBase", …)`; that dvar is client-only, so in dedicated mode it either does not exist or (if created from the command line) lacks `DVAR_SAVED` | register it natively with `DVAR_SAVED` before the first `SV_SpawnServer` | **needs `Dvar_Register*` + the flag bit from `re`**; code already written in `server/components/dedicated/dedicated.cpp` |
| 3 | `BG_LoadWeaponDef` | `ERROR: Could not find default weapon`. Not a missing file: `weapons/sp/defaultweapon` lives in `mods\nazi_zombie_ali\zombie_clinic.iwd`, that iwd **is** mounted, and after I extracted all 47 `weapons/sp/*` as loose files into the mod dir (p13) the `Could not load weapon file` warning disappeared **but the error stayed**. So the def is read and then rejected or not registered | unknown; needs a breakpoint, not another probe | **reached only with `fs_game` active** — see the caveat below |
| — | UDP 3074 | the lobby/party socket is bound with no dvar to move it | patch the port, or bypass the party layer entirely | not a crash; blocks several instances per box |

**Caveat on #3, and it matters for the count.** The only way I had to get past #2 without a DLL was to
override `maps/_load.gsc`, and that requires `fs_game`. `fs_game` is also what appears to push weapon
and AI-accuracy loading onto the filesystem. So #3 may be an artifact of running with a mod folder
rather than a genuine dedicated-mode bug. **The true next crash after #2 in a clean, no-mod dedicated
run is still unknown** and will only be revealed once the DLL registers the dvar. Do not treat 3 as
"we are nearly there"; treat it as "3 found, the loop has barely started".

**Trend so far:** 12 probes, ~1.5 h, no code, no debugger → 3 sites, each found in 1–3 probes, and
each one further into the boot than the last. The loop is productive and fast at this stage because
the failures are all loud, logged, and near the surface.

---

## 5. The DLL in a headless process (E1, dedicated half)

`deploy.ps1 dedi` puts `enw_t4.dll` in as the `binkw32.dll` proxy. Launched headless
(`+set dedicated 1 +set zombiemode 1 +map nazi_zombie_prototype`) our DLL loads and runs:

```
enw_t4 build Sep 20 2026 00:28:16
  cmd : ...CoDWaW.exe ... +set dedicated 1 +set zombiemode 1 +map nazi_zombie_prototype
  components registered: 9
dedicated: command line asks for dedicated 1
steamstub: image base 00400000, .text 00401000+3E99FF, first dword 9EF490B8, .bind present (SteamStub)
steamstub: decrypted after 109 ms (57 polls); 0x401000 = 55 8B EC 83 E4 F8 D9 45 08 ...
game: Com_Printf    @ 0059A2C0 LOOKS OK
game: Dvar_FindVar  @ 005EDE30 LOOKS OK
game: engine up after 47 ms (dvar 'logfile' exists)
enw_t4: ready
```

**So the loader works with no renderer and no window.** Two facts that cost me a probe and are worth
everyone knowing:

- **`post_unpack` is too early to touch dvars.** There, `Dvar_FindVar("dedicated")` returns
  `00000000` and `*com_dedicated` is `00000000` — `Com_Init` has not registered anything yet.
  `post_init` is the first phase where dvar reads work.
- The log file is opened without sharing, so you cannot read it while the game is alive.

With the work moved to `post_init` the component reads the live engine correctly (p15):

```
dedicated: command line asks for dedicated 1
dedicated: Dvar_FindVar("dedicated")=021B1628  com_dedicated=021B1628  (agree)
dedicated: layout probe dvar 'con_typewriterColorGlowCheckpoint' not found in this mode
dedicated: TODO register 'con_typewriterColorBase' ... currently ABSENT
dedicated: TODO register 'hud_drawhud'            ... currently ABSENT
dedicated: TODO register 'ui_campaign'            ... currently ABSENT
dedicated: value=1. The engine already gives us: no D3D, no game window, no 'ui' fastfile,
           r_loadForRenderer=0, sv_fps=20, sv_maxclients=4, a UDP socket on net_port.
```

Three things worth having from that:

1. **`re`'s `com_dedicated = 0x212B2F4` is confirmed live** — the pointer there and
   `Dvar_FindVar("dedicated")` return the same `dvar_s*` (`0x021B1628`) inside a real headless boot.
   This is the strongest possible form of the answer to R12 §4c: T4 SP has a genuine, functioning
   `com_dedicated`, not a vestigial one.
2. All three dvars stock GSC needs are **ABSENT at `post_init`**, which is before the first
   `SV_SpawnServer` — so `post_init` is exactly the right place to register them once we have
   `Dvar_RegisterVec3` / `Dvar_RegisterString`.
3. Even `con_typewriterColorGlowCheckpoint` is missing at `post_init`, although it appears in the
   later dvar dump. The console dvars are registered after `post_init`, so if we register our own
   first we must make sure the engine's later registration does not overwrite or conflict.

## 6. What I built

- `server/components/dedicated/dedicated.hpp` / `.cpp` — an `enw::component` against foundation's
  framework. `post_load()` detects dedicated mode from the command line (safe before SteamStub
  decrypts); `post_unpack()` sanity-checks `Dvar_FindVar` with `memory::looks_like_function()` before
  touching anything, then registers the missing SAVED dvars and logs exactly which addresses it is
  still waiting on. It compiles against the vault's confirmed public addresses and degrades loudly
  (a warning per missing address) instead of jumping into the middle of a function.
- The addresses it still needs, and that I have asked `re` for on the board:
  `Dvar_RegisterVec3` / `Dvar_RegisterString` / `Dvar_RegisterBool`, the `DVAR_SAVED` flag bit, the
  client-init call site, and T4's frame-sync point.

`server/components/net/` is empty on purpose: the direct-connect work (iw4x-sp's `connect_coop`
pattern) is client-side and needs the milestone-(d) experiment, which never happened.

---

## 7. Prior art, counted, and what it predicts

Repos cloned to `C:\Users\b\ZombiesDev\thirdparty\`: `iw4x-client`, `iw4x-sp` (from
`git.alterware.dev` — the GitHub mirror 404s), `h1-mod`, `CoD4x_Server`, `CoD2rev_Server`,
`T4SP-Server-Plugin`.

### 7.1 What each project actually converted

| Project | Base binary | SP or MP | Nature of the work |
|---|---|---|---|
| iw4x-client | `iw4mp.exe` | **MP** | runtime byte-patching of a client exe into a headless dedi |
| h1-mod | `h1_mp64_ship.exe` | **MP** | same, x64 — its `mode::server` loads the **MP** exe |
| iw4x-sp | `iw4sp.exe` | SP | **not a dedicated server at all**: no `sv_maxclients`, no `SV_SpawnServer`, no `dedicated`. An SP client that can outbound-connect to a co-op host |
| CoD4x_Server | full source rebuild | server | never compiles renderer/sound/client; `null_client.cpp` is link-time symbol closure |
| CoD2rev_Server | full source rebuild | server | `qcommon.h`: *"We only care about dedicated server"*; `dedicated` registered defaulting to 2 |

Only the two MP-exe projects are prior art for a binary conversion, **and none of them started from an
exe that already had a working dedicated mode. T4 SP does.**

### 7.2 Counts

| Project | Sites in the dedicated module | Dedi sites elsewhere | Components skipped wholesale | Total |
|---|---|---|---|---|
| iw4x-client | **40** (`Dedicated.cpp`: 39 patches + 1 dvar) | 16 (`Threading.cpp` 8, `Console.cpp` 6, `Maps.cpp` 1, `Branding.cpp` 1) | ~10 | **56** |
| h1-mod | **67** (`dedicated.cpp`: 63 patches + 4 dvars) | ~12 | ~23 | **79** |
| iw4x-sp `connect_coop` | 22 byte patches (SP direct-connect only) | ~39 other SP patches | — | ~61, still not a server |
| CoD4x_Server `null_client.cpp` | 70 no-op definitions (42 renderer/D3D, 10 sound, 7 CG/client, 11 misc) | — | — | leaf-level worst case |

Per subsystem:

| Subsystem | iw4x | h1-mod |
|---|---|---|
| renderer incl. D3D | 6 | 27 |
| render-thread sync | 1 | 5 |
| sound | 4 | 8 |
| front-end UI | 3 | 5 |
| lobby / party / matchmaking | 5 | 3 |
| client-0 slot | 2 | 2 |
| frame pacing | 3 | 1 |
| console I/O | 4 | 1 |
| misc / config / init / netcode | 12 | 15 |
| input | 0 (component skip) | 0 (component skip) |
| cinematics | 0 (global, not dedi-gated) | 0 |

### 7.3 The three mechanisms worth copying

**Frame re-pacing.** h1-mod replaces the GPU fence with a wall-clock sleep: it hooks `R_SyncGpu` with
a stub that sleeps `com_frameTime - Sys_Milliseconds()` ms. iw4x does it twice — `Com_ClampMsec` is
replaced so hitches print instead of clamping, and `Threading.cpp` swaps the waiter for a hybrid
sleep+spin with `timeBeginPeriod(1)`, commented *"Select/Sleep resolution is often too coarse (>1ms) …
we sleep for the bulk of the time but spin for the final 2ms"*. CoD4x simply defines
`R_SyncRenderThread()` as empty.

**Client 0 / the host slot.** One verbatim precedent, h1-mod: `nop(…, 4); // allow first slot to be
occupied`. Both MP projects also kill `CL_CheckForResend`, with the identical comment *"which tries to
connect to the local server constantly"*.

**Render-thread sync.** h1-mod nulls a `// render synchronization lock` / `// render synchronization
unlock` pair plus two mutexes and the render thread; iw4x nulls `// start render thread`. If T4's
dedicated mode never starts a render thread — and nothing in p05's log suggests it does — this whole
family is moot for us.

### 7.4 Prediction for T4

A source-counting estimate made *without* the probe evidence lands at **~110 sites (85–145)**: ~55
predictable up front, ~30 findable only by crashing (34 % of h1-mod's rows carry comments like `^`,
`idk`, `some loop`, `sound thing` — i.e. found empirically), and ~25 of surcharge for inventing a
dedicated mode that is not there.

**The measurements delete most of that.** On T4 SP the renderer, D3D, the window, the render thread,
the `ui` fastfile and the client console are already skipped; `r_loadForRenderer`, `sv_fps` and
`sv_maxclients` are already right; there is already a WinConsole and a UDP socket. That removes the
renderer family (6–27), render-thread sync (1–5), sound init (4–8), console I/O (1–4) and the whole
SP surcharge (~25).

What is left: lobby/party (~3–5, including the hardcoded 3074 socket), client-0 (~2–3), frame pacing
(~1–3), config save/load (~2–3), and the category the probes actually found and the prior art does
not have — **client-only dvars and client-only state that stock GSC touches** (unknown, ≥1, plausibly
5–10 across the four stock maps plus custom maps).

**Revised prediction: 12–30 distinct patch/stub sites, central estimate ~18.**
Confidence: medium. The largest single unknown is the GSC-touches-client-state category, because no
prior art measures it and we have exactly one data point.

---

## 8. Does a game box need a Steam client?

**What is measured.** `CoDWaW.exe` has six sections; the last is **`.bind`** (0x4ABB000, 0x56000
bytes) and the PE entry point is `0x4ABB2ED` — *inside* it. That is Steam's DRM wrapper. Every Steam
string in the file is encrypted: `SteamStub`, `steam_api`, `SteamAppId`, `steamclient`, `steam://`
and `CEG` are all absent from the raw bytes. There is **no `steam_api.dll`** in the install, so the
game does not use the Steamworks API; the DRM is purely the stub. Launched with no Steam environment
it exits(0) in 1.5 s having written nothing (p01); with `SteamAppId`/`SteamGameId` set and
`steam_appid.txt` present it runs in place (p02 onward). **Steam was running for every successful
probe.**

**What is not measured.** I have not run it with the Steam client closed, because the dev-box rules
say nobody but B touches the Steam client. That single test decides the answer, and I have asked for
it in `questions.md`.

**The options, if a Steam session is required.**
1. **A logged-in Steam account per concurrent game box.** This is the expensive one: an account per
   box, each owning WaW, plus Steam's one-game-session-per-account rule to work around. It is a real
   money and terms-of-service problem, not a technical one.
2. **Steam offline mode.** Needs a one-time online login per box, then the client can run offline.
   Still one account per box; still a terms question.
3. **A non-Steam retail copy of WaW 1.7 for servers.** WaW shipped on DVD before the Steam-only era, so
   non-Steam 1.7 binaries exist and would have no `.bind` section. This costs money (B owns the Steam
   copy) and needs B's decision.
4. **What Plutonium appears to do**, from public information only: the Plutonium T4 Linux server guide
   and the third-party Plutainer project run `t4sp -dedicated` under Wine with **no Steam client and no
   Xvfb**, supplying only `zone/` plus a few `.iwd` files. That is only consistent with a server binary
   that is not the SteamStub exe. I am not designing anything that strips or bypasses the DRM — the
   constraint is the finding.

**My read:** this is the single most likely thing to change Stage C's cost, and it is a decision for B,
not a problem to engineer around. Everything else in this document is ordinary work.

---

## 9. Traps and open questions for everyone

1. **SteamStub relaunch.** A copied exe launched directly exits(0) silently. Set `SteamAppId=10090`
   and `SteamGameId=10090` in the environment.
2. **Safe-mode marker.** Delete `%LOCALAPPDATA%\Activision\codwaw\__CoDWaW` before every automated
   launch or a modal box blocks the run before any logging.
3. **Both modal boxes** ("Set Optimal Settings?", "Run In Safe Mode?") are plain `#32770` MessageBoxes
   and can be answered with `PostMessage(hwnd, WM_COMMAND, IDNO, 0)`. Our DLL should suppress them.
4. **Per-instance user data is unsolved.** `fs_homepath` does not move the profile directory and
   `LOCALAPPDATA` is ignored. Several games on one box will share
   `%LOCALAPPDATA%\Activision\codwaw`, including the single-instance PID marker, and will collide on
   **UDP 3074**. Options to test: a junction swap per instance, `com_playerProfile`, one Windows user
   per instance, or hooking `SHGetFolderPath` and the party socket in our DLL.
5. **`Measured CPU speed is 0.01 GHz` / `Total CPU performance is estimated as 0.03 GHz`** on a Ryzen
   9800X3D — the engine's CPU benchmark is broken on modern hardware. If anything paces frames off
   that number our timing will be nonsense. Worth a look from `re`.
6. **`System memory is 1024 MB (capped at 1 GB)`** — a 32-bit process with a hard cap. Relevant to
   several games per box and to the `g_mem` patch sites in the vault.
7. **Seven stock `.iwd` files are not listed in the engine's search path** (`iw_06`, `iw_08`, `iw_13`,
   `iw_14`, `iw_20`, `iw_23`, `iw_27`) and Python's `zipfile` also refuses them; `iw_20.iwd` does not
   even start with a PK signature. They are byte-for-byte the same size as Steam's, so our copy is not
   at fault. Low confidence that this matters, but `accuracy/aivsai/mp44.accu` — one of the files the
   engine said it could not load — lives in `iw_14.iwd`. Worth someone checking whether this is normal
   for Steam WaW.
8. **Loose GSC override needs `fs_game`** (§3, p09/p10). Handy for `referee`; it also means our scripts
   never have to touch a stock install.

---

## 10. Milestones and a wall-clock estimate

| Milestone (from the brief) | Status |
|---|---|
| (a) the process runs with no renderer/window | **done, by the stock exe** |
| (b) loads `nazi_zombie_prototype` and runs script frames | map load **done**; script frames blocked by crash site 2 |
| (c) stable frame rate with sleep-based pacing, CPU and RAM measured | **not started** — needs (b). Only idle numbers so far: ~0 % CPU, 190–273 MB RSS |
| (d) a second instance can `connect 127.0.0.1` and spawn in | **not started** — needs (b) and (c), plus `re` for the connect path |

**Estimate for a focused agent swarm to finish Stage C, assuming `re` keeps supplying addresses and
the Steam question in §7 is answered:**

- Crash site 2 (register the SAVED dvars): **hours** once `Dvar_Register*` is known. The code is
  already written.
- Crash site 1 (stop the client-init fallback): **half a day to a day** — needs the call site found,
  which is a `re` task plus one patch.
- The rest of the crash loop to a map that runs script frames: **1–2 days**, on the observed rate of
  1–3 probes per site and ~15 sites remaining.
- Frame pacing, CPU/RAM soak, `sv_fps` behaviour: **1 day**.
- A client connecting and spawning (milestone d): **2–4 days** — this is the least explored part; it
  needs the party/lobby bypass, the direct-connect patches on the client side, and client 0 kept out
  of the game.
- Several instances per box (the 3074 collision and the shared profile directory): **1 day**.

**Total: 5–9 working days for the swarm; call it 1.5–2 weeks of wall clock with review.** That is for
"Stage C works on one box on a LAN", not for the hosting product around it.

**If I am wrong, the most likely way is milestone (d)**: everything up to a running headless map is now
well-evidenced, but nothing has yet proved that a remote client can join a T4 SP-exe server without
the Xbox-Live-style party layer. That is the piece I would spike next, ahead of polishing (b) and (c).
