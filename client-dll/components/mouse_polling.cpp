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

#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"
#include "memory.hpp"

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
    rid[0].dwFlags = enable ? (nolegacy ? RIDEV_NOLEGACY : 0u) : RIDEV_REMOVE;
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

// The buttons, put back on the engine's own path as the legacy messages it
// expects. One message per transition, never per motion report.
void synth_buttons(USHORT flags, SHORT wheel) {
    if (!flags || !g_prev_wndproc || !g_hwnd) return;
    POINT p = {};
    ::GetCursorPos(&p);
    ::ScreenToClient(g_hwnd, &p);
    const LPARAM lp = MAKELPARAM(static_cast<WORD>(p.x), static_cast<WORD>(p.y));

    // The engine reads the *other* buttons' state out of wParam, so build it the
    // way Windows would rather than passing zero.
    WPARAM wp = 0;
    if (::GetAsyncKeyState(VK_LBUTTON) & 0x8000) wp |= MK_LBUTTON;
    if (::GetAsyncKeyState(VK_RBUTTON) & 0x8000) wp |= MK_RBUTTON;
    if (::GetAsyncKeyState(VK_MBUTTON) & 0x8000) wp |= MK_MBUTTON;
    if (::GetAsyncKeyState(VK_XBUTTON1) & 0x8000) wp |= MK_XBUTTON1;
    if (::GetAsyncKeyState(VK_XBUTTON2) & 0x8000) wp |= MK_XBUTTON2;
    if (::GetAsyncKeyState(VK_SHIFT) & 0x8000) wp |= MK_SHIFT;
    if (::GetAsyncKeyState(VK_CONTROL) & 0x8000) wp |= MK_CONTROL;

    struct { USHORT flag; UINT msg; WPARAM extra; } map[] = {
        {RI_MOUSE_LEFT_BUTTON_DOWN, WM_LBUTTONDOWN, 0},
        {RI_MOUSE_LEFT_BUTTON_UP, WM_LBUTTONUP, 0},
        {RI_MOUSE_RIGHT_BUTTON_DOWN, WM_RBUTTONDOWN, 0},
        {RI_MOUSE_RIGHT_BUTTON_UP, WM_RBUTTONUP, 0},
        {RI_MOUSE_MIDDLE_BUTTON_DOWN, WM_MBUTTONDOWN, 0},
        {RI_MOUSE_MIDDLE_BUTTON_UP, WM_MBUTTONUP, 0},
        {RI_MOUSE_BUTTON_4_DOWN, WM_XBUTTONDOWN, XBUTTON1},
        {RI_MOUSE_BUTTON_4_UP, WM_XBUTTONUP, XBUTTON1},
        {RI_MOUSE_BUTTON_5_DOWN, WM_XBUTTONDOWN, XBUTTON2},
        {RI_MOUSE_BUTTON_5_UP, WM_XBUTTONUP, XBUTTON2},
    };
    for (const auto& m : map) {
        if (!(flags & m.flag)) continue;
        const WPARAM w = m.extra ? MAKEWPARAM(static_cast<WORD>(wp), static_cast<WORD>(m.extra)) : wp;
        ::CallWindowProcA(g_prev_wndproc, g_hwnd, m.msg, w, lp);
    }
    if (flags & RI_MOUSE_WHEEL)
        ::CallWindowProcA(g_prev_wndproc, g_hwnd, WM_MOUSEWHEEL,
                          MAKEWPARAM(static_cast<WORD>(wp), static_cast<WORD>(wheel)), lp);
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
                const RAWMOUSE& m = ri->data.mouse;
                const bool absolute = (m.usFlags & MOUSE_MOVE_ABSOLUTE) != 0;
                g_raw_x.Update(m.lLastX, absolute);
                g_raw_y.Update(m.lLastY, absolute);
                // Only while NOLEGACY is actually registered. In the menu the
                // legacy messages are back and the engine is already getting
                // the clicks; synthesising here as well would double them.
                if (m.usButtonFlags && g_nolegacy_now)
                    synth_buttons(m.usButtonFlags, static_cast<SHORT>(m.usButtonData));
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
    if (got == static_cast<UINT>(-1) || raw.header.dwType != RIM_TYPEMOUSE) return;

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

    const bool absolute = (raw.data.mouse.usFlags & MOUSE_MOVE_ABSOLUTE) != 0;
    g_raw_x.Update(raw.data.mouse.lLastX, absolute);
    g_raw_y.Update(raw.data.mouse.lLastY, absolute);

    // With RIDEV_NOLEGACY there is no WM_LBUTTONDOWN either, so this event's
    // button transitions have to go back onto the engine's own path -- the same
    // thing drain_raw_buffer() does for the reports it consumes. Only while
    // NOLEGACY is actually registered: with legacy messages on, the engine is
    // already getting them and synthesising would double every click.
    if (g_nolegacy_now && raw.data.mouse.usButtonFlags)
        synth_buttons(raw.data.mouse.usButtonFlags,
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

LRESULT CALLBACK wndproc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
    ::InterlockedIncrement(&g_msgs_total);
    ::InterlockedIncrement(&g_msgs_frame);
    switch (msg) {
    case WM_MOUSEMOVE:
        // The legacy half of the flood. We do not consume it -- the menu cursor
        // and the engine's own button routing live on this path -- we count it.
        ::InterlockedIncrement(&g_wm_mousemove_total);
        ::InterlockedIncrement(&g_wm_mousemove_frame);
        break;
    case WM_INPUT:
        OnRawInput(lparam);
        break;  // and fall through to the engine/DefWindowProc, as MSDN requires
    case WM_SETFOCUS:
        g_in_focus = true;
        g_first_raw_update = true;
        break;
    case WM_KILLFOCUS:
        g_in_focus = false;
        g_first_raw_update = true;
        // Alt-tab. A clipped cursor that survives losing focus traps the mouse
        // on the game's monitor, and NOLEGACY that survives it stops the OS
        // cursor moving for the whole desktop. Both go, now, on the message --
        // not on the next frame, because there may not be one.
        clip_cursor_to_client(false);
        set_nolegacy(false);
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
    if (!g_enabled || !g_in_raw_input) {
        real_in_mousemove()();
        return;
    }
    // The stock function's own first guard. Keep it: a background game must not
    // turn the player.
    if (::GetForegroundWindow() != game_hwnd()) return;

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
            return;
        }
        g_verbose = env_on("ENW_RAW_MOUSE_VERBOSE");
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
            return;
        }
        g_cl_mouse_event = enw::at(t4::fn::CL_MouseEvent);

        if (!memory::retarget_call(site, &in_mousemove)) {
            ENW_ERROR("mouse_polling: retarget_call on 0x%08X failed",
                      static_cast<unsigned>(t4::fn::IN_MouseMove_callsite));
            g_enabled = false;
            return;
        }
        ENW_INFO("mouse_polling: IN_Frame's `call IN_MouseMove` (0x%08X -> 0x%08X) now goes to "
                 "our raw-input mouse move. The engine's IN_MouseMove bytes are untouched and "
                 "are still the fallback.",
                 static_cast<unsigned>(t4::fn::IN_MouseMove_callsite),
                 static_cast<unsigned>(t4::fn::IN_MouseMove));
    }

    void post_init() override {
        if (!g_enabled) return;

        // The window does not exist yet at post_unpack (~110 ms, before the
        // renderer). Install from the frame tick, first chance we get.
        frame::subscribe("mouse_polling", [](uint64_t n) {
            if (!g_installed) {
                if (!g_enabled) return;
                if (install_window_hook()) g_installed = true;
                return;
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
            }
        });
    }

    void pre_destroy() override {
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
}  // namespace enw::client
