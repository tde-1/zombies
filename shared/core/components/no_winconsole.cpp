// Stopping the dedicated server's console window grinding the frame loop.
//
// THE PROBLEM. `dedi`'s headless server spends its time between
// `NtUserExtTextOutW` and `NtUserScrollDC` -- grinding, not deadlocked. Every
// line appended to the WinConsole is a synchronous SendMessage -> wndproc ->
// paint *and scroll*, which is quadratic in the text already in the control. A
// server that logs steadily therefore gets slower and slower.
//
// WHY THIS IS AN IAT HOOK AND NOT AN ENGINE STUB. `re` traced the creator to
// 0x605500 (RegisterClassA + CreateWindowExA) and established that it is lazy:
// its only caller is the append function at 0x605804, so **the window is created
// on the first append**. They also marked 0x605500, 0x6057F0 and 0x605870
// **unsafe to stub** -- `dedi` tried, and it was strictly worse: `Com_Init`
// stopped returning at all, because these are not no-arg cdecl functions and a
// plain-`ret` stub corrupts the caller's stack. `re` declined to hand over
// unverified prototypes, correctly.
//
// So we go around the engine entirely. CoDWaW.exe imports `CreateWindowExA`
// (IAT 0x7EB2BC) and `RegisterClassA` (0x7EB2B4) from USER32 by name. No engine
// calling convention is involved, nothing to re-verify when the binary moves,
// and if the window never exists the ExtTextOut/ScrollDC grind cannot happen.
// `+set logfile 2` already captures everything the console would have shown.
//
// IT IS ALSO A CLEAN EXPERIMENT. If the grind persists once the window is gone,
// the cause is the 0x5B0810 cluster (15 of 16 samples, not console code) and not
// the console at all -- and we learn that in one run instead of by elimination
// over several.
//
// DEDICATED ONLY. A player's client may legitimately want its console, so this
// does nothing unless we are confident we are a dedicated server.
//
//   ENW_NO_WINCONSOLE=1       force on
//   ENW_NO_WINCONSOLE=0       force off
//   ENW_NO_WINCONSOLE=hide    create it but strip WS_VISIBLE, instead of
//                             refusing outright (fallback if a null HWND ever
//                             turns out to upset the caller)
#include "../component.hpp"

#include "../game_link.hpp"
#include "../logger.hpp"
#include "../memory.hpp"

namespace enw {
namespace {

// The class the engine registers at 0x605500; the string lives at 0x48489C.
constexpr char kConsoleClass[] = "Call of Duty WinConsole";

using CreateWindowExA_t = HWND(__stdcall*)(DWORD, LPCSTR, LPCSTR, DWORD, int, int, int, int, HWND,
                                           HMENU, HINSTANCE, LPVOID);
using RegisterClassA_t = ATOM(__stdcall*)(const WNDCLASSA*);

CreateWindowExA_t g_orig_create = nullptr;
RegisterClassA_t g_orig_register = nullptr;

enum class mode { off, refuse, hide };
mode g_mode = mode::off;

volatile LONG g_refused = 0;
volatile LONG g_hidden = 0;
volatile LONG g_seen_class = 0;

std::string env(const char* name) {
    char buf[64]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
}

bool is_console_class(LPCSTR cls) {
    // A class can be an ATOM (high word zero) rather than a pointer. Do not
    // dereference one of those.
    if (!cls) return false;
    if (reinterpret_cast<uintptr_t>(cls) <= 0xFFFF) return false;
    return _stricmp(cls, kConsoleClass) == 0;
}

ATOM __stdcall register_class_detour(const WNDCLASSA* wc) {
    // We do not refuse registration -- registering a class is cheap and
    // harmless, and letting it succeed keeps the engine's own bookkeeping
    // happy. We watch it purely so the log says whether the class we expect
    // ever actually appears.
    if (wc && wc->lpszClassName && reinterpret_cast<uintptr_t>(wc->lpszClassName) > 0xFFFF) {
        if (_stricmp(wc->lpszClassName, kConsoleClass) == 0) {
            ::InterlockedIncrement(&g_seen_class);
            ENW_INFO("no_winconsole: the engine registered '%s' - the console is about to be "
                     "created", kConsoleClass);
        }
    }
    return g_orig_register ? g_orig_register(wc) : 0;
}

HWND __stdcall create_window_detour(DWORD ex, LPCSTR cls, LPCSTR name, DWORD style, int x, int y,
                                    int w, int h, HWND parent, HMENU menu, HINSTANCE inst,
                                    LPVOID param) {
    if (g_mode != mode::off && is_console_class(cls)) {
        if (g_mode == mode::refuse) {
            ::InterlockedIncrement(&g_refused);
            ENW_INFO("no_winconsole: REFUSED the '%s' window. Console output still goes to "
                     "console.log (logfile 2); the ExtTextOut/ScrollDC grind cannot happen "
                     "without a window.",
                     kConsoleClass);
            // A null HWND is what CreateWindowExA returns on failure, so the
            // caller is on a path it already has to handle. SendMessage to a
            // null HWND is a no-op that returns 0, not a fault.
            ::SetLastError(ERROR_CANNOT_MAKE);
            return nullptr;
        }
        // hide: let it exist, just never let it paint.
        ::InterlockedIncrement(&g_hidden);
        style &= ~static_cast<DWORD>(WS_VISIBLE);
        ENW_INFO("no_winconsole: creating '%s' WITHOUT WS_VISIBLE", kConsoleClass);
    }
    return g_orig_create
               ? g_orig_create(ex, cls, name, style, x, y, w, h, parent, menu, inst, param)
               : nullptr;
}

// Are we a dedicated server? This has to be decided in post_load, before any
// engine code runs, so we cannot read the com_dedicated dvar (it does not exist
// yet). Both signals come from the launcher.
bool looks_dedicated() {
    if (env("ENW_ROLE") == "server") return true;

    // `+set dedicated 1` / `2` on the command line.
    const char* cmd = ::GetCommandLineA();
    if (!cmd) return false;
    const char* p = cmd;
    while ((p = strstr(p, "dedicated")) != nullptr) {
        p += 9;
        while (*p == ' ' || *p == '\t' || *p == '"') ++p;
        if (*p == '1' || *p == '2') return true;
    }
    return false;
}

class no_winconsole final : public component {
public:
    const char* name() const override { return "no_winconsole"; }

    void post_load() override {
        const std::string opt = env("ENW_NO_WINCONSOLE");
        if (opt == "0") {
            ENW_DEBUG("no_winconsole: off by request");
            return;
        }
        if (opt == "hide") {
            g_mode = mode::hide;
        } else if (opt == "1") {
            g_mode = mode::refuse;
        } else if (looks_dedicated()) {
            g_mode = mode::refuse;
        } else {
            ENW_DEBUG("no_winconsole: not a dedicated server; leaving the console alone");
            return;
        }

        const bool c = memory::hook_import("USER32.dll", "CreateWindowExA",
                                           reinterpret_cast<void*>(&create_window_detour),
                                           reinterpret_cast<void**>(&g_orig_create));
        const bool r = memory::hook_import("USER32.dll", "RegisterClassA",
                                           reinterpret_cast<void*>(&register_class_detour),
                                           reinterpret_cast<void**>(&g_orig_register));
        if (!c) {
            ENW_ERROR("no_winconsole: could not patch CreateWindowExA. The console window will be "
                      "created and the frame loop will grind.");
            g_mode = mode::off;
            return;
        }
        ENW_INFO("no_winconsole: armed in %s mode (RegisterClassA %s). Watching for class '%s'.",
                 g_mode == mode::refuse ? "REFUSE" : "HIDE", r ? "hooked" : "not hooked",
                 kConsoleClass);
    }

    void post_init() override {
        if (g_mode == mode::off) return;
        const LONG refused = ::InterlockedCompareExchange(&g_refused, 0, 0);
        const LONG hidden = ::InterlockedCompareExchange(&g_hidden, 0, 0);
        const LONG seen = ::InterlockedCompareExchange(&g_seen_class, 0, 0);

        if (refused || hidden) {
            ENW_INFO("no_winconsole: %ld refused, %ld hidden - the console window is gone. If the "
                     "frame loop still grinds, it is NOT the console (look at 0x5B0810).",
                     refused, hidden);
            game_link::get().send_log("info", "WinConsole suppressed (%ld refused, %ld hidden)",
                                      refused, hidden);
        } else if (seen) {
            ENW_WARN("no_winconsole: the class was registered but no window creation reached us. "
                     "Check the call shape.");
        } else {
            // Entirely normal: the console is created lazily on the first
            // append, which may not have happened yet.
            ENW_DEBUG("no_winconsole: no console window requested yet (it is created lazily on "
                      "the first append)");
        }
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::no_winconsole)
