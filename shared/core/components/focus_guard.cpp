// Keeping the game running when nothing is looking at it.
//
// THE BUG THIS FIXES. `tools\dev\launch.ps1` parks the game window off-screen so
// it never interrupts B. The engine then decides it is not the foreground
// application and stops ticking: the referee ran two 420-second captures and
// both produced **exactly 65.2 s** of gameplay and then silence -- player frozen
// at spawn on full health, zombies still at round-1 health. Every unattended
// measurement on this project was silently capped at about a minute, and the
// only reason it was caught is that two runs produced *identical* durations.
//
// That is my bug: the off-screen parking caused it.
//
// THE FIX. CoDWaW.exe imports `GetActiveWindow` and `GetForegroundWindow` from
// USER32 **by name** (IAT slots 0x7EB338 and 0x7EB31C), which is how it decides
// whether it has focus. We replace both and answer with the game's own window,
// so the engine always believes it is the active foreground application. As with
// the other IAT work this needs no engine addresses, survives the binary moving,
// and is armed in post_load before a single engine instruction runs.
//
// This is not throwaway harness glue: a trusted host running games nobody is
// looking at needs exactly the same behaviour.
//
// Turn it off with ENW_FOCUS_GUARD=0 if you are ever chasing a focus-related
// bug and want the stock behaviour back.
#include "../component.hpp"

#include "../frame.hpp"
#include "../game_link.hpp"
#include "../logger.hpp"
#include "../memory.hpp"

namespace enw {
namespace {

using GetActiveWindow_t = HWND(__stdcall*)();
using GetForegroundWindow_t = HWND(__stdcall*)();

GetActiveWindow_t g_orig_active = nullptr;
GetForegroundWindow_t g_orig_foreground = nullptr;

// Resolved on the game thread, read from the hooks. Never call EnumWindows from
// inside the hooks themselves -- they are on hot paths and we do not want to
// reason about re-entrancy there.
volatile LONG_PTR g_game_window = 0;
volatile LONG g_active_calls = 0;
volatile LONG g_foreground_calls = 0;
bool g_armed = false;

HWND cached_window() { return reinterpret_cast<HWND>(::InterlockedCompareExchangePointer(
    reinterpret_cast<PVOID volatile*>(&g_game_window), nullptr, nullptr)); }

HWND __stdcall get_active_detour() {
    ::InterlockedIncrement(&g_active_calls);
    if (HWND w = cached_window()) return w;
    return g_orig_active ? g_orig_active() : nullptr;
}

HWND __stdcall get_foreground_detour() {
    ::InterlockedIncrement(&g_foreground_calls);
    if (HWND w = cached_window()) return w;
    return g_orig_foreground ? g_orig_foreground() : nullptr;
}

struct find_ctx {
    DWORD pid;
    HWND found;
};

BOOL CALLBACK find_game_window(HWND h, LPARAM param) {
    auto* ctx = reinterpret_cast<find_ctx*>(param);
    DWORD pid = 0;
    ::GetWindowThreadProcessId(h, &pid);
    if (pid != ctx->pid) return TRUE;
    char cls[64]{};
    ::GetClassNameA(h, cls, sizeof(cls));
    // The render window. Not the splash, not the console, not an IME window.
    if (_stricmp(cls, "CoD-WaW") == 0) {
        ctx->found = h;
        return FALSE;
    }
    return TRUE;
}

class focus_guard final : public component {
public:
    const char* name() const override { return "focus_guard"; }

    void post_load() override {
        char opt[8]{};
        ::GetEnvironmentVariableA("ENW_FOCUS_GUARD", opt, sizeof(opt));
        if (opt[0] == '0') {
            ENW_INFO("focus_guard: disabled by ENW_FOCUS_GUARD=0; the game will stop ticking "
                     "about a minute after launch if its window is not focused");
            return;
        }

        const bool a = memory::hook_import("USER32.dll", "GetActiveWindow",
                                           reinterpret_cast<void*>(&get_active_detour),
                                           reinterpret_cast<void**>(&g_orig_active));
        const bool f = memory::hook_import("USER32.dll", "GetForegroundWindow",
                                           reinterpret_cast<void*>(&get_foreground_detour),
                                           reinterpret_cast<void**>(&g_orig_foreground));
        if (!a && !f) {
            ENW_ERROR("focus_guard: could not patch either focus import. An off-screen game WILL "
                      "stop ticking after ~65 s.");
            return;
        }
        g_armed = true;
        ENW_INFO("focus_guard: armed (GetActiveWindow %s, GetForegroundWindow %s)",
                 a ? "hooked" : "FAILED", f ? "hooked" : "FAILED");
    }

    void post_unpack() override {
        if (!g_armed) return;
        // Resolve the window on the game thread, and keep re-resolving until we
        // have it: it does not exist until the renderer comes up, and a
        // vid_restart replaces it.
        frame::subscribe("focus_guard", [](uint64_t n) {
            if (cached_window() && (n % 600) != 0) return;  // re-check every ~10 s
            find_ctx ctx{::GetCurrentProcessId(), nullptr};
            ::EnumWindows(&find_game_window, reinterpret_cast<LPARAM>(&ctx));
            if (ctx.found && ctx.found != cached_window()) {
                ::InterlockedExchangePointer(reinterpret_cast<PVOID volatile*>(&g_game_window),
                                             ctx.found);
                ENW_INFO("focus_guard: game window is %p; the engine will be told it is always "
                         "active", ctx.found);
            }
        });
    }

    void post_init() override {
        if (!g_armed) return;
        ENW_INFO("focus_guard: %ld GetActiveWindow / %ld GetForegroundWindow calls so far",
                 ::InterlockedCompareExchange(&g_active_calls, 0, 0),
                 ::InterlockedCompareExchange(&g_foreground_calls, 0, 0));
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::focus_guard)
