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

## 1f. 2026-09-23 — the WOW64 raw-buffer bug, a harness that works, and the 1 kHz numbers (lane 17)

B's mouse is set to **1000 Hz**, not 8 kHz. The stutter is at 1 kHz. Branch
`worktree-agent-a5c23903ea0e7949a`. The raw-input design is still iw4x-client's `RawMouse` (§1b).
This section adds one bug fix and the instruments that go with it.

### The bug (fixed in `30d09a4`, proven)

`GetRawInputBuffer` in a 32-bit process on 64-bit Windows lays each block out with the **64-bit**
`RAWINPUTHEADER` (24 bytes), so the `RAWMOUSE` starts at +24. `drain_raw_buffer()` read
`ri->data.mouse`, which is at +16 (the 32-bit header). From 0.2.3 to 0.2.20, every report that
came through the buffered read (7–47 % of B's reports) was read 8 bytes early. With the game in the
foreground, `wParam` is `RIM_INPUT` = 0, so the bad read gives zero motion and zero buttons. The
turn simply loses those reports. The same layout also turns a click or wheel in a buffered report
into a yaw: `lLastX` lands on the real `ulButtons`. A wheel notch comes out as 0x00780400 counts.
That part follows from the layout and has not been seen in play. The proof is `tools/dev/rawprobe`:
every injected move carries a `dwExtraInfo` marker, and the marker read back at **+16 0/2974** and
at **+24 2974/2974** (rerun after the merge: 0/4103 vs 2973/2973 injected). The same fix exists in
MSDN's `GetRawInputBuffer` remarks and SDL3's `WIN_PollRawInput`. The code is in
`components/raw_buffer.hpp`, which picks the offset with `IsWow64Process`.
`ENW_RAW_MOUSE_WOW64FIX=0` brings back the old read, for A/B only.

### The harness, and three traps it hit (each would have produced a wrong number)

`tools/dev/mousebench.ps1` runs one invisible game per arm (`ENW_TEST_NO_ACTIVATE=1`, off-screen,
private LocalAppData, `com_maxfps 250`, under `game.lock` via `launch.ps1`). `rawprobe inject` is a
1000 Hz `SendInput` mouse. `ENW_FRAMETIME=1` turns on the `frametime` and `mouse_jitter` lines.
Harness-only knob: `ENW_RAW_MOUSE_INPUTSINK=1` registers with `RIDEV_INPUTSINK`, holds
`g_wv.activeApp` at 1 (`IN_Frame` 0x5FA8A0 otherwise never calls `IN_MouseMove` for a
never-activated window) and skips the foreground check. The launcher never sets it.

1. **The injector was the stutter.** At normal priority with `Sleep(0)`, a running 250 fps game
   took its core for whole scheduler quanta: **41 % of reports more than 2 ms late, worst 345 ms**.
   Every harness number from before 11:53 on 2026-09-23 was measured against a lumpy source. It now
   spins at high priority (**0–0.07 % > 2 ms, worst 1.8–3.4 ms**) and prints its own pacing line.
   `-Sleep0` keeps the old loop.
2. **T4 calls `IN_MouseMove` twice per engine frame.** 2432 of 2432 frames had exactly 2 calls: one
   with the frame's counts, then one about 0.3 ms later that finds almost nothing. The first meter
   worked per call, so it scored every second call as a dropout. That was the "90–95 % jitter,
   70 % dropouts" of the first benches, and it is not a property of the input. The meter now adds
   up the calls and is fed once per engine frame. Its `dt` runs between the first calls of two
   frames, which is when the counts are sampled. `mouse_tests` has the case.
3. **B is at his PC.** Each arm starts only after 60–120 s of desktop idle
   (`GetLastInputInfo`). It never starts while a CoDWaW.exe outside `ZombiesDev` is running, and it
   queues on the lock again after the idle wait. `rawprobe inject` watches raw input with
   `RIDEV_INPUTSINK` and **stops on the first report from a real device** (exit 3, and it names the
   device). The bench then kills its own game and releases the lock. This fired 4 times today on
   B's mouse and keyboard, and it had no false positives on injected input.

### The numbers (synthetic 1000 Hz, `nazi_zombie_prototype`, 250 fps cap, 3 × 10 s windows while injecting)

Frame pacing and delivery, with the fix (default) and without it (`ENW_RAW_MOUSE_WOW64FIX=0`).
Bench `mousebench-20260923-120243.txt`, spin injector, logs `enw-25020` (fix) and `enw-29936`
(bug):

| arm | fps | p99 | max | sd | frames > 16.7 ms | counts to engine /s (injected 1000) | buffered reports /10 s → counts |
|---|---|---|---|---|---|---|---|
| **fix** | 241.5–242.3 | 12.00–12.50 ms | 14.8–15.1 ms | 1.81–1.86 ms | 0 | **994 / 996 / 901** | 1532–1715 → all of them |
| **bug** | 241.5–242.3 | 12.00–12.75 ms | 16.4–18.1 ms | 1.82–1.85 ms | 1 / 1 / 0 | **1479 / 1496 / 1389** | 1528–1729 → **0** |
| no input (same runs, windows 8–10) | 245–247 | 10.25–10.75 ms | 12.4–14.6 ms | 1.37–1.62 ms | 0 | — | — |

View-turn (delta) jitter, per-frame meter, fix arm (`enw-29884`, 12:22; the run was cut short when
B touched the keyboard, so this is one full 10 s window):

| arm | moving frames | jitter | p50 err | p99 err | dropouts | ideal-source floor (simulated) |
|---|---|---|---|---|---|---|
| fix | 2320 | **28.7 %** | 25 % | 163 % | 55 (2.4 %) | 13.1 % / p50 13 % |

How to read these numbers:

* **Frame pacing does not change with the fix at 1 kHz.** p99, sd and >16.7 ms are the same within
  run-to-run noise. The worst frame is 1–3 ms longer on the bug arm, which is not significant from
  three windows. Moving the mouse at 1 kHz costs about **1.5 ms on p99** (10.5 → 12.2 ms) against
  the same run's idle windows. Our code in `in_mousemove`, which includes the engine's
  `CL_MouseEvent` it calls, averages **~90–100 µs per call** while moving, against ~13 µs idle.
  There are two calls per frame, so that is about 5 % of a 4 ms frame.
* **Delivery does change.** With the fix, the engine gets the counts that were sent: 994 to 996 per
  second against 1000 sent, with the buffered ~17 % carrying their motion. Without the fix, the
  buffered reports carry 0 counts, and in this harness the engine got **~1.45×** the counts that
  were sent. That is wrong motion, not missing motion. The reason is a harness artefact: under
  `RIDEV_INPUTSINK`, `wParam` is 1, so the +16 read gives `usFlags = MOUSE_MOVE_ABSOLUTE`, and
  iw4x's `Update()` then zeroes `current`, so each such report is a snap back to position 0. In
  B's foreground game `wParam` is 0, so the same bug drops the report instead. **Nobody has
  measured the bug arm's per-frame jitter.** The time limit ended the run before it.
* **The fix arm's 28.7 % is about twice the floor.** An evenly paced 1 kHz source sampled at
  these frame times reads about 13 % from the whole-report quantisation alone (simulated from the
  logged frame times). Our guess is that the other ~15 points come from the frame's sampling
  instant (pump → first `IN_MouseMove`) moving within the frame. That is not proven.
* The `cadence` line's `WM_INPUT gaps` are **dispatch** times inside our WndProc. The pump runs
  once per frame, so they show the pump's cadence, not how evenly Windows delivered the reports.

### What B tests: three runs, one minute each, on his own screen at 1000 Hz

Build: this branch's DLL. Set `ENW_FRAMETIME=1` for all three runs. Turn steadily the whole minute
and flick a few times. Read `frametime: window`, `mouse_jitter: window N (…)` and
`mouse_jitter: window N cadence` from `%LOCALAPPDATA%\ENWZombies\logs\enw-<pid>.log`.

| run | environment | what it decides |
|---|---|---|
| 1 | `ENW_FRAMETIME=1` | the fix (default): buffered reports carry their motion |
| 2 | `ENW_FRAMETIME=1 ENW_RAW_MOUSE_WOW64FIX=0` | 0.2.3–0.2.20 exactly: buffered reports lost |
| 3 | `ENW_FRAMETIME=1 ENW_RAW_MOUSE_BUFFER=0` | no bulk read at all; every report via its `WM_INPUT` |

Run 1 should show `buffered N carrying ≈N counts` and fewer `DROPOUTS` than run 2. Run 2 should show
`buffered N carrying 0 counts`. The verdict is **B's feel plus the dropouts and jitter figures**,
not the frame times, which the fix does not move. If runs 1 and 3 feel the same and both beat
run 2, the stutter B felt was lost reports, and this closes it. If run 1 still stutters, the next
suspect is the sampling-instant jitter above, then DWM (next section).

### Still unproven

* Whether the fix removes the stutter **B feels**. No human hand has been on the mouse with this
  build.
* Anything that needs a visible window: DWM composition, the cursor, 250 fps against his panel,
  and the legacy `WM_MOUSEMOVE` path (legacy messages go to the window under the cursor, never an
  off-screen game).
* The per-frame jitter of the bug arm and of `ENW_RAW_MOUSE_BUFFER=0`, which the time limit cut.
  Also why the fix arm's jitter sits ~15 points above the quantisation floor.
* The snap-on-click/wheel in the old build. It follows from the layout; nobody has seen it in play.
* The abort's cursor restore is approximate with Windows pointer acceleration on.

## 1g. 2026-09-23: every downside of the fix and of NOLEGACY, and what pays for each (lane 17b)

B played 0.2.24. Frame time while moving the mouse is fine and he is happy with it. He asked for
every downside of the mouse fix and of the NOLEGACY mode, written down honestly, and for each one
to be fixed in code where code can fix it. Commit `0db25c9` is the code. The pure rules are in
`components/raw_mouse_model.hpp`, and `tools/dev/mouse_tests.cpp` tests them (12 new cases, all
pass). **B was playing the whole time, so no game was run.** Everything marked "unproven" below
waits for his next ordinary session. `rawprobe` was not run either: every mode of it injects
`SendInput` motion, and that would have moved B's own cursor.

Reuse: the WOW64 block layout, the 8-byte stride, `ERROR_INSUFFICIENT_BUFFER` counting as a buffer
problem and not a dead API, and absolute reports mapped to desktop pixels all come from SDL3
(`WIN_PollRawInput`, `WIN_HandleRawMouseInput` in `src/video/windows/SDL_windowsevents.c`). The
clip-on-capture and release-on-focus-loss shape comes from iw4x-client `RawMouse.cpp` (it clips
after `CL_MouseEvent` returns true and calls `ClipCursor(NULL)` in the menu and on kill-focus). The
pointer-speed table is the standard SPI_GETMOUSESPEED one.

Facts read out of the dump today. They are the evidence for rows below.

* **`CL_MouseEvent` (0x63D9A0) only adds** the deltas to `cl.mouseDx/Dy[index]`
  (`add [eax*4+0x307D650], edx`, `add [eax*4+0x307D658], ecx`) and returns 1. In a UI (keyCatchers
  & 0x10) it hands the client **x,y** to 0x5BB4F0 and returns 0. `sensitivity`, `m_filter`,
  `cl_mouseAccel`, `m_pitch` / `ui_mousePitch` and invert are all applied after this point. They
  see the same numbers as in the stock path, and two calls per frame add up.
* **The WM_MOUSEWHEEL handler (0x60706B) queues one `K_MWHEELUP` (0xCE) or `K_MWHEELDOWN` (0xCD)
  down+up per message.** Delta > 0 is up. Delta ≤ 0 is down, and that includes 0. A wheel is an
  event, not a state, so the mask-differ argument that makes duplicate button messages harmless
  does not apply to it.
* `IN_Frame` has three callers (0x4625DC, 0x59E1B2, 0x644A3C). At 0x4625DC it runs just before
  0x63E940. `Com_EventLoop` is called at 0x5AA578 and 0x5AA5A0.

### The table

Severity describes this player on this setup: 1000 Hz, 2560x1440 borderless, a second monitor.

| # | Downside | Severity | Evidence | Compensation (code) | Proven? |
|---|---|---|---|---|---|
| D1 | **Double wheel notch** whenever legacy messages are on: the stock menus, the console, the frame of a flip, all of `ENW_RAW_MOUSE_NOLEGACY=0`. We synthesised the raw notch and also forwarded Windows' legacy twin. A real bug since 0.2.3 | **High** in menus (scrolls 2 per notch). In gameplay it only happens with NOLEGACY=0 or a wheel bind on the flip frame | 0x60706B read above, plus `apply_raw_buttons` in every mode | A **wheel ledger** pairs the twins. Whichever twin arrives first is delivered and the other is swallowed (3-frame TTL). A legacy notch with no raw twin (touchpad) is delivered. A zero delta is never synthesised | Rule: unit tests (the old path gives 10 for 5 notches, the new one 5; burst, twin-first, touchpad, expiry). **In game: unproven.** `ENW_INPUT_TRACE=1` now prints a `WHEEL … engine QUEUED … PERFECT/DOUBLED` verdict read from the engine's own event ring |
| D13 | **`ENW_RAW_MOUSE_BUTTONS=0` left gameplay with no clicks and no wheel.** NOLEGACY means no legacy button messages, and with the tracker off nothing synthesised them | High, for that A/B knob only | Code read | BUTTONS=0 now implies NOLEGACY=0, with a WARN line | Code read. Not run |
| D2 | The **`WOW64FIX=0` A/B arm** reproduces the old +16 read. A buffered wheel notch reads as lLastX = 0x00780400 (a random ~7.8 M-count spin), and a click as a 1–2 count nudge | High in that arm | Layout arithmetic, unit test | Any relative delta outside ±32767 (a HID axis is 16 bits) throws away the **whole report**: motion and buttons, counted and logged. The arm still loses buffered motion, which is what it is for | Unit test (the misread wheel is refused, a real ±32767 passes) |
| D3 | The buffered offset depended only on `IsWow64Process`. A different layout would have turned clicks into yaw again | Low (the layout on this box is proven, §1f) | §1f | The offset now also comes from the block's own `dwSize` (40 → +16, 48 → +24). An unknown size is skipped, not guessed. On WOW64 the step to the next block rounds to 8, not 4 (the 64-bit side's alignment), and the buffer is `alignas(8)` (it only happened to be aligned before) | Unit tests (40/48/44/0, stride 41 → 48 vs 44, a wheel block parsed by size) |
| D4 | A click that landed in the **buffered** queue (17–47 % of B's reports) was synthesised in `IN_Frame`, outside `Com_EventLoop`. So it could reach the usercmd **up to one frame later** than a dispatched click: 4 ms at 250 fps, 50 ms at 20 fps. Motion is not affected (`CL_MouseEvent` is called directly) | Low–Medium, and worse at low fps | Call order read above. **Not measured** | **The pump drain.** After `GetRawInputData` for the dispatched event, `OnRawInput` now also calls `GetRawInputBuffer`. That is MSDN's whole pattern, and SDL's is the same idea. Buffered clicks now enter the ring while the event loop is running. It also means *fewer* `WM_INPUT` dispatches, because whatever it drains is never dispatched. A re-entrancy guard protects the static buffer. `ENW_RAW_MOUSE_PUMP_DRAIN=0` reverts | **Unproven**: latency and frame-time effect. The `compensations` line counts `pump drains … carrying N reports` |
| — | **Is a click delivered exactly once** (never dropped, never doubled), buffered or dispatched, in either mode? | — | §6 state machine | None needed. It now runs through the same code as the tests (`apply_transition`, `rewrite_low_word`, `decode_button_flags` moved into the header unchanged) | Unit tests against a model of the engine's differ: NOLEGACY buffered, legacy twin before and after raw, the first click ever, down+up in one report, stale-mask moves (§6b arm C). The engine side was proven in §6b for the legacy path only |
| — | **Duplicate delivery** between the dispatched `WM_INPUT` and the buffer | none found | `GetMessage` removes the dispatched event from the buffered queue (MSDN). §1f's counts, 994–996 to the engine per 1000 injected, show no doubling | Both paths now share one `consume_mouse()`, so every guard covers both | Counts in §1f (harness) |
| — | **Report order across the two `IN_MouseMove` calls per frame** | none found | One accumulator, filled in consumption order (FIFO). `CL_MouseEvent` adds, it does not overwrite (0x63D9F9) | — | Code read + dump read |
| D5 | Any `GetRawInputBuffer` -1 turned the bulk read off for the session, including `ERROR_INSUFFICIENT_BUFFER` | Low | Code read. SDL3 grows and retries | Insufficient-buffer skips only this frame's bulk read (the report stays queued and its own `WM_INPUT` delivers it). Other errors must happen 3 times in a row before the bulk read is off | Unit test of the policy |
| D6 | **A lost or stale clip was never noticed.** UAC, Ctrl+Alt+Del, Win+L, another program's `ClipCursor(NULL)`, `borderless` or `vid_restart` moving the window: `g_cursor_clipped` stayed true | **Medium** with a second monitor: the cursor can walk off, and a click there activates the other window | Code read | While clipped, every 8th call checks `GetClipCursor` against the client rect (2 px slack for DPI virtualisation) and re-applies if it differs. Counted and logged | Rule: unit tests. **In game: unproven** (`clip re-applied N`) |
| D7 | With the recentre skipped, an OS cursor that Windows still moves **parks at the clip edge**. One lost clip later it is on the other screen | Medium (the same setup) | Code read | When the cursor leaves the middle half of the client rect, recentre **once** with the engine's own `IN_RecenterMouse`. That is every few hundred pixels of pointer travel, not every frame | Rule: unit tests. **Whether Windows moves the cursor under NOLEGACY at all is unknown.** The docs are ambiguous, and `edge recentres 0` in B's log after a session of turning would mean it does not |
| D8 | The stock menu, the ENW Esc menu and the chat opened with the pointer **wherever it drifted** (the stock path recentred every frame, so stock menus opened centred) | Low, cosmetic | `CL_MouseEvent`'s UI branch takes client x,y | One recentre when `CL_MouseEvent` hands the mouse to a UI, and when `input_gate::set_captured(true)` opens our overlay while NOLEGACY is on. Not on focus loss (never move the desktop cursor while the player alt-tabs). Never in the harness sink | **Unproven** (`menu recentres N`) |
| D9 | Registration is one entry per usage **per process**, and the last registration wins silently. If another module replaces or removes ours, NOLEGACY means a **dead mouse**, not a degraded one | Medium (probability unknown) | Win32 semantics | `GetRegisteredRawInputDevices` once a second. If the entry is not (our hwnd, our NOLEGACY bit), it is re-registered, at most 5 times. After that it gives up and goes to the **stock `GetCursorPos` path** (subclass stays in passthrough for the chat gate) and logs an ERROR | Rule: unit tests. Not seen in play |
| D10 | `GetRawInputBuffer` drains the **thread's** whole raw queue, so another module's keyboard/HID raw input delivered to our thread was eaten and dropped | Low (nothing we know registers today) | Win32 semantics | The first non-mouse block in our drain turns the bulk read off (NOLEGACY stays). A foreign registration is logged once. It is not acted on until its reports actually show up, so a harmless overlay does not cost everyone the bulk read | Rule: unit test. Not seen in play |
| D11 | **Absolute devices** (RDP, VMs, pen tablets, some remote-play tools): upstream took the 0..65535 coordinate as counts, about **25×** the sensitivity of the same movement in pixels on a 2560-wide desktop, with a jump when switching device. The relative accumulator also grew for ever and was an `int` | Low for B, high for those users | Code read | SDL3's mapping to desktop pixels (`MOUSE_VIRTUAL_DESKTOP` → `SM_*VIRTUALSCREEN`). The first absolute report after relative ones moves by 0. The relative accumulator is rebased every frame | Unit tests |
| D12 | **Sensitivity matches stock only at Windows pointer speed 10/20 with Enhance Pointer Precision off.** The stock path inherited the slider factor and the EPP curve, and raw input sees neither | Medium for anyone with a non-default slider or EPP on. None for B if he is at 10/20 with EPP off | Stock deltas are `GetCursorPos` differences | Startup line: `Windows pointer speed N/20 (xK), Enhance pointer precision on/off` with a plain verdict. `ENW_RAW_MOUSE_WINSPEED=1` (opt-in) scales counts by the slider factor with the remainder carried, so nothing is lost to rounding. The EPP curve is deliberately not emulated: removing it is the point of raw input | Unit tests (table, carry). The log line shows B's own values |
| — | **Alt-tab / another window / minimise** | handled | §6c/§6d: `WM_KILLFOCUS` and `WM_ACTIVATE(inactive)` unclip, put legacy back and release all buttons. `WM_SETFOCUS` resyncs and drops the first delta (upstream's anti-snap) | unchanged. The first report after regaining focus is discarded on purpose | Proven in §6b's run (forced release at 77055 ms) |
| — | **In-process overlays** (the Steam overlay, the old Discord overlay) may read legacy messages and get no mouse while NOLEGACY is on. Out-of-process overlays (the new Discord one) take focus and fall into the alt-tab row | unknown | none | none possible without their API. `ENW_RAW_MOUSE_NOLEGACY=0` is the workaround | **Unproven** |
| — | **Menus still get the flood** (legacy + `WM_INPUT` per report), because legacy is on there | Low (menus only) | design | none. The menu needs the legacy cursor, and unregistering raw in menus would blind the button tracker | — |
| — | **8 kHz / overflow.** 512 blocks per call and the loop repeats, which covers about 4 frames at 8 kHz / 250 fps or ~1 at 20 fps. The OS raw-queue limit is undocumented. After a long hitch the whole backlog arrives as one frame's turn. That is real motion, which the stock path would have clamped at the screen edge | Low | design | none (it is the player's actual movement) | **Unproven** at 8 kHz on B's hardware. B is at 1 kHz |
| — | **Hi-res wheels** (`usButtonData` < 120): each report is one notch | parity | 0x60706B | none. Stock's legacy messages behave the same | — |
| — | **Precision-touchpad scroll in gameplay** under NOLEGACY (touchpads are legacy-only, no raw wheel) | Low | Win32 | none possible. It works in the menus through the legacy path and the ledger | **Unproven** |
| — | **20–250 fps.** Only D4 (latency) and the wheel TTL (3 frames = 12 ms at 250, 150 ms at 20) depend on frame rate | Low | design | D4 | — |
| — | **Game hangs with the clip on**: the cursor is trapped in the window until alt-tab | Low | design | none new | — |
| — | **Cost of the compensations** | unmeasured | — | `GetClipCursor` every 8th call. Registration check once a second. The pump drain replaces dispatches with one bulk read. `ENW_RAW_MOUSE_PUMP_DRAIN=0` is the A/B | **Partly measured (P1, 2026-09-23 14:24):** p99 6.25 ms at ~249 fps with the drain on and off (B's real mouse, not the synthetic one; see "Still unproven" below) |

### Every switch, so B can A/B

| env | what it does now |
|---|---|
| `ENW_RAW_MOUSE=0` | the stock `GetCursorPos` path, and no raw input at all. The subclass stays in passthrough only for the chat/Esc gate |
| `ENW_RAW_MOUSE_NOLEGACY=0` | legacy messages kept, per-frame recentre, no clip. This is 0.2.2's flood, but with the wheel fixed (D1) |
| `ENW_RAW_MOUSE_BUFFER=0` | no bulk read. Every report comes through its own `WM_INPUT` (and so no pump drain either) |
| `ENW_RAW_MOUSE_WOW64FIX=0` | the 0.2.3–0.2.20 +16 read (buffered motion lost), now without the wheel-spin hazard (D2) |
| `ENW_RAW_MOUSE_PUMP_DRAIN=0` | **new**: 0.2.24's drain placement (IN_Frame only) |
| `ENW_RAW_MOUSE_BUTTONS=0` | tracker off. **Now implies NOLEGACY=0** (D13) |
| `ENW_RAW_MOUSE_WINSPEED=1` | **new, opt-in**: scale by the Windows pointer-speed factor |
| `ENW_INPUT_TRACE=1` | per-button verdicts, and now a **WHEEL** verdict too |

### What B reads after his next session (any session, no special run)

About every 15 s: `mouse_polling: compensations -- wheel raw … / legacy … / twins swallowed … |
impossible reports dropped … | bad blocks …, offset disagreements … | pump drains … carrying … |
GetRawInputBuffer transient …, hard failures … | clip re-applied … | edge recentres … | menu
recentres … | registration checks …, repairs … | foreign raw input … | absolute reports … | speed
x…`. Expected on B's box: `impossible`, `bad blocks`, `disagreements`, `repairs`, `foreign` and
`hard failures` all 0. `twins swallowed` ≈ the number of wheel notches he made in menus. `menu
recentres` ≈ the number of times he opened a menu. `edge recentres` > 0 means Windows does move the
cursor under NOLEGACY. `clip re-applied` > 0 is worth a look, because it means something outside
the game took the clip.

### Still unproven, because no game could run

* Everything in game: the wheel verdict, the pump drain's latency and cost, the clip re-apply and
  both recentres, and whether the Esc menu and the chat open centred.
  **→ Partly run by lane P1, 2026-09-23 14:24–14:28, on `974c2e8d`** (`p1m17d1` / `p1m17d0`,
  fear_mc_2, local dedi, INPUTSINK, 250 fps; `next-session.md` "Local proofs 2026-09-23
  afternoon"). **Proven:** the `compensations --` line runs in game every ~3.6 s. The pump drain
  works: `PUMP_DRAIN=1` logged `pump drains 1885 carrying 163 reports`, and `=0` logged 0. Every
  fault counter was 0 in both arms (impossible, bad blocks, disagreements, transient, hard
  failures, repairs, foreign, absolute). Frame p99 was **6.25 ms** in every steady window in both
  arms. `=0` had two windows at 6.50/6.75 ms and 8 frames over 16.7 ms; `=1` had none after the
  load window. **Not a controlled A/B:** B was using his mouse, and the 1 kHz injector aborted
  both times (285 and 16,332 moves), so the input was mostly his. `clip re-applied`, `edge
  recentres` and `menu recentres` were 0, which means nothing here: an unfocused harness window
  never clips. They still need B's own session.
* Whether Windows moves the OS cursor under `RIDEV_NOLEGACY` (answered by `edge recentres`).
* Whether any in-process overlay loses the mouse under NOLEGACY.
* The 8 kHz and 20 fps behaviour on B's hardware.
* DPI virtualisation for a DPI-unaware `CoDWaW.exe` on a scaled display. The 2 px slack is a guess
  at the rounding, not a measurement.

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
| Graphics | Optimize for Dual Video Cards | `r_multiGpu` | 0/1 | 0 (ENW baseline 0 since 2026-09-23; was 1 — broke skinning, `mod-compat.md` §10.4) | `waw` |
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



---

## 10. 2026-09-23 ~01:30 — straight into zombies: no "Online Service Error", no main menu (`components/boot_direct.cpp`, branch `boot-direct`)

> Handoff note 03:30: merged (`340ea09`) and shipped in launcher 0.2.17.

B: *"When the game boots up, it first says 'can't connect to online servers' before connecting into
the game. Make it not show that — or not even show the main menu at all and not play the main menu
music."* Pictures: `ui/boot-before-2026-09-23.jpg`, `ui/boot-before-popup-1280x720.jpg`,
`ui/boot-before-menu-1280x720.jpg`, `ui/boot-after-2026-09-23.jpg` (the profile name in the menu's
top-right corner is blanked in all of them).

### 10a. What the popup is — PROVEN (static read + back-buffer captures)

It is the menu **`popup_cannot_connect_to_dw`**: title *Online Service Error*, text *Can not connect
to Online Service.*, one Ok button. It is the engine's Demonware log-on state machine answering the
DNS lookup our `net:` filter blocks:

| Addr | What |
|---|---|
| `0x5FC870` | DW log-on frame (runs while `dw_active` — "Pumps Live_Frame (and hence DW) if true", dvar ptr `0x46E5098`). State from `0x57BDA0`; state 2 = the auth DNS lookup `0x57C320` |
| `0x5FC951`/`0x5FC956` | lookup failed: prints *Failed to log on.* (`0x882670`), clears `dw_popup`, `mov eax,"popup_cannot_connect_to_dw"; call 0x5D7FD0` |
| `0x5FC9BA`/`0x5FC9BF` | sibling: `popup_cannot_connect_to_dw_create_offline_profile` |
| `0x5FDB10` | the `dw_popup` setter (dvar ptr `0x229A0E0`), name in EDI; opens the new one at **`0x5FDB57`** (`popup_connecting_dw`, `popup_dw_dns_lookup` — the "connecting…" boxes that precede it) |
| `0x5D7FD0` | open menu by name: EAX = name; `Menus_FindByName(uiContext 0x208E920)` `0x5C0200` + `Menus_Open` `0x5C5180`; preserves ECX; none of the three callers reads EAX after |
| `0x5D8000` | close menu by name (same shape) |

The log-on retries: in every "before" run the four popups were opened 16 times in the first ~0.2 s
(4× `popup_cannot_connect_to_dw`), and the capture at +3054 ms shows the box over the main menu.

**The fix**: the three rel32 call sites above are retargeted (byte-checked first: all three must
`call 0x5D7FD0` and `0x5D7FD0` must start `51 50 68 20 E9 08 02`, or nothing is touched) to a naked
thunk that refuses exactly those four names and jumps to `0x5D7FD0` for anything else. `0x5D7FD0`
itself is not hooked (it has other callers). The log-on machine is left alone: it still fails,
retries and prints *Failed to log on.* in the console; nothing is shown. Applies to every client
process (Play Local too). Off switch **`ENW_SHOW_ONLINE_WARNING=1`**: the thunk then passes every
name through and logs `let through menu '…'`, which is how the before runs name it.

### 10b. The direct boot — PROVEN against a local dedicated server

`connect_local`'s gate waited for the main menu's Bink + 750 ms + a 2 s floor (§7). Its reason — a
video over the HUD — was the map's load Bink, which is refused for a join anyway, and the Treyarch
intro never opens with our args. So the gate now asks `boot_direct::fire_now()` first (the only
change to `connect_local.cpp`, plus a `note_connect()` after the call): for an armed join it fires
on the **first frame tick after post_init** if no file video is open and `clc.state != 1`.
Measured: the first frame is the frame the menu's Bink opens (clc.state 2), and `CL_ConnectLocal`
works there — clc.state 2 → 4 → 5 → 7 → 6 → 9 → 10, the same sequence as before, just earlier.
`ENW_DIRECT_BOOT_MIN_FRAME=<n>` delays it (a measurement knob); **`ENW_DIRECT_BOOT=0`** restores the
old gate exactly.

**The one menu frame, and the black cover.** Our tick runs *after* frame 1's `Com_Frame`, which has
already built the main menu (text over black; its Bink background not drawn yet): `boot-after1`
captured it being presented once (~7 ms). So from the first tick until the connect has moved
clc.state to 5, the back buffer is `ColorFill`ed black at `Present` (device slot 17 and swap chain
slot 3; `frame_capture.cpp` found T4 presents through the swap chain). Measured: 2 frames painted,
then lifted. The load screen after it is black anyway (load video refused, `ui_autoContinue 1`).
Off switch `ENW_BOOT_COVER=0`.

**The mute.** Not `snd_volume`: **that dvar does not exist in this SP build.** At the first in-game
frame it is still the *external* dvar the command line's `+set` created (flags `0x4000`, tested by
Dvar_RegisterVariant's inner `0x5EEA20`; type byte `+0xA` = 7, string). The registered volumes are
the Options > Sound sliders, floats from the sound init `0x6B47C0` (`snd_menu_music` `0x6B4E18`,
`snd_menu_master` `0x6B4E6A`, through Dvar_RegisterFloat `0x5EEF10`, type 1). So the mute is
**`snd_menu_master`**, the one every dev harness already zeroes to keep test games silent. It is read
at the first frame tick (post_init runs inside Com_Init, *before* the command line's `+set`s execute
— `boot-after3` read the wrong value there), set to 0, and restored to the player's value at the
first in-game frame. While muted, the dvar's own archive bit (flags word `+8` bit 0, which the
config writer `0x59FAA0` tests; `Com_WriteConfiguration` is `0x59D8F0`) is held off, so a crash
mid-mute can never write the 0 into config.cfg (and from there into the account via the launcher's
read-back); it is given back after the restore. Nets: restore after 60 s without a game;
`pre_destroy` puts the value and the bit back. `boot-after6` (`+set snd_menu_master 0.003`, i.e.
inaudible): `muted (0.003 -> 0; type 1, flags 0x0001)` … `restoring to 0.003` … `0.003 again,
archive bit given back (flags 0x0001)`. Off switch `ENW_BOOT_MUTE=0`.

**Finding for the launcher lane:** `gamecfg.js` maps the account's *volume* to `snd_volume`, which
this exe never registers, so that setting does nothing in game. `snd_menu_master` is the master.

### 10c. Measured — process start → first in-game frame (clc.state 10), 1280x720 windowed

Local dedicated `waw-bootd` + client `waw-boot` (own copies), `nazi_zombie_prototype`, off-screen at
-4000,-4000, `ENW_TEST_NO_ACTIVATE=1`, `ENW_BORDERLESS_COVER=0`, `jointest.ps1 -ClientExtraArgs`
(new: extra `+set`s for the client only). Timestamps are the DLL's own, ms since process creation.
Logs: `ZombiesDev\logs\dedi\boot-*.client.enw.log`.

| run | mode | CL_ConnectLocal | first in-game frame |
|---|---|---|---|
| boot-before1 | old gate, captures on | +3549 | +6657 |
| boot-before-t1 | old gate | +2954 | **+5929** |
| boot-before-t2 | old gate | +2913 | **+5919** |
| boot-after1..6 | direct boot, captures on | +1739..+1904 | +4737..+4982 |
| boot-after-t1 | direct boot | +1895 | **+4965** |
| boot-after-t2 | direct boot | +1767 | **+4799** |

**About 1.0–1.1 s faster** (the menu wait); the load itself (connect → in game, ~3.0 s) is
unchanged. The picture fades in from black over the next ~1.5 s in both. Captures
(`ui/boot-after-2026-09-23.jpg`): every frame from the first is black until the map fades in; no
menu, no popup.

### 10d. NOT proven

* **Launcher Play → process start** is not in these numbers (seeding, config writes, spawn); the
  launcher itself was not used, only the dev harness with the launcher's join environment.
* **A box join** was not run: box leases are stopped (dedi.md §20) and the journal's idle line has
  been unreliable tonight; a local dedicated server stood in.
* **Audio**: nobody listened. The mute is proven only as dvar values in the log.
* **B's machine** (2560x1440, borderless, 250 fps): not run. The cover and the gate do not depend
  on size or mode, but that is an argument.
* The engine's **startup splash window** (`CoD Splash Screen`, before any frame) is unchanged and
  still shows for about a second.
* The first frame is still built by the engine and painted over at Present.

**Harness note (not fixed here):** without `ENW_USE_PRIVATE_LOCALAPPDATA=1`, `launch.ps1` lets a dev
game write the box owner's own `%LOCALAPPDATA%\Activision\CoDWaW\players\profiles\…\config.cfg` — it
was rewritten at 01:25:51 during these runs and carries the harness's `snd_menu_master "0"`.

Lock holds (one per run, server + client, released by `jointest.ps1`; each started only with no
CoDWaW process and no lock present): 01:04:08–01:05:10, 01:07:11–01:08:08, 01:10:29–01:11:21,
01:14:03–01:14:49, 01:14:49–01:15:35, 01:15:35–01:16:22, 01:16:22–01:17:08, 01:17:08–01:17:54,
01:19:00–01:19:47, 01:22:20–01:23:06, 01:24:56–01:25:42.


## 2026-09-23 — the ENW Esc menu (`components/pause_menu.cpp`), branch `esc-menu`

> Handoff note 03:30: merged (`c72190f`) and shipped in launcher 0.2.17.

B: *"Replace the escape menu with our custom menu: Resume, Restart game (tells the dedicated server
to restart), Exit game, the chat, and invites from your friends and friends online with what maps
they're on."* Built; the write-up, the restart contract and every run are in **`esc-menu.md`**.

| File | What |
|---|---|
| `components/pause_menu.cpp` + `.hpp` | All of the menu. Esc is taken in the gate filter before the engine's WndProc sees it, so World at War's pause menu never opens. Box games only (`clc.serverAddress.type` 0x300FFF8 != NA_LOOPBACK); `ENW_ESC_MENU=all` also Play Local, `=0` off. Draws with the overlay's engine calls in the 640x480 virtual space, right panel right-aligned on wide screens. Friends/invites from `GET /api/game-chat/menu/state` (10 s, only while open) over the chat pass. Restart = `setu enw_req restart.<n>` (two clicks). Exit = `POST /api/party/quit` (2 s cap) then `disconnect`, `quit`. Selftest `ENW_ESC_MENU_SELFTEST=1` (captures), `=2` (+ a real restart request), `=3` (Exit for real). |
| `components/chat_overlay.cpp` | **Only hook points, each marked `[esc-menu]`**: `pause_menu::filter()` first in the filter, `pause_menu::draw()` first in the draw hook, `report_ui_state` says `paused` while the menu is up (menu wins), `close_overlay` is a no-op while embedded, `draw_panel` takes the menu's anchor and hides its own close box and cursor while embedded; plus the `chat_embed` block at the end (open / close / draw_at / in_game / chat_open_alone). |

The pause contract is unchanged: the menu reports exactly what the stock Esc menu did (`enw_ui
paused`), measured on a dedicated server: `pause: PAUSED (solo_menu, 1 player(s))` on open,
`RESUMED ... no catch-up` on close (`esc-menu.md` §7).



## 2026-09-23 01:45 — custom maps: the stretched Reapers Colt, and a frame-capture timer (`mod-compat.md`)

B saw Minecraft Village's first-person Reapers Colt drawn as stretched polygons on a box join. **Not
reproduced** on a local dedi + client with byte-identical files, B's resolution and every renderer
dvar his config differs in, and the chat overlay open (`mod-compat.md` §1, pictures in `ui/`). Mod
files, add-on IWDs, fastfile order and settings are ruled out; the box server and B's own session
are not. **B's client has written no `console.log` since 2026-09-22 18:07** despite `+set logfile 2`
— the next report has no engine-side evidence until that is found.

New, test-only: `components/frame_capture_timer.cpp`. `ENW_FRAME_CAPTURE_AT="10,25,45"` asks
`frame_capture.cpp` for a back buffer that many seconds after `clc.state` first reaches 10;
`ENW_FRAME_CAPTURE_CMDS="7:closemenu briefing|30:+attack|31:-attack"` runs console commands on the
same clock through `Cbuf_AddText` 0x594200. Both need `ENW_FRAME_CAPTURE=1`. No hooks; a frame
subscriber. The stock `briefing` menu otherwise stays open on an off-screen client and the pause
lane freezes the world as `solo_menu`.

### 9c. Round 4 (2026-09-23) — the stock font, whatever the mod

`components/stock_font.cpp` (`chat-overlay.md` §12): the overlay and the Esc menu draw with World at
War's stock font even when a mod replaces `fonts/*` and the `gamefonts_pc` atlas (29 of 78 archived
mods do). Glyph tables are found in the font pool by SHA-256 (the in-place override moves the stock
header to a spare slot), the material by its name string lying in the `code_post_gfx` zone, and the
atlas is read from the player's own `main\*.iwd` and made into a texture on the device thread
(`frame_capture::run_at_present`). Only hashes ship. Proof: the sample card is pixel-identical on
Nacht and on mw2rust. `ENW_FONT_PROBE=1` logs the font pool.


## 11. 2026-09-23 ~02:30–03:00 — a join that is refused as "not ready yet" waits instead of dying (`components/join_retry.cpp`)

B on the box: *"it said maps cannot be joined mid-game when I tried to join at the very start."* The
server half and the race are in `dedi.md` §21: since §10's direct boot the client connects ~3.4 s
after process start, the box had just loaded bridge_zombie, the dedi opened its co-op gate 140 ms too
late, and the stock client turned the one `error\nEXE_ERR_CANNOTJOININPROGRESS` into a fatal
`Com_Error(ERR_DROP)`. The server no longer refuses; this is the belt for any refusal that really means
"not ready yet".

### 11a. How

* **Where the refusal becomes fatal.** Both OOB `error` and `lobbyerror` replies end in one call inside
  `CL_ConnectionlessPacket` 0x643380: `push msg; push "%s"; push 1; call Com_Error` at **0x643D50**,
  followed by `add esp,0xC; mov al,1`. That rel32 is retargeted (8 bytes before and 5 after checked) to
  a naked thunk with Com_Error's exact stack. `EXE_ERR_CANNOTJOININPROGRESS`, `EXE_SERVERISFULL`,
  `EXE_BAD_CHALLENGE` and `EXE_ERR_HOSTALREADYCONNECTED` → it **returns** (the caller reports the packet
  handled) after putting `clc.state` (0x305842C) back to 4 and `clc.connectTime` (0x3010010) to
  `cls.realtime` (0x48AE4E8). Anything else → `jmp Com_Error` with the stack untouched.
* **The retry is the engine's own** `CL_CheckForResend` 0x642C80 (state 4 = `getchallenge`, 5 =
  `connect`), not a second `CL_ConnectLocal`. While waiting, the frame tick brings its 3000 ms resend
  forward to 2000 ms — for refusals and for "no answer yet" (the server process still starting).
* **The line.** After `SCR_DrawScreenField` 0x478DC0 (its one caller `push esi; call; add esp,4` at
  **0x479271**, retargeted, byte-checked): *Waiting for the server... N s* and a grey second line (*The
  server is starting up* / *The map is still starting on the server*), centred through `UI_DrawText`
  on scrPlaceFull 0x957360 (the placement of the engine's own connect screen 0x5D7D40) in the stock
  font (`stock_font::pick`, §9c). Up after 2.5 s in state 4/5 with no answer, or at the first refusal;
  it lifts `boot_direct`'s black cover (`boot_direct::lift_cover`). The engine's error code is in the
  log only. Picture: `ui/2026-09-23-join-retry-waiting.png`.
* **Giving up** after `ENW_JOIN_RETRY_SECONDS` (default 60) from the connect: after refusals, the next
  refusal goes to the engine's error box with our message (*The ENW server did not let you in within
  60 seconds. Press Play again.*; 4 s grace so it is that path and not the silent one); with no answer
  at all, `disconnect` through `Cbuf_AddText` and *Could not reach the server / Press Play again in the
  launcher.* over the menu for 15 s (`ui/2026-09-23-join-retry-noanswer-and-giveup.png`).
* Launcher joins only (`ENW_CLIENT_CONNECT`), never a dedicated process. **Off: `ENW_JOIN_RETRY=0`**
  (nothing patched; the stock error).

### 11b. Proof (local `jrd` + `jrc`, off-screen, `ENW_TEST_NO_ACTIVATE=1`; logs `ZombiesDev\logs\dedi\`)

| run | server | client |
|---|---|---|
| `final-nacht-control` | old race forced (`ENW_JOIN_GATE_TEST_CLOSED_MS=6000`), client `ENW_JOIN_RETRY=0` | **B's bug reproduced**: one refusal, `Com_Error … EXE_ERR_CANNOTJOININPROGRESS`, clc.state 5 → 2, never asks again |
| `final-nacht-retry` | same, retry on | refusal 1 at +0.0 s, line up, 3 refusals 2 s apart, `IN -- … after 6.2 s and 3 refusal(s)`, first in-game frame |
| `final-bridge-retry` | same on bridge_zombie | 3 refusals, in after 6.2 s, in game |
| `giveup2` | `ENW_DEDI_NO_JIP=1` (refuses forever), `ENW_JOIN_RETRY_SECONDS=10` | 6 refusals 2 s apart, then `GIVING UP after 10.2 s` through Com_Error with our message |
| `noanswer1` | none (connect to a dead port), 10 s | line *The server is starting up*, then `disconnect` and *Could not reach the server* over the menu |
| `final-*-first` (dedi.md §21.4) | fixed server started 2.3–2.6 s AFTER the client | `WAITING … no answer yet`, then in on the first answer; Nacht, bridge_zombie, fear_mc_2 |

Run `retry1` found the one bug: the refusal set `connectTime` 1 s back AND the tick brought the resend
forward, so it asked every 1.0 s; fixed before the `final-*` runs.

**Client DLL for the coordinator (not published): `build/client-lane/enw_t4.dll` =
`03b04bc3414d12ceb7bb3c65bcb773a4424a438846a4bb3874e8670163e85db5`**, from a clean worktree at main
`81086d4` — the same binary as the box's dedi DLL (one full build carries both halves). *(Handoff
note 03:30: published as launcher **0.2.20**, `071d4d8`. The box has since moved to `6b1ccfc5`, main
`fd29f8f`, dedi.md §22.)*

**Not proven:** a real launcher Play on the box against this build (the box half was proven with a
scripted connect, dedi.md §21.4); B's machine; the line at 2560x1440 (drawn on scrPlaceFull, so it is
stretched the way the engine's own connect text is).


## 2026-09-23 03:15 — `net_probe_client.cpp`: snapshot arrival, from the player's own log

`recvfrom` IAT hook (WSOCK32 #17); every 5 s `net_probe_client:` from the busiest source: packets/s,
bytes, fragments, arrival gap avg/max/sd, gaps >100/>250 ms. `ENW_NET_PROBE=0` off. The lag B had on
fear_mc_2 was the server's stock `sv_maxRate 7000` (dedi.md §22): 10 → 3 snapshots/s over the internet,
20/s after. **Launcher lane: baseline `rate 25000`, `snaps 30`, `cl_maxpackets 100`** (dedi.md §22.4) —
a player with a low `rate` in config.cfg is otherwise still capped by his own setting.


## 2026-09-23 ~04:00 — the chat-Enter crash was Discord; engine console per process (`overlay_guard.cpp`, `console_tap.cpp`)

**Crash (B, 03:42, fear_mc_2 on the box, 0.2.20).** Not the chat overlay: Discord's in-process
graphics hook (`DiscordHook.dll`, injected ~36 s after launch) maps a 50 MB view for its capture
object, gets nothing because the 2 GB non-LAA process has no 50 MB hole left on fear_mc_2 (measured
**39.1 / 19.6 MB** largest free block a minute in, `ovg1`/`ovg2`), and then dereferences the NULL
object on the next Present (DiscordHook+0x1F7FD, write to 0x45; B's `CrashDumps\CoDWaW.exe.23916.dmp`,
Event 1000, `discord_hook.log`). Same offset in `waw-nc` at 03:10 with nobody typing. Full chain,
disassembly and table: **`chat-overlay.md` §13**.

**`components/overlay_guard.cpp`** (client only, `ENW_OVERLAY_GUARD=0` off): `ntdll!LdrLoadDll`
detour refuses `DiscordHook.dll` (`ENW_ALLOW_DISCORD_HOOK=1` allows it); every DLL loaded after engine
start is logged with ms since launch and the largest free address block; one address-space line a
minute; an unhandled exception is logged with module+offset before the engine's filter hides it.

**B's "missing" console.log (next-session bug 2) — the premise was wrong.** The engine wrote it every
launch, to `%LOCALAPPDATA%\ENWZombies\home\mods\<fs_game>\console.log` (fear_mc_2's: last written
03:42:30, the second the game died). It looked dead because it is one file per map, it is truncated
on every launch, and a rewritten file keeps its first creation time (09-22 17:07). The isolation
redirect (`enw_localappdata.cpp`) does not move it: `fs_homepath` is the launcher's
`ENWZombies\home`, the redirect only moves `fs_localAppData` (profiles, mod files).
It is still the wrong tool on a player's PC — it needs `logfile`, which puts the script VM in
developer mode (dedi.md §16), and a relaunch wipes it — so:

**`components/console_tap.cpp`** (client only, `ENW_CONSOLE_TAP=0` off): a MinHook detour on
`Com_PrintMessage` (0x59A170, cdecl `(channel, msg, type)`, byte-checked `55 8B EC 83 E4 F8 56 57 8B
7D 0C`; Com_Printf / DPrintf / PrintError all end there) writes **`%LOCALAPPDATA%\ENWZombies\logs\
console-<pid>.log`** (or `ENW_LOGDIR`) beside `enw-<pid>.log`, always, whatever `logfile` says. The
detour writes and then calls the engine; `WriteFile` per message (in the OS cache the moment it
returns, so it survives a crash); a `[hh:mm:ss.mmm]` stamp per line to line up with the DLL log;
colour codes stripped; each distinct message at most 5 times per 10 s then a `(suppressed N more…)`
count (fear_mc_2 prints "Failed to log on." every frame: 12,703 of 48,598 lines in 2 min); rotates at
16 MB to `console-<pid>.old.log`. The launcher still passes `+set logfile 2`; dropping it would make
a player's script VM retail again, and is a launcher-lane decision.

**Proof.** Unit test `client-dll/tests/overlay_console_test.cpp` **40/0** (x86 `cl`). Local dedi +
client on fear_mc_2 (`jointest`, `nd`+`nc`, invisible, `ENW_TEST_NO_ACTIVATE=1`,
`ENW_BORDERLESS_COVER=0`, `com_maxfps 125`, private LocalAppData): `ovg1` (lock 04:16:01–04:18:07)
wrote `ZombiesDev\logs\nc\console-25180.log`, 2.3 MB, starting
`1.7.1263 CL(350073) JADAMS2 … / begin $init / ----- FS_Startup -----`; both runs 105 s alive at
125 fps with the guard armed. Enter in the chat on fear_mc_2: `ovg4` (lock 04:59:54–05:02:01),
`CLOSED (Enter)` at 05:00:42.758, 105 s alive, no fault (offline line: no site in the harness);
`console-30112.log` 7,004 lines with the limiter. Table: `chat-overlay.md` §13.4.
**DLL for the coordinator (not published):** `build/overlayguard/enw_t4.dll` from worktree HEAD
`84e6201`, sha256 `7b0135abad15c789d6a2f7252249e7bee78f6925d24e2fba38395df5f496972f`.

**Not proven:** a refusal against a real Discord attach (Discord did not try these pids); the
tap on B's PC and at 2560x1440; Discord's retry behaviour after a refusal.

**Revision ~11:00–12:00 (`dd8ac00`, `224f6ba`, merge `5e15d75`) — the guard no longer refuses Discord
outright.** `ENW_DISCORD_HOOK=auto|allow|refuse` (replaces `ENW_ALLOW_DISCORD_HOOK`); auto (default)
lets `DiscordHook.dll` load only while the largest free address block is ≥ 0x3210000 bytes (Discord's
50 MB view, page-rounded and 64 KB-aligned), logs every decision with the measured block, and on a
refusal puts one line in the chat Global tab ("Discord overlay off: not enough memory on this map").
Setting "Discord overlay" Auto/On/Off (`discordOverlay`) on /settings → ENW, carried by the launcher
as `ENW_DISCORD_HOOK` the same way as `ENW_RAW_MOUSE`. Test-only `ENW_OVERLAY_GUARD_PROBE(_AT)`.
Unit test **60/0**. Proof `ovg5` (fear_mc_2, client pid 17356, lock 11:49:52–11:51:59): +4 s
134.3 MB largest free, +64 s 34.9 MB, probe at +71 s **REFUSED** in auto, game ran on to the
harness kill. DLL `build/overlayguard/enw_t4.dll` at `5e15d75`, sha256
`9acc16d9e4fb21cf916be73e2d75c6c6cee0e669cd77e0c02b2b070670092fa9` (not published). Not proven: the
chat line on screen, an ALLOWED decision in a game, a real Discord attach; no margin is kept for the
game after an allow. Detail: `chat-overlay.md` §13.6.


## 12. 2026-09-23 ~13:15 — `session-<pid>.json`: one small file per session for the launcher (T1 telemetry, `components/session_record.cpp`)

The launcher can flag a session (crash / hang / error / quit) without parsing a 50 MB log. Under the
T1 decision (nothing new in the frame path, logging unchanged, only what is cheap), the component has
**no frame subscriber and no hook**: other components fill a few plain globals where the number is
already computed, and the file is written at four moments that are already rare.

**Where:** beside `enw-<pid>.log`, i.e. the directory of `log::file_path()` (`ENW_LOGDIR`, which the
launcher sets to `%LOCALAPPDATA%\ENWZombies\logs`; else beside the DLL, as the logger). Client
processes only. Off: `ENW_SESSION_RECORD=0`.

| When | Who writes | `exit` |
|---|---|---|
| startup, once (`post_load`, loader thread, before the SteamStub wait) | `session_record.cpp` | `unknown` — a hard kill leaves this |
| clean shutdown: `pre_destroy`, i.e. `DLL_PROCESS_DETACH` from `ExitProcess` (`quit`, our Esc menu's Exit, the lockdown's quit, Alt+F4) | `session_record.cpp` | `quit`, or `error` when the session ended on an engine error (below) |
| the unhandled-exception filter, **first statement, before the logger line and before chaining to the engine's filter** | `overlay_guard.cpp` `on_unhandled` → `write_crash` | `crash` + `exception` |
| after the hang minidump (or its failure) | `hang_watchdog.cpp` `write_dump` → `write_hang` | `hang` + `hang_dump` (null if the dump failed) |

A record is only rewritten with an equal or worse exit (`unknown < quit < error < hang < crash`); a
crash record is never rewritten (so the engine's filter → `Sys_Error` → the window closed later does
not turn `crash` into `quit`). A hang that recovers and then quits stays `hang` with a fresh
`ended_at` and frame count.

**The shape** (one line, pure ASCII, `\n`-terminated; real output of the built DLL under
`loadtest.exe`, `ENW_CLIENT_CONNECT=fear_mc_2`, after `FreeLibrary`):

```json
{"v":1,"pid":2616,"build":"enw_t4 Sep 23 2026 13:13:23","started_at":"2026-09-23T12:13:53.347Z","ended_at":"2026-09-23T12:13:57.347Z","exit":"quit","exception":null,"last_error":null,"last_map":"fear_mc_2","frames":0,"largest_free_block_mb":null,"hang_dump":null,"discord_hook_refused":0}
```

and a crash (the unit test's rendering of B's 03:42 crash):
`"exit":"crash","exception":{"code":"0xC0000005","address":"0x6A21F7FD","module":"DiscordHook.dll","offset":"0x1F7FD"}`.

| Field | Source (already computed there) |
|---|---|
| `build` | `"enw_t4 " __DATE__ " " __TIME__` — the same compile stamp `dllmain.cpp` logs as "enw_t4 build"; **there is no git sha in the DLL**. The launcher knows the sha256 of the DLL it installed |
| `started_at`, `ended_at` | UTC ISO 8601 with ms; `ended_at` null in the startup record; for `hang` it is when the hang was recorded |
| `last_map` | `ENW_CLIENT_CONNECT` (the launcher's join map; one map per process since the lockdown quits at the menu). Null for a hand launch |
| `frames` | `frame::count()`, the core's interlocked counter; no per-frame work added |
| `largest_free_block_mb` | overlay_guard's measurements: at engine start, at every DiscordHook load decision, once a minute. One decimal. Null if overlay_guard is off |
| `discord_hook_refused` | overlay_guard's refusal count |
| `last_error` | **`com_errorMessage` as `menu_lockdown` read it when the game fell back to the menu** (its end screen), or "Lost the connection to the server (...)" for its silent-server rule. `exit` becomes `error` unless the text is empty or the server closing the game (`*DISCONNECT*`, how every box game ends) — `session_fmt::is_error_end` |
| `exception` | `code`, `address`, `module` (the image's PE export-directory name, or the exe's file name), `offset`; module/offset null outside any image |

**Deviation, on purpose: `last_error` is not the "=== Com_Error TRAPPED ===" text.** That trap is
`server/components/dedicated/error_trap.cpp` (compiled into the client DLL too, but the dedi lane's
file), and a Com_Error/Sys_Error hook of our own would break rule 9. So `Sys_Error` text (which parks
the main thread; the hang watchdog then records `hang`) and Com_Errors that do not end the session are
not in the record — they stay in `enw-<pid>.log`. If wanted later: one call from `error_trap.cpp`'s
`log_error` into `session_record::note_error` (dedi lane's decision).

**The crash path.** `write_crash` takes no lock (a try-once `InterlockedExchange`), allocates nothing,
does not use `snprintf` (the CRT's per-thread data and locale may allocate on an engine thread that
never used the CRT) — the formatter is plain loops into a static 16 KB buffer
(`session_record_format.hpp`) — and names the module with `VirtualQuery` + reading the image's PE
headers under `__try`, not `GetModuleHandleEx`/`GetModuleFileName` (both take the loader lock, which
the crashing thread may hold). Then one `CreateFileA` / `WriteFile` / `CloseHandle`. The existing
`ENW_ERROR` line after it still takes the logger's lock, as before; the record is on disk first. The
only shared state it reads are fixed-size char buffers whose last byte is never written, so a torn
read is still NUL-bounded, and every string is read at most 1024 bytes. Known window: a non-crash
write in progress on another thread at the instant of the crash could interleave in the file (both
open with `CREATE_ALWAYS`); vanishingly rare, and the launcher treats unparseable as unknown.

**For the launcher.** Read `<logs>\session-<pid>.json` **after the process has exited** (the pid is the
game process's). It is complete whenever it parses; it is rewritten whole each time (never appended).
`exit: "unknown"` after exit = killed hard (TerminateProcess, power loss) or a crash with overlay_guard
off (`ENW_OVERLAY_GUARD=0`) or a crash whose filter never ran (e.g. a stack overflow that killed the
thread, or WER taking it first). If it does not parse, treat it as `unknown`.

**Proof.** Unit test `client-dll/tests/session_record_test.cpp` **44/0** (x86 `cl /W4`, no warnings):
the startup record byte for byte, empty → null, the exception object with and without a module, path
backslashes, quotes / backslash / `\n\r\t` / control bytes / Windows-1252 bytes (`é`) in error
text, the 1024-byte cap, overflow returns 0 (never a truncated record), the worst case of the real
globals fits 16 KB, every record parses (a small validator in the test), `iso_utc`, `is_error_end`.
`overlay_console_test.cpp` still **60/0**. One DLL build, `build/t1-session/enw_t4.dll` (worktree
`agent-ac8b6c03e75664e66`, HEAD `c8f1505` + these uncommitted files; `git status` showed no other
lane's `.cpp` under `client-dll/`, `server/`, `shared/`), sha256
**`233948549fa75bf38163e18bec8ac1a997cae2059493a10fe38e60e1468d0c10`** — not staged, not published.
`loadtest.exe` (no game, no lock) loaded it: startup record written, rewritten `quit` at
`FreeLibrary` (the JSON above).

**Not proven:** a real crash writing its record (only the formatter is tested; `write_crash` needs the
engine, since the filter is installed at `post_init`); a real hang record; that the engine's `quit`
reaches `DLL_PROCESS_DETACH` in the game (if it `TerminateProcess`es, a quit reads `unknown`); the
`error` classification against real box endings (which `com_errorMessage` a normal game-over leaves).

---

## 13. 2026-09-23 ~16:45–18:30 — lane CL: "my game crashed launching Town of the Dead" was a hang in the engine's GPU query wait (`components/gpu_query_guard.cpp`)

B, 0.2.27 (client DLL `04a3ad6d`), `zombie_town`, 15:12:40 UK. **Not a crash.** The game froze
~0.3 s after its first in-game frame; Windows closed the frozen window 30 s later (exit code
`0xCFFFFFFF` = 3489660927, Event 1002 AppHang at 15:13:31). The first lease `m_8fe79035` (14:06 UTC)
is not a second failure: no client process was started for it (no launch at 15:06 in
`%LOCALAPPDATA%\ENWZombies\logs`); the site retired it (`lease … is no longer live at the site`,
incident 55) while the 483 MB map was downloading, and the relaunch was `m_679dedb8` (incident 60).

### 13.1 Evidence (read-only, B's PC)

| Source | What it says |
|---|---|
| `logs\session-32100.json` | `exit:"hang"`, `frames:1023`, `hang_dump:null`, `largest_free_block_mb:221.3` — memory is not the class |
| `logs\enw-32100.log` 15:13:00 | `hang_watchdog: the MAIN THREAD … has not ticked for 8000 ms`; stack `ntdll wait ← 0x70E370 ← 0x59DFC5 ← 0x59E4DC (Com_Frame)`; `MiniDumpWriteDump failed (0x8007001F)` |
| `logs\console-32100.log` | last line 15:12:52.016; before it only the map's own CSC runtime errors (`_dual_wield.csc` line 136, non-fatal) |
| Event log | 1001/1002 AppHang for CoDWaW.exe 1.7.0.0 at 15:13:30–31; no Event 1000; no WER dump in `CrashDumps` |
| Site incident 60 (read-only) | `game_hang` P1 — and a false **Crash P1** from overlay_guard's start-up INFO line (fixed on main by crash review L1 at the same time) |

`0x70E340` is the engine's **render lock** (recursive: `EnterCriticalSection(0x2298EA0)`, owner tid
at `[0x46E56A0]`, count `[0x46E569C]`; released by `0x70E3A0`), taken by the screen update
`0x479370`. In a WER dump of a healthy frame (`CoDWaW.exe.23916.dmp`) its owner is the **render
thread**. So the main thread was waiting for the render thread; the old watchdog never looked there.

### 13.2 Reproduced locally (invisible client + local dedi on `zombie_town`): 4 of 5 runs without the guard

`jointest.ps1` (`d2` server, `c1` client, private LocalAppData, `ENW_TEST_NO_ACTIVATE=1`, -4000,-4000,
`ENW_BORDERLESS_COVER=0`, 800×600 windowed, B's other renderer dvars from incident 60's launch line),
game.lock taken and released by the harness (one leftover of mine after a harness exit was ended and
its lock released by hand, `cl3`).

| Run | DLL | Result |
|---|---|---|
| `cl1` 16:55 | B's exact `04a3ad6d` (both halves) | **hang** 0.4 s after the first frame; the identical main-thread stack; dump failed `0x8007001F` |
| `cl2` 17:00 | lane CL watchdog (client) | **hang**; the new report names the holder (below); dump failed `0x80070008` |
| `cl3` 17:04 | same, `ENW_CHAT_OVERLAY=0` | **hang** — not our overlay / stock font / frame capture |
| `cl4` 17:14 | **the fix** (`b3be646a`, pre-merge; guard code as shipped) | guard timed out 3× at 0.30–0.43 s after the first frame and **tripped**; the game played on 90 s at 150–250 fps, no hang |
| `cl5` 17:19 | final DLL `db909469`, `zm_nuked`, guard **off** | no hang in 60 s (200–240 fps): zm_nuked does not reproduce locally |
| `cl6` 17:25 | same, `zm_nuked`, guard on | guard never needed (every query answered), 60 s at 222 fps — nothing changes on a healthy path |
| `cl8` 17:24 | `db909469`, `zombie_town`, guard **off** | **hang** (4th); the watchdog's full report: holder tid, its stack, every thread's EIP via `NtGetNextThread`, `hang_where` in the session record; dump still failed `0x80070008` |
| `cl9` 17:34 | final DLL `cc859f8a`, guard on | **crashed during the map load** (0xC0000005 read of NULL at `0x70F4D0`, 8 s in, before the first frame): `largest free address block 1.2 MB of 32.7 MB free` — address-space exhaustion, a different class (below). The guard had not engaged |
| `cl10` 17:39 | `cc859f8a`, guard off | no hang in 30 s — but only 53 fps (other lanes' games were running); the hang is timing-dependent |
| `cl12r2` 18:23 | **final DLL `cc859f8a`**, private copies `waw-clc`/`waw-cls`, guard on | guard timed out 3× at 0.56–0.70 s after the first frame and **tripped**; played on 90 s at 105–142 fps, no hang, no crash (largest free block 185 MB at +3 s) |
| `cl7`, `cl11` | — | **discarded**: another lane deployed its own DLL (`a077f3ac`) into the shared `waw-c1` between my deploy and my launch. Later runs use private copies `waw-clc` / `waw-cls` |

The render-lock holder, from the watchdog and from an external read-only probe of the live process:

```
render thread (entry 0x6FC6F0) holds CS 0x2298EA0, 3-13 waiters:
  AMDXN32.DLL (SleepConditionVariableCS) <- d3d9.dll+0x498BD (IDirect3DQuery9::GetData)
  <- 0x725605 (0x7255D0: while (q->GetData(&n,4,D3DGETDATA_FLUSH) == S_FALSE) Sleep(0);)
  <- 0x72C721 (0x72C670, sun visibility occlusion query) <- 0x72CE95 (0x72CE70) <- 0x6E893B
  <- 0x6E8BD0 <- 0x6FC4FD <- 0x6FC6F0 (render thread) <- 0x5A3099 (thread start)
```

Sampling the render thread's EIP 300 times: mostly ntdll/AMDXN32, and **`CoDWaW.exe+0x3255F6`
(0x7255F6, the loop body) and `Sleep`** — GetData *returns* `S_FALSE` every time and the engine
loops forever (≈1.4 cores busy, as `jointest` measured). The query never completes on B's driver
(AMD RX 9070 XT, `amdxn32.dll`, 32.0.31041) and the loop has no way out. `0x72CE70` runs the sun
query only when the map's world has a **sun flare** (`[[0x3BF392C]+0x194]`; the string
`Sun sprite occlusion query calibration failed…` at `0x6D6AD0` names the subsystem).

### 13.3 The fix: `gpu_query_guard.cpp`

`0x7255D0` (query in ESI, answer in EAX, -1 = no answer) has exactly four call sites — `0x72C71C`
(sun visibility), `0x725B71` / `0x725B7E` (sun sprite calibration pair), `0x72DF6B` — and **every
caller already handles -1** (it is what the engine returns for a failed GetData; the sun code then
keeps last frame's visibility, `[ebp+0x1C] = 1`). All four are retargeted (byte-checked: the
function's 21-byte prologue and each rel32) to a naked thunk → `bounded_query_wait`: the same
GetData(FLUSH) + Sleep(0) loop with a **50 ms budget**, then -1 and a WARN; after **3** timeouts it
stops waiting at all (one GetData, -1 if not ready) — the sun flare may lag or hold still, the game
runs. On a healthy machine nothing changes (a query issued 2N frames ago answers at once). Client
only; off `ENW_GPU_QUERY_GUARD=0`; `ENW_GPU_QUERY_TEST=1` makes every wait time out (harness).
It is generic: **any map, any GPU query, any driver** — a query that never answers can no longer
freeze the game.

### 13.4 The hang watchdog now names the culprit (`hang_watchdog.cpp`)

It reads the render lock and logs the holder's stack (`… is HELD by tid N … -- the thread the main
thread waits for`), every thread's EIP (via `NtGetNextThread`; Toolhelp failed inside the hang), and
writes a one-line verdict into `session-<pid>.json` as **`hang_where`** (e.g. `main waits on the
render lock; holder tid 30920 at 0x7779CD30 (KernelBase.dll+0x24CD30)`), which the site's Hang flag
now shows in its detail. No loader lock on the report path (VirtualQuery + GetMappedFileName, stack
scan for call-preceded return addresses under SEH, nothing allocated while a thread is suspended).
The dump excludes threads whose context cannot be read, skips unreadable memory, falls back to a
plain dump, and deletes a failed (empty) file. `ENW_HANG_TEST=2` makes a test thread hold the render
lock for 12 s (the zombie_town shape) so the report can be seen on demand.

### 13.5 The player is told (launcher) and telemetry agrees

* `crash.gameEndNotice()` + `main.js` `flow.on('ended')`: a game that ends `hang` (DLL verdict or
  exit `0xCFFFFFFF`) toasts **"World at War froze on <map>. We have the logs."**; `crash` →
  "crashed on …"; an unexplained non-zero exit → "closed unexpectedly on …"; a quit, an engine error
  the lockdown already explained, or our own stop → nothing. Before this, a hang at launch showed B
  nothing at all.
* `classifyGame` reads the DLL's `session.exit` (the watchdog now deletes an empty dump, which was the
  only reason B's hang classified as `game_hang` rather than `game_crash`).

### 13.6 Other maps in the same class

All 68 hosted maps have an asset list in `ZombiesDev\archive\cache\asset-lists`; the world's sun
flare sprite (`sun_flare` material) is in the map's own zone for **8**: `zombie_town`, `zm_nuked`,
`sanatorium`, `nazi_zombie_temple`, `nazi_zombie_puns` (playable), `nazi_zombie_snowglobe`,
`nazi_zombie_pogreb`, `nazi_zombie_rc` (custom-only); stock **`nazi_zombie_asylum`** (Verrückt) too.
B's unexplained 0.2.18 hang on `zm_nuked` ~200 ms after the first frame (`chat-overlay.md` §12.4,
item 3 in `next-session.md`) is very likely this class. The guard covers them all without a per-map
list; nothing is gated.

### 13.7 A second hazard on the same map: address space (not fixed here)

`cl9` died in the load with the address space gone: at +3 s its largest free block was already
127 MB of 478 MB (the runs that loaded had 197 of 549; B's had 221 of 578), and the map's load took
the rest. This is the archive's `client_memory_risk` class (`zombie_town`'s zone is 201 MB, the
largest of the 22 flagged; `dedi.md` §20.3), a 32-bit exe that cannot be made large-address-aware
under SteamStub (`launcher.md`, "laaON … Steam Error"). What took the extra ~70 MB before the load in
that run is unknown (other lanes' games were running on the same GPU). The telemetry already flags
it (`low_address_space`, Crash with the overlay_guard exception line). Nothing in lane CL changes it;
the next step is vault R14 (peak RSS) or a per-map gate on measured client headroom.

### 13.8 Proof, and what is not proven

* C++: `session_record_test` 48/0 and `overlay_console_test` 60/0 (x86 `cl /W4`), incl. `hang_where`. DLL builds clean (warnings are
  main's `snd_alias_dvars.cpp`).
* Launcher: `test/run-all.js` 172/0 (with a client DLL staged in `resources/client`),
  `telemetry.js` 21/0, `waw-settings` 20/0, `modcompat` 6/0, `discord-presence` 26/0.
* Web: `npm test` all suites 0 failed (telemetry 41/0 after main's L1 crash-rule fix was merged; my
  identical fix was dropped in favour of main's).
* **Client DLL for the next launcher: `build/clfinal/enw_t4.dll`, sha256 `cc859f8ac8d0b2e0ec84f35d4c97a0d19982f9e29467bc1f869cdc00fd87fe3d`** (branch
  `worktree-agent-a022ed210c6d334f4`, main merged). Client-only change; the box DLL does not need it
  (the guard is `is_supported() == !dedicated`).
* **Not proven:** B's own PC with the fixed DLL (his AMD RX 9070 XT is the same machine as the harness,
  so the driver is the same); whether the sun flare looks right after a trip (the harness window is
  off-screen); the in-process minidump inside a real hang (`0x80070008` — the report text is now the
  evidence instead); why the AMD driver never completes the query (driver-side, not investigated);
  zm_nuked and the other six sun-flare maps hanging (only the asset evidence and B's 0.2.18 zm_nuked
  hang link them).
