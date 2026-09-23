# Client: the player's game (`client-dll/`)

Owner: the **client** lane. Scope: `client-dll/components/`, plus new verified addresses in
`shared/t4/addresses.hpp`. Everything reuses `shared/core/`; nothing here forks it.

Opened 2026-09-22 with one shipped feature (the mouse polling-rate fix) and a plan for the rest of
what B has asked for.

---

## 1. The high-polling-rate mouse fix (`components/mouse_polling.cpp`)

### 1a. The hypothesis was wrong, and the real mechanism is worse

The brief's working hypothesis was the Quake-3-family one: buffered DirectInput,
`SetProperty(DIPROP_BUFFERSIZE, 16)`, `GetDeviceData` once per frame, `DI_BUFFEROVERFLOW` at
1000 Hz. **T4 does not use DirectInput at all.** Checked four ways on our own dump
(`ZombiesDev\dumps\codwaw-1.7-a.exe`):

* the 18 imported DLLs (foundation.md §2) contain no `dinput8.dll` / `dinput.dll`;
* `DirectInput8Create` does not appear as a string;
* `CLSID_DirectInput8`, `IID_IDirectInput8A`, `GUID_SysMouse` and `GUID_SysKeyboard` do not appear
  as **bytes** anywhere in the 78 MB image;
* the three `"...DirectInput..."` strings in `.rdata` are rows of a generic HRESULT-to-text table
  with no code path near the input module.

There is no buffer size to raise. What T4 actually does, once per frame, in `IN_MouseMove`
(`0x5FA6D0`, whose **only** caller is `IN_Frame` `0x5FA850` at `0x5FA8E4`):

```
005FA6DB  call [GetForegroundWindow]   ; bail unless we are the foreground window
005FA6F2  call [GetCursorPos]          ; POINT at [esp+8]
005FA717  sub esi, [0x229A0CC]         ; dx = pt.x - oldPos.x
005FA72D  sub edi, [0x229A0D0]         ; dy = pt.y - oldPos.y
005FA73B  call [ScreenToClient]
005FA74B  call 0x63D9A0                ; CL_MouseEvent(edx=x, ecx=y, dx, dy) -> recentre?
005FA764  call 0x5FA510                ; IN_RecenterMouse -> SetCursorPos(window centre)
```

The engine's idea of "how far the mouse moved" is **the difference between two OS cursor positions,
in whole screen pixels, sampled at frame rate**. At 1000–8000 Hz that breaks twice over:

1. every report goes through Windows' pointer ballistics and is then rounded to an integer pixel,
   so a large share of reports move the pointer by zero pixels and are lost outright — motion
   becomes quantised and erratic rather than smooth;
2. the pointer is clamped to the desktop, so anything past a screen edge between two recentres is
   discarded.

For completeness, because the brief asked about the two alternative hypotheses:

* **`in_mouse` is a plain bool** (registered at `0x5FA820`, dvar at `[0x229A0B8]`); there is **no**
  raw-input path in stock T4.
* **The message pump is drained completely every frame.** `Sys_GetEvent` (`0x5FEC60`) loops
  `PeekMessageA` / `GetMessageA` / `TranslateMessage` / `DispatchMessageA` until the queue is
  empty, and `Com_EventLoop` (`0x5FEDE0`) calls it until the event type is 0. The engine event ring
  (`Sys_QueEvent` `0x5FEB30`) is 256 entries with an audible `Sys_QueEvent: overflow`. But mouse
  **motion is never queued** — the game WndProc (`0x606BE0`) only queues button transitions — so
  "the pump is flooded" is a cost to measure, not a defect we can name. `mouse_polling` logs
  WM_INPUT messages per frame so B's real test produces that number.

### 1b. What we shipped: a port of iw4x-client's `RawMouse`

`client-dll/components/mouse_polling.cpp` is **a port, not our design**. Source:
[iw4x-client](https://github.com/iw4x/iw4x-client) `src/Components/Modules/RawMouse.cpp` (+ `.hpp`)
at commit **`f55d287440f81f26bdbc7bb8edd30e88e77b3d89`** (2026-09-02), GPL-3.0-or-later.
`client-dll/` is GPL-3.0 too, so this is a licence-compatible adaptation; the attribution header is
at the top of the file and there is a row in the vault's reuse register (`18 - Reuse Register`, §1).

Kept from upstream: the structure, the names (`rawMouseValue_t`, `ToggleRawInput`,
`IN_RawMouseMove`, `OnRawInput`, `FirstRawInputUpdate`), the absolute-flag handling, the
first-update delta reset that kills the alt-tab angle snap, and the `m_rawinput` semantics.

What it does:

* subclasses the game window's WndProc (`0x606BE0`, the `lpfnWndProc` of the `"CoD-WaW"` class registered at `0x5FF450`; hwnd at `[0x22C1BE4]`) and accumulates `WM_INPUT` relative
  motion;
* retargets the one `call IN_MouseMove` at `0x5FA8E4` to our replacement, which feeds the
  accumulated raw counts straight to the engine's own `CL_MouseEvent` and then lets the engine's own
  `IN_RecenterMouse` run;
* leaves `IN_MouseMove`'s own bytes untouched, so it is still callable and is the runtime fallback.

**Deliberate deviations from upstream**, each because T4 is not IW4:

| # | Upstream | Here | Why |
|---|---|---|---|
| 1 | `RIDEV_INPUTSINK \| RIDEV_NOLEGACY`, buttons reimplemented from raw flags | `dwFlags = 0`, legacy messages **kept**, buttons untouched | On T4 the buttons come from the game WndProc `0x606BE0` → its message helper `0x606B60` → `IN_MouseEvent` `0x5FA5F0` → `Sys_QueEvent` `0x5FEB30`. Suppressing legacy would also take the OS cursor away from the menu path. We take **motion only**. So `ProcessMouseRawEvent` / `OnLegacyMouseEvent` / `mw_up` / `mw_down` are not ported |
| 2 | `ClipCursor` to the client rect | not ported | A separate windowed-mode fix; see §2c |
| 3 | `m_rawinput` dvar | `ENW_RAW_MOUSE` env var | Registering a dvar needs `Dvar_RegisterBool` (`0x5EEE20`), whose convention is name-in-EDI / default-in-AL / (flags, desc) on the stack. Readable, but rule 2 of `addresses.hpp` is *do not invent a prototype from an address*, and a wrong one crashes at startup. The name and semantics are kept so the dvar drops straight in later |
| 4 | `r_autopriority`, `Key_ClearStates` on focus loss | not ported | Separate upstream features, not part of this fix |

**One correction, kept in place because the wrong answer looked right.** The first version of this
component checked for `0x606B60` as the window proc, because `0x606B60` calls `IN_MouseEvent`,
`IN_RecenterMouse` and `DefWindowProcA` — it reads exactly like a WndProc. It is not one; it is a
message helper the real proc calls. The class registration settles it:
`0x5FF47A  mov [esp+0x10], 0x606BE0` is `WNDCLASSEX.lpfnWndProc` (cbSize is at `[esp+8]`),
`0x5FF4B1` sets `lpszClassName = "CoD-WaW"`, and `0x5FF4B9` calls `RegisterClassExA`. `0x606BE0`
also has the proc shape (`hwnd@[ebp+8]`, `msg@[ebp+0xC]`, `wParam@[ebp+0x10]`, `lParam@[ebp+0x14]`).
Two independent signals, which is what the map's rule 2 asks for and what the first pass did not
have. `0x605210` is a third red herring: it is the proc of the **"Call of Duty WinConsole"** class
created at `0x605500`, not the game window.

**Self-verifying, in the house style** (`server/components/dedicated/no_autosave.cpp`). Nothing is
written until both checks pass, and a failure logs loudly and leaves the stock path alone:

1. `0x5FA8E4` must be an `E8` whose target is `0x5FA6D0` (`IN_MouseMove`);
2. the window we are about to subclass must currently have `0x606BE0` as its WndProc, i.e. it is
   the engine's own game window and nobody else has subclassed it.

**How to turn it off.** `ENW_RAW_MOUSE=0` in the environment — the component logs that it is off and
patches nothing. `ENW_RAW_MOUSE_VERBOSE=1` adds the enable/disable lines.

### 1c. What B should see in the log, and how to test it

Log: `C:\Users\b\ZombiesDev\logs\<copy>\enw_t4.log` (and the game's own
`homes\<copy>\main\console.log`).

Install lines, in order:

```
mouse_polling: IN_Frame's `call IN_MouseMove` (0x005FA8E4 -> 0x005FA6D0) now goes to our raw-input
               mouse move. ...
mouse_polling: RAW INPUT ON. hwnd=0x..., WndProc 0x00606BE0 subclassed,
               RegisterRawInputDevices(usage 1/2, dwFlags=0, legacy messages KEPT) ok. ...
```

Then, roughly every 15 s while the game ticks:

```
mouse_polling: WM_INPUT total=..., peak/frame=..., frames with motion=..., raw=on focus=yes
```

**The number that proves the mouse is being read at its real rate is `peak/frame`.** At 60 fps it
should be about (report rate ÷ 60) while the mouse is moving: ~2 at 125 Hz, ~8 at 500 Hz, ~17 at
1000 Hz, ~67 at 4000 Hz, ~133 at 8000 Hz. If `peak/frame` stays at 1–2 with a 1000 Hz mouse, raw
input is not reaching us and something in §1b's guards or `RegisterRawInputDevices` went wrong —
the log will say which.

B's real test: play a round at 1000 Hz (or 4000/8000) with the component on, then relaunch with
`ENW_RAW_MOUSE=0` and play the same round. The A/B is the point; the counters only prove the
plumbing.

### 1d. It has been measured, on this box, on the map

Run 4, `waw-c2`, windowed, `+map nazi_zombie_prototype`, 2026-09-22 03:56. The window happened to
hold focus for the first ~30 s, so this is not a dry run — it is the mechanism working:

```
mouse_polling: IN_Frame's `call IN_MouseMove` (0x005FA8E4 -> 0x005FA6D0) now goes to our
               raw-input mouse move. ...
mouse_polling: RAW INPUT ON. hwnd=0x00100C34, WndProc 0x00606BE0 subclassed,
               RegisterRawInputDevices(usage 1/2, dwFlags=0, legacy messages KEPT) ok. ...
mouse_polling: first WM_INPUT received (lLastX=-8 lLastY=2, flags=0x0000). Raw input is live ...
mouse_polling: WM_INPUT total=14597, peak/frame=72, frames with motion=1046, raw=on focus=yes
heartbeat:     still ticking at 75 s - 4527 frames total, 62.5 fps over the last 15 s
```

Read that `peak/frame=72`: at the measured 62.5 fps that is about **4,500 mouse reports per second
reaching the game**, where the stock path could only ever have turned them into at most one
whole-pixel `GetCursorPos` difference per frame. The counters also stop dead and `focus=no` the
moment the window loses focus, which is the `dwFlags = 0` foreground-only registration behaving as
intended. 75 s on the map, 62.5 fps, no crash, both byte checks passed.

Two earlier runs are worth keeping because they are what the guards are for. Run 1 refused to patch
(`looks_like_function` is a prologue heuristic and `CL_MouseEvent` has no standard prologue — now a
byte compare against the dump). Run 3 installed but never took focus, so `total=0`: an honest zero,
not a silent failure, because `focus=no` was in the same line.

**Still unproven, and say so.** Whether this removes the *feel* of the stutter can only be
established by a person playing with a high-polling-rate mouse. Everything above is plumbing
evidence, and it is the plumbing that was broken.

---

## 2. Plan: the next client features

Nothing in this section is written yet. Each item records what the exe told us, so the next session
does not re-derive it.

### 2a. The in-game settings menu must keep working

Non-negotiable constraint on everything below: video, audio and controls changes made **in the
game's own menus** must apply and persist. That rules out hard-patching dvars to constants or
stripping the menu, and it is the main reason `mouse_polling` takes motion only and leaves the
legacy message path (and therefore the menu cursor and buttons) exactly as it found it.

What we know:

* `writeconfig` is a real console command (string at `0x872E58`).
* The profile config path is `%s/players/profiles/%s/config.cfg` (`0x883E64`) under `fs_homepath`,
  plus a plain `config.cfg` (`0x871F0`… `0x8717F0`). The launcher already sets `fs_homepath`, so the
  file lands somewhere we control.
* `vid_restart` exists (`0x88B644`) — a resolution change is applied by the engine itself; we do not
  have to implement one.

### 2b. Round-tripping video settings into the launcher's per-account settings

The launcher passes `r_fullscreen`, `r_mode`, `cg_fov`, `com_maxfps` on the command line
(launcher.md §3). The missing half is the way back.

Facts for whoever builds it:

* **`r_mode` is a string, not an index** — the default in the image is literally `set r_mode
  800x600` (`0x22BB545`), and there is also `r_customMode` (`0x8A5564`) and `r_displayRefresh`
  (`0x89E6DC`). A launcher that writes an integer `r_mode` is writing the wrong type.
* `r_fullscreen` exists (`0x89E710`), and the image also carries a literal `set r_fullscreen 0`
  (`0x22BB531`).
* The engine writes `config.cfg` under `fs_homepath` on exit (and on `writeconfig`).

**The round trip**, and it is a doc-only proposal until someone builds it: the launcher launches
with the account's saved values on the command line; the player changes them in-game; the game
writes `config.cfg`; **after the game exits, the launcher parses `config.cfg` under that account's
`fs_homepath` for `r_fullscreen` / `r_mode` / `r_customMode` / `r_displayRefresh` / `cg_fov` /
`com_maxfps` and stores them back into the per-account settings.** Read-after-exit, not
read-while-running — the file is only complete once the process is gone, and the DLL has no business
in the launcher's settings store. That keeps the whole feature in `launcher/` with no client-DLL
work at all, which is why it is not a component.

### 2c. Borderless windowed — **done** (`components/borderless.cpp`)

**B's decision (2026-09-22):** the game launches **by default in perfect borderless windowed at the
main display's native resolution**. The launcher's Display settings offer monitor, mode (Borderless
default / Fullscreen / Windowed) and resolution, with resolution editable only when the mode is not
Borderless.

The community recipe is Plutonium's documented one for T4 —
`r_fullscreen 0; r_noborder 1; vid_xpos 0; vid_ypos 0; vid_restart`
(<https://plutonium.pw/docs/client/t4/perfect-borderless-window/>).

**`r_noborder` is not a vanilla dvar.** The byte string `r_noborder` — and the substring
`noborder`, case-insensitive — appears **zero times** in the 78 MB dump. It is something
Plutonium's own client adds, so their recipe cannot be followed with command-line dvars alone on a
stock exe. The three dvars around it *are* vanilla: `r_fullscreen` (`0x89E710`), `vid_xpos`
(`0x89E720`), `vid_ypos` (`0x89E72C`), plus `r_monitor` (`0x8A5448`) for the monitor picker and
`r_displayRefresh` (`0x89E6DC`).

So the DLL does the `r_noborder 1` half. `borderless.cpp` clears
`WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME`, sets `WS_POPUP`, clears
`WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME` and `SetWindowPos`es to the requested
rect with `SWP_FRAMECHANGED`, on the `"CoD-WaW"` window (`[0x22C1BE4]`).

Three design points worth keeping:

* **No second WndProc subclass.** `mouse_polling` already owns the subclass on that window and its
  guard refuses to install if the proc is no longer `0x606BE0`, so a second subclass would make one
  of the two refuse depending on load order. `borderless` instead re-checks the style from the
  shared frame tick every 20 frames — one `GetWindowLongA` — which is also the only thing that
  covers **alt-tab putting the frame back** and **`vid_restart` recreating the window** (it detects
  a new HWND and re-applies).
* **Geometry comes from the command line, not the dvar system.** `r_mode` (a *string* on T4,
  `"1280x720"`, not an index), `vid_xpos`, `vid_ypos`, `r_fullscreen`, `r_noborder`. `dvar_s` is
  deliberately opaque to us and reading a value means committing to a struct layout for bool vs
  string — the kind of guess this project has paid for. The command line is free and exact. Missing
  or unparseable `r_mode` falls back to the whole monitor rect via `MonitorFromWindow` +
  `GetMonitorInfo`, which is B's default anyway. **Last `+set` wins**, as the engine does — run 1
  read the first and picked up `launch.ps1`'s own `800x600` instead of the caller's.
* **Windowed only.** Skipped when the command line asks for `r_fullscreen != 0`: exclusive
  fullscreen has no frame to remove and reshaping it fights the renderer.

Switches: `ENW_BORDERLESS=1` to enable, `ENW_BORDERLESS=0` to force off, or `+set r_noborder 1` on
the command line — we match that *text*, we do not read the dvar, because there is none to read.
Name it `r_noborder` for real once the `Dvar_RegisterBool` thunk in §1b deviation 3 is proven, so a
player following Plutonium's docs finds the dvar they expect.

**Verified**, `waw-c2`, `+set r_fullscreen 0 +set r_mode 1280x720 +set vid_xpos 0 +set vid_ypos 0
+map nazi_zombie_prototype`, 45 s on the map:

```
borderless: target 1280x720 at (0,0) from the command line (r_mode, vid_xpos, vid_ypos)
borderless: style 0x14C80000 -> 0x94080000, exstyle 0x00000100 -> 0x00000000.
            WS_CAPTION=0 WS_THICKFRAME=0 WS_BORDER=0 WS_POPUP=1.
            window rect 1280x720 at (0,0), client 1280x720. BORDERLESS.
```

That is a `GetWindowLong` read-back, not a call that returned without error, and **window rect ==
client rect** is the proof there is no frame left. Still unverified: alt-tab re-application and
`vid_restart`, both of which are handled by the poll but were not exercised.

### 2d. In-game chat overlay — **built 2026-09-22, see §9 and `chat-overlay.md` §9**

What the DLL would need, and nothing more than that is decided:

* **a hook on the 2D draw path**, to draw a chat box over the game. Not located yet. Warning from
  `addresses.hpp`: `0x648490` / `0x6F5F10` are a HUD/debug **coloured-text** pair and calling them
  as a text renderer corrupts a ring buffer at `0x3DCB4C0` — they were withdrawn for exactly this.
  Whatever is found must be identified by two independent signals before it is used.
* **input capture**, so a chat key swallows keystrokes instead of passing them to the game. The
  place for that is the event path already mapped here: the game WndProc `0x606BE0`, `Sys_QueEvent`
  `0x5FEB30` and `Sys_GetEvent` `0x5FEC60`. Note `mouse_polling` already subclasses that WndProc;
  a second consumer must extend the one subclass, not add another.
* the transport already exists — `clientchat_send` `0x655C80` / `hostchat_send` `0x65B630` and the
  game link.

---

## 3. Addresses this lane added

All added to `shared/t4/addresses.hpp` under "win32 input / mouse", all `[V]` from our own dump
except the two marked `[C]`: `IN_Init` `0x5FA820`, `IN_StartupMouse` `0x5FA7D0`,
`IN_DeactivateMouse` `0x5FA5B0`, `IN_MouseEvent` `0x5FA5F0`, `IN_Frame` `0x5FA850`, `IN_MouseMove`
`0x5FA6D0`, `IN_MouseMove_callsite` `0x5FA8E4`, `IN_RecenterMouse` `0x5FA510`,
`IN_ClampCursorToWindow` `0x5FA660`, `CL_MouseEvent` `0x63D9A0`, `WndProc_game` `0x606BE0`,
`WndProc_game_msg_helper` `0x606B60`, `Sys_RegisterGameWindowClass` `0x5FF450`,
`WndProc_winconsole` `0x605210`, `Sys_CreateConsoleWindow` `0x605500`, `Sys_QueEvent` `0x5FEB30`,
`Sys_GetEvent` `0x5FEC60`, `Com_EventLoop` `0x5FEDE0` `[C]`; globals `g_wv_hwnd` `0x22C1BE4`,
`g_wv_sysMsgTime` `0x22C1BF8`, `in_mouse_dvar` `0x229A0B8`, `s_wmv_mouseActive` `0x229A0D4`,
`s_wmv_mouseInited` `0x229A0D5`, `s_wmv_oldPos_x/y` `0x229A0CC`/`0x229A0D0`,
`s_wmv_centre_x/y` `0x229A0C0`/`0x229A0BC`.

How each was verified: the function bounds and call graph come from `tools/re/t4map.py` over the
decrypted dump, and every one of them was read as an instruction — a call site, an operand, a
branch or a stride — not inferred from a single string. `CL_MouseEvent`'s convention (edx = client
x, ecx = client y, `[esp+4]` = dx, `[esp+8]` = dy, caller cleans 8) was read off the call at
`0x5FA74B` and the `add esp, 8` at `0x5FA750`, and is used through a naked thunk rather than a
guessed C prototype.

---

## 1e. The stutter: measuring it, and what it is not (2026-09-22)

B: *"when I'm in the game there's stuttery performance; it needs to run smooth and flawless on
modern systems"*, and then, while this was being measured: *the stutter happens only while the
mouse is moving*, and he normally has to drop his mouse to 250 Hz to make old CoD smooth.

### The instrument: `components/frametime.cpp`, `ENW_FRAMETIME=1`, off by default

An average frame rate is the one statistic that cannot see a stutter. 175 fps average is what you
get from 2,600 frames at 5.5 ms plus forty at 120 ms, and it is also what you get from a perfectly
smooth 175. The eye sees the forty. `heartbeat` prints the average; this prints the **distribution**
— p50 / p95 / p99 / max and the count of frames over **16.7 / 33.3 / 50 ms** ("dropped a frame at
60 Hz", "visible hitch", "unmistakable") per 10-second window, out of 0.25 ms buckets.

One `QueryPerformanceCounter` and one array increment per frame off the shared frame tick
(`enw::frame::subscribe` — we do not hook `Com_Frame`, foundation §3). No allocation, no I/O on the
frame path, and **nothing at all** unless the env var is set. `ENW_FRAMETIME_WINDOW=<seconds>`
changes the window.

### The control, and it is the most useful number in this section

`nazi_zombie_prototype`, Local, B's 2560x1440 **240 Hz** panel, borderless, the launcher's full
baseline command line (`logfile 2`, `r_vsync 0`, `com_maxfps 250`, `r_picmip 0`, aniso 16), with
**nothing touching the mouse**:

```
frametime: window 12 -- 2501 frames, 250.0 fps avg | p50 4.25 ms  p95 5.75 ms  p99 6.25 ms
           max 7.61 ms | over 16.7ms: 0 (0.00%)  over 33.3ms: 0 (0.00%)  over 50ms: 0
```

and that is not one lucky window — it is **sixteen consecutive ten-second windows** at the
`com_maxfps` cap with **0.00 %** of frames over 16.7 ms. The game is flawless when the mouse is
still.

**So the following are excluded as the cause on this box, each by the same run rather than by
argument:**

| Suspect | Why it is not it |
|---|---|
| `logfile 2` (a per-frame log write) | was **on** for every window above |
| `r_vsync 0` + uncapped fps fighting DWM in a borderless window | 250.0 fps held flat, p99 6.25 ms, in a borderless window |
| the fps cap vs the panel | `com_maxfps 250` on a **240 Hz** panel, and it sits exactly on the cap |
| `r_picmip 0` + 16× aniso texture stalls | pinned that way throughout |
| our own per-frame components | `referee`, `replay` (20 Hz sampler) and `frametime` itself all ran |
| `dedi_frame_pacing` pacing the client | it is compiled into the player DLL but `is_supported()` is false for a non-dedicated process — `components: dedi_frame_pacing not supported here, skipped`. It does **not** pace the client |

For the record on the other candidate from the brief: **our proxy DLL is `binkw32.dll`, so there is
no filename collision with DXVK's `d3d9.dll`** — DXVK can be dropped in beside us. It has not been
tried, and on this evidence there is no reason to: an idle scene that holds 250 fps with a 0.00 %
hitch rate does not have a D3D9 driver problem.

### With the mouse moving, same build, same scene

The very first 190-second run, with B's own mouse (nobody at the machine; the counters move anyway):

| window | mouse | p50 | p95 | p99 | max | >16.7 ms | fps |
|---|---|---|---|---|---|---|---|
| 12 | **none** (counters frozen) | 4.25 | 5.75 | **6.75** | 8.69 | **0.00 %** | 249.0 |
| 1 | heavy, peak 29–42 WM_INPUT/frame | 4.75 | 13.50 | **23.00** | 62.36 | **4.03 %** | 168.7 |
| 5 | heavy, peak 54 | 5.25 | 15.25 | **23.00** | 53.75 | **4.23 %** | 148.7 |
| 6 | heavy, peak 54 | 5.25 | 15.75 | **27.25** | 45.31 | **4.44 %** | 148.2 |
| 9 | light | 4.25 | 7.50 | 11.00 | 48.45 | 0.13 % | 230.9 |

p99 goes from 6.75 ms to 27 ms and the frame rate falls by a third, on the same scene, with the
only variable being how much mouse input is arriving. B's description was exactly right.

### Two harness traps that produced false results first, both written down because they are the kind of thing that wastes a night

1. **`play-cli --seconds` was only an upper bound.** `flow.run()` resolves the instant the map is
   playable and the CLI then stopped the game, about two seconds after `post_init`. The first
   stutter run produced a log with **zero frames in it**. `--hold` exists now (launcher.md).
2. **A bare `spawn` gives a window that never receives `WM_SETFOCUS`** — and `mouse_polling`'s
   `OnRawInput` began `if (!g_in_focus) return;`. `g_in_focus` is initialised from
   `GetForegroundWindow()`, which **`focus_guard` hooks**, and is only updated by focus messages
   afterwards. So the flag can be stuck false for a whole session and **every raw report is thrown
   away in silence**: a run took **360,000 injected moves at 8 kHz** and logged
   `WM_INPUT total=0, focus=no`. It reads as "raw input never reached us" and is really "we
   received it and dropped it".

   **That gate is now gone, and its removal is a fix rather than an omission.** We register with
   `dwFlags = 0`, which is foreground-only *by definition* — Windows does not deliver `WM_INPUT` to
   a window that is not in the foreground — so a report arriving at all is the proof the flag was
   trying to be. `g_in_focus` is kept for the log line and for `g_first_raw_update`, which is what
   genuinely needs focus transitions (upstream's alt-tab angle-snap fix).

### Driving the mouse without B — ATTEMPTED, AND IT DOES NOT WORK ON THIS BOX

**Retracted before it was ever relied on.** The plan was to reproduce B's 8 kHz mouse with
`SendInput` (`MOUSEEVENTF_MOVE`, tiny deltas, busy-waited to a chosen rate) so the raw-input arms
could be bisected without a hand on the mouse. The harness reports success and the numbers look
clean, and **every one of those runs is void**, because the game never received the input.

The game's own counters are the check, and they are unambiguous. Across one arm, **456,000 moves
were injected at a measured 7,999–8,000/s** onto a window the harness had verified was the
foreground window, and the DLL logged:

```
mouse_polling: WM_INPUT total=0, peak/frame=0, frames with motion=0, raw=on focus=yes
               | legacy WM_MOUSEMOVE total=58 peak/frame=2
```

58 legacy messages and **zero** raw reports, against B's own mouse in the same build producing
**78,958** WM_INPUT in a 190-second run. The most likely reason is UIPI: injected input from a
process at a lower integrity level than the target window is discarded in silence, and
`SetForegroundWindow`/`BringWindowToTop` can still appear to succeed. Whatever the mechanism, the
measurement is the verdict.

So **nothing in this section is bisect evidence**, and two earlier conclusions that were written
down from it are withdrawn here rather than deleted:

* ~~"8 kHz synthetic input with `ENW_RAW_MOUSE=0` changes nothing, so the legacy WM_MOUSEMOVE flood
  alone is cheap."~~ **Wrong** — that arm had our component off, so it had no counters, and there is
  now no reason to believe its input arrived either. It measured an idle game.
* ~~"`ENW_RAW_MOUSE=1` at 8 kHz is smooth."~~ **Wrong**, same reason. The 252 FPS on the on-screen
  counter in `shot-RAWON.png` is a one-second average and could not have shown a 4 % hitch rate
  anyway.

Two window-finding notes, because each cost a run and both are true regardless:
**`FindWindowA("CoD-WaW", NULL)` returns NULL on this box** even with the game up, and
`Process.MainWindowHandle` **is** the right window (class `CoD-WaW`, 2560x1440 at (0,0)) — the
`CoD Splash Screen` and IME windows are the others. `SetForegroundWindow` is also refused outright
to a process that is not already foreground; the documented `AttachThreadInput` dance gets past
that part, and does not get past the input filtering.

### So what is proven, and what is still open

**Proven.** The stutter tracks mouse input volume, on B's own hardware, in one run, with the scene
and every dvar held constant — the table above. And the usual suspects are excluded by the control.

**Not proven, and it needs B's hand on the mouse for five minutes.** Whether the cost is *ours*
(the `WM_INPUT` registration and the per-message `GetRawInputData`) or the *engine's* (the legacy
`WM_MOUSEMOVE` flood through `Sys_GetEvent`, which drains the queue completely every frame). The
synthetic harness cannot tell them apart on this machine, and guessing is what this project does
not do.

**The A/B for B**, same map, a minute each, moving the mouse the whole time, reading the three
`frametime: window` lines out of `%LOCALAPPDATA%\ENWZombies\logs\enw-<pid>.log`:

| run | environment | what it tells us |
|---|---|---|
| 1 | `ENW_FRAMETIME=1` | today's default: raw input on, legacy messages kept |
| 2 | `ENW_FRAMETIME=1 ENW_RAW_MOUSE=0` | the stock engine path. If this is *also* bad, the flood is the engine's and NOLEGACY is the fix |
| 3 | `ENW_FRAMETIME=1 ENW_RAW_MOUSE_NOLEGACY=1` | the candidate fix below |

If run 3 wins, it becomes the default. **Nothing has been made default on this evidence.**

### The candidate fix, built and off by default: `ENW_RAW_MOUSE_NOLEGACY=1`

The mechanism it targets, which is a fact about the code rather than a measurement: we register raw
input with `dwFlags = 0`, which **keeps** the legacy messages (deviation 1 in §1b, and deliberate —
the buttons and the menu cursor live on that path). So every device report produces a
`WM_MOUSEMOVE` **and** a `WM_INPUT`, and `Sys_GetEvent` (`0x5FEC60`) drains the queue completely
every frame while `Com_EventLoop` (`0x5FEDE0`) calls it until the event type is 0. At 8 kHz that is
~16,000 messages a second dispatched one at a time on the game thread; run A peaked at **57
`WM_INPUT` in a single frame** at only ~4,500 reports/s.

What the switch does:

* **`RIDEV_NOLEGACY`**, so Windows stops generating the `WM_MOUSEMOVE` half at all;
* **`GetRawInputBuffer` once per frame** from our replacement `IN_MouseMove`, so the other half is
  one call instead of one dispatch per report;
* **only while the game owns the mouse.** `RIDEV_NOLEGACY` also stops the OS cursor moving, and
  T4's menu cursor *is* the OS cursor, so leaving it on in the menu would freeze the pointer and
  §2a is non-negotiable. `CL_MouseEvent`'s return value is the engine's own answer to "should the
  cursor be recentred", i.e. "does the game own the mouse" — we already read it every frame, and it
  cannot go stale the way a cached menu flag can. The legacy messages go straight back when it is 0,
  and the flip is logged.
* **buttons are handed back to the engine's own path.** With legacy off there is no
  `WM_LBUTTONDOWN` either. Rather than call `IN_MouseEvent` (`0x5FA5F0`) with a convention nobody
  has verified — `addresses.hpp` rule 2, and this project has paid for guessing one — we give the
  **original WndProc** the exact legacy message it would have received, through `CallWindowProcA`,
  with `wParam` rebuilt from `GetAsyncKeyState`. Documented Win32 plus the engine's own proc: no new
  address, no guessed prototype. Button transitions are a handful a second, so none of the flood
  comes back with them.

`ENW_RAW_MOUSE=0` remains the full revert. **Untested against a real high-rate mouse**, for the
reason above; it compiles, loads and arms, and that is all that is claimed.

---

## 4. The LocalAppData redirect: the game stops sharing a folder with the player's own (2026-09-23)

B, this morning: **"our client must never touch the user's own World at War data."** Steam-launched
vanilla WaW must see nothing of ours, and everything we add â€” maps, config, saves, our DLL â€” lives
under `%LOCALAPPDATA%\ENWZombies\` only.

`client-dll/components/enw_localappdata.cpp`.

### What was actually shared, and why `fs_homepath` was never enough

`+set fs_homepath <dir>` moves `main/` and `console.log`. It does not move any of this
(foundation.md Â§7, and the engine dump in `tools/dev/mapmount.ps1`):

| what | where it lived |
|---|---|
| the profile, `config.cfg`, binds | `%LOCALAPPDATA%\Activision\CoDWaW\players\profiles\â€¦` |
| **the custom-map folder** | `%LOCALAPPDATA%\Activision\CoDWaW\mods\<bsp>\` |
| the safe-mode / single-instance marker | `%LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW` |
| **the map-exists check** | `<fs_localAppData>\<fs_game>\<bsp>.ff`, opened with `CreateFileA` at 0x48FC10, and the *only* thing that decides `Can't find map` â€” the FS search path is not consulted |

That last row is why the launcher installed maps into the player's folder at all, and the last two
rows together are why **vanilla World at War's Mods menu was listing ENW's maps** and why B kept
seeing *"already in your own World at War mods folder"* when he pressed Install (launcher.md,
2026-09-22 Â§1 â€” that message and the predicate behind it are both gone now).

### The hook

`CoDWaW.exe` imports `SHGetFolderPathA` from SHELL32 and appends the literal `\Activision\CoDWaW`
to what it returns (the string is at 0x47EC90). The component replaces that one IAT entry and hands
back `ENW_LOCALAPPDATA` for `CSIDL_LOCAL_APPDATA` and `CSIDL_APPDATA`; the engine then builds
`players`, `mods`, `__CoDWaW` and its own map-exists path off our folder by itself.

Three things about the shape, all of which are the reason it is an IAT patch and not a detour:

* the IAT is in `.rdata`, which **SteamStub does not encrypt**, and the loader fills it before the
  PE entry point runs â€” so this installs at `post_load`, before the game's code is decrypted and
  before any engine code executes. It has to be: the profile path is resolved during very early init.
* one pointer write, reversible, no prologue to relocate;
* **setting the `LOCALAPPDATA` environment variable does nothing.** The dedi lane measured that:
  the engine uses `SHGetFolderPathA`, which reads the shell's own state, not the environment.

`ENW_LOCALAPPDATA` is what the launcher sets (`launch.js`); `ENW_INSTANCE_APPDATA` is accepted too
because the dev scripts already set that one. With neither set the component stays off and says so,
so a stock dev launch is unchanged.

### Hook ownership

`shared/core/components/instance_paths.cpp` patches **the same import** for per-instance profiles.
It is opt-in (`ENW_PRIVATE_PROFILE=1`) and this component **stands down when it is on**, with a log
line, rather than letting two owners race for one IAT slot and letting the loser find out from a log
line (kickstart rule 9).

### Self-verifying, because a redirect that silently did not happen is the dangerous outcome

`post_init` prints how many times the engine actually came through the hook and **warns loudly at
zero**, naming the consequence â€” profiles, mods and the map-exists check still resolving to the
player's folder â€” and saying that any "we did not touch their data" claim from that run is unproven.
Believing a redirect that did not take is how a player's own save gets overwritten.

### Evidence

See `launcher.md`, the 2026-09-23 section, for the run: a Play Local on a custom map with the
player's whole `Activision\CoDWaW` tree hashed before and after.


---

## 5. The 2026-09-22 evening pass: B played 0.2.2 and reported three things

B, after a real session on launcher 0.2.2: *"micro stutters and the frame rate visibly goes down
when the mouse is moving at a high polling rate; turning the mouse down to 125 Hz fixed it"*,
*"default ADS should be hold, not toggle"*, and *"borderless is not working — I'm in windowed mode
with a border"*.

### 5a. Start here, because it changes how you read everything below

**The DLL B played did not contain the components he was reporting on.** The launcher's bundled
client (`launcher/resources/client/enw_t4.dll`) was `24b3bf94…`, staged 2026-09-22 03:43, and a
`loadtest` of it registers **39 components**; the repo's build at the time registered **46**, and
the one 0.2.3 ships registers **47**. `frametime`, `enw_localappdata` and the whole
`ENW_RAW_MOUSE_NOLEGACY` path are absent from `24b3bf94…` — checked by byte-string search of the
binary, not by inference. A launcher-spawned run that evening (`enw-30340.log`, 16:58) announces
`components registered: 28` and contains **not one `mouse_polling:` or `borderless:` line**, despite
`ENW_BORDERLESS=1` and `+set r_noborder 1` on its own command line, which the same log quotes.

The cause is `launcher/tools/stage-client.js`: its `PREFER = ['launcher', 'referee', 'foundation']`
picked `build/launcher` **unconditionally, regardless of age**, so a DLL built before
`borderless.cpp` existed was staged over a newer one sitting in `build/c2`. That is now a hard gate
— see 5e.

**Two traps that made this take an hour, both now fixed in place:**

1. **The build banner lied.** `__DATE__` / `__TIME__` are the compile time of `dllmain.cpp`'s
   translation unit, and an incremental build leaves an unchanged TU alone. *Three different DLLs*
   all announced `build Sep 21 2026 16:18:51`, so the banner could not identify the binary a player
   had run. `log_banner()` now also prints the **file's own last-write time and size**, which cannot
   go stale.
2. **A read of `%LOCALAPPDATA%` from an agent shell is not a write to it.** `npm run smoke` says so
   out loud: this process's writes under `%LOCALAPPDATA%` are redirected into a per-app package
   cache, so an install done from here is invisible to the launcher B starts. Reads pass through.
   Everything quoted in this section is a read.

### 5b. The mouse: what the community has actually proven, and what we took from it

Researched across CoD4x, iw4x, Plutonium, cod2x, T4M, Special K, Quake3e / ioquake3, RInput and the
Win32 documentation. The short version: **there is no WaW patch to port.** T4M
(<https://github.com/iAmThatMichael/T4M>) raises asset limits and does not touch input, the message
loop or timer resolution; Plutonium's `raw_input 1` exists for T4 but is documented as an
*acceleration* fix and their 2026 threads still tell people to drop to 125 Hz
(<https://forum.plutonium.pw/topic/40851/mouse-acceleration-solved>); CoD4x's thread
(<https://cod4x.ovh/t/possible-fix-for-fps-drops-when-moving-mouse/4105>) is anecdote with no diff.
The WaW community's only circulating fix is "lower your polling rate"
(<https://steamcommunity.com/app/10090/discussions/0/1837937637880549012/>).

**The one piece of proven prior art is iw4x-client PR #166, "Fix of fps drop when using a high
polling rate mouse"** (<https://github.com/iw4x/iw4x-client/pull/166>), whose entire mechanism is
`RIDEV_NOLEGACY` — *"disabling legacy WindowProc messages ... bottleneck of window messages when
using high polling rate mouse (8k)"*. It is demonstrated by a working toggle (`m_rawinput 0` brings
the drop back), not by numbers. **Quake3e** does the same and is the cleanest reference
(<https://github.com/ec-/Quake3e/blob/master/code/win32/win_input.c>): `RIDEV_NOLEGACY`, commented
*"skips all WM_\*BUTTON\* and WM_MOUSEMOVE stuff"*, and — the part we had missed — **its raw path
never recentres**; `IN_CaptureMouse` does one `ClipCursor` instead. **CoD2x**
(<https://github.com/callofduty2x/CoD2x>) exposes the whole thing as `m_rinput` with an
`m_rinput_hz` measured-rate readout.

Two Win32 facts underneath: **`GetRawInputData` takes a lock per call**
(<https://github.com/libsdl-org/SDL/issues/8756> — Valorant shipped a "Raw Input Buffer" option for
exactly this and later defaulted it on), and **`SetCursorPos` synthesises a `WM_MOUSEMOVE`** into the
queue you are draining.

So T4's stock path floods the pump **three** ways at once, and 0.2.2 had only stopped counting one
of them:

| | per device report | our 0.2.2 default | 0.2.3 |
|---|---|---|---|
| legacy `WM_MOUSEMOVE`, dispatched one at a time by `Sys_GetEvent` | 1 | **kept** | **gone** (`RIDEV_NOLEGACY`) |
| `WM_INPUT` + a locked `GetRawInputData` each | 1 | one read each | one **`GetRawInputBuffer`** for the queued ones |
| `IN_RecenterMouse` → `SetCursorPos` → another `WM_MOUSEMOVE` | once a frame | **still running** | **skipped**, `ClipCursor` instead |

### 5c. What changed in `mouse_polling.cpp`, and the deviation that is retracted

`ENW_RAW_MOUSE_NOLEGACY` is **on by default**. Deviation 1 in §1b — "NO `RIDEV_NOLEGACY`" — is
retracted in the file rather than deleted: its reasoning (suppressing legacy would take the OS
cursor away from the menu path) was sound and its conclusion was still wrong, and B played the wrong
conclusion. NOLEGACY is registered **only while the game owns the mouse**, which is what
`CL_MouseEvent`'s own return value says, read fresh every frame; the menu, the console, `WM_KILLFOCUS`
and shutdown all put it straight back. Buttons go to the engine's own WndProc as the legacy messages
it expects, through `CallWindowProcA`.

Four more, each because the research named a specific failure:

* **The recentre is skipped and the cursor is clipped instead** while NOLEGACY is on (Quake3e's
  structure). This is the third leg of the flood and it was ours to remove: the only reason the
  engine recentres is that its deltas are differences between two cursor positions, and with raw
  deltas there is nothing to recentre for.
* **A real bug in the never-tested NOLEGACY path is fixed.** It used to `return` from `OnRawInput`
  on the grounds that the once-a-frame buffer read owned everything. It does not: **`GetMessage`
  removes the raw event it is delivering from the buffered queue before it returns**, so
  `GetRawInputBuffer` never sees the report that produced this `WM_INPUT` — only later ones. Every
  dispatched report was being dropped. MSDN's documented pattern (`GetRawInputData` for the current
  event, then `GetRawInputBuffer` for the rest) is what runs now, and the button transitions on the
  dispatched event are synthesised too.
* **`GetRawInputBuffer` returning `-1` no longer means a dead mouse.** Special K leaves it failing
  with `ERROR_PROC_NOT_FOUND` (<https://github.com/SpecialKO/SpecialK/issues/354>); we log once and
  fall back to per-message reads for the rest of the session, keeping NOLEGACY.
* **A measured device rate in the log**, CoD2x's `m_rinput_hz` as a line: `mouse_polling: measured
  device rate 4500 Hz now, 8000 Hz peak this session`. It is the number that says whether the reports
  are reaching the game at all.

Separately, and it is **additive, not the same fix**: the research is clear that Windows timer
resolution and a clean `com_maxfps` are their own stutter source in the Q3 lineage (only divisors of
1000 behave — 125 / 250 / 333 / 500). `com_maxfps` is already 250 and the DLL already calls
`timeBeginPeriod(1)`. Nothing was changed there and nothing should be credited to it.

### 5d. Aim down sights: it is a bind, not a dvar

**There is no ADS hold/toggle dvar in T4.** `ads_toggle`, `cl_ads`, `cg_ads`, `ads_button` and
`ToggleADS` are all **zero occurrences** in the decrypted 1.7 image. What the game's own Controls
menu writes when you pick Hold or Toggle is **which command `MOUSE2` is bound to** — both pairs are
in the image, at `0x44D40D` and `0x489A91`:

```
+speed_throw      / -speed_throw        HOLD
+toggleads_throw  / -toggleads_throw    TOGGLE   <- what B's profile held
```

So the default is set where the game will find it, in the seeded config, as
`bind MOUSE2 "+speed_throw"`, and the round trip is free: a player who picks Toggle in the menu has
the game rewrite that line, and `applyReadBack` reads binds already. Nothing was patched in the DLL
for this — a bind is the stock mechanism, it survives a `writeconfig`, and it is what the menu
itself would have written.

### 5e. Borderless: the component is right; it was not in the binary

`r_noborder` is **confirmed absent** from the exe. `r_noborder`, and the substring `noborder`
case-insensitively, are **zero occurrences** in the 78 MB dump — re-checked this session against the
dump itself rather than against the note, because the R15 trawl claimed otherwise. The trawl is
**wrong on that one dvar**; the other four in Plutonium's recipe (`r_fullscreen`, `vid_xpos`,
`vid_ypos`, plus `r_monitor`) are real, and so, it turns out, is `r_autopriority` — it is in the
config.cfg the engine writes on this box, which is how iw4x's own feature name showed up in a 2008
game.

`borderless.cpp` therefore stays as the Borderless-Gaming-style style strip, and it demonstrably
works — `enw-7372.log`, 15:48 on 2026-09-22, our own harness:

```
borderless: target 2560x1440 at (0,0) from the command line (r_mode, vid_xpos, vid_ypos)
borderless: style 0x14C80000 -> 0x94080000, exstyle 0x00000100 -> 0x00000000.
            WS_CAPTION=0 WS_THICKFRAME=0 WS_BORDER=0 WS_POPUP=1.
            window rect 2560x1440 at (0,0), client 2560x1440. BORDERLESS.
```

That is a `GetWindowLong` read-back, and `window rect == client rect` is the proof there is no frame
left. What B ran did not have the component in it at all (5a) — **and even if it had, the engine
profile it read still said `seta vid_xpos "40"` and `seta r_mode "800x600"`**, because the launcher
was seeding a path the engine never opens. `config.cfg` is exec'd during `Com_Init`, after the
command line's `+set`s, so it wins. That is `launcher.md`'s 2026-09-22 section and it is fixed.

`vid_restart` is **not** used: the R15 trawl reports a known deadlock on it, and the style strip
re-applies from the shared frame tick anyway — it detects a new HWND and re-applies, which is what
covers both `vid_restart` and alt-tab. Those two re-applications remain **unproven**; the poll
handles them and nothing has exercised it.

### 5f. What is PROVEN, and the three runs that decide the rest

**Proven.**

* The stutter tracks mouse input volume on B's own hardware, scene and dvars held constant (§1e's
  table: p99 6.75 ms and 0.00 % of frames over 16.7 ms with the counters frozen; p99 23–27 ms and
  ~4 % with the mouse moving). The usual suspects are excluded by the same run.
* The DLL B played was missing the components he was reporting on — three independent readings:
  component counts from `loadtest` (39 vs 47), byte-string search of the binaries, and a launcher
  run whose log contains no line from either component (5a).
* `r_noborder` does not exist in the image (5e). ADS is a bind, and B's profile held the toggle one
  (5d). The launcher's config seed was going to a directory the engine has never opened — the
  directory did not exist on this box after a night of play (launcher.md).
* 0.2.3's DLL builds, loads and registers **47** components with no faults (`loadtest`), and the
  launcher's 107 tests pass.

**Proven in the running game, 2026-09-22 17:38, `waw-c2`, 55 s on `nazi_zombie_prototype`,
windowed, 0.2.3's DLL** (`ZombiesDev\logs\c2\enw-23460.log`). The lock came free at 17:45 and this
run took and released it. The mechanism does what it claims, and every line below is a read-back or
a counter, not a call that returned without error:

```
enw_t4 build Sep 22 2026 17:34:15 (translation unit; the FILE is 2026-09-22 17:38:08, 1577472 bytes)
  components registered: 47
borderless: style 0x14C80000 -> 0x94080000, exstyle 0x00000100 -> 0x00000000.
            WS_CAPTION=0 WS_THICKFRAME=0 WS_BORDER=0 WS_POPUP=1.
            window rect 2560x1440 at (0,0), client 2560x1440. BORDERLESS.
mouse_polling: legacy mouse messages OFF -- the game owns the mouse now.   (flip 1)
mouse_polling: WM_INPUT total=1051 ... | legacy WM_MOUSEMOVE total=50
mouse_polling: NOLEGACY is ON (3 flips); GetRawInputBuffer: in use, 198 call(s) for 211 report(s);
               IN_RecenterMouse skipped 802 time(s) (ClipCursor on instead)
frametime: window 2 -- 2489 frames, 248.8 fps avg | p50 4.25  p95 5.75  p99 7.25  max 13.08 ms
           | over 16.7ms: 0 (0.00%)
```

Read the second and third `mouse_polling` lines together, because that pair is the whole point:
**1,051 `WM_INPUT` against 50 legacy `WM_MOUSEMOVE`.** The legacy half of the flood is gone while the
game owns the mouse, and it comes straight back when it does not — `legacy WM_MOUSEMOVE` jumps 50 →
186 → 197 in the two windows after flip 4 hands the mouse to the menu, and `ClipCursor` follows it
`off`. Four flips in 55 s, driven by `CL_MouseEvent`'s own return value, with the menu cursor alive
throughout. `IN_RecenterMouse skipped 1,101` times: the `SetCursorPos` feedback leg is gone too.
`GetRawInputBuffer: in use` — no Special K fallback on this box. And the borderless line is a
`GetWindowLong` read-back with **window rect == client rect** covering the whole 2560x1440 monitor,
from 0.2.3's own binary.

**Still not proven, and it is the only thing that matters to B.** Whether this removes the *feel* of
the stutter at his real polling rate. Nobody had a hand on the mouse in that run — the measured
device rate peaked at 118 Hz, which is ambient cursor drift, so `reports per call` sat at 1.1 and the
buffered read was never under load. `SendInput` at 8 kHz is discarded on this machine (§1e, retracted
there in full). Also unexercised: alt-tab re-application and `vid_restart`.

**B's three runs.** Same map, one minute each, moving the mouse the whole time at his real polling
rate. Read the `frametime: window` and `mouse_polling:` lines out of
`%LOCALAPPDATA%\ENWZombies\logs\enw-<pid>.log`.

| run | environment | what it decides |
|---|---|---|
| 1 | `ENW_FRAMETIME=1` | **0.2.3's default**: NOLEGACY, no recentre, buffered reads |
| 2 | `ENW_FRAMETIME=1 ENW_RAW_MOUSE_NOLEGACY=0` | exactly what 0.2.2 did — the A/B for the whole change |
| 3 | `ENW_FRAMETIME=1 ENW_RAW_MOUSE=0` | the stock engine path, as the floor |

Run 1 should show `legacy WM_MOUSEMOVE total` near zero while in the game, `IN_RecenterMouse skipped`
climbing, `reports per call` well above 1, and a `measured device rate` matching his mouse — those
four together are the plumbing proof. The verdict is whether run 1 beats run 2 on **p99** and on
**over 16.7ms**. If it does not, the default reverts and the next suspect is `Sys_GetEvent`'s
drain-until-empty loop itself, which no community project has touched.


---

## 6. 2026-09-23 — dropped mouse clicks: what T4 thinks a click *is*, and why that loses them

B, playing 0.2.2 on the evening of 2026-09-22: *"mouse inputs get dropped — if I aim, sometimes it
aims and un-aims; keyboard is fine, mouse clicks disappear a lot of the time, at 125 Hz and
1000 Hz."*

This section is the answer, and it is the first thing in this lane that was **proven in the running
engine** rather than argued from a listing. Read 6a before anything else: it changes what a fix has
to do, and every design decision below falls out of it.

### 6a. PROVEN: for T4 a click is a *mask difference*, and a mouse MOVE carries the mask

Read out of the dump instruction by instruction (all of it is now in `addresses.hpp` under
"the button path"). The game WndProc's second dispatch is

```
0060704E  lea   eax, [edi - 0x200]          ; edi = msg
00607054  cmp   eax, 0x18
00607057  ja    default
0060705D  movzx ecx, byte ptr [eax + 0x607204]
00607064  jmp   dword ptr [ecx*4 + 0x6071F4]
```

and decoding those two tables gives this, which is the whole finding:

| message | handler |
|---|---|
| `WM_MOUSEMOVE` 0x200 | **0x6070F7** |
| `WM_LBUTTONDOWN/UP`, `WM_RBUTTONDOWN/UP`, `WM_MBUTTONDOWN/UP`, `WM_XBUTTONDOWN/UP` | **0x6070F7** |
| `WM_MOUSEWHEEL` 0x20A | 0x60706B |
| the three `*DBLCLK`, `WM_MOUSEHWHEEL` | default, ignored |

**`WM_MOUSEMOVE` goes to the same handler as every button message.** And that handler does exactly
one thing:

```
006070F7  xor eax, eax
          test bl, 0x01 -> eax |= 1        ; bl = wParam. MK_LBUTTON
          test bl, 0x02 -> eax |= 2        ; MK_RBUTTON
          test bl, 0x10 -> eax |= 4        ; MK_MBUTTON
          test bl, 0x20 -> eax |= 8        ; MK_XBUTTON1
          test bl, 0x40 -> eax |= 0x10     ; MK_XBUTTON2
00607123  push eax
00607124  call 0x5FA5F0                    ; IN_MouseEvent
```

and `IN_MouseEvent` (0x5FA5F0) XORs that byte against `s_wmv.oldButtonState` (0x229A0C8) and calls
`Sys_QueEvent(SE_KEY, K_MOUSE1 + n, down)` once per bit that **changed**.

So, and this is the sentence the rest of the section hangs on:

> **The engine never looks at the message id.** A click, for T4, is not a `WM_LBUTTONDOWN`. A click
> is "the MK_ mask of some mouse message differs from the mask of the previous one" — and a plain
> mouse *move* is one of those messages.

Three consequences:

* a **duplicated** button message cannot double a click (same mask, no edge) — so the flood is not
  a doubling risk;
* a button message whose mask is **wrong** produces **no edge at all** — the click is gone, not
  mis-ordered;
* a `WM_MOUSEMOVE` carrying a stale or premature mask can **invent** a click or **destroy** one.

`s_wmv.oldButtonState` is written in exactly one place in the whole 78 MB image (0x5FA648, inside
`IN_MouseEvent`), so nothing else resets it and there is no third party to blame.

### 6b. PROVEN IN THE RUNNING GAME, 2026-09-22 18:17, `waw-c2`, `nazi_zombie_prototype`

Three arms posted into the game's own message queue with `PostMessage` (**not** `SendInput` —
§1e retracted that; `PostMessage` is same-integrity and is not filtered), while
`ENW_INPUT_TRACE=1` read the engine's `Sys_QueEvent` ring. `ZombiesDev\logs\c2\enw-23108.log`.

**Arm B — four button messages carrying the wrong mask.** `WM_LBUTTONDOWN` with `wParam = 0`, i.e.
exactly what `synth_buttons` built when `GetAsyncKeyState` was sampled after the physical button had
already moved on:

```
8148 ms  LEG  MOUSE1 DOWN wParam mask=0x00 tracked=0x00
8261 ms  LEG  MOUSE1 UP   wParam mask=0x00 tracked=0x00
8548 ms  LEG  MOUSE1 DOWN wParam mask=0x00 tracked=0x00
8553 ms  LEG  MOUSE1 UP   wParam mask=0x00 tracked=0x00
...
input_trace: MOUSE1  raw 1 down / 0 up | legacy msgs 2 / 2 | engine QUEUED 0 down / 0 up -> DROPPED
```

**Four button-down/up messages, zero key events queued.** The clicks did not arrive late or out of
order; they did not exist.

**Arm C — three pure mouse MOVES carrying `MK_RBUTTON`, and no button message at all:**

```
9329 ms  QUEUED MOUSE2 DOWN  <- the engine
9488 ms  QUEUED MOUSE2 UP    <- the engine
9646 ms  QUEUED MOUSE2 DOWN  <- the engine
9781 ms  QUEUED MOUSE2 UP    <- the engine
9939 ms  QUEUED MOUSE2 DOWN  <- the engine
10102 ms QUEUED MOUSE2 UP    <- the engine
...
input_trace: MOUSE2  raw 0 down / 0 up | legacy msgs 0 / 0 | engine QUEUED 3 down / 3 up -> DOUBLED
```

**Three right-clicks manufactured out of mouse movement**, with the right mouse button never
touched and no button message ever sent. That is 6a's third consequence, measured.

`QUEUED` is not our count of what we sent; it is a read of the engine's own event ring
(0x22BBF48, head 0x22BBA34, stride 0x18 — layout in `addresses.hpp`). **Nothing is hooked for it**:
the ring is read, not intercepted, so no MinHook address is taken and kickstart rule 9 does not
apply.

### 6c. The two defects this proves, and what changed

**DEFECT 1 — `synth_buttons` built the mask from `GetAsyncKeyState` at synthesis time.** Arm B *is*
this defect. Under `RIDEV_NOLEGACY` (0.2.3's default, which **B has never run**) every button
transition was re-manufactured, and the mask was re-sampled from the OS at the moment the report was
*consumed* rather than taken from the report itself. A report consumed after the physical button had
moved on — which is every click during a 30–60 ms hitch, and the norm at 1000 Hz where one
`GetRawInputBuffer` consumes several milliseconds of reports — carried the wrong mask and queued
nothing. **0.2.3 and 0.2.4 would have dropped clicks for B on their default path.** This is the
single most valuable thing in this section: it was caught before he ran it.

**DEFECT 2 — buttons were synthesised only while `g_nolegacy_now` was true.** The NOLEGACY flip
happens once a frame, driven by `CL_MouseEvent`'s return. A click whose legacy twin was already
queued when we flipped *to* NOLEGACY was delivered twice; a click whose raw report was generated
under NOLEGACY but dispatched after we flipped *back* was delivered zero times, because `OnRawInput`
refused to synthesise it.

**What changed.** `RIDEV_NOLEGACY` is now a **motion-and-OS-cursor decision only**. Buttons behave
identically on both sides of it, because:

1. **Raw input is the single source of button truth, in both modes.** Every `RAWMOUSE.usButtonFlags`
   transition updates `g_btn_mask` in report order and emits **one** message carrying the
   **post-transition** mask — ours, from the report, never re-sampled from the OS.
2. **Every legacy mouse message Windows still delivers is forwarded with its mask rewritten** to
   `g_btn_mask` — `WM_MOUSEMOVE` included, which is what closes arm C. Never swallowed, so the menu
   cursor, `DefWindowProc` and the UI are untouched (§2a).
3. **Only bits we have actually seen a raw transition for are rewritten** (`g_btn_known`). A button
   raw input never reports keeps the stock path exactly, so this can never leave a player unable to
   click. That is the safety net, and it is deliberate.
4. **Everything is released on `WM_ACTIVATE(WA_INACTIVE)` / `WM_KILLFOCUS`,** as one mask-0 move.
   Raw input stops the instant we are not foreground, so a button let go during an alt-tab is a
   transition we will never see and the differ would hold it down for the rest of the session. A
   stuck `+attack`, or a stuck toggle-ADS, reads to a player exactly like "inputs get dropped".
   Visible in the same run at 77055 ms: a real click's `QUEUED MOUSE1 DOWN` followed immediately by
   the forced `QUEUED MOUSE1 UP`.

**Why this is exactly one edge per transition, and not a patched race.** After rules 1–3 every mouse
message the engine sees carries `g_btn_mask` in the bits we own. So the sequence of masks the engine
differs *is* the sequence of `g_btn_mask` values, in raw report order, with arbitrary repeats
interleaved. A differ over a sequence with repeats yields exactly the transitions of the underlying
sequence — no more, no fewer. Message order, message id, `GetAsyncKeyState` timing and the NOLEGACY
flip all stop being able to affect the outcome. The state machine is written out in full at the top
of `mouse_polling.cpp`.

`ENW_RAW_MOUSE_BUTTONS=0` is the one-word revert to the old pass-through behaviour, for A/B only.

### 6d. The focus flap, and why B's windowed session made it worse

A second, independent loser of input, and this one is visible in an ordinary run on this box.

`IN_Frame` (0x5FA850) reads:

```
005FA897  cmp byte ptr [0x229A0D5], 0   ; s_wmv.mouseInited -- 0 means do nothing at all
005FA8A0  cmp dword ptr [0x229A0C4], 0  ; g_wv.activeApp
005FA8A7  jne 0x5FA8AF
005FA8AA  jmp 0x5FA5B0                  ; IN_DeactivateMouse, and RETURN
005FA8E4  call 0x5FA6D0                 ; IN_MouseMove -- OUR retarget, never reached above
```

`g_wv.activeApp` is written by exactly two places: the **`WM_ACTIVATE`** handler (0x606AA0) and the
`WM_MOVE` case (0x606E18). So a single `WM_ACTIVATE(WA_INACTIVE)` takes the engine out of the mouse
entirely — our `IN_MouseMove` replacement is **not called at all**, raw deltas stop being consumed,
and whatever was held is stuck. `WM_SETFOCUS`/`WM_KILLFOCUS` do **not** do this; all they do is
`SetPriorityClass` (0x20 / 0x40), which is `r_autopriority`. Checked, because the Q3 lineage's
`Key_ClearStates()`-on-focus-loss was the obvious suspect and **T4 does not have it**.

`focus_guard` (`shared/core`) hooks `GetForegroundWindow` and `GetActiveWindow` and answers with the
game window, so `IN_Frame`'s own re-activation check (0x5FA8CA) and `IN_MouseMove`'s first guard
(0x5FA6DB) can never see the truth. The engine can therefore be certain it is foreground while
Windows routes clicks by hit-test to whatever is actually on top — **keyboard keeps working, because
keyboard follows focus and mouse buttons follow the window under the cursor.** That is B's
"keyboard is fine, mouse clicks disappear" exactly.

With `ENW_BORDERLESS=0` B played **windowed**, on the same desktop as the Electron launcher. The
launcher had three `state.win.show(); state.win.focus()` sites that could fire mid-game — the
deep-link handler (party invites and follow-the-leader arrive *while you are playing*), the Steam
sign-in callback, and the second-instance `onFocus`. All three are now routed through
`launcher/src/main/focusguard.js`, which refuses to raise the window while `state.flow` is set and
performs the raise once the flow ends. The tray menu and the tray click are left alone: those are
the player asking, at the keyboard.

### 6e. What is PROVEN and what is still SUSPECTED

**Proven** (6a, 6b, 6d — each by a read of an instruction or a counter, not by argument):

* T4 derives every mouse-button edge from the MK_ mask alone, and `WM_MOUSEMOVE` feeds the same
  differ as the button messages.
* A button message with a wrong mask queues **nothing** (arm B, 4 messages → 0 events).
* Three pure mouse-moves with a stale mask queue **three full clicks** (arm C, 0 button messages →
  6 events).
* Defect 1 was on 0.2.3/0.2.4's **default** path. B has not run it; he would have lost clicks.
* `g_wv.activeApp` at 0 stops `IN_MouseMove` being called at all, and only `WM_ACTIVATE` clears it.
* T4 has no `Key_ClearStates` on focus loss — that suspect is excluded by reading both handlers.

**Suspected, and B's run decides it.** *Which* of these hit B on 0.2.2 specifically. 0.2.2 ran
`IN_RecenterMouse` → `SetCursorPos` **every frame**, and `SetCursorPos` generates a `WM_MOUSEMOVE`
whose mask Windows assembles when the message is *retrieved*, not when the cursor moved — arm C is
the live demonstration that such a move rewrites the engine's button state. The mechanism is proven
to exist and to be sufficient; that it is the thing he felt is **not yet measured on his hardware**,
because nobody can click for him. `SendInput` at rate is discarded on this box (§1e, retracted in
full there) and `PostMessage` cannot produce raw input at all, so **no agent can generate a real
click on this machine** — the arms above drive the legacy path only, which is why they prove the
*engine's* behaviour and not B's *session*.

### 6f. The run B does — one minute, and the verdict is one line

`ENW_INPUT_TRACE=1` is off by default and costs a handful of increments behind one `bool` when on.

Launch the game twice, a minute each, **on the same map**, clicking and aiming continuously the
whole time — fire in bursts, aim down sights repeatedly, use MOUSE4/MOUSE5 if bound:

| run | mouse polling rate | environment |
|---|---|---|
| 1 | **125 Hz** | `ENW_INPUT_TRACE=1 ENW_FRAMETIME=1` |
| 2 | **1000 Hz** (or 4000/8000) | `ENW_INPUT_TRACE=1 ENW_FRAMETIME=1` |

Then read `%LOCALAPPDATA%\ENWZombies\logs\enw-<pid>.log`. The last `input_trace (session total)`
block is the verdict, one line per button:

```
input_trace (session total): MOUSE1  raw 128 down / 128 up | legacy msgs 128 / 128 |
                             engine QUEUED 128 down / 128 up  ->  PERFECT
input_trace (session total): MOUSE2  raw 61 down / 61 up   | legacy msgs 61 / 61   |
                             engine QUEUED 61 down / 61 up   ->  PERFECT
input_trace (session total): masks rewritten 940, forced releases 0,
                             Sys_QueEvent overflow windows 0, tracker on, NOLEGACY on (12 flips)
```

How to read it:

* **`raw` is what the device reported. `engine QUEUED` is what the game actually acted on.** They
  must be equal. `PERFECT` on every button at both rates is the pass.
* `DROPPED` means `engine QUEUED` is short: clicks were lost. `DOUBLED` means it is over: clicks were
  invented. Either one names the button and is a failure, and the per-event `RAW` / `LEG` /
  `QUEUED` lines above it, all timestamped in milliseconds, say where in the run it happened.
* **`masks rewritten` being large is the fix working**, not a warning: it counts legacy messages
  whose mask disagreed with the device and was corrected. A large number at 1000 Hz and a small one
  at 125 Hz is the expected shape.
* **`forced releases` should be 0 in a clean run.** Anything else means the window lost activation
  mid-game — look for the `FOCUS WM_ACTIVATE INACTIVE` line next to it and for whatever stole focus.
* `Sys_QueEvent overflow windows` must be 0. It has never been non-zero in B's logs and it is not
  the mechanism, but it is now counted rather than assumed.
* Read the `frametime: window` lines beside it as before: the click verdict and the stutter verdict
  come out of the same run.

If run 1 and run 2 are both `PERFECT` on every button, inputs are exact at 125 Hz and at his real
rate and this is finished. If either shows `DROPPED`, send the log: the timestamps around the first
divergence are the whole diagnosis.

---

## 7. 2026-09-22 19:30 — the "intro over the HUD" is the map's load video; the join now waits for a safe menu

**What B reported** (run `enw-11524.log`, launcher 0.2.7, 2560x1440, `com_maxfps 250`): a cinematic
drawn over the in-game HUD and round counter, and in one run `Hunk_AllocateTempMemory: failed on
11059216 bytes`. `connect_local` fired blindly at frame 300 — 2.0 s after `post_init` in that run.

**What it actually is — PROVEN in `jointest` runs gate1..gate3** (`ZombiesDev\logs\dedi\gate*.client.enw.log`,
local dedi `d2` + client `c1`, off-screen, lock taken by the harness, our PIDs killed): the new
BinkOpen/BinkClose watch logs every open.

| | gate1 (gate on "no Bink open") | gate3 (shipped) |
|---|---|---|
| startup `Treyarch.bik` | **never opened** with our args | never opened |
| menu background | a **fastfile (memory) Bink**, opened 0.9 s after `post_init`, open until the connect closes it | same; its first open = "menu is up" |
| gate | never opened (the menu video) -> 30 s ceiling fired, logged WARN | opened at 2.0 s, `clc.state=2`, menu video seen |
| `nazi_zombie_prototype_load.bik` | opened 35 ms after connect, **open 28 s**; level live after 3.3 s | refused; engine: `R_Cinematic_BinkOpen ... trying default` |
| `default.bik` fallback | — | refused; engine: `'default' failed ... not playing movie` |
| ROUND 1 | yes | yes, 3 s after connect; client ticking 45 s after |

So the video over the HUD is the **map's load cinematic outliving the load** (`ui_autoContinue 1`
drops the loadscreen while the Bink keeps playing), not the startup intro. gate2 proved refusing
only `*_load.bik` is not enough: the engine falls back to `main\video\default.bik`, which then
played 10 s, 7 s into the game.

**The code** (`client-dll/components/connect_local.cpp`):
- IAT wraps of `_BinkOpen@8` (slot `0x7EB42C`) and `_BinkClose@4` (`0x7EB418`); `binkw32.def` is
  untouched (generated). Sole BinkOpen caller `0x6EB3B0`; flags `0x04104400` = from fastfile memory
  (`0x6EB42E`), `0x01104400` = from a path (`0x6EB47E`). NULL is handled by the engine (above).
- Gate, on the frame tick: menu up (first memory Bink, or 6 s) AND no **file** Bink open AND
  `clc.state [0x305842C] != 1` (1 = CA_CINEMATIC, written at `0x46F296` by the `cinematic` player
  `0x46F170`) for 750 ms, floor 2 s after `post_init`, ceiling 30 s with a WARN. Menu idle state
  measured as `clc.state = 2`.
- For an armed join only: refuse `*_load.bik`, and `default.bik` for 60 s after our connect
  (`ENW_ALLOW_LOAD_VIDEO=1` restores both). Always: refuse a path containing `Treyarch`
  (`ENW_ALLOW_INTRO=1`).

**Why the intro "still plays" despite `com_introPlayed 1` — answered statically, and the runs agree:
it does not.** Com_Init (`0x59CEB0`) queues `cinematic Treyarch\n` (`0x872584`) at `0x59D684` only if
`com_startupIntroPlayed` (dvar ptr `0x1F96494`) is 0; the cinematic player skips `Treyarch` when
`com_introPlayed` (`0x1F964A4`) is 1 and `fs_game` is set. The profile config also has both at 1.
Nothing in `mods/enw` resets them (the folder ships empty). The Treyarch refusal is a belt only.

**UNPROVEN**: B's own machine (2560x1440, 250 fps) on 0.2.8; the Hunk failure. `11059216 - 16 =
2560*1440*3` — a screen-sized RGB buffer, not a Bink frame; inference only that it came from the
video/load overlap. The 30 s ceiling path runs only if the menu never shows a video and never idles.
B's check: join a box game on 0.2.8 — no cinematic after the loadscreen; the DLL log shows
`connect_local: gate OPEN` and `bink: REFUSED the load video`.

---

## 8. 2026-09-22, evening — World at War's Options menus on the site: the dvar table

B: *"Have the settings page allow you to make it look like the game's World at War settings menu,
with all the exact same settings, and make sure they all map properly and work properly."*
The page is `web/client/src/pages/Settings.jsx` (`/settings`, and the account menu's **Settings**
inside the launcher); `web.md` has the site half. This section is the dvar table and where each
row came from, because "the exact same settings" is a claim about the game, not about us.

### 8a. Where the list comes from — read out of the game, not remembered

The stock PC menus are compiled into `zone/english/ui.ff`. Read-only, out of the copy in
`ZombiesDev\waw-base` (nothing written back; the Steam install untouched): the file is a 12-byte
`IWffu100` header and one zlib stream (41,475,998 bytes inflated). Each menu's items survive as data:
the dvar name, the label's localize key, and — for a list item — the `multiDef_s` table (32 label
pointers, 32 string pointers, 32 floats, count, strDef), so the **values** each label writes are
read off the table rather than guessed. Sliders carry an `editFieldDef` (min, max, default).
Menus read: `options_graphics`, `options_graphics_texture`, `options_sound`, `options_game`,
`options_look`, `options_move`, `options_shoot`, `options_misc`, `options_control_defaults`,
`options_graphics_defaults`.

Also used, from `main/iw_00.iwd` and `localized_english_iw00.iwd`: `options_graphics_set.cfg`
(every `ui_r_*` shadow dvar → its real `r_*`), `configure.cfg` (stock graphics values),
`default_controls.cfg` (stock binds and mouse dvars — exactly what the menu's *Set Default Controls*
execs, per `options_control_defaults`). Every dvar below was then found by name in the decrypted
1.7 image (`ZombiesDev\dumps\codwaw-1.7-a.exe`), and so was the `reset` command and `setRecommended`.

### 8b. The table

*Carried* = where the launcher puts it. *Tested* = `launcher/test/waw-settings.js` shows the value
saved by the page reaching the `+set` list and/or the merged `config.cfg`; the whitelist test there
covers every row's values. *Dev port* = saved through the real page on `:3437` and read back out of a
launch dry run; *bridge* = clicked on the page inside the launcher's real preload (web.md).
**In game = UNPROVEN for every row** — nobody launched the game for this (B was playing; §8d is the
one-minute check).

| Menu | Item | dvar / command | Values the menu writes | Game default | Carried |
|---|---|---|---|---|---|
| Graphics | Video Mode | `r_mode` (via `ui_r_mode`) | `WxH` | 800x600 (image) | existing `resolution`; tested |
| Graphics | Screen Refresh Rate | `r_displayRefresh` (via `ui_r_displayRefresh`) | `"N Hz"` | engine | `waw` |
| Graphics | Aspect Ratio | `r_aspectRatio` | auto / standard / wide 16:10 / wide 16:9 | auto (configure.cfg) | `waw` |
| Graphics | Anti-Aliasing | `r_aaSamples` (via `ui_r_aasamples`) | Off=1, 2x=2, 4x=4 | recommended → `reset` | `waw` |
| Graphics | Brightness | `r_gamma` | 0.5–3 | 1 | `waw`; tested |
| Graphics | Sync Every Frame | `r_vsync` (via `ui_r_vsync`) | 0/1 | 0 (configure.cfg) | existing `vsync`; tested |
| Graphics | Optimize for Dual Video Cards | `r_multiGpu` | 0/1 | 0 (ENW baseline 1) | `waw` |
| Graphics | Shadows | `sm_enable` | 0/1 | recommended → `reset` (ENW 1) | `waw`; tested (reset) |
| Graphics | Specular Map | `r_specular` | 0/1 | recommended → `reset` | `waw` |
| Graphics | Ocean Simulation | `r_gfxopt_water_simulation` | 0/1 | 1 | `waw` |
| Graphics | Dynamic Foliage | `r_gfxopt_dynamic_foliage` | 0/1 | 1 | `waw` |
| Graphics | Bullet Impacts | `fx_marks` | 0/1 | 1 | `waw` |
| Graphics | Number of Corpses | `ai_corpseCount` | Tiny 3, Small 5, Medium 10, Large 20, Insane 32 | 5 | `waw`; tested, dev port |
| Texture | Texture Mipmaps | `r_texFilterMipMode` | Unchanged / Force Bilinear / Force Trilinear | Unchanged | `waw`; tested, dev port |
| Texture | Texture Anisotropy | `r_texFilterAnisoMin` | 1–16 | 1 (ENW 16) | `waw`; tested |
| Texture | Texture Quality | `r_picmip_manual` | Automatic 0 / Manual 1 | 0 | `waw` |
| Texture | Texture Resolution | `r_picmip` | Low 3, Normal 2, High 1, Extra 0 | recommended (ENW 0) | `waw` |
| Texture | Normal Map Resolution | `r_picmip_bump` | as above | recommended (ENW 0) | `waw` |
| Texture | Specular Map Resolution | `r_picmip_spec` | as above | recommended (ENW 0) | `waw` |
| Sound | Master / Voice / Music / Effects / Cinematics Volume | `snd_menu_master`, `snd_menu_voice`, `snd_menu_music`, `snd_menu_sfx`, `snd_cinematicVolumeScale` | 0–1 | 1 each | `waw`; master tested |
| Sound | Line of Sight Occlusion | `snd_losOcclusion` | No 0 / Yes 1 | 1 | `waw`; bridge |
| Game | Mature Content | `cg_mature` (+ `cg_blood 1` on Unrestricted) | Unrestricted 1 / Reduced 0 | 1 | `waw`; tested |
| Game | Enable Console | `monkeytoy` | Yes 0 / No 1 | recommended → `reset` | `waw` |
| Game | Subtitles | `cg_subtitles` | 0/1 | 0 | `waw`; read-back tested |
| Game | Draw HUD | `hud_enable` | 0/1 | 1 | `waw` |
| Game | Enable Crosshair | `cg_drawCrosshair` | 0/1 | 1 | `waw` |
| Look | Invert Mouse | `ui_mousePitch` + `m_pitch` ±0.022 | 0/1 | 0 / 0.022 | `waw`; tested |
| Look | Free Look | `cl_freelook` | 0/1 | 1 | `waw` |
| Look | Smooth Mouse | `m_filter` | 0/1 | 0 | `waw` |
| Look | Mouse Sensitivity | `sensitivity` | 1–30 | 5 | existing `sensitivity`; tested |
| Look / Move / Combat / Interact | 41 key rows | `bind <KEY> "<command>"`, two keys each | — | `default_controls.cfg` (ADS hold: ENW) | `wawBinds`; tested (rebind, release, read-back), dev port |
| ENW | Display Mode | `r_fullscreen` + the DLL's borderless | borderless / fullscreen / windowed | borderless | existing `mode`; tested |
| ENW | Monitor, Field of View, Max FPS, Show FPS | `r_monitor` + `vid_xpos/ypos`, `cg_fov`, `com_maxfps` (≤250), `cg_drawFPS` | — | primary, 80, 250, Off | existing keys; fov/maxFps/showFps tested, fov dev port |
| ENW | Raw Mouse Input | env `ENW_RAW_MOUSE=0` when off | on/off | on | new `rawMouse`; source-contract test |
| ENW | Depth of Field, Glow | `r_dof_enable`, `r_glow_allowed` | 0/1 | 1, recommended | `waw` — **not in WaW's menus**; archived engine dvars, labelled as ENW extras |

"Recommended → `reset`": the graphics-defaults page runs `uiScript setRecommended`, which is
hardware-dependent. For those rows *Reset to game defaults* writes the engine's own `reset <dvar>`
(the game's `dvar_defaults.cfg` uses it) into `config.cfg` and takes the dvar off the command line,
instead of inventing a number. That `reset` in `config.cfg` does what it should is **unproven**.
`ai_corpseCount` is the one row matching the launcher's "gameplay dvar" pattern (`ai_`); it is
corpse clean-up, a Graphics-menu item, and the test allows exactly it.

**2026-09-22, late:** the page's *presentation* changed (Gaff-style tabs and small sections,
`web.md` last section; `web/client/src/data/settingsLayout.js` places the rows). This table is still
exactly what each row writes — no mapping changed, and `web/test/run-all.js` checks every item is
still on the page once.

### 8c. Not mapped, and why

* **Speaker Configuration** (Stereo / 5.1 / 7.1) — driven through `ui_outputConfig` and engine
  visibility expressions not decoded; forcing it is PCGW's way to break sound.
* **Voice chat, Multiplayer, Co-op option pages** — Activision's online options; ENW does not use them.
* **Chat keys** (`chatmodepublic`, `+talk`) and **`weapprev`** — bound in `default_controls.cfg`, not
  items in any Options menu.
* **Set Recommended / Apply** buttons — engine UI scripts; the launcher applies at the next launch.
* **Mature: Reduced** writes `cg_mature 0` only. Unrestricted's script (`cg_mature 1; cg_blood 1`) is
  in ui.ff; Reduced opens `mature_content_pc_disable_warning`, whose body is not, so `cg_blood` is
  left alone rather than guessed.
* **Fullscreen and FOV are not in WaW's PC menus at all** (no `cg_fov`, no `r_fullscreen` item in
  ui.ff) — they are ENW knobs on the ENW tab. So `launcher.md`'s "80 is the top of the in-game
  slider" (the launch-baseline table) is wrong: there is no in-game FOV slider. Left in place,
  corrected here.

### 8d. The one-minute proof B does (in game)

1. On `/settings` (in the launcher: account menu → Settings): Graphics → Number of Corpses
   **Insane**; Texture Settings → Texture Mipmaps **Trilinear**; Move → Forward alternate **I**.
2. Press Play. `launcher.log` has `applied N account settings … to …\players\profiles\<p>\config.cfg`.
3. In game: Options → Graphics reads *Insane*, Texture Settings reads *Trilinear*, Controls → Move
   shows *W* and *I* for Forward. Console `/ai_corpseCount` → 32.
4. In game set Subtitles **Yes**, quit. `/settings` → Game Options shows Subtitles *Yes* (the
   post-exit read-back → launcher → site sync).

---

## 9. 2026-09-22, evening — the in-game chat overlay (`components/chat_overlay.cpp`)

Built and proven in the running game; the full write-up, the address table and every run are in
**`chat-overlay.md` §9**. What this lane's code now contains:

| File | What |
|---|---|
| `components/chat_overlay.cpp` | The overlay. Retargets the one `call CG_Draw2D` at `0x4628AB` (inside `CG_DrawActiveFrame` `0x4621E0`) to draw after the HUD with the engine's own `UI_DrawText` `0x5B5FB0` / `R_AddCmdDrawStretchPic` `0x6F58E0` / `R_TextWidth` `0x6E8DA0`, in the 640x480 virtual space of `scrPlaceView` `0x957318`, at WaW's own chat anchor (`cg_hudChatPosition`). WinHTTP to `/api/game-chat/*`; the pause keys `enw_ui`/`enw_pchat` through `setu`. Byte-checks all of it and turns itself off on a mismatch. Off: `ENW_CHAT_OVERLAY=0`. |
| `components/input_gate.hpp` | How a second consumer gets the game window's messages **without a second subclass**: a filter `mouse_polling`'s one WndProc calls first, a *captured* state (no motion, no buttons to the engine, NOLEGACY off, no recentre), and `send_to_engine()`. |
| `components/mouse_polling.cpp` | Implements the gate. With `ENW_RAW_MOUSE=0` it now installs the subclass and the `IN_MouseMove` retarget in **passthrough** mode (hand straight to the engine) so the overlay still works; `ENW_CHAT_OVERLAY=0` too and nothing is installed. |
| `components/chat_link.hpp` + `auth_token.cpp` | The launcher's one-shot token pipe now also carries `chat: {base, bearer}` (and may carry it without an invite token, for Play Local). Dev fallback `ENW_CHAT_BASE`/`ENW_CHAT_BEARER`. |
| `components/frame_capture.cpp` | Test instrument, off unless `ENW_FRAME_CAPTURE=1` or `ENW_CHAT_SELFTEST`: swaps the `Present` of `dx.device` `[0x3BF3B08]` and of its swap chain (vtable slots 17 and 3; the device's alone never fired — T4 presents through the swap chain) to save the back buffer as .bmp on request. Works off-screen and in exclusive mode, where `screenshotJPEG` refuses ("game window is partially off-screen"). |

**Corrections to the address map** this lane found on the way (`docs/re/t4-sp-map.md` updated):
`0x6F5F10` is `R_AddCmdDrawText` (render command 0xD), not a server command; `0x4388A0` is
`CG_Draw2D`, `0x4621E0` is `CG_DrawActiveFrame`, `0x473F10` is `Con_DrawSay` (the stock "Say:"
field), `0x436900` is `CG_DrawChat`. World at War's whole MP chat HUD is still in the SP exe.

Harness rules learned tonight (both cost B a disturbed screen): a test window at the desktop's own
size, or `ENW_BORDERLESS=1` with the default *cover the monitor*, ends up on B's screen and fights
`launch.ps1`'s 700 ms park loop. Test below desktop size, set `ENW_BORDERLESS_COVER=0`, and never
exclusive fullscreen while B is at the PC.

No DLL version constant exists to bump; `stage-client.js`'s gate is the build's mtime against the
sources, so a fresh build of `build/client-lane` (or whichever build the coordinator ships) is what
makes it stageable.

### 9a. Round 2 (2026-09-22, late) — B used 0.2.12: "you can move your mouse but can't click the tabs"

Cause: the overlay drew WaW's UI cursor from its top-left at the pointer, but the engine draws it
**centred** (`0x5B6970`, `x - 32*0.5`), so the visible tip was 16 virtual units (48 px at 1440p)
off the real hot spot. Clicks were arriving and hit-testing fine. Fixed, plus a real text box
(selection, word/line clicks, Ctrl+A/C/X/V on `CF_UNICODETEXT`, Up/Down recall), selectable
history, a tab per DM conversation, name-click and `/w` `/r`, hover. Proven by logged
click → target lines at 1280x720 windowed and 2560x1440 borderless: `chat-overlay.md` §10.

New harness switch **`ENW_TEST_NO_ACTIVATE=1`** (`components/test_no_activate.cpp`): the engine's
windows are created `WS_EX_NOACTIVATE`, its startup `ShowWindow(SW_SHOW)` becomes
`SW_SHOWNOACTIVATE` and `SetFocus` is a no-op (IAT slots `CreateWindowExA` / `ShowWindow` /
`SetFocus`). With it a test game never takes the foreground from the person at the PC (0 of 129
samples foreground, both round-2 runs). Never set by the launcher.

### 9b. Round 3 (2026-09-23) — Esc on a box, and holding the clock through a pause

`chat-overlay.md` §11. Three fixes, each measured in a local dedi + client join:
* `connect_local.cpp`: a refused load video left its name pending at `0x3DB3D40`, which makes
  CL_KeyEvent ignore Esc for the whole game (`cg_cinematicFullscreen`). The engine's own stop
  (`0x6EBE20`) now clears it once the map is live.
* `chat_overlay.cpp`: the Esc menu's `cl_paused 1` paused only a remote client and stopped it sending
  `enw_ui paused`; with no local server it is set back to 0 (`Dvar_SetIntByName` `0x5EF930`).
* `chat_overlay.cpp` `pause_hold`: while snapshots arrive with a held serverTime, `cl.serverTimeDelta`
  is pinned so the client clock stands still, and set once on resume so it continues without a jump.
  `ENW_PAUSE_HOLD=0` reverts.

