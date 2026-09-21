// Stop a headless server parking in GetMessageA for whole seconds at a time.
//
// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------
// Once the frame loop ran (see local_client.cpp) the server still hitched. Run
// r03, 90 s: seven `Hitch warning: 5034 msec frame time` lines, and the frame
// rate alternating between ~500 Hz and ~170 Hz in five-second bands. The stack
// walk catches it in the slow bands at:
//
//     EIP = win32u!NtUserGetMessage+0xC   ESP = 000EFD98
//     validated: 005FED11 <- 0059B64C <- 0059DD95 <- 0059E4DC <- 005FF7C2
//
// WinMain -> Com_Frame -> the pacing loop -> Com_EventLoop (0x59B630) ->
// Sys_GetEvent (0x5FEC60), blocked in GetMessageA. Sys_GetEvent's pump:
//
//     005FECD6  esi = PeekMessageA                  ; IAT 0x7EB2EC
//     005FECE9  call esi                            ; PeekMessageA(&m,NULL,0,0,PM_NOREMOVE)
//     005FECED  je  005FED44                        ; nothing -> Sys_ConsoleInput
//     005FED00: call [0x7EB2CC]                     ; GetMessageA(&m,NULL,0,0)  <- BLOCKS
//     005FED13  je  005FEDCD                        ; returned 0 -> treated as WM_QUIT
//     005FED28  TranslateMessage / DispatchMessageA
//     005FED3E  call esi ; jne 005FED00             ; re-peek -> loop
//
// The PM_NOREMOVE peek is not a guarantee. The loop re-peeks at 0x5FED3E, and
// if a message arrives between that peek and GetMessageA being reached with an
// otherwise empty queue, GetMessageA blocks until the next message of ANY kind.
// A rendered client's queue is never empty so this never bites. Headless, with
// the WinConsole window refused, the queue is empty almost always -- so the main
// thread parks until one of our own 5 s worker-thread log lines happens to wake
// it. Hence exactly ~5 s, over and over.
//
// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------
// Replace GetMessageA in the IAT, dedicated-only, with a non-blocking version:
// PeekMessageA(..., PM_REMOVE), and if there is nothing, hand back a synthetic
// WM_NULL on a NULL window.
//
// Returning 0 is NOT an option: the engine reads 0 as WM_QUIT at 0x5FED13 and
// would shut down. Returning non-zero with WM_NULL/hwnd=NULL is safe --
// TranslateMessage ignores it and DispatchMessageA on a NULL hwnd is a no-op --
// and the re-peek at 0x5FED3E then returns FALSE, so the pump exits normally
// after one extra harmless turn.
//
// This is the IAT technique that already fixed the foreground-app freeze and the
// WinConsole grind: no engine bytes are touched, so there is no calling
// convention to guess and nothing for another component to collide with.
//
// A real WM_QUIT still works. If PeekMessage(PM_REMOVE) hands us one we pass it
// through untouched and return 0, exactly as GetMessage would, so the engine's
// quit path at 0x5FEDCD is unaffected.
//
// KNOWN SIDE EFFECT, accepted: `Sys_Error`'s terminal park (0x5FE960..0x5FE97D)
// is `TranslateMessage / DispatchMessageA / GetMessageA / jne 0x5FE960`, so with
// a non-blocking GetMessageA a fatal error becomes a 100%-CPU spin instead of a
// 0%-CPU block. It is a dead process either way, and `error_trap` traps Sys_Error
// before it gets there -- but if you ever see one core pinned on a headless
// server, look at Sys_Error first, not at the frame loop.
//
// ENW_DEDI_BLOCKING_PUMP=1 restores the stock behaviour for comparison.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "dedicated.hpp"

#include <cstdlib>
#include <windows.h>

namespace enw::dedi {
namespace {

using GetMessageA_t = BOOL(__stdcall*)(LPMSG, HWND, UINT, UINT);

GetMessageA_t g_orig_get_message = nullptr;

volatile long g_calls = 0;
volatile long g_synthetic = 0;   // how often we saved the thread from blocking
volatile long g_quits = 0;

BOOL __stdcall get_message_detour(LPMSG msg, HWND wnd, UINT min_filter, UINT max_filter) {
    ::InterlockedIncrement(&g_calls);

    if (!msg) return g_orig_get_message ? g_orig_get_message(msg, wnd, min_filter, max_filter) : 0;

    if (::PeekMessageA(msg, wnd, min_filter, max_filter, PM_REMOVE)) {
        if (msg->message == WM_QUIT) {
            ::InterlockedIncrement(&g_quits);
            return FALSE;   // what GetMessageA returns for WM_QUIT; the engine quits.
        }
        return TRUE;
    }

    // Nothing pending. Hand back a message the engine can dispatch harmlessly
    // rather than letting it block. hwnd = NULL makes DispatchMessageA a no-op.
    ::InterlockedIncrement(&g_synthetic);
    msg->hwnd = nullptr;
    msg->message = WM_NULL;
    msg->wParam = 0;
    msg->lParam = 0;
    msg->time = ::GetTickCount();
    msg->pt.x = 0;
    msg->pt.y = 0;
    return TRUE;
}

class nonblocking_pump_component final : public component {
public:
    const char* name() const override { return "dedi_nonblocking_pump"; }

    bool is_supported() override { return is_dedicated(); }

    void post_unpack() override {
        if (std::getenv("ENW_DEDI_BLOCKING_PUMP")) {
            ENW_WARN("dedi_nonblocking_pump: ENW_DEDI_BLOCKING_PUMP set - leaving GetMessageA "
                     "alone. Expect ~5 s stalls in Sys_GetEvent (dedi.md §7c).");
            return;
        }
        if (!memory::hook_import("USER32.dll", "GetMessageA",
                                 reinterpret_cast<void*>(&get_message_detour),
                                 reinterpret_cast<void**>(&g_orig_get_message))) {
            ENW_ERROR("dedi_nonblocking_pump: could not patch the GetMessageA import. "
                      "Sys_GetEvent (0x5FEC60) will keep blocking the frame loop for seconds "
                      "at a time.");
            return;
        }
        ENW_INFO("dedi_nonblocking_pump: GetMessageA is now non-blocking for this process. "
                 "Sys_GetEvent's pump at 0x5FED00 can no longer park the main thread on an "
                 "empty message queue.");
    }

    void pre_destroy() override {
        ENW_INFO("dedi_nonblocking_pump: GetMessageA calls=%ld  would-have-blocked=%ld  quits=%ld",
                 g_calls, g_synthetic, g_quits);
    }
};

ENW_REGISTER_COMPONENT(nonblocking_pump_component)

}  // namespace
}  // namespace enw::dedi
