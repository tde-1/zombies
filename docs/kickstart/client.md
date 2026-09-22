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

### 2d. In-game chat overlay (note only — not designed)

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
