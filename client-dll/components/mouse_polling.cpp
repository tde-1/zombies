// Raw Input for the mouse -- the high-polling-rate fix.
//
// ===========================================================================
// THIS IS A PORT, NOT OUR DESIGN.
// ===========================================================================
// Ported from iw4x-client, `src/Components/Modules/RawMouse.cpp` (+ `.hpp`),
// upstream commit f55d287440f81f26bdbc7bb8edd30e88e77b3d89 (2026-09-02),
// https://github.com/iw4x/iw4x-client -- GPL-3.0-or-later.
// Copyright (C) the iw4x-client authors.
// This file is GPL-3.0-or-later, as is the rest of client-dll/.
//
// Kept from upstream: the structure, the names (`rawMouseValue_t`,
// `ToggleRawInput`, `IN_RawMouseMove`, `OnRawInput`, `FirstRawInputUpdate`),
// the absolute-flag handling, the first-update delta reset that kills the
// alt-tab angle snap, and the dvar semantics of `m_rawinput`.
// Changed for T4, and why, in the DEVIATIONS section below.
// Reuse register row: vault `18 - Reuse Register`, §1 iw4x-client.
//
// ===========================================================================
// WHAT THE ENGINE ACTUALLY DOES (measured on our own dump, not assumed)
// ===========================================================================
// The working hypothesis handed to this lane was buffered DirectInput with a
// 16-entry buffer overflowing at 1000+ Hz. **That is not what T4 does.**
// CoDWaW.exe contains no DirectInput at all:
//   * no `dinput8.dll` / `dinput.dll` import (the 18 imported DLLs are listed
//     in foundation.md §2 and none of them is DirectInput),
//   * no `DirectInput8Create` string, and
//   * CLSID_DirectInput8, IID_IDirectInput8A, GUID_SysMouse and
//     GUID_SysKeyboard do not appear as bytes ANYWHERE in the 78 MB image.
// (The three "...DirectInput..." strings in .rdata are rows of a generic
// HRESULT-to-text table. A string is a hypothesis, not an identification.)
//
// T4 reads the mouse with plain Win32, once per frame, in IN_MouseMove
// (0x5FA6D0), whose only caller is IN_Frame (0x5FA850) at 0x5FA8E4:
//
//   005FA6DB  call [GetForegroundWindow]   ; bail unless we are the fg window
//   005FA6F2  call [GetCursorPos]          ; POINT at [esp+8]
//   005FA717  sub esi, [0x229A0CC]         ; dx = pt.x - oldPos.x
//   005FA72D  sub edi, [0x229A0D0]         ; dy = pt.y - oldPos.y
//   005FA73B  call [ScreenToClient]
//   005FA74B  call 0x63D9A0                ; CL_MouseEvent(edx=x, ecx=y, dx, dy)
//   005FA764  call 0x5FA510                ; IN_RecenterMouse (SetCursorPos centre)
//
// So the engine's idea of "how far the mouse moved" is a difference of two
// **OS cursor positions, in whole screen pixels**, sampled at frame rate. That
// is the mechanism that goes wrong at a high report rate, and it goes wrong in
// two ways at once:
//   1. every individual report is put through Windows' pointer ballistics and
//      then rounded to an integer pixel, so at 1000-8000 Hz a large fraction
//      of the reports move the pointer by zero pixels and are simply lost --
//      motion becomes quantised and erratic rather than smooth;
//   2. the pointer is also clamped to the desktop, so anything past a screen
//      edge between two recenters is discarded.
// Neither is a buffer overflow, and neither has a buffer size to raise. The
// community's answer on this engine family is Raw Input, and that is what
// iw4x's RawMouse does, so that is what this ports.
//
// For the record, since the brief asked: the message pump IS drained fully
// every frame (Sys_GetEvent 0x5FEC60 loops PeekMessageA/GetMessageA/
// TranslateMessage/DispatchMessageA until the queue is empty), and the engine
// event ring (Sys_QueEvent 0x5FEB30) is 256 entries with an audible
// "Sys_QueEvent: overflow". But mouse MOTION is never queued -- the game
// WndProc (0x606B60) only queues button transitions -- so the flood theory has
// a counter we can watch rather than a defect we can name. This component logs
// WM_INPUT messages per frame so B's real test produces that number.
//
// ===========================================================================
// WHAT WE DO
// ===========================================================================
// * Subclass the game window's WndProc (0x606BE0, the lpfnWndProc of the
//   "CoD-WaW" class registered at 0x5FF450; its hwnd is at [0x22C1BE4]) and
//   accumulate WM_INPUT relative motion. One subclass, ours, installed once.
// * Retarget the single `call IN_MouseMove` at 0x5FA8E4 to our replacement,
//   which feeds the accumulated raw counts to the engine's own CL_MouseEvent
//   and then lets the engine's own IN_RecenterMouse run. The engine's frame
//   shape, recentring, menus and buttons are otherwise untouched.
// * IN_MouseMove's own bytes are NOT patched, so we can still call it: that is
//   the runtime fallback when raw input is off or unavailable.
//
// SELF-VERIFYING, in the house style (see server/components/dedicated/
// no_autosave.cpp): before we write anything we check that 0x5FA8E4 really is
// an `E8` whose target is 0x5FA6D0, and that the window we are about to
// subclass really has 0x606BE0 as its WndProc. Either check failing means the
// image is not the one these addresses came from; we log loudly and leave the
// stock path alone rather than guess.
//
// ===========================================================================
// DEVIATIONS FROM UPSTREAM (deliberate, each with a reason)
// ===========================================================================
// 1. RETRACTED 2026-09-22, and left here rather than deleted because the wrong
//    answer shipped and B played it. This used to read "NO RIDEV_NOLEGACY ...
//    we register with dwFlags = 0 and take only MOTION from raw input", on the
//    grounds that suppressing legacy messages would take the OS cursor away
//    from the menu. That reasoning is sound and the conclusion was still wrong:
//    keeping legacy messages means every device report is dispatched TWICE
//    (a WM_MOUSEMOVE and a WM_INPUT) through a pump that drains the queue
//    completely every frame, and the whole mechanism iw4x's own fix
//    (iw4x/iw4x-client PR #166, "Fix of fps drop when using a high polling
//    rate mouse") rests on is RIDEV_NOLEGACY. B played 0.2.2 with that
//    deviation in and the stutter was still there.
//    NOW: RIDEV_NOLEGACY is registered WHILE THE GAME OWNS THE MOUSE and
//    dropped the instant the menu, the console or another window takes it --
//    CL_MouseEvent's own return value is the engine's answer to that question
//    and we read it every frame. Buttons go back to the engine's own WndProc as
//    the legacy messages it expects, via CallWindowProcA. Off switch:
//    ENW_RAW_MOUSE_NOLEGACY=0.
// 2. ClipCursor, and the recentre is skipped. Upstream clips to the client
//    rect; Quake3e's IN_CaptureMouse does the same and its raw path never
//    recentres. We now do both, because T4's per-frame IN_RecenterMouse is a
//    SetCursorPos and SetCursorPos SYNTHESISES a WM_MOUSEMOVE into the queue
//    the pump is draining -- a feedback loop that only exists because the stock
//    deltas are differences between cursor positions. With raw deltas there is
//    nothing to recentre for. Both revert with the mouse the moment the game
//    stops owning it.
// 3. Env var, not a dvar. `m_rawinput` would need Dvar_RegisterBool (0x5EEE20),
//    whose convention is name-in-EDI / default-in-AL / (flags, desc) on the
//    stack -- readable, but this project's rule 2 is not to invent a prototype
//    from an address, and a wrong one crashes at startup. The off switch is
//    ENW_RAW_MOUSE=0 until that thunk is written and proven. The name and
//    semantics are kept so the dvar can drop straight in.
// 4. No r_autopriority / Key_ClearStates on focus loss; those are separate
//    upstream features, not part of the polling-rate fix.

// ===========================================================================
// 2026-09-23 -- WHERE MOUSE BUTTONS ACTUALLY COME FROM, AND THE STATE MACHINE
// ===========================================================================
// B, playing 0.2.2: "mouse inputs get dropped -- if I aim, sometimes it aims
// and un-aims; keyboard is fine, mouse clicks disappear a lot of the time, at
// 125 Hz and 1000 Hz."
//
// The button path was read out of the dump instruction by instruction before
// anything here was changed, because the shape of it decides the whole design.
// It is written down in addresses.hpp under "the button path"; the one fact
// that matters is this:
//
//   The game WndProc's mouse dispatch (0x60704E) sends WM_MOUSEMOVE (0x200)
//   AND every WM_?BUTTON?DOWN/UP to the SAME handler, 0x6070F7, which does
//   nothing but translate wParam's MK_ bits into a 5-bit mask and call
//   IN_MouseEvent with it. IN_MouseEvent XORs that mask against
//   s_wmv.oldButtonState (0x229A0C8) and queues one Sys_QueEvent(K_MOUSE1+n,
//   down) per bit that CHANGED.
//
// THE ENGINE NEVER LOOKS AT THE MESSAGE ID. For T4 a click is not a
// WM_LBUTTONDOWN; a click is "the mask of some mouse message differs from the
// mask of the previous one". Three consequences, and the fix falls out of them:
//
//   * a duplicated button message cannot double a click -- same mask, no edge;
//   * a WM_MOUSEMOVE carrying a stale or premature mask CAN invent a click or
//     destroy one, because it is the same input to the same differ;
//   * whatever we hand the engine, only the LOW WORD of wParam is read.
//
// That last point is what makes the state machine below airtight rather than
// best-effort, and it retires two real defects that were in this file:
//
//   DEFECT 1 (in the NOLEGACY path, default since 0.2.3, never yet played).
//   synth_buttons() built wParam from GetAsyncKeyState AT SYNTHESIS TIME. A
//   report processed after the physical button had already moved on therefore
//   carried the WRONG mask, and since the engine reads ONLY the mask, a
//   synthesised WM_LBUTTONDOWN whose GetAsyncKeyState said "up" produced
//   wParam = 0 == oldButtonState and NO EDGE AT ALL. Not a reordering: the
//   click was gone. The mirror case turned a synthesised UP into a DOWN. Any
//   click whose down and up both landed before one drain -- which is every
//   click at all during a 30-62 ms hitch, and the norm at 1000 Hz where a
//   single GetRawInputBuffer consumes several milliseconds of reports -- was
//   at risk.
//
//   DEFECT 2 (the per-frame legacy<->NOLEGACY flip). Buttons were synthesised
//   only while g_nolegacy_now was true. So a click whose legacy twin was
//   already queued when we flipped to NOLEGACY got delivered twice, and a
//   click whose raw report was generated under NOLEGACY but dispatched after
//   we flipped back got delivered zero times, because OnRawInput refused to
//   synthesise it. The flip is once a frame and driven by CL_MouseEvent, so
//   this is not a rare race.
//
// ---------------------------------------------------------------------------
// THE STATE MACHINE (g_btn_mask), and why it is exactly one engine edge per
// physical transition in BOTH modes
// ---------------------------------------------------------------------------
// NOLEGACY is now a MOTION AND OS-CURSOR decision only. Buttons behave
// identically on both sides of the flip.
//
// ONE SOURCE OF TRUTH: g_btn_mask, an MK_ mask maintained from RAWMOUSE
// usButtonFlags in the order the reports are consumed -- the dispatched one in
// OnRawInput, the queued ones in drain_raw_buffer, which is the order the
// device produced them.
//
//   raw DOWN(b)   ->  g_btn_mask |= MK_b ; g_btn_known |= MK_b
//                     send the matching legacy message to the ORIGINAL WndProc
//                     with wParam low word = g_btn_mask
//   raw UP(b)     ->  g_btn_mask &= ~MK_b ; g_btn_known |= MK_b ; same
//   raw wheel     ->  WM_MOUSEWHEEL, MAKEWPARAM(g_btn_mask, delta)
//
//   ANY legacy mouse message Windows still delivers (WM_MOUSEMOVE, any
//   WM_?BUTTON?, WM_MOUSEWHEEL) is FORWARDED -- never swallowed -- with the
//   bits of its low word that are in g_btn_known REPLACED by g_btn_mask.
//   Bits NOT in g_btn_known pass through untouched, which is the safety net:
//   a button whose raw transitions we have never seen keeps the stock
//   behaviour exactly, so this can never leave the player unable to click.
//
//   focus/capture lost, or shutdown -> g_btn_mask = 0 and one WM_MOUSEMOVE
//   carrying mask 0, so the engine queues the UPs for everything that was
//   down. Without that, a button held across an alt-tab is stuck down for
//   ever: the differ has no other way back, and a stuck +attack or a stuck
//   toggle-ADS is indistinguishable from "inputs get dropped".
//   focus regained -> g_btn_mask resynced from GetAsyncKeyState, one
//   WM_MOUSEMOVE, then raw takes over again.
//
// WHY IT IS EXACTLY ONE EDGE. After the rule above, every mouse message the
// engine sees carries g_btn_mask in the bits we own. So the sequence of masks
// the engine differs is the sequence of g_btn_mask values, in raw report
// order, with arbitrary REPEATS interleaved (the forwarded legacy messages and
// the WM_MOUSEMOVEs). A differ over a sequence with repeats yields exactly the
// transitions of the underlying sequence -- no more, no fewer. Message order,
// message id, GetAsyncKeyState timing and the NOLEGACY flip all stop being
// able to affect the outcome. That is the whole argument, and it is why this
// is a design change rather than a patched race.
//
// ENW_RAW_MOUSE_BUTTONS=0 turns the tracker off and passes every legacy
// message through untouched (stock button behaviour, raw motion only).
//
// ---------------------------------------------------------------------------
// ENW_INPUT_TRACE=1 -- the instrument that decides this, out of ONE run
// ---------------------------------------------------------------------------
// Counters only; no allocation and no I/O on the message or frame path. Per
// button it counts raw transitions, messages we sent, legacy messages seen,
// and -- the ground truth -- what the engine ACTUALLY QUEUED, read straight
// out of the Sys_QueEvent ring (0x22BBF48, head 0x22BBA34, stride 0x18;
// layout in addresses.hpp). NOTHING IS HOOKED for this: the ring is read, not
// intercepted, so no MinHook address is taken and kickstart rule 9 is not in
// play. A drop is a raw transition with no matching queued key event; a double
// is two queued events for one transition. Focus flaps (WM_ACTIVATE,
// WM_SETFOCUS, WM_KILLFOCUS, WM_CAPTURECHANGED) and the engine's own
// s_wmv.mouseActive / g_wv.activeApp / oldButtonState are timestamped
// alongside, because IN_Frame (0x5FA8A0) does not call IN_MouseMove at all
// while activeApp is 0, and focus_guard hooks GetForegroundWindow, so the
// engine can believe it is foreground while Windows is routing clicks
// somewhere else. The verdict prints every ~15 s and once at shutdown.

#include "component.hpp"
#include "frame.hpp"
#include "input_gate.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "mouse_jitter.hpp"
#include "raw_buffer.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#if __has_include("t4/addresses.hpp")
#include "t4/addresses.hpp"
#define ENW_HAVE_T4_ADDRESSES 1
#endif

namespace enw::client {
namespace {

#ifdef ENW_HAVE_T4_ADDRESSES

// ------------------------------------------------------------------ upstream
// rawMouseValue_t, ported from iw4x-client RawMouse.hpp/.cpp verbatim in shape.
struct rawMouseValue_t {
    int current = 0;
    int previous = 0;

    void ResetDelta() { previous = current; }
    int GetDelta() const { return current - previous; }

    void Update(int value, bool absolute) {
        // An absolute-positioning device reports a coordinate, not a delta.
        // Treating it as a delta spins the view; upstream zeroes first.
        if (absolute) current = 0;
        current += value;
    }
};

// ------------------------------------------------------------------- state
rawMouseValue_t g_raw_x;
rawMouseValue_t g_raw_y;
bool g_first_raw_update = true;
bool g_in_raw_input = false;   // RegisterRawInputDevices succeeded
bool g_in_focus = true;
bool g_enabled = true;         // ENW_RAW_MOUSE (the `m_rawinput` stand-in)
bool g_verbose = false;        // ENW_RAW_MOUSE_VERBOSE (`m_rawinput_verbose`)
bool g_installed = false;

HWND g_hwnd = nullptr;
WNDPROC g_prev_wndproc = nullptr;

// The input gate (input_gate.hpp). The chat overlay is the one consumer today.
// PASSTHROUGH is the subclass without raw input: with ENW_RAW_MOUSE=0 the stock
// mouse path runs exactly as before, but the subclass and the IN_MouseMove
// retarget still go in so the overlay's filter and its capture have somewhere to
// run. ENW_CHAT_OVERLAY=0 together with ENW_RAW_MOUSE=0 installs nothing at all.
input_gate::filter_fn g_filter = nullptr;
bool g_captured = false;
bool g_passthrough = false;

// Evidence counters. B cannot hand us a feeling; these are what the log shows.
volatile long g_events_total = 0;
volatile long g_events_this_frame = 0;
long g_events_peak_frame = 0;
long g_frames_with_events = 0;
uint64_t g_last_report_frame = 0;

// THE MESSAGE FLOOD, counted (2026-09-22). B: "the stutter happens only while
// the mouse is moving", and he normally has to drop an 8 kHz mouse to 250 Hz to
// make old CoD smooth. Run A measured exactly that shape -- with the counters
// frozen (no input at all) the same scene held p99 6.75 ms and 0.00% of frames
// over 16.7 ms at the 250 fps cap; with the mouse moving, p99 20-27 ms and 3-4%
// of frames over 16.7 ms.
//
// WM_INPUT alone does not explain it, because we asked for `dwFlags = 0`, which
// KEEPS the legacy messages: every device report produces a WM_MOUSEMOVE **and**
// a WM_INPUT, and `Sys_GetEvent` (0x5FEC60) drains the queue completely every
// frame. So these count both, per frame, and the report prints them side by side.
volatile long g_wm_mousemove_total = 0;
volatile long g_wm_mousemove_frame = 0;
long g_wm_mousemove_peak = 0;
volatile long g_msgs_total = 0;   // everything through our subclass
volatile long g_msgs_frame = 0;
long g_msgs_peak = 0;

// ------------------------------------------------------- engine entry points
using void_fn = void(__cdecl*)();

inline void_fn real_in_mousemove() {
    return reinterpret_cast<void_fn>(enw::at(t4::fn::IN_MouseMove));
}
inline void_fn in_recenter_mouse() {
    return reinterpret_cast<void_fn>(enw::at(t4::fn::IN_RecenterMouse));
}
inline HWND game_hwnd() { return *enw::ptr<HWND>(t4::var::g_wv_hwnd); }

// Resolved once at install time; the naked thunk below cannot call enw::at().
uintptr_t g_cl_mouse_event = 0;

// CL_MouseEvent's first eight bytes on our dump:
//   0063D9A0  f6 05 24 84 05 03 10   test byte ptr [0x3058424], 0x10
//   0063D9A7  56                     push esi
constexpr uint8_t kCLMouseEventHead[] = {0xF6, 0x05, 0x24, 0x84, 0x05, 0x03, 0x10, 0x56};

// CL_MouseEvent takes two of its four arguments in registers, so no C prototype
// can express it (addresses.hpp says so, and this project has paid for guessing
// a convention twice). A naked thunk reproduces exactly the call the engine
// makes at 0x5FA74B:
//     mov edx, clientX ; mov ecx, clientY ; push dy ; push dx ; call ; add esp,8
// Returns non-zero when the engine wants the cursor recentred.
__declspec(naked) int __cdecl cl_mouse_event(int /*x*/, int /*y*/, int /*dx*/, int /*dy*/) {
    __asm {
        mov edx, [esp + 4]            // client x
        mov ecx, [esp + 8]            // client y
        push dword ptr [esp + 16]     // dy  (pushed first, as the engine does)
        push dword ptr [esp + 16]     // dx  (esp moved by 4, so still +16)
        mov eax, g_cl_mouse_event
        call eax
        add esp, 8                    // the caller cleans: `add esp,8` @0x5FA750
        ret
    }
}

// ---------------------------------------------------------------- NO LEGACY
// ===========================================================================
// WHY (2026-09-22, measured -- see frametime.cpp and the run table in
// client.md 1e)
// ===========================================================================
// With `dwFlags = 0` Windows generates BOTH a WM_MOUSEMOVE and a WM_INPUT for
// every device report. `Sys_GetEvent` (0x5FEC60) drains the queue COMPLETELY
// every frame -- `Com_EventLoop` (0x5FEDE0) calls it until the event type is 0
// -- so at 8 kHz that is ~16,000 messages a second, two per report, being
// dispatched one at a time on the game thread. Run A peaked at 57 WM_INPUT in a
// single frame, and the frame-time histogram is unambiguous: with input frozen
// the same scene holds p99 6.75 ms and 0.00% of frames over 16.7 ms at the
// 250 fps cap; with the mouse moving, p99 20-27 ms and 3-4% over. B says the
// same thing from the chair, and that he normally has to drop an 8 kHz mouse to
// 250 Hz to make old CoD smooth.
//
// RIDEV_NOLEGACY removes the WM_MOUSEMOVE half outright, and reading the raw
// input in BULK (GetRawInputBuffer, once per frame, from our replacement
// IN_MouseMove) collapses the other half into one call instead of one dispatch
// per report.
//
// ===========================================================================
// WHAT NOLEGACY COSTS, AND HOW IT IS PAID FOR
// ===========================================================================
// RIDEV_NOLEGACY means, per MSDN, no legacy messages AND THE OS CURSOR STOPS
// MOVING. T4's menu cursor is the OS cursor -- `IN_MouseMove` reads it with
// GetCursorPos -- so leaving it on in the menu would freeze the pointer, and
// client.md 2a makes "the in-game menu must keep working" non-negotiable. Two
// things pay for it:
//
//   1. IT IS ONLY ON WHILE THE ENGINE IS RECENTRING. CL_MouseEvent returns
//      non-zero exactly when the engine wants the cursor recentred, i.e. when
//      the game -- not the menu or the console -- owns the mouse. We already
//      read that value every frame. When it goes false we put the legacy
//      messages straight back, so the menu gets its cursor. This is the same
//      distinction iw4x-client's RawMouse draws; it just draws it with a dvar
//      and a menu check, and we have a per-frame signal that is cheaper and
//      cannot go stale.
//   2. BUTTONS ARE SYNTHESISED BACK ONTO THE ENGINE'S OWN PATH. With legacy off
//      there is no WM_LBUTTONDOWN either, and T4 routes buttons through the game
//      WndProc -> 0x606B60 -> IN_MouseEvent -> Sys_QueEvent. Rather than call
//      IN_MouseEvent with a convention nobody has verified (addresses.hpp rule 2,
//      and this project has paid for guessing one), we hand the ORIGINAL WndProc
//      the exact legacy message it would have received, through CallWindowProcA.
//      Documented Win32 plus the engine's own proc; no new address, no guessed
//      prototype. Button transitions are a handful a second, so nothing about
//      the flood comes back with them.
//
// ON BY DEFAULT since 2026-09-22 (launcher 0.2.3). `ENW_RAW_MOUSE_NOLEGACY=0`
// goes back to the 0.2.2 behaviour (legacy messages kept); `ENW_RAW_MOUSE=0` is
// still the full revert to the stock GetCursorPos path. The default moved
// because this is the configuration iw4x-client actually ships and demonstrated
// — see §1f of client.md and iw4x PR #166, "Fix of fps drop when using a high
// polling rate mouse", whose whole mechanism is RIDEV_NOLEGACY.
bool g_nolegacy_wanted = true;   // ENW_RAW_MOUSE_NOLEGACY
bool g_nolegacy_now = false;     // what is actually registered right now
bool g_engine_recentring = false;
long g_nolegacy_flips = 0;
long g_buffered_reads = 0;
long g_buffered_reports = 0;

// GetRawInputBuffer can fail outright in a process that has been injected into
// by something else — Special K makes it return (UINT)-1 with
// ERROR_PROC_NOT_FOUND (SpecialKO/SpecialK#354). If that happens we must NOT
// sit there with a dead mouse: fall back to reading each WM_INPUT on its own.
bool g_bulk_read = true;
long g_bulk_failures = 0;

// ===========================================================================
// 2026-09-23 -- THE WOW64 BUFFERED-READ BUG (client.md §1f). Read this first.
// ===========================================================================
// From 0.2.3 to 0.2.20 drain_raw_buffer() read `ri->data.mouse`, i.e. the
// RAWMOUSE at sizeof(RAWINPUTHEADER) = 16. CoDWaW.exe is 32-bit, every player
// runs it on 64-bit Windows, and under WOW64 GetRawInputBuffer lays its blocks
// out with the 64-BIT header (24 bytes). So every report taken through the
// buffered read was parsed 8 bytes early: lLastX read the real button flags
// (0 for a move), lLastY read ulRawButtons (0), and usButtonFlags read the
// top of the 64-bit wParam (0). Motion AND clicks in those reports were lost.
// Proven by tools/dev/rawprobe.cpp on this box (injected moves carry a
// dwExtraInfo marker: 0 of 1987 found at +16, 1987 of 1987 at +24) and by B's
// own logs: 17-47 % of all raw reports in his 2026-09-22/23 sessions went
// through the buffered read (e.g. enw-39816: 8,667 of 18,350), and every one
// of them turned the view by zero. That is an uneven turn at a perfect frame
// rate -- a micro-stutter that exists only while the mouse moves.
// raw_buffer.hpp has the offset and its prior art (MSDN, SDL3).
// ENW_RAW_MOUSE_WOW64FIX=0 reads at 16 again, for B's A/B run ONLY.
unsigned g_rawbuf_off = sizeof(RAWINPUTHEADER);
bool g_wow64fix = true;

// Where the motion came from, per path. With the bug, `buffered` reports carry
// zero motion however many there are -- one line in the log proves or clears it.
long g_msg_reports = 0;
double g_msg_motion = 0.0;
long g_buf_reports = 0;
double g_buf_motion = 0.0;

// Test harness ONLY (never set by the launcher): RIDEV_INPUTSINK, so an
// off-screen, never-activated test game receives WM_INPUT from a synthetic
// SendInput mouse (tools/dev/mousebench.ps1). ClipCursor is skipped in this mode
// so a test game can never trap the desktop cursor.
bool g_sink = false;

// Plumbing counters for the probe line: every WM_INPUT that reached the proc,
// GetRawInputData failures (and the first error), non-mouse reports, and the
// most frequent other message id (to name a flood we did not expect).
long g_wm_input_seen = 0;
long g_rid_fail = 0;
unsigned long g_rid_fail_err = 0;
long g_rid_notmouse = 0;
long g_msg_hist[0x400] = {};

// ENW_FRAMETIME=1 (or ENW_MOUSE_JITTER=1): the view-turn meter (mouse_jitter.hpp)
// plus the time our own input code costs per window. Nothing when off.
bool g_probe = false;
enw::mousejitter::meter g_jit;
int64_t g_probe_last_qpc = 0;
int64_t g_probe_window_qpc = 0;
long g_probe_window = 0;
double g_probe_cost_us = 0.0;      // in_mousemove + OnRawInput, this window
double g_probe_cost_max_us = 0.0;  // worst single in_mousemove call
long g_probe_frames = 0;
long g_probe_msg_reports0 = 0, g_probe_buf_reports0 = 0;
double g_probe_msg_motion0 = 0.0, g_probe_buf_motion0 = 0.0;
// Cadence: WHERE a lumpy turn comes from. Per window: the gap between
// consecutive WM_INPUT arrivals at our proc (is the OS delivering in bursts?),
// the counts each gameplay in_mousemove handed over and the time since the
// previous one (is the engine consuming in bursts?), and the first 24 of those
// (counts@ms) as a literal sample.
long g_cad_arrive[5] = {};  // gap <0.5, 0.5-1.5, 1.5-4, 4-10, >=10 ms
int64_t g_cad_last_arrive = 0;
long g_cad_counts[5] = {};  // per call: 0, 1-2, 3-5, 6-10, >10
long g_cad_dt[5] = {};      // per call: <1, 1-3, 3-5, 5-10, >=10 ms
long g_cad_calls[4] = {};   // engine frames with 0, 1, 2, 3+ in_mousemove calls
int64_t g_probe_frame_qpc = 0;   // previous frame's first in_mousemove (its sampling instant)
int64_t g_frame_first_qpc = 0;
int g_frame_dx = 0, g_frame_dy = 0, g_frame_calls = 0;
bool g_frame_owned = false;
char g_cad_sample[24 * 12] = {};
int g_cad_sample_n = 0;
inline int cad_bucket(double v, double a, double b, double c, double d) {
    return v < a ? 0 : v < b ? 1 : v < c ? 2 : v < d ? 3 : 4;
}

inline int64_t qpc_now() {
    LARGE_INTEGER n{};
    ::QueryPerformanceCounter(&n);
    return n.QuadPart;
}

// The third leg of the flood, and the one the port had kept: T4 calls
// IN_RecenterMouse (SetCursorPos to the window centre) once per frame whenever
// the game owns the mouse. SetCursorPos SYNTHESISES A WM_MOUSEMOVE, which goes
// into the same queue Sys_GetEvent drains completely every frame. With
// RIDEV_NOLEGACY there is no legacy motion to recentre for — the deltas come
// from the device — so we do what Quake3e's IN_CaptureMouse does instead: clip
// the cursor to the client rect once, and stop recentring. One less SetCursorPos
// and one less synthesised message per frame.
bool g_cursor_clipped = false;
long g_recentres_skipped = 0;

void clip_cursor_to_client(bool on) {
    if (on == g_cursor_clipped) return;
    if (on && g_sink) return;  // harness: never clip the desktop to an off-screen game
    if (on) {
        if (!g_hwnd || !::IsWindow(g_hwnd)) return;
        RECT c = {};
        if (!::GetClientRect(g_hwnd, &c)) return;
        POINT tl = {c.left, c.top};
        POINT br = {c.right, c.bottom};
        ::ClientToScreen(g_hwnd, &tl);
        ::ClientToScreen(g_hwnd, &br);
        const RECT screen = {tl.x, tl.y, br.x, br.y};
        if (!::ClipCursor(&screen)) return;
    } else {
        ::ClipCursor(nullptr);
    }
    g_cursor_clipped = on;
}

// Measured device report rate, the instrument CoD2x exposes as `m_rinput_hz`.
// An average frame rate cannot see a stutter and neither can a total: what tells
// us whether a 1000/4000/8000 Hz mouse is really reaching the game is reports
// per second while it is moving.
double g_rate_hz = 0.0;
double g_rate_hz_peak = 0.0;
long g_rate_last_total = 0;
int64_t g_rate_last_qpc = 0;

void update_rate_hz() {
    LARGE_INTEGER now{}, freq{};
    if (!::QueryPerformanceCounter(&now) || !::QueryPerformanceFrequency(&freq) ||
        freq.QuadPart == 0)
        return;
    const long total = g_events_total;
    if (g_rate_last_qpc) {
        const double secs =
            static_cast<double>(now.QuadPart - g_rate_last_qpc) / static_cast<double>(freq.QuadPart);
        if (secs > 0.0) {
            g_rate_hz = static_cast<double>(total - g_rate_last_total) / secs;
            if (g_rate_hz > g_rate_hz_peak) g_rate_hz_peak = g_rate_hz;
        }
    }
    g_rate_last_qpc = now.QuadPart;
    g_rate_last_total = total;
}

bool register_raw(bool enable, bool nolegacy) {
    RAWINPUTDEVICE rid[1] = {};
    rid[0].usUsagePage = 0x01;  // HID_USAGE_PAGE_GENERIC
    rid[0].usUsage = 0x02;      // HID_USAGE_GENERIC_MOUSE
    // DEVIATION 1 from upstream stands for the DEFAULT: dwFlags = 0, legacy
    // messages kept. Foreground-only is what we want anyway -- a background
    // game must not read the mouse -- and it is why the counters go to
    // focus=no and stop.
    rid[0].dwFlags = enable ? (nolegacy ? RIDEV_NOLEGACY : 0u) | (g_sink ? RIDEV_INPUTSINK : 0u)
                            : RIDEV_REMOVE;
    rid[0].hwndTarget = enable ? g_hwnd : nullptr;
    return ::RegisterRawInputDevices(rid, 1, sizeof rid[0]) == TRUE;
}

bool ToggleRawInput(bool enable) {
    if (!g_enabled) enable = false;
    if (g_in_raw_input == enable) return g_in_raw_input;

    if (!register_raw(enable, false)) {
        ENW_WARN("mouse_polling: RegisterRawInputDevices(%s) failed, GetLastError=%lu. "
                 "Staying on the stock GetCursorPos path.",
                 enable ? "on" : "off", ::GetLastError());
        return g_in_raw_input;
    }

    g_in_raw_input = enable;
    g_nolegacy_now = false;
    g_first_raw_update = true;
    if (g_verbose)
        ENW_INFO("mouse_polling: raw input %s", enable ? "enabled" : "disabled");
    return g_in_raw_input;
}

// Put the legacy messages back, or take them away, to match whether the game
// currently owns the mouse. Called once per frame; does nothing unless the
// answer changed.
void set_nolegacy(bool want) {
    if (!g_in_raw_input || !g_nolegacy_wanted) want = false;
    if (want == g_nolegacy_now) return;
    if (!register_raw(true, want)) {
        ENW_WARN("mouse_polling: RegisterRawInputDevices(NOLEGACY=%d) failed, "
                 "GetLastError=%lu. Staying as we are.", want ? 1 : 0, ::GetLastError());
        return;
    }
    g_nolegacy_now = want;
    if (++g_nolegacy_flips <= 2 || g_verbose)
        ENW_INFO("mouse_polling: legacy mouse messages %s -- the %s owns the mouse now. "
                 "With NOLEGACY on, Windows stops generating a WM_MOUSEMOVE per device "
                 "report (and stops moving the OS cursor), which is half the message "
                 "flood. Flip %ld.",
                 want ? "OFF" : "back ON", want ? "game" : "menu/console", g_nolegacy_flips);
}

// ===========================================================================
// THE BUTTON STATE MACHINE. The argument for it is in the file header; this is
// the implementation, and it is deliberately small.
// ===========================================================================
// g_btn_mask is the MK_ mask we believe the physical buttons are in, updated
// from raw transitions in report order. g_btn_known is the set of buttons we
// have ever seen a raw transition for -- the safety net: bits outside it are
// never rewritten, so a device whose buttons raw input does not report keeps
// the stock behaviour exactly and the player can always click.
WPARAM g_btn_mask = 0;
WPARAM g_btn_known = 0;
bool g_btn_track = true;          // ENW_RAW_MOUSE_BUTTONS=0 turns this off

// ---------------------------------------------------------------- the trace
// ENW_INPUT_TRACE=1. Counters only: no allocation, no I/O, nothing on the
// message path but a handful of increments behind one bool.
bool g_trace = false;

// [0]=MOUSE1 .. [4]=MOUSE5, matching K_MOUSE1..K_MOUSE5 = 0xC8..0xCC.
long g_raw_down[5] = {};      // physical transitions seen in raw input
long g_raw_up[5] = {};
long g_legacy_down[5] = {};   // legacy WM_?BUTTON?DOWN/UP Windows delivered
long g_legacy_up[5] = {};
long g_que_down[5] = {};      // what the engine ACTUALLY queued (ground truth)
long g_que_up[5] = {};
long g_legacy_move_maskchange = 0;  // forwarded WM_MOUSEMOVE whose mask we corrected
long g_mask_rewrites = 0;
long g_force_release = 0;
long g_que_overflow = 0;

// Where we are in the engine's event ring. The head counter is monotonic and
// never masked (0x5FEB8A: `add dword [0x22BBA34], 1`), so a saved copy is a
// valid cursor.
unsigned g_que_head_seen = 0;
bool g_que_started = false;

int64_t g_qpc0 = 0;
double g_qpc_freq = 0.0;

unsigned trace_ms() {
    if (!g_qpc_freq) return 0;
    LARGE_INTEGER n{};
    if (!::QueryPerformanceCounter(&n)) return 0;
    return static_cast<unsigned>((static_cast<double>(n.QuadPart - g_qpc0) / g_qpc_freq) * 1000.0);
}

// Engine state we watch for flaps, sampled once a frame; only transitions are
// logged. IN_Frame (0x5FA8A0) does not call IN_MouseMove AT ALL while
// g_wv.activeApp is 0, and focus_guard hooks GetForegroundWindow, so the
// engine can be certain it is foreground while Windows routes clicks elsewhere.
int g_last_active_app = -1;
int g_last_mouse_active = -1;

const char* button_name(int i) {
    static const char* n[5] = {"MOUSE1", "MOUSE2", "MOUSE3", "MOUSE4", "MOUSE5"};
    return (i >= 0 && i < 5) ? n[i] : "?";
}

// ------------------------------------------------------------ mask rewriting
// Replace the bits we own with our tracked state, leave everything else. Only
// the LOW WORD of wParam is the button mask; WM_XBUTTON* and WM_MOUSEWHEEL
// carry the button number / wheel delta in the high word and it must survive.
WPARAM rewrite_mask(WPARAM wp) {
    if (!g_btn_track || !g_btn_known) return wp;
    const WPARAM lo = wp & 0xFFFF;
    const WPARAM fixed = (lo & ~g_btn_known) | (g_btn_mask & g_btn_known);
    if (fixed == lo) return wp;
    ++g_mask_rewrites;
    return (wp & ~static_cast<WPARAM>(0xFFFF)) | fixed;
}

void send_to_engine(UINT msg, WPARAM wp, LPARAM lp) {
    if (!g_prev_wndproc || !g_hwnd) return;
    // An overlay owns the mouse: the engine gets no button from us. The tracker
    // keeps counting (g_btn_mask), so leaving capture resyncs to the truth.
    if (g_captured) return;
    ::CallWindowProcA(g_prev_wndproc, g_hwnd, msg, wp, lp);
}

LPARAM cursor_lparam() {
    POINT p = {};
    ::GetCursorPos(&p);
    if (g_hwnd) ::ScreenToClient(g_hwnd, &p);
    return MAKELPARAM(static_cast<WORD>(p.x), static_cast<WORD>(p.y));
}

// The modifier bits. The engine does not read them (0x6070F7 only tests
// MK_LBUTTON/RBUTTON/MBUTTON/XBUTTON1/XBUTTON2) but DefWindowProc and any
// future consumer might, so build them the way Windows would.
WPARAM modifier_bits() {
    WPARAM w = 0;
    if (::GetAsyncKeyState(VK_SHIFT) & 0x8000) w |= MK_SHIFT;
    if (::GetAsyncKeyState(VK_CONTROL) & 0x8000) w |= MK_CONTROL;
    return w;
}

// One physical transition -> one message carrying the POST-transition mask.
// This is the whole of defect 1's fix: the mask is ours, taken at the moment
// the report is consumed, never re-sampled from GetAsyncKeyState.
void emit_button(int idx, bool down, LPARAM lp) {
    static const struct { WPARAM mk; UINT dn; UINT up; WPARAM xbtn; } kMap[5] = {
        {MK_LBUTTON,  WM_LBUTTONDOWN, WM_LBUTTONUP, 0},
        {MK_RBUTTON,  WM_RBUTTONDOWN, WM_RBUTTONUP, 0},
        {MK_MBUTTON,  WM_MBUTTONDOWN, WM_MBUTTONUP, 0},
        {MK_XBUTTON1, WM_XBUTTONDOWN, WM_XBUTTONUP, XBUTTON1},
        {MK_XBUTTON2, WM_XBUTTONDOWN, WM_XBUTTONUP, XBUTTON2},
    };
    if (idx < 0 || idx > 4) return;
    const auto& m = kMap[idx];
    if (down) g_btn_mask |= m.mk; else g_btn_mask &= ~m.mk;
    g_btn_known |= m.mk;

    const WPARAM lo = g_btn_mask | modifier_bits();
    const WPARAM wp = m.xbtn ? MAKEWPARAM(static_cast<WORD>(lo), static_cast<WORD>(m.xbtn)) : lo;
    send_to_engine(down ? m.dn : m.up, wp, lp);
    if (down) ++g_raw_down[idx]; else ++g_raw_up[idx];
    if (g_trace)
        ENW_INFO("input_trace: %8u ms  RAW  %s %-4s mask=0x%02X", trace_ms(), button_name(idx),
                 down ? "DOWN" : "UP", static_cast<unsigned>(g_btn_mask));
}

// Everything down, released, as one mask-0 mouse move. The engine's differ has
// no other way back: a button held across an alt-tab, a NOLEGACY flip into the
// menu, or a shutdown would otherwise stay down for ever, and a stuck +attack
// or a stuck toggle-ADS reads to a player exactly like "inputs get dropped".
void release_all_buttons(const char* why) {
    if (!g_btn_track || !g_btn_mask) return;
    g_btn_mask = 0;
    send_to_engine(WM_MOUSEMOVE, modifier_bits(), cursor_lparam());
    ++g_force_release;
    if (g_trace || g_verbose)
        ENW_INFO("input_trace: %8u ms  RELEASE-ALL (%s) -- every tracked button forced up so the "
                 "engine's differ cannot leave one stuck down", trace_ms(), why);
}

// Coming back from a focus loss: believe the OS once, then raw again.
void resync_buttons_from_os(const char* why) {
    if (!g_btn_track) return;
    WPARAM m = 0;
    if (::GetAsyncKeyState(VK_LBUTTON) & 0x8000) m |= MK_LBUTTON;
    if (::GetAsyncKeyState(VK_RBUTTON) & 0x8000) m |= MK_RBUTTON;
    if (::GetAsyncKeyState(VK_MBUTTON) & 0x8000) m |= MK_MBUTTON;
    if (::GetAsyncKeyState(VK_XBUTTON1) & 0x8000) m |= MK_XBUTTON1;
    if (::GetAsyncKeyState(VK_XBUTTON2) & 0x8000) m |= MK_XBUTTON2;
    if (m == g_btn_mask) return;
    g_btn_mask = m;
    send_to_engine(WM_MOUSEMOVE, m | modifier_bits(), cursor_lparam());
    if (g_trace || g_verbose)
        ENW_INFO("input_trace: %8u ms  RESYNC (%s) mask=0x%02X", trace_ms(), why,
                 static_cast<unsigned>(m));
}

// RAWMOUSE.usButtonFlags -> our tracker, in report order. Called for the
// dispatched report AND for every buffered one, in BOTH modes -- that is
// defect 2's fix: buttons no longer depend on which side of the NOLEGACY flip
// the report happened to land on.
void apply_raw_buttons(USHORT flags, SHORT wheel) {
    if (!flags || !g_btn_track || !g_prev_wndproc || !g_hwnd) return;
    const LPARAM lp = cursor_lparam();

    static const struct { USHORT dn; USHORT up; int idx; } kRaw[5] = {
        {RI_MOUSE_LEFT_BUTTON_DOWN,   RI_MOUSE_LEFT_BUTTON_UP,   0},
        {RI_MOUSE_RIGHT_BUTTON_DOWN,  RI_MOUSE_RIGHT_BUTTON_UP,  1},
        {RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_UP, 2},
        {RI_MOUSE_BUTTON_4_DOWN,      RI_MOUSE_BUTTON_4_UP,      3},
        {RI_MOUSE_BUTTON_5_DOWN,      RI_MOUSE_BUTTON_5_UP,      4},
    };
    // A single report can carry a down AND an up for the same button (a click
    // shorter than one report interval). Emit both, down first, so the engine
    // differs two transitions instead of losing the pair.
    for (const auto& r : kRaw) {
        if (flags & r.dn) emit_button(r.idx, true, lp);
        if (flags & r.up) emit_button(r.idx, false, lp);
    }
    if (flags & RI_MOUSE_WHEEL)
        send_to_engine(WM_MOUSEWHEEL,
                       MAKEWPARAM(static_cast<WORD>(g_btn_mask | modifier_bits()),
                                  static_cast<WORD>(wheel)),
                       lp);
}

// ------------------------------------------------- the engine's own verdict
// Read (never hook) the Sys_QueEvent ring and count the K_MOUSE key events the
// engine really queued. This is the ground truth the whole trace exists for:
// a raw transition with no matching queued event is a DROP; two queued events
// for one transition is a DOUBLE.
void drain_engine_event_ring() {
    const unsigned head = *enw::ptr<unsigned>(t4::var::sys_event_head);
    const unsigned tail = *enw::ptr<unsigned>(t4::var::sys_event_tail);
    if (!g_que_started) {
        g_que_head_seen = head;
        g_que_started = true;
        return;
    }
    if (head - tail >= t4::var::sys_event_count) ++g_que_overflow;
    // If we fell more than a ring behind (we cannot, at frame rate, but say so
    // rather than read wrapped garbage) skip forward and count the loss.
    if (head - g_que_head_seen > t4::var::sys_event_count) {
        g_que_head_seen = head - static_cast<unsigned>(t4::var::sys_event_count);
        ++g_que_overflow;
    }
    for (; g_que_head_seen != head; ++g_que_head_seen) {
        const uintptr_t slot = enw::at(t4::var::sys_event_ring) +
                               (g_que_head_seen & (t4::var::sys_event_count - 1)) *
                                   t4::var::sys_event_stride;
        const int type = *reinterpret_cast<int*>(slot + 0x04);
        if (type != 1) continue;  // SE_KEY
        const int key = *reinterpret_cast<int*>(slot + 0x08);
        const int down = *reinterpret_cast<int*>(slot + 0x0C);
        const int idx = key - static_cast<int>(t4::var::K_MOUSE1);
        if (idx < 0 || idx > 4) continue;
        if (down) ++g_que_down[idx]; else ++g_que_up[idx];
        if (g_trace)
            ENW_INFO("input_trace: %8u ms  QUEUED %s %s  <- the engine", trace_ms(),
                     button_name(idx), down ? "DOWN" : "UP");
    }
}

// The one line B reads. Raw transitions against what the engine queued, per
// button. Anything but a match is named in words, because a table of numbers
// is not a verdict.
void report_verdict(const char* when) {
    bool any = false;
    for (int i = 0; i < 5; ++i) any = any || g_raw_down[i] || g_legacy_down[i] || g_que_down[i];
    if (!any) {
        ENW_INFO("input_trace (%s): no mouse button activity at all this session -- nothing to "
                 "judge. If you were clicking, the clicks are not reaching this window.", when);
        return;
    }
    for (int i = 0; i < 5; ++i) {
        if (!g_raw_down[i] && !g_raw_up[i] && !g_que_down[i] && !g_que_up[i] && !g_legacy_down[i])
            continue;
        const long lost_d = g_raw_down[i] - g_que_down[i];
        const long lost_u = g_raw_up[i] - g_que_up[i];
        const char* verdict = (lost_d == 0 && lost_u == 0) ? "PERFECT"
                              : (lost_d > 0 || lost_u > 0) ? "DROPPED"
                                                           : "DOUBLED";
        ENW_INFO("input_trace (%s): %s  raw %ld down / %ld up  |  legacy msgs %ld / %ld  |  "
                 "engine QUEUED %ld down / %ld up  ->  %s%s%s",
                 when, button_name(i), g_raw_down[i], g_raw_up[i], g_legacy_down[i],
                 g_legacy_up[i], g_que_down[i], g_que_up[i], verdict,
                 lost_d ? (lost_d > 0 ? "  (downs lost)" : "  (extra downs)") : "",
                 lost_u ? (lost_u > 0 ? "  (ups lost)" : "  (extra ups)") : "");
    }
    ENW_INFO("input_trace (%s): masks rewritten %ld, forced releases %ld, "
             "Sys_QueEvent overflow windows %ld, tracker %s, NOLEGACY %s (%ld flips)",
             when, g_mask_rewrites, g_force_release, g_que_overflow,
             g_btn_track ? "on" : "OFF (ENW_RAW_MOUSE_BUTTONS=0)", g_nolegacy_now ? "on" : "off",
             g_nolegacy_flips);
}

// Read every pending raw report in ONE call instead of one WM_INPUT dispatch
// each. Returns how many reports it consumed.
long drain_raw_buffer() {
    if (!g_in_raw_input || !g_bulk_read) return 0;
    // 512 reports is ~4 frames' worth at 8 kHz / 250 fps; the loop runs again if
    // there is more.
    static BYTE buf[512 * (sizeof(RAWINPUT) + 16)];
    long consumed = 0;
    for (;;) {
        UINT size = sizeof buf;
        const UINT n = ::GetRawInputBuffer(reinterpret_cast<PRAWINPUT>(buf), &size,
                                           sizeof(RAWINPUTHEADER));
        if (n == static_cast<UINT>(-1)) {
            // Not "no reports": the call itself failed. Known cause: another
            // injected module (Special K, SpecialKO/SpecialK#354) leaves
            // GetRawInputBuffer returning -1 / ERROR_PROC_NOT_FOUND. Silently
            // treating that as "no input" is a dead mouse, so give up on the
            // bulk read for the rest of the session and let the per-message
            // GetRawInputData path in OnRawInput carry everything.
            if (++g_bulk_failures == 1)
                ENW_WARN("mouse_polling: GetRawInputBuffer failed (GetLastError=%lu). Falling "
                         "back to one GetRawInputData per WM_INPUT for the rest of this "
                         "session. RIDEV_NOLEGACY stays on -- the legacy WM_MOUSEMOVE half of "
                         "the flood is still gone -- but the per-message read is back.",
                         ::GetLastError());
            g_bulk_read = false;
            break;
        }
        if (n == 0) break;

        PRAWINPUT ri = reinterpret_cast<PRAWINPUT>(buf);
        for (UINT i = 0; i < n; ++i) {
            // Same reasoning as OnRawInput: no `g_in_focus` gate. A stuck flag
            // silently discarded every report.
            if (ri->header.dwType == RIM_TYPEMOUSE) {
                // NOT `ri->data.mouse`: under WOW64 that is 8 bytes early and
                // reads zero motion and zero buttons (see g_rawbuf_off).
                const RAWMOUSE& m = *enw::rawbuf::mouse_of(ri, g_rawbuf_off);
                ++g_buf_reports;
                g_buf_motion += std::fabs(static_cast<double>(m.lLastX)) +
                                std::fabs(static_cast<double>(m.lLastY));
                const bool absolute = (m.usFlags & MOUSE_MOVE_ABSOLUTE) != 0;
                g_raw_x.Update(m.lLastX, absolute);
                g_raw_y.Update(m.lLastY, absolute);
                // IN BOTH MODES, and that is defect 2's fix. The old code
                // did this only while NOLEGACY was registered, on the
                // reasoning that the legacy messages were already carrying
                // the clicks. They were -- but the flip happens once a frame,
                // so a report generated on one side of it and consumed on the
                // other was either doubled or dropped. Now raw input is the
                // only source of button transitions and every legacy message
                // is mask-rewritten to agree with it (see wndproc), so the
                // engine sees exactly one edge per transition either way.
                if (m.usButtonFlags)
                    apply_raw_buttons(m.usButtonFlags, static_cast<SHORT>(m.usButtonData));
                ::InterlockedIncrement(&g_events_total);
                ::InterlockedIncrement(&g_events_this_frame);
                ++consumed;
            }
            ri = NEXTRAWINPUTBLOCK(ri);
        }
        ++g_buffered_reads;
        if (n * (sizeof(RAWINPUT) + 16) < sizeof buf / 2) break;  // it all fitted
    }
    g_buffered_reports += consumed;
    if (consumed && g_first_raw_update) {
        g_raw_x.ResetDelta();
        g_raw_y.ResetDelta();
        g_first_raw_update = false;
    }
    return consumed;
}

void OnRawInput(LPARAM lparam) {
    if (!g_in_raw_input) return;

    // CORRECTION 2026-09-22, and it is a bug fix, not a tidy-up. This used to
    // be `if (g_nolegacy_wanted) return;` on the reasoning that the once-a-frame
    // GetRawInputBuffer owned the reading and taking the same report here would
    // double the delta. IT WOULD NOT, AND THE EARLY RETURN LOST INPUT:
    // GetMessage REMOVES the raw event it is delivering from the buffered queue
    // before it returns, so GetRawInputBuffer never sees the report that
    // produced this WM_INPUT -- only the ones that arrived after it. MSDN's
    // GetRawInputBuffer page says so, and the documented pattern is exactly the
    // one used here now: read the CURRENT event with GetRawInputData, then drain
    // whatever else has piled up with GetRawInputBuffer (in_mousemove, once a
    // frame). The dispatched message is counted once and the queued ones once.
    // This path also carries everything when the bulk read is unavailable
    // (g_bulk_read == false).
    RAWINPUT raw = {};
    UINT size = sizeof raw;
    const UINT got = ::GetRawInputData(reinterpret_cast<HRAWINPUT>(lparam), RID_INPUT, &raw,
                                       &size, sizeof(RAWINPUTHEADER));
    if (got == static_cast<UINT>(-1)) {
        if (++g_rid_fail == 1) g_rid_fail_err = ::GetLastError();
        return;
    }
    if (raw.header.dwType != RIM_TYPEMOUSE) { ++g_rid_notmouse; return; }

    // NO `if (!g_in_focus) return;` HERE, and that is a fix, not an omission.
    //
    // MEASURED 2026-09-22. `g_in_focus` starts as `GetForegroundWindow() ==
    // g_hwnd` -- and `focus_guard` HOOKS GetForegroundWindow -- and is only
    // updated afterwards by WM_SETFOCUS / WM_KILLFOCUS. A window that already
    // had focus when we subclassed it never sends WM_SETFOCUS, so the flag can
    // be stuck false for the whole session, and this early return then threw
    // away EVERY report in silence: a bisect run took 360,000 injected mouse
    // moves at 8 kHz and logged `WM_INPUT total=0, focus=no` while the game sat
    // there feeling like the stock path. It looks exactly like "raw input is not
    // reaching us" and is really "we received it and dropped it".
    //
    // The check was also redundant. We register with `dwFlags = 0`, which is
    // foreground-only BY DEFINITION -- Windows does not deliver WM_INPUT to a
    // window that is not in the foreground -- so arriving at all is the proof
    // the old flag was trying to be. `g_in_focus` is kept for the log line and
    // for `g_first_raw_update`, which is what actually needs focus transitions
    // (upstream's alt-tab angle-snap fix).

    ++g_msg_reports;
    g_msg_motion += std::fabs(static_cast<double>(raw.data.mouse.lLastX)) +
                    std::fabs(static_cast<double>(raw.data.mouse.lLastY));
    const bool absolute = (raw.data.mouse.usFlags & MOUSE_MOVE_ABSOLUTE) != 0;
    g_raw_x.Update(raw.data.mouse.lLastX, absolute);
    g_raw_y.Update(raw.data.mouse.lLastY, absolute);

    // This event's button transitions, in BOTH modes. See drain_raw_buffer for
    // why the old `g_nolegacy_now &&` guard was defect 2 rather than a saving.
    if (raw.data.mouse.usButtonFlags)
        apply_raw_buttons(raw.data.mouse.usButtonFlags,
                          static_cast<SHORT>(raw.data.mouse.usButtonData));

    // Upstream's alt-tab fix: the first update after (re)acquiring the device
    // carries everything that happened while we were not looking, and applying
    // it snaps the view violently.
    if (g_first_raw_update) {
        g_raw_x.ResetDelta();
        g_raw_y.ResetDelta();
        g_first_raw_update = false;
    }

    const long total = ::InterlockedIncrement(&g_events_total);
    ::InterlockedIncrement(&g_events_this_frame);
    if (total == 1)
        ENW_INFO("mouse_polling: first WM_INPUT received (lLastX=%ld lLastY=%ld, flags=0x%04X). "
                 "Raw input is live; mouse motion is no longer coming from screen pixels.",
                 static_cast<long>(raw.data.mouse.lLastX), static_cast<long>(raw.data.mouse.lLastY),
                 static_cast<unsigned>(raw.data.mouse.usFlags));
}

// The index of a WM_?BUTTON? message in our 0..4 button space, or -1.
int legacy_button_index(UINT msg, WPARAM wparam, bool* down) {
    switch (msg) {
    case WM_LBUTTONDOWN: *down = true;  return 0;
    case WM_LBUTTONUP:   *down = false; return 0;
    case WM_RBUTTONDOWN: *down = true;  return 1;
    case WM_RBUTTONUP:   *down = false; return 1;
    case WM_MBUTTONDOWN: *down = true;  return 2;
    case WM_MBUTTONUP:   *down = false; return 2;
    case WM_XBUTTONDOWN: *down = true;  return GET_XBUTTON_WPARAM(wparam) == XBUTTON2 ? 4 : 3;
    case WM_XBUTTONUP:   *down = false; return GET_XBUTTON_WPARAM(wparam) == XBUTTON2 ? 4 : 3;
    default: return -1;
    }
}

LRESULT CALLBACK wndproc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
    ::InterlockedIncrement(&g_msgs_total);
    ::InterlockedIncrement(&g_msgs_frame);
    if (g_probe) {
        if (msg == WM_INPUT) {
            ++g_wm_input_seen;
            const int64_t t = qpc_now();
            if (g_cad_last_arrive && g_qpc_freq > 0.0)
                ++g_cad_arrive[cad_bucket(1000.0 * static_cast<double>(t - g_cad_last_arrive) /
                                              g_qpc_freq,
                                          0.5, 1.5, 4.0, 10.0)];
            g_cad_last_arrive = t;
        }
        ++g_msg_hist[msg < 0x3FF ? msg : 0x3FF];
    }

    // ---- the input gate: a consumer's filter runs FIRST (input_gate.hpp).
    if (g_filter) {
        LRESULT r = 0;
        if (g_filter(hwnd, msg, wparam, lparam, &r)) return r;
    }
    // Captured by an overlay: no mouse message reaches the engine, whatever the
    // filter chose to let through. WM_INPUT still runs below so the button
    // tracker stays true (and send_to_engine drops what it would emit).
    if (g_captured) {
        switch (msg) {
        case WM_MOUSEMOVE:
        case WM_LBUTTONDOWN: case WM_LBUTTONUP: case WM_LBUTTONDBLCLK:
        case WM_RBUTTONDOWN: case WM_RBUTTONUP: case WM_RBUTTONDBLCLK:
        case WM_MBUTTONDOWN: case WM_MBUTTONUP: case WM_MBUTTONDBLCLK:
        case WM_XBUTTONDOWN: case WM_XBUTTONUP: case WM_XBUTTONDBLCLK:
        case WM_MOUSEWHEEL:
            return 0;
        default:
            break;
        }
    }
    // Passthrough (ENW_RAW_MOUSE=0): the subclass exists only for the gate.
    if (!g_in_raw_input) return ::CallWindowProcA(g_prev_wndproc, hwnd, msg, wparam, lparam);

    // ---- mouse messages: FORWARDED, never swallowed, with the mask corrected.
    // The engine derives every button edge from wParam's MK_ bits alone
    // (addresses.hpp, WndProc_mouse_case 0x6070F7) and WM_MOUSEMOVE feeds the
    // SAME differ as the button messages. So a message carrying a stale or a
    // premature mask can invent a click or destroy one, and the SetCursorPos
    // the engine does once a frame generates exactly such a message. Replacing
    // the bits we track makes the sequence of masks the engine sees equal to
    // the sequence our raw tracker produced, with repeats -- and a differ over
    // a sequence with repeats yields exactly the underlying transitions.
    switch (msg) {
    case WM_MOUSEMOVE: {
        ::InterlockedIncrement(&g_wm_mousemove_total);
        ::InterlockedIncrement(&g_wm_mousemove_frame);
        const WPARAM fixed = rewrite_mask(wparam);
        if (fixed != wparam) {
            ++g_legacy_move_maskchange;
            if (g_trace)
                ENW_INFO("input_trace: %8u ms  LEG  WM_MOUSEMOVE mask 0x%02X -> 0x%02X  "
                         "(a move carrying a button state the device never reported)",
                         trace_ms(), static_cast<unsigned>(wparam & 0x1F),
                         static_cast<unsigned>(fixed & 0x1F));
        }
        return ::CallWindowProcA(g_prev_wndproc, hwnd, msg, fixed, lparam);
    }
    case WM_LBUTTONDOWN: case WM_LBUTTONUP:
    case WM_RBUTTONDOWN: case WM_RBUTTONUP:
    case WM_MBUTTONDOWN: case WM_MBUTTONUP:
    case WM_XBUTTONDOWN: case WM_XBUTTONUP:
    case WM_MOUSEWHEEL: {
        bool down = false;
        const int idx = legacy_button_index(msg, wparam, &down);
        if (idx >= 0) {
            if (down) ++g_legacy_down[idx]; else ++g_legacy_up[idx];
            if (g_trace)
                ENW_INFO("input_trace: %8u ms  LEG  %s %-4s wParam mask=0x%02X tracked=0x%02X",
                         trace_ms(), button_name(idx), down ? "DOWN" : "UP",
                         static_cast<unsigned>(wparam & 0x1F),
                         static_cast<unsigned>(g_btn_mask));
        }
        return ::CallWindowProcA(g_prev_wndproc, hwnd, msg, rewrite_mask(wparam), lparam);
    }
    case WM_INPUT:
        if (g_probe) {
            const int64_t t0 = qpc_now();
            OnRawInput(lparam);
            g_probe_cost_us += 1e6 * static_cast<double>(qpc_now() - t0) / g_qpc_freq;
        } else {
            OnRawInput(lparam);
        }
        break;  // and fall through to the engine/DefWindowProc, as MSDN requires

    // ---- the focus and capture flaps ------------------------------------
    // These are traced because a Q3-lineage engine loses buttons across them
    // and because focus_guard hooks GetForegroundWindow, so the ENGINE cannot
    // see them: IN_Frame will keep believing it is foreground. WM_ACTIVATE is
    // the one that matters most -- its handler (0x606AA0) is the ONLY thing
    // that clears g_wv.activeApp (0x229A0C4), and with activeApp at 0 IN_Frame
    // tail-jumps to IN_DeactivateMouse and never calls IN_MouseMove at all.
    case WM_ACTIVATE: {
        const bool active = LOWORD(wparam) != WA_INACTIVE;
        if (g_trace || g_verbose)
            ENW_INFO("input_trace: %8u ms  FOCUS WM_ACTIVATE %s (minimized=%d). This is the one "
                     "the engine acts on: its handler is the only writer of g_wv.activeApp, and "
                     "with that zero IN_Frame never calls IN_MouseMove.",
                     trace_ms(), active ? "ACTIVE" : "INACTIVE", HIWORD(wparam) ? 1 : 0);
        if (!active) {
            clip_cursor_to_client(false);
            set_nolegacy(false);
            release_all_buttons("WM_ACTIVATE inactive");
        }
        break;
    }
    case WM_SETFOCUS:
        g_in_focus = true;
        g_first_raw_update = true;
        if (g_trace || g_verbose)
            ENW_INFO("input_trace: %8u ms  FOCUS WM_SETFOCUS", trace_ms());
        resync_buttons_from_os("WM_SETFOCUS");
        break;
    case WM_KILLFOCUS:
        g_in_focus = false;
        g_first_raw_update = true;
        if (g_trace || g_verbose)
            ENW_INFO("input_trace: %8u ms  FOCUS WM_KILLFOCUS", trace_ms());
        // Alt-tab. A clipped cursor that survives losing focus traps the mouse
        // on the game's monitor, and NOLEGACY that survives it stops the OS
        // cursor moving for the whole desktop. Both go, now, on the message --
        // not on the next frame, because there may not be one. And every
        // tracked button is released: raw input stops arriving the moment we
        // are not foreground, so a button let go while alt-tabbed is a
        // transition we will never see, and the engine's differ would hold it
        // down for the rest of the session.
        clip_cursor_to_client(false);
        set_nolegacy(false);
        release_all_buttons("WM_KILLFOCUS");
        break;
    case WM_CAPTURECHANGED:
        if (g_trace || g_verbose)
            ENW_INFO("input_trace: %8u ms  FOCUS WM_CAPTURECHANGED (capture went to 0x%p)",
                     trace_ms(), reinterpret_cast<void*>(lparam));
        break;
    default:
        break;
    }
    return ::CallWindowProcA(g_prev_wndproc, hwnd, msg, wparam, lparam);
}

// ------------------------------------------------------- the replacement move
// Upstream's RawMouse::IN_MouseMove + IN_RawMouseMove, collapsed and mapped
// onto T4's own IN_MouseMove (0x5FA6D0), whose shape is quoted at the top.
void __cdecl in_mousemove() {
    // An overlay owns the mouse: no motion reaches the engine and nothing
    // recentres or clips, so the OS cursor moves freely for the overlay. Raw
    // reports are still drained so the button tracker stays true and no stale
    // delta is waiting when the overlay closes.
    if (g_captured) {
        if (g_in_raw_input) {
            if (g_nolegacy_wanted) drain_raw_buffer();
            g_raw_x.ResetDelta();
            g_raw_y.ResetDelta();
            set_nolegacy(false);
        }
        clip_cursor_to_client(false);
        return;
    }
    if (!g_enabled || !g_in_raw_input) {
        real_in_mousemove()();
        return;
    }
    // The stock function's own first guard. Keep it: a background game must not
    // turn the player.
    // (Our call is NOT through the game's IAT, so focus_guard does not answer it:
    // this is the real foreground window. The harness sink skips it, because an
    // off-screen test game is never foreground by design.)
    if (!g_sink && ::GetForegroundWindow() != game_hwnd()) return;

    const int64_t probe_t0 = g_probe ? qpc_now() : 0;

    // Drain whatever queued up behind the WM_INPUT messages the pump already
    // dispatched. One call for the lot instead of one GetRawInputData each --
    // and GetRawInputData takes a lock per call, which is the documented reason
    // a high polling rate costs frame time (libsdl-org/SDL#8756; Valorant
    // shipped a "Raw Input Buffer" option for exactly this and later defaulted
    // it on). Only when NOLEGACY is armed: with legacy messages on, every report
    // is being dispatched as a message anyway, so there is nothing left to
    // drain and the WndProc path has already counted it.
    if (g_nolegacy_wanted) drain_raw_buffer();

    const int dx = g_raw_x.GetDelta();
    const int dy = g_raw_y.GetDelta();
    g_raw_x.ResetDelta();
    g_raw_y.ResetDelta();

    // The menu still wants a real client-space cursor position, so we read it
    // exactly as the engine does and keep the engine's own oldPos in step --
    // otherwise falling back to the stock path would produce one huge jump.
    POINT p = {};
    ::GetCursorPos(&p);
    *enw::ptr<int>(t4::var::s_wmv_oldPos_x) = p.x;
    *enw::ptr<int>(t4::var::s_wmv_oldPos_y) = p.y;
    ::ScreenToClient(game_hwnd(), &p);

    const int recentre = cl_mouse_event(p.x, p.y, dx, dy);
    if (recentre && (dx || dy)) {
        // THE THIRD LEG OF THE FLOOD. IN_RecenterMouse is SetCursorPos to the
        // window centre, and SetCursorPos synthesises a WM_MOUSEMOVE into the
        // very queue Sys_GetEvent drains completely every frame (the feedback
        // loop is a documented Win32 hazard, not a theory). The only reason the
        // engine recentres is that its deltas are differences between two
        // cursor positions and the pointer would otherwise walk off the screen.
        // With NOLEGACY registered the deltas come from the device and the OS
        // cursor is not moving at all, so recentring buys nothing and costs a
        // SetCursorPos plus a message per frame. Quake3e does the same thing:
        // IN_CaptureMouse clips once and the raw path never recentres.
        if (g_nolegacy_now) {
            clip_cursor_to_client(true);
            ++g_recentres_skipped;
        } else {
            in_recenter_mouse()();
            *enw::ptr<int>(t4::var::s_wmv_oldPos_x) = *enw::ptr<int>(t4::var::s_wmv_centre_x);
            *enw::ptr<int>(t4::var::s_wmv_oldPos_y) = *enw::ptr<int>(t4::var::s_wmv_centre_y);
        }
    }

    // CL_MouseEvent's return is the engine's own answer to "does the GAME own
    // the mouse right now, or the menu?" -- it is what decides whether to
    // recentre. Use the same answer to decide whether the legacy messages (and
    // therefore the OS cursor the menu needs) may be taken away. It is read
    // fresh every frame, so it cannot go stale the way a cached menu flag can.
    g_engine_recentring = recentre != 0;
    set_nolegacy(g_engine_recentring);
    // The clip belongs to gameplay, exactly like NOLEGACY. The menu, the
    // console and an unfocused window all get the cursor back.
    if (!g_nolegacy_now) clip_cursor_to_client(false);

    if (g_probe) {
        // The view-turn meter: what the engine was handed this frame, against
        // how long the frame was. Gameplay frames only (the engine owns the
        // mouse); a menu frame resets the neighbour window.
        const int64_t now = qpc_now();
        const double cost = 1e6 * static_cast<double>(now - probe_t0) / g_qpc_freq;
        g_probe_cost_us += cost;
        if (cost > g_probe_cost_max_us) g_probe_cost_max_us = cost;
        ++g_probe_frames;
        // T4 calls IN_MouseMove TWICE per engine frame (measured 2026-09-23 12:14:
        // "4@4.8 0@0.4 3@2.7 0@0.2 ..." -- a call with the frame's counts, then one
        // ~0.3 ms later that finds almost nothing). Metering per CALL scored every
        // second call as a dropout (the 90 %+ "jitter" of the first benches). So
        // the calls are summed here and the meter is fed once per engine frame by
        // probe_frame_flush() from the frame tick.
        if (g_frame_calls == 0) g_frame_first_qpc = probe_t0;  // this frame's sampling instant
        if (recentre) {
            g_frame_dx += dx;
            g_frame_dy += dy;
            g_frame_owned = true;
        }
        ++g_frame_calls;
        if (g_probe_last_qpc && recentre && (dx || dy || g_frame_dx || g_frame_dy)) {
            const double dt = 1000.0 * static_cast<double>(now - g_probe_last_qpc) / g_qpc_freq;
            const double d = std::sqrt(static_cast<double>(dx) * dx + static_cast<double>(dy) * dy);
            ++g_cad_counts[d <= 0.0 ? 0 : cad_bucket(d, 0.0, 2.5, 5.5, 10.5)];
            ++g_cad_dt[cad_bucket(dt, 1.0, 3.0, 5.0, 10.0)];
        }
        g_probe_last_qpc = now;
    }
}

// Once per engine frame (the frame tick): the view-turn meter's input is what
// the engine was handed over the whole frame, against the frame's length.
void probe_frame_flush() {
    if (!g_probe || !g_qpc_freq) return;
    // dt is between the FIRST in_mousemove of consecutive frames: that call is
    // where the frame's counts are sampled (right after the pump), so it is the
    // interval the counts really cover. Frame-tick-to-frame-tick carries the
    // render time's variation instead and read ~40 % on an even source.
    if (!g_frame_calls) { g_frame_owned = false; return; }
    const int64_t now = g_frame_first_qpc;
    if (g_probe_frame_qpc && g_frame_owned) {
        const double dt = 1000.0 * static_cast<double>(now - g_probe_frame_qpc) / g_qpc_freq;
        const double d = std::sqrt(static_cast<double>(g_frame_dx) * g_frame_dx +
                                   static_cast<double>(g_frame_dy) * g_frame_dy);
        g_jit.add(d, dt);
        ++g_cad_calls[g_frame_calls < 3 ? g_frame_calls : 3];
        if (g_jit.delivered() > 0.0 && g_cad_sample_n < 24) {
            const size_t used = std::strlen(g_cad_sample);
            std::snprintf(g_cad_sample + used, sizeof g_cad_sample - used, "%s%.0f@%.1f",
                          g_cad_sample_n ? " " : "", d, dt);
            ++g_cad_sample_n;
        }
    }
    g_probe_frame_qpc = now;
    g_frame_dx = g_frame_dy = 0;
    g_frame_calls = 0;
    g_frame_owned = false;
}

// One line per ~10 s window when the probe is on. Called from the frame tick.
void probe_report(bool final_line) {
    if (!g_probe || !g_qpc_freq) return;
    const int64_t now = qpc_now();
    if (!g_probe_window_qpc) {
        g_probe_window_qpc = now;
        return;
    }
    const double secs = static_cast<double>(now - g_probe_window_qpc) / g_qpc_freq;
    if (!final_line && secs < 10.0) return;
    const long msg_r = g_msg_reports - g_probe_msg_reports0;
    const long buf_r = g_buf_reports - g_probe_buf_reports0;
    const double msg_m = g_msg_motion - g_probe_msg_motion0;
    const double buf_m = g_buf_motion - g_probe_buf_motion0;
    ENW_INFO("mouse_jitter: window %ld (%.1f s) -- view turn: %ld moving frames, jitter %.1f%%, "
             "p50 err %d%%, p99 err %d%%, DROPOUTS %ld (a frame that turned by 0 between two that "
             "moved) | counts handed to the engine %.0f (%.0f/s) | reports: dispatched %ld "
             "carrying %.0f counts, buffered %ld carrying %.0f counts (RAWMOUSE @+%u, WOW64 fix "
             "%s) | our input code: %.1f us/call avg, %.1f us worst in_mousemove",
             ++g_probe_window, secs, g_jit.moving_frames(), g_jit.jitter_pct(),
             g_jit.pct_error_percentile(0.50), g_jit.pct_error_percentile(0.99), g_jit.dropouts(),
             g_jit.delivered(), secs > 0 ? g_jit.delivered() / secs : 0.0, msg_r, msg_m, buf_r,
             buf_m, g_rawbuf_off, g_wow64fix ? "ON" : "OFF (ENW_RAW_MOUSE_WOW64FIX=0, A/B only)",
             g_probe_frames ? g_probe_cost_us / g_probe_frames : 0.0, g_probe_cost_max_us);
    unsigned top = 0;
    for (unsigned m = 0; m < 0x400; ++m)
        if (m != WM_INPUT && g_msg_hist[m] > g_msg_hist[top]) top = m;
    ENW_INFO("mouse_jitter: window %ld plumbing -- WM_INPUT seen by our proc %ld, "
             "GetRawInputData failed %ld (first error %lu), non-mouse %ld | busiest other "
             "message 0x%04X x%ld",
             g_probe_window, g_wm_input_seen, g_rid_fail, g_rid_fail_err, g_rid_notmouse, top,
             g_msg_hist[top]);
    ENW_INFO("mouse_jitter: window %ld cadence -- WM_INPUT gaps <0.5/0.5-1.5/1.5-4/4-10/>=10 ms: "
             "%ld/%ld/%ld/%ld/%ld | per in_mousemove counts 0/1-2/3-5/6-10/>10: %ld/%ld/%ld/%ld/%ld "
             "| call spacing <1/1-3/3-5/5-10/>=10 ms: %ld/%ld/%ld/%ld/%ld | engine frames with "
             "0/1/2/3+ calls: %ld/%ld/%ld/%ld | per-FRAME sample counts@ms: %s",
             g_probe_window, g_cad_arrive[0], g_cad_arrive[1], g_cad_arrive[2], g_cad_arrive[3],
             g_cad_arrive[4], g_cad_counts[0], g_cad_counts[1], g_cad_counts[2], g_cad_counts[3],
             g_cad_counts[4], g_cad_dt[0], g_cad_dt[1], g_cad_dt[2], g_cad_dt[3], g_cad_dt[4],
             g_cad_calls[0], g_cad_calls[1], g_cad_calls[2], g_cad_calls[3],
             g_cad_sample_n ? g_cad_sample : "-");
    std::memset(g_cad_calls, 0, sizeof g_cad_calls);
    std::memset(g_cad_arrive, 0, sizeof g_cad_arrive);
    std::memset(g_cad_counts, 0, sizeof g_cad_counts);
    std::memset(g_cad_dt, 0, sizeof g_cad_dt);
    g_cad_sample[0] = 0;
    g_cad_sample_n = 0;
    std::memset(g_msg_hist, 0, sizeof g_msg_hist);
    g_wm_input_seen = 0;
    g_jit.reset();
    g_probe_window_qpc = now;
    g_probe_cost_us = g_probe_cost_max_us = 0.0;
    g_probe_frames = 0;
    g_probe_msg_reports0 = g_msg_reports;
    g_probe_buf_reports0 = g_buf_reports;
    g_probe_msg_motion0 = g_msg_motion;
    g_probe_buf_motion0 = g_buf_motion;
}

// ------------------------------------------------------------------ component
bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

bool env_off(const char* name) {
    const char* v = std::getenv(name);
    return v && (v[0] == '0') && v[1] == '\0';
}
bool env_on(const char* name) {
    const char* v = std::getenv(name);
    return v && v[0] && !(v[0] == '0' && v[1] == '\0');
}

bool install_window_hook() {
    g_hwnd = game_hwnd();
    if (!g_hwnd || !::IsWindow(g_hwnd)) return false;

    // Self-verifying check #2: this must be the engine's own game window, i.e.
    // the proc that routes mouse buttons into IN_MouseEvent.
    const auto current = reinterpret_cast<uintptr_t>(
        reinterpret_cast<void*>(::GetWindowLongPtrA(g_hwnd, GWLP_WNDPROC)));
    const uintptr_t expected = enw::at(t4::fn::WndProc_game);
    if (current != expected) {
        ENW_ERROR("mouse_polling: NOT subclassing 0x%p: its WndProc is 0x%08X, expected "
                  "0x%08X (the game proc). Leaving the stock mouse path alone.",
                  g_hwnd, static_cast<unsigned>(current), static_cast<unsigned>(expected));
        g_hwnd = nullptr;
        return false;
    }

    g_prev_wndproc = reinterpret_cast<WNDPROC>(
        ::SetWindowLongPtrA(g_hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&wndproc)));
    if (!g_prev_wndproc) {
        ENW_ERROR("mouse_polling: SetWindowLongPtrA failed, GetLastError=%lu", ::GetLastError());
        g_hwnd = nullptr;
        return false;
    }

    if (g_passthrough) {
        ENW_INFO("mouse_polling: PASSTHROUGH subclass on hwnd=0x%p (WndProc 0x%08X). Raw input is "
                 "OFF (ENW_RAW_MOUSE=0) and the stock mouse path runs unchanged; the subclass is "
                 "there only for the input gate (the chat overlay). ENW_CHAT_OVERLAY=0 removes it.",
                 g_hwnd, static_cast<unsigned>(expected));
        return true;
    }
    if (!ToggleRawInput(true)) {
        // Put the proc back rather than leave a subclass that does nothing.
        ::SetWindowLongPtrA(g_hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(g_prev_wndproc));
        g_prev_wndproc = nullptr;
        g_hwnd = nullptr;
        return false;
    }

    g_in_focus = (::GetForegroundWindow() == g_hwnd);
    ENW_INFO("mouse_polling: RAW INPUT ON. hwnd=0x%p, WndProc 0x%08X subclassed, "
             "RegisterRawInputDevices(usage 1/2, dwFlags=0) ok. Mouse motion now comes from "
             "WM_INPUT counts, not from GetCursorPos pixels. Legacy messages are KEPT at this "
             "moment and %s -- watch for the `legacy mouse messages OFF` line a frame or two "
             "from here, which is NOLEGACY arming as soon as CL_MouseEvent says the game owns "
             "the mouse. Off switch: ENW_RAW_MOUSE=0.",
             g_hwnd, static_cast<unsigned>(expected),
             g_nolegacy_wanted ? "will be dropped in gameplay (NOLEGACY is the default)"
                               : "will stay on (ENW_RAW_MOUSE_NOLEGACY=0)");
    return true;
}

class mouse_polling final : public component {
public:
    const char* name() const override { return "mouse_polling"; }

    bool is_supported() override { return !is_dedicated_process(); }

    void post_unpack() override {
        if (env_off("ENW_RAW_MOUSE")) {
            g_enabled = false;
            ENW_INFO("mouse_polling: OFF (ENW_RAW_MOUSE=0). The stock GetCursorPos mouse path "
                     "runs unchanged -- expect the high-polling-rate stutter back.");
            // The chat overlay still needs the one subclass (input_gate.hpp).
            if (env_off("ENW_CHAT_OVERLAY")) return;
            g_passthrough = true;
            ENW_INFO("mouse_polling: installing the subclass and the IN_MouseMove retarget in "
                     "PASSTHROUGH mode for the input gate; both hand straight to the engine.");
        }
        g_verbose = env_on("ENW_RAW_MOUSE_VERBOSE");

        // The button tracker. ON by default -- it is the fix, not an
        // experiment -- with a one-word revert for a machine where raw button
        // reports turn out not to arrive.
        g_btn_track = !env_off("ENW_RAW_MOUSE_BUTTONS");
        g_trace = env_on("ENW_INPUT_TRACE");
        {
            LARGE_INTEGER f{}, n{};
            if (::QueryPerformanceFrequency(&f) && ::QueryPerformanceCounter(&n) && f.QuadPart) {
                g_qpc_freq = static_cast<double>(f.QuadPart);
                g_qpc0 = n.QuadPart;
            }
        }
        if (!g_btn_track)
            ENW_WARN("mouse_polling: BUTTON TRACKING OFF (ENW_RAW_MOUSE_BUTTONS=0). Legacy mouse "
                     "messages pass through with the mask Windows put in them, which is the "
                     "0.2.2/0.2.3 behaviour and the thing that dropped clicks. Use this only to "
                     "A/B the fix.");
        if (g_trace)
            ENW_INFO("mouse_polling: INPUT TRACE ON (ENW_INPUT_TRACE=1). Every raw button "
                     "transition, every legacy mouse message whose mask we corrected, every "
                     "focus/capture flap, and every K_MOUSE key event THE ENGINE ACTUALLY "
                     "QUEUED (read straight out of the Sys_QueEvent ring at 0x22BBF48 -- read, "
                     "not hooked) is logged with a millisecond timestamp, and a verdict line "
                     "per button prints every ~15 s and at shutdown. A drop is a raw transition "
                     "with no matching queued event; a double is two queued events for one "
                     "transition.");
        // 2026-09-23 (client.md §1f): the buffered read's RAWMOUSE offset, the
        // bulk-read switch, the harness sink, and the view-turn probe.
        g_wow64fix = !env_off("ENW_RAW_MOUSE_WOW64FIX");
        g_rawbuf_off = g_wow64fix ? enw::rawbuf::mouse_offset()
                                  : static_cast<unsigned>(sizeof(RAWINPUTHEADER));
        if (env_off("ENW_RAW_MOUSE_BUFFER")) g_bulk_read = false;
        g_sink = env_on("ENW_RAW_MOUSE_INPUTSINK");
        g_probe = env_on("ENW_MOUSE_JITTER") || env_on("ENW_FRAMETIME");
        ENW_INFO("mouse_polling: GetRawInputBuffer blocks are read with the RAWMOUSE at +%u "
                 "(%s). Bulk read %s.%s%s",
                 g_rawbuf_off,
                 g_wow64fix ? (g_rawbuf_off == 24 ? "WOW64: the 64-bit header layout, the fix"
                                                  : "native header layout")
                            : "ENW_RAW_MOUSE_WOW64FIX=0: the 0.2.3-0.2.20 BUG, every buffered "
                              "report reads zero motion and zero buttons -- A/B only",
                 g_bulk_read ? "on" : "OFF (ENW_RAW_MOUSE_BUFFER=0: every report via its WM_INPUT)",
                 g_sink ? " HARNESS: RIDEV_INPUTSINK on (ENW_RAW_MOUSE_INPUTSINK=1), no ClipCursor."
                        : "",
                 g_probe ? " View-turn probe ON (mouse_jitter lines every 10 s)." : "");

        // DEFAULT ON since 0.2.3. `ENW_RAW_MOUSE_NOLEGACY=0` is the one-word
        // A/B back to 0.2.2's behaviour.
        g_nolegacy_wanted = !env_off("ENW_RAW_MOUSE_NOLEGACY");
        if (g_nolegacy_wanted)
            ENW_INFO("mouse_polling: NOLEGACY mode armed (the default; ENW_RAW_MOUSE_NOLEGACY=0 "
                     "reverts to 0.2.2). While the game owns the mouse: Windows generates no "
                     "WM_MOUSEMOVE per device report, the queued reports are read in bulk with "
                     "GetRawInputBuffer once a frame (the dispatched one is still read with "
                     "GetRawInputData, because GetMessage has already taken it out of the "
                     "buffered queue), IN_RecenterMouse is SKIPPED in favour of a ClipCursor to "
                     "the client rect, and buttons are handed back to the engine's own WndProc "
                     "as legacy messages. All three come straight back the moment the menu, the "
                     "console or another window takes the mouse. ENW_RAW_MOUSE=0 is the full "
                     "revert to the stock GetCursorPos path.");
        else
            ENW_INFO("mouse_polling: NOLEGACY OFF (ENW_RAW_MOUSE_NOLEGACY=0). Legacy mouse "
                     "messages are kept, every device report is dispatched as a WM_MOUSEMOVE as "
                     "well as a WM_INPUT, and IN_RecenterMouse runs every frame. This is what "
                     "0.2.2 did.");

        // Self-verifying check #1: is 0x5FA8E4 really `call IN_MouseMove`?
        const uintptr_t site = enw::at(t4::fn::IN_MouseMove_callsite);
        const uintptr_t target = memory::call_target(site);
        const uintptr_t expected = enw::at(t4::fn::IN_MouseMove);
        if (target != expected) {
            ENW_ERROR("mouse_polling: NOT patching 0x%08X: it calls 0x%08X, expected 0x%08X "
                      "(IN_MouseMove). The raw-input fix is disabled; the stock mouse path "
                      "is untouched.",
                      static_cast<unsigned>(t4::fn::IN_MouseMove_callsite),
                      static_cast<unsigned>(target), static_cast<unsigned>(expected));
            g_enabled = false;
            g_passthrough = false;
            return;
        }
        // Self-verifying check #1b. `looks_like_function()` is the WRONG tool here and
        // run 1 proved it: CL_MouseEvent is optimised and has no standard prologue --
        // it opens `test byte ptr [0x3058424], 0x10` -- so the heuristic refused a
        // perfectly correct address. A byte compare against the dump is both stricter
        // and right.
        uint8_t head[sizeof kCLMouseEventHead] = {};
        if (!memory::read_raw(enw::at(t4::fn::CL_MouseEvent), head, sizeof head) ||
            std::memcmp(head, kCLMouseEventHead, sizeof head) != 0) {
            ENW_ERROR("mouse_polling: 0x%08X is not CL_MouseEvent on this image: expected "
                      "F6 05 24 84 05 03 10 56, found %s. Refusing.",
                      static_cast<unsigned>(t4::fn::CL_MouseEvent),
                      memory::hex_dump(enw::at(t4::fn::CL_MouseEvent), 8).c_str());
            g_enabled = false;
            g_passthrough = false;
            return;
        }
        g_cl_mouse_event = enw::at(t4::fn::CL_MouseEvent);

        if (!memory::retarget_call(site, &in_mousemove)) {
            ENW_ERROR("mouse_polling: retarget_call on 0x%08X failed",
                      static_cast<unsigned>(t4::fn::IN_MouseMove_callsite));
            g_enabled = false;
            g_passthrough = false;
            return;
        }
        ENW_INFO("mouse_polling: IN_Frame's `call IN_MouseMove` (0x%08X -> 0x%08X) now goes to "
                 "our raw-input mouse move. The engine's IN_MouseMove bytes are untouched and "
                 "are still the fallback.",
                 static_cast<unsigned>(t4::fn::IN_MouseMove_callsite),
                 static_cast<unsigned>(t4::fn::IN_MouseMove));
    }

    void post_init() override {
        if (!g_enabled && !g_passthrough) return;

        // The window does not exist yet at post_unpack (~110 ms, before the
        // renderer). Install from the frame tick, first chance we get.
        frame::subscribe("mouse_polling", [](uint64_t n) {
            if (!g_installed) {
                if (!g_enabled && !g_passthrough) return;
                if (install_window_hook()) g_installed = true;
                return;
            }
            // `vid_restart` destroys the game window and makes a new one (borderless.cpp
            // says the same). The subclass -- and with it the input gate the chat overlay
            // and the Esc menu live on -- and the raw-input registration (hwndTarget) went
            // with the old one. Install again on the new window. esc-menu.md §9.
            {
                const HWND now = game_hwnd();
                if (g_hwnd && (!::IsWindow(g_hwnd) || (now && now != g_hwnd))) {
                    if (!now || !::IsWindow(now)) return;   // mid-restart: no window yet
                    ENW_INFO("mouse_polling: the game window was recreated (0x%p -> 0x%p, vid_restart); "
                             "installing the subclass%s again", g_hwnd, now,
                             g_passthrough ? "" : " and raw input");
                    const HWND old = g_hwnd;
                    g_in_raw_input = false;   // the registration named the dead window
                    g_nolegacy_now = false;
                    g_prev_wndproc = nullptr;
                    if (!install_window_hook()) {
                        ENW_WARN("mouse_polling: could not install on the new window 0x%p; will retry", now);
                        g_hwnd = old;   // compare against the old one again next frame
                        return;
                    }
                }
            }
            if (!g_in_raw_input) return;  // passthrough: nothing to count
            probe_frame_flush();
            probe_report(false);

            // HARNESS ONLY (ENW_RAW_MOUSE_INPUTSINK=1). A never-activated test
            // window never gets WM_ACTIVATE, so g_wv.activeApp stays 0 and
            // IN_Frame (0x5FA8A0) tail-jumps to IN_DeactivateMouse instead of
            // calling IN_MouseMove. With activeApp != 0 the path from 0x5FA8AF
            // to our retarget at 0x5FA8E4 has no side effects (no ClipCursor,
            // no SetCapture, no ShowCursor -- read from the dump), so holding it
            // at 1 is the smallest change that lets the synthetic mouse reach
            // CL_MouseEvent. Never set by the launcher.
            if (g_sink && *enw::ptr<int>(t4::var::g_wv_activeApp) == 0) {
                *enw::ptr<int>(t4::var::g_wv_activeApp) = 1;
                static bool said = false;
                if (!said) {
                    said = true;
                    ENW_WARN("mouse_polling: HARNESS: g_wv.activeApp held at 1 "
                             "(ENW_RAW_MOUSE_INPUTSINK=1) so an off-screen, never-activated "
                             "test game runs IN_MouseMove.");
                }
            }

            // Ground truth for the trace, and cheap: two reads and a walk of
            // whatever the engine queued since the last frame. Only when asked.
            if (g_trace) {
                drain_engine_event_ring();
                const int aa = *enw::ptr<int>(t4::var::g_wv_activeApp) ? 1 : 0;
                const int ma = *enw::ptr<unsigned char>(t4::var::s_wmv_mouseActive) ? 1 : 0;
                if (aa != g_last_active_app) {
                    if (g_last_active_app >= 0)
                        ENW_INFO("input_trace: %8u ms  ENGINE g_wv.activeApp %d -> %d. While this "
                                 "is 0, IN_Frame tail-jumps to IN_DeactivateMouse and our "
                                 "IN_MouseMove replacement is NOT CALLED.",
                                 trace_ms(), g_last_active_app, aa);
                    g_last_active_app = aa;
                }
                if (ma != g_last_mouse_active) {
                    if (g_last_mouse_active >= 0)
                        ENW_INFO("input_trace: %8u ms  ENGINE s_wmv.mouseActive %d -> %d "
                                 "(focus_guard hooks GetForegroundWindow, so this reflects our "
                                 "answer, not the desktop's)",
                                 trace_ms(), g_last_mouse_active, ma);
                    g_last_mouse_active = ma;
                }
            }

            const long ev = ::InterlockedExchange(&g_events_this_frame, 0);
            if (ev > 0) {
                ++g_frames_with_events;
                if (ev > g_events_peak_frame) g_events_peak_frame = ev;
            }
            const long mm = ::InterlockedExchange(&g_wm_mousemove_frame, 0);
            if (mm > g_wm_mousemove_peak) g_wm_mousemove_peak = mm;
            const long ms = ::InterlockedExchange(&g_msgs_frame, 0);
            if (ms > g_msgs_peak) g_msgs_peak = ms;

            // One line every ~15 s at 60 fps. This is the evidence B's real
            // test produces: events/frame scales with the report rate, and at
            // 1000 Hz on a 60 fps client it should sit around 16.
            if (n - g_last_report_frame >= 900) {
                g_last_report_frame = n;
                update_rate_hz();
                ENW_INFO("mouse_polling: measured device rate %.0f Hz now, %.0f Hz peak this "
                         "session (125/500/1000/4000/8000 is what the mouse is set to). This is "
                         "CoD2x's `m_rinput_hz` in a log line: it is the number that says "
                         "whether the reports are reaching the game at all.",
                         g_rate_hz, g_rate_hz_peak);
                ENW_INFO("mouse_polling: WM_INPUT total=%ld, peak/frame=%ld, frames with "
                         "motion=%ld, raw=%s focus=%s | legacy WM_MOUSEMOVE total=%ld "
                         "peak/frame=%ld | ALL messages through our proc total=%ld "
                         "peak/frame=%ld",
                         g_events_total, g_events_peak_frame, g_frames_with_events,
                         g_in_raw_input ? "on" : "off", g_in_focus ? "yes" : "no",
                         g_wm_mousemove_total, g_wm_mousemove_peak, g_msgs_total, g_msgs_peak);
                if (g_nolegacy_wanted)
                    ENW_INFO("mouse_polling: NOLEGACY is %s right now (%ld flips); "
                             "GetRawInputBuffer: %s, %ld call(s) for %ld report(s) = %.1f "
                             "reports per call; IN_RecenterMouse skipped %ld time(s) "
                             "(ClipCursor %s instead)",
                             g_nolegacy_now ? "ON" : "off", g_nolegacy_flips,
                             g_bulk_read ? "in use" : "FAILED, per-message fallback",
                             g_buffered_reads, g_buffered_reports,
                             g_buffered_reads ? static_cast<double>(g_buffered_reports) /
                                                    static_cast<double>(g_buffered_reads)
                                              : 0.0,
                             g_recentres_skipped, g_cursor_clipped ? "on" : "off");
                if (g_trace) report_verdict("15 s window");
            }
        });
    }

    void pre_destroy() override {
        // Nothing may be left held down in the engine's differ.
        release_all_buttons("shutdown");
        if (g_in_raw_input) probe_report(true);
        if (g_trace) {
            drain_engine_event_ring();
            report_verdict("session total");
        }
        // Put the legacy messages back BEFORE unregistering, so a game that is
        // shutting down never leaves the desktop without a moving cursor.
        set_nolegacy(false);
        clip_cursor_to_client(false);
        if (g_in_raw_input) ToggleRawInput(false);
        if (g_hwnd && g_prev_wndproc && ::IsWindow(g_hwnd))
            ::SetWindowLongPtrA(g_hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(g_prev_wndproc));
        if (g_events_total)
            ENW_INFO("mouse_polling: %ld WM_INPUT mouse messages this session, peak %ld in one "
                     "frame", g_events_total, g_events_peak_frame);
    }
};

#else

class mouse_polling final : public component {
public:
    const char* name() const override { return "mouse_polling"; }
};

#endif

ENW_REGISTER_COMPONENT(mouse_polling)

}  // namespace

// ------------------------------------------------------------ the input gate
// input_gate.hpp. Main thread only, like everything else on the message path.
namespace input_gate {
#ifdef ENW_HAVE_T4_ADDRESSES

void set_filter(filter_fn fn) { g_filter = fn; }

void set_captured(bool on) {
    if (on == g_captured) return;
    if (on) {
        // Release BEFORE the flag goes up, while send_to_engine still delivers:
        // a button held when the overlay opens must not stay held in the engine's
        // differ (a stuck +attack while typing).
        if (g_btn_track && g_in_raw_input) {
            release_all_buttons("overlay opened");
        } else if (g_prev_wndproc && g_hwnd) {
            ::CallWindowProcA(g_prev_wndproc, g_hwnd, WM_MOUSEMOVE, 0, cursor_lparam());
        }
        g_captured = true;
        set_nolegacy(false);
        clip_cursor_to_client(false);
        g_raw_x.ResetDelta();
        g_raw_y.ResetDelta();
    } else {
        g_captured = false;
        g_first_raw_update = true;
        g_raw_x.ResetDelta();
        g_raw_y.ResetDelta();
        // The tracker kept counting while captured; hand the engine the truth
        // once so a button still physically held is one clean edge, not a loss.
        if (g_btn_track && g_in_raw_input) resync_buttons_from_os("overlay closed");
    }
}

bool captured() { return g_captured; }
bool installed() { return g_installed && g_prev_wndproc != nullptr; }
HWND window() { return g_hwnd; }

LRESULT send_to_engine(UINT msg, WPARAM wparam, LPARAM lparam) {
    if (!g_prev_wndproc || !g_hwnd) return 0;
    return ::CallWindowProcA(g_prev_wndproc, g_hwnd, msg, wparam, lparam);
}

#else
void set_filter(filter_fn) {}
void set_captured(bool) {}
bool captured() { return false; }
bool installed() { return false; }
HWND window() { return nullptr; }
LRESULT send_to_engine(UINT, WPARAM, LPARAM) { return 0; }
#endif
}  // namespace input_gate
}  // namespace enw::client
