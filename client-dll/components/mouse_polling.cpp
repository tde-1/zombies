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
// * Subclass the game window's WndProc (its hwnd is at [0x22C1BE4]) and
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
// subclass really has 0x606B60 as its WndProc. Either check failing means the
// image is not the one these addresses came from; we log loudly and leave the
// stock path alone rather than guess.
//
// ===========================================================================
// DEVIATIONS FROM UPSTREAM (deliberate, each with a reason)
// ===========================================================================
// 1. NO RIDEV_NOLEGACY. iw4x registers RIDEV_INPUTSINK|RIDEV_NOLEGACY and
//    reimplements every mouse button from the raw button flags. On T4 the
//    buttons come from the game WndProc (0x606B60 -> IN_MouseEvent 0x5FA5F0 ->
//    Sys_QueEvent), and suppressing legacy messages would take the OS cursor
//    away from the menu path as well. We register with dwFlags = 0 and take
//    only MOTION from raw input, so buttons, the wheel and the menu cursor
//    keep working exactly as they do today. That also means we do NOT port
//    upstream's ProcessMouseRawEvent / OnLegacyMouseEvent / mw_up / mw_down.
//    If B's test shows the residual message flood still matters, NOLEGACY plus
//    the button port is the next step and it is a bigger change.
// 2. No ClipCursor. Upstream clips the cursor to the client rect; that is a
//    separate windowed-mode fix and is tracked in docs/kickstart/client.md.
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

// ------------------------------------------------------------- the raw input
bool ToggleRawInput(bool enable) {
    if (!g_enabled) enable = false;
    if (g_in_raw_input == enable) return g_in_raw_input;

    RAWINPUTDEVICE rid[1] = {};
    rid[0].usUsagePage = 0x01;  // HID_USAGE_PAGE_GENERIC
    rid[0].usUsage = 0x02;      // HID_USAGE_GENERIC_MOUSE
    // DEVIATION 1: dwFlags = 0, not RIDEV_INPUTSINK|RIDEV_NOLEGACY. See the
    // header. Foreground-only is what we want anyway: a background game must
    // not read the mouse.
    rid[0].dwFlags = enable ? 0u : RIDEV_REMOVE;
    rid[0].hwndTarget = enable ? g_hwnd : nullptr;

    if (::RegisterRawInputDevices(rid, 1, sizeof rid[0]) != TRUE) {
        ENW_WARN("mouse_polling: RegisterRawInputDevices(%s) failed, GetLastError=%lu. "
                 "Staying on the stock GetCursorPos path.",
                 enable ? "on" : "off", ::GetLastError());
        return g_in_raw_input;
    }

    g_in_raw_input = enable;
    g_first_raw_update = true;
    if (g_verbose)
        ENW_INFO("mouse_polling: raw input %s", enable ? "enabled" : "disabled");
    return g_in_raw_input;
}

void OnRawInput(LPARAM lparam) {
    if (!g_in_raw_input) return;

    RAWINPUT raw = {};
    UINT size = sizeof raw;
    const UINT got = ::GetRawInputData(reinterpret_cast<HRAWINPUT>(lparam), RID_INPUT, &raw,
                                       &size, sizeof(RAWINPUTHEADER));
    if (got == static_cast<UINT>(-1) || raw.header.dwType != RIM_TYPEMOUSE) return;
    if (!g_in_focus) return;

    const bool absolute = (raw.data.mouse.usFlags & MOUSE_MOVE_ABSOLUTE) != 0;
    g_raw_x.Update(raw.data.mouse.lLastX, absolute);
    g_raw_y.Update(raw.data.mouse.lLastY, absolute);

    // Upstream's alt-tab fix: the first update after (re)acquiring the device
    // carries everything that happened while we were not looking, and applying
    // it snaps the view violently.
    if (g_first_raw_update) {
        g_raw_x.ResetDelta();
        g_raw_y.ResetDelta();
        g_first_raw_update = false;
    }

    ::InterlockedIncrement(&g_events_total);
    ::InterlockedIncrement(&g_events_this_frame);
}

LRESULT CALLBACK wndproc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
    switch (msg) {
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
        in_recenter_mouse()();
        *enw::ptr<int>(t4::var::s_wmv_oldPos_x) = *enw::ptr<int>(t4::var::s_wmv_centre_x);
        *enw::ptr<int>(t4::var::s_wmv_oldPos_y) = *enw::ptr<int>(t4::var::s_wmv_centre_y);
    }
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
             "RegisterRawInputDevices(usage 1/2, dwFlags=0, legacy messages KEPT) ok. "
             "Mouse motion now comes from WM_INPUT counts, not from GetCursorPos pixels. "
             "Off switch: ENW_RAW_MOUSE=0.",
             g_hwnd, static_cast<unsigned>(expected));
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
        if (!memory::looks_like_function(enw::at(t4::fn::CL_MouseEvent))) {
            ENW_ERROR("mouse_polling: 0x%08X does not look like CL_MouseEvent (%s). Refusing.",
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

            // One line every ~15 s at 60 fps. This is the evidence B's real
            // test produces: events/frame scales with the report rate, and at
            // 1000 Hz on a 60 fps client it should sit around 16.
            if (n - g_last_report_frame >= 900) {
                g_last_report_frame = n;
                ENW_INFO("mouse_polling: WM_INPUT total=%ld, peak/frame=%ld, frames with "
                         "motion=%ld, raw=%s focus=%s",
                         g_events_total, g_events_peak_frame, g_frames_with_events,
                         g_in_raw_input ? "on" : "off", g_in_focus ? "yes" : "no");
            }
        });
    }

    void pre_destroy() override {
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
