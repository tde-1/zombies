// test_no_activate: a HARNESS switch that keeps a test game from ever taking the
// foreground. OFF unless ENW_TEST_NO_ACTIVATE=1. Never set by the launcher.
//
// Why (2026-09-22, chat overlay round 2): B works at this PC while agents run the
// game off-screen. The engine activates its own window at startup
// (`ShowWindow(hwnd, SW_SHOW)` in R_Init, 0x6D68ED, and `SetFocus` in WinMain at
// 0x5FF7A5), and an off-screen window that is foreground takes B's keyboard -- he
// saw the test window "tabbing out and in". The overlay's selftest drives input by
// posting messages, so the test window never needs to be active at all.
//
// How: three IAT slots, armed in post_load before any engine code runs (the IAT is
// in .rdata and filled by the loader, see memory.hpp :: hook_import):
//   CreateWindowExA  -> top-level windows get WS_EX_NOACTIVATE
//   ShowWindow       -> SW_SHOW / SW_SHOWNORMAL / SW_RESTORE / SW_SHOWMAXIMIZED
//                       become SW_SHOWNOACTIVATE
//   SetFocus         -> a no-op that returns the current focus
#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>

#include <cstdlib>

namespace enw::client {
namespace {

using create_t = HWND(WINAPI*)(DWORD, LPCSTR, LPCSTR, DWORD, int, int, int, int, HWND, HMENU,
                               HINSTANCE, LPVOID);
using show_t = BOOL(WINAPI*)(HWND, int);
using focus_t = HWND(WINAPI*)(HWND);

create_t g_create = nullptr;
show_t g_show = nullptr;
focus_t g_focus = nullptr;
volatile long g_n_create = 0, g_n_show = 0, g_n_focus = 0;

HWND WINAPI create_hook(DWORD ex, LPCSTR cls, LPCSTR name, DWORD style, int x, int y, int w, int h,
                        HWND parent, HMENU menu, HINSTANCE inst, LPVOID param) {
    if (!(style & WS_CHILD)) {
        ex |= WS_EX_NOACTIVATE;
        ::InterlockedIncrement(&g_n_create);
    }
    return g_create(ex, cls, name, style, x, y, w, h, parent, menu, inst, param);
}

BOOL WINAPI show_hook(HWND h, int cmd) {
    if (cmd == SW_SHOW || cmd == SW_SHOWNORMAL || cmd == SW_RESTORE || cmd == SW_SHOWMAXIMIZED) {
        cmd = SW_SHOWNOACTIVATE;
        ::InterlockedIncrement(&g_n_show);
    }
    return g_show(h, cmd);
}

HWND WINAPI focus_hook(HWND) {
    ::InterlockedIncrement(&g_n_focus);
    return ::GetFocus();
}

class test_no_activate final : public component {
public:
    const char* name() const override { return "test_no_activate"; }
    void post_load() override {
        const char* v = std::getenv("ENW_TEST_NO_ACTIVATE");
        if (!v || !v[0] || v[0] == '0') return;
        const bool a = memory::hook_import("USER32.dll", "CreateWindowExA",
                                           reinterpret_cast<void*>(&create_hook),
                                           reinterpret_cast<void**>(&g_create));
        const bool b = memory::hook_import("USER32.dll", "ShowWindow",
                                           reinterpret_cast<void*>(&show_hook),
                                           reinterpret_cast<void**>(&g_show));
        const bool c = memory::hook_import("USER32.dll", "SetFocus",
                                           reinterpret_cast<void*>(&focus_hook),
                                           reinterpret_cast<void**>(&g_focus));
        ENW_WARN("test_no_activate: ON (ENW_TEST_NO_ACTIVATE=1, a harness switch): the game's "
                 "windows are created WS_EX_NOACTIVATE and never shown activated or focused. "
                 "CreateWindowExA %s, ShowWindow %s, SetFocus %s.",
                 a ? "hooked" : "FAILED", b ? "hooked" : "FAILED", c ? "hooked" : "FAILED");
    }
    void pre_destroy() override {
        if (g_create)
            ENW_INFO("test_no_activate: %ld window(s) created no-activate, %ld show(s) and %ld "
                     "focus call(s) neutralised", g_n_create, g_n_show, g_n_focus);
    }
};

ENW_REGISTER_COMPONENT(test_no_activate)

}  // namespace
}  // namespace enw::client
