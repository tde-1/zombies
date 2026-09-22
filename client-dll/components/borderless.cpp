// Perfect borderless windowed, because vanilla T4 has no `r_noborder`.
//
// ===========================================================================
// WHY THIS HAS TO BE IN THE DLL
// ===========================================================================
// Plutonium's documented recipe for T4 is
//     r_fullscreen 0 ; r_noborder 1 ; vid_xpos 0 ; vid_ypos 0 ; vid_restart
// (https://plutonium.pw/docs/client/t4/perfect-borderless-window/).
//
// **`r_noborder` is not a vanilla dvar.** The byte string `r_noborder` -- and
// the substring `noborder`, case-insensitively -- appears ZERO times in our
// decrypted dump of CoDWaW.exe 1.7. It is something Plutonium's own client
// adds. The other three are real and vanilla: `r_fullscreen` (0x89E710),
// `vid_xpos` (0x89E720), `vid_ypos` (0x89E72C), plus `r_monitor` (0x8A5448).
//
// So a launcher cannot do this with command-line dvars alone on a stock exe.
// Something has to take the frame off the window, and that is us.
//
// ===========================================================================
// WHAT WE DO
// ===========================================================================
// The game window is the "CoD-WaW" class registered at 0x5FF450; its HWND is
// at [0x22C1BE4] (both verified, see shared/t4/addresses.hpp). Once it exists
// we clear WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME, set WS_POPUP,
// clear the WS_EX_WINDOWEDGE / WS_EX_CLIENTEDGE / WS_EX_DLGMODALFRAME extended
// bits, and SetWindowPos to the requested rect with SWP_FRAMECHANGED.
//
// NO SECOND SUBCLASS. mouse_polling.cpp already subclasses this window and its
// install guard refuses to run if the proc is not still 0x606BE0 -- so a second
// subclass here would make one of the two components refuse at random depending
// on load order. Instead we re-check the style from the shared frame tick a few
// times a second. That is cheap (one GetWindowLongA), and it is also the only
// thing that survives the two cases a one-shot cannot:
//   * alt-tab / restore, where the window manager can put the frame back, and
//   * `vid_restart`, which destroys and recreates the window entirely.
// If the frame comes back we take it off again and say so once.
//
// ===========================================================================
// WHERE THE GEOMETRY COMES FROM, AND WHY NOT FROM DVARS
// ===========================================================================
// We read `r_mode`, `vid_xpos`, `vid_ypos`, `r_fullscreen` and `r_noborder`
// off the process COMMAND LINE, not out of the dvar system. The launcher now
// always passes them explicitly (launcher.md §3, and tools/dev/launch.ps1 does
// too), and `enw::game::dvar_s` is deliberately opaque to us -- reading a value
// out of it means committing to a struct layout for a bool vs a string, which
// is exactly the kind of guess this project has paid for before. The command
// line is free, exact, and cannot fault.
//
// `r_mode` is a STRING on T4 ("800x600" is the literal default in the image),
// not an index. If it is missing or unparseable we fall back to the full rect
// of the monitor the window is on (MonitorFromWindow + GetMonitorInfo), which
// is B's stated default anyway: borderless at the main display's native
// resolution.
//
// Off switch: ENW_BORDERLESS=0. On: ENW_BORDERLESS=1, or `+set r_noborder 1`
// on the command line (we match the text, we do not read the dvar). Borderless
// is only applied when `r_fullscreen` is 0 -- an exclusive-fullscreen window
// has no frame to take off and reshaping it would fight the renderer.
//
// Clean room: our own code. The only thing taken from Plutonium is the fact of
// which dvars their recipe names, which is documentation, not code.

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

constexpr LONG kFrameStyles = WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME;
constexpr LONG kFrameExStyles = WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME;

bool g_enabled = false;
bool g_applied = false;
HWND g_hwnd = nullptr;
long g_reapplied = 0;
int g_want_x = 0, g_want_y = 0, g_want_w = 0, g_want_h = 0;
bool g_have_size = false;

// --------------------------------------------------------------- cmdline bits
// Find `+set <name> ` in the command line and return what follows, trimmed to
// the next whitespace. Returns false if absent. No allocation, no dvar system.
bool cmdline_set(const char* name, char* out, size_t out_size) {
    const char* cmd = ::GetCommandLineA();
    if (!cmd || !name || !out || out_size < 2) return false;

    char needle[64];
    if (::_snprintf_s(needle, sizeof needle, _TRUNCATE, "+set %s ", name) < 0) return false;

    // LAST occurrence wins, because that is what the engine does with repeated
    // `+set`. Run 1 of this component proved it matters: launch.ps1 passes its
    // own `+set r_mode 800x600 +set vid_xpos 20` before the caller's -GameArgs,
    // so a first-match read gave 800x600 at (20,20) for a launch that asked for
    // 1280x720 at (0,0).
    const char* p = nullptr;
    for (const char* q = std::strstr(cmd, needle); q; q = std::strstr(q + 1, needle)) p = q;
    if (!p) return false;
    p += std::strlen(needle);
    while (*p == ' ' || *p == '\t') ++p;

    size_t n = 0;
    while (*p && *p != ' ' && *p != '\t' && n + 1 < out_size) out[n++] = *p++;
    out[n] = '\0';
    return n > 0;
}

bool cmdline_int(const char* name, int* out) {
    char buf[32];
    if (!cmdline_set(name, buf, sizeof buf)) return false;
    *out = std::atoi(buf);
    return true;
}

// r_mode is "WxH" on T4, not an index.
bool cmdline_mode(int* w, int* h) {
    char buf[32];
    if (!cmdline_set("r_mode", buf, sizeof buf)) return false;
    const char* x = std::strchr(buf, 'x');
    if (!x) x = std::strchr(buf, 'X');
    if (!x) return false;
    const int ww = std::atoi(buf);
    const int hh = std::atoi(x + 1);
    if (ww < 320 || hh < 240) return false;
    *w = ww;
    *h = hh;
    return true;
}

bool env_is(const char* name, char value) {
    const char* v = std::getenv(name);
    return v && v[0] == value && v[1] == '\0';
}

// ------------------------------------------------------------------- the work
void resolve_target_rect() {
    int w = 0, h = 0;
    const bool have_mode = cmdline_mode(&w, &h);
    int x = 0, y = 0;
    const bool have_x = cmdline_int("vid_xpos", &x);
    const bool have_y = cmdline_int("vid_ypos", &y);

    if (have_mode) {
        g_want_w = w;
        g_want_h = h;
        g_want_x = have_x ? x : 0;
        g_want_y = have_y ? y : 0;
        g_have_size = true;
        ENW_INFO("borderless: target %dx%d at (%d,%d) from the command line "
                 "(r_mode%s, vid_xpos%s, vid_ypos%s)",
                 g_want_w, g_want_h, g_want_x, g_want_y, have_mode ? "" : " missing",
                 have_x ? "" : " missing", have_y ? "" : " missing");
        return;
    }

    // Fall back to the whole monitor the window is on -- B's default: borderless
    // at the main display's native resolution.
    MONITORINFO mi = {};
    mi.cbSize = sizeof mi;
    HMONITOR mon = ::MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTOPRIMARY);
    if (mon && ::GetMonitorInfoA(mon, &mi)) {
        g_want_x = mi.rcMonitor.left;
        g_want_y = mi.rcMonitor.top;
        g_want_w = mi.rcMonitor.right - mi.rcMonitor.left;
        g_want_h = mi.rcMonitor.bottom - mi.rcMonitor.top;
        g_have_size = true;
        ENW_INFO("borderless: no usable r_mode on the command line; using the whole monitor "
                 "rect %dx%d at (%d,%d)", g_want_w, g_want_h, g_want_x, g_want_y);
        return;
    }
    ENW_WARN("borderless: no r_mode and MonitorFromWindow/GetMonitorInfo failed; the frame "
             "will be removed but the window will not be moved or resized.");
    g_have_size = false;
}

bool has_frame(HWND h) {
    const LONG s = ::GetWindowLongA(h, GWL_STYLE);
    const LONG e = ::GetWindowLongA(h, GWL_EXSTYLE);
    return (s & kFrameStyles) != 0 || (e & kFrameExStyles) != 0 || (s & WS_POPUP) == 0;
}

// Returns true if the window is borderless afterwards.
bool strip_frame(HWND h, bool first_time) {
    const LONG before = ::GetWindowLongA(h, GWL_STYLE);
    const LONG before_ex = ::GetWindowLongA(h, GWL_EXSTYLE);

    const LONG want = (before & ~kFrameStyles) | WS_POPUP;
    const LONG want_ex = before_ex & ~kFrameExStyles;

    ::SetWindowLongA(h, GWL_STYLE, want);
    ::SetWindowLongA(h, GWL_EXSTYLE, want_ex);

    UINT flags = SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    if (!g_have_size) flags |= SWP_NOMOVE | SWP_NOSIZE;
    ::SetWindowPos(h, nullptr, g_want_x, g_want_y, g_want_w, g_want_h, flags);

    // Read it back. A call returning without error is not evidence.
    const LONG after = ::GetWindowLongA(h, GWL_STYLE);
    const LONG after_ex = ::GetWindowLongA(h, GWL_EXSTYLE);
    RECT wr = {}, cr = {};
    ::GetWindowRect(h, &wr);
    ::GetClientRect(h, &cr);
    const bool ok = (after & kFrameStyles) == 0 && (after_ex & kFrameExStyles) == 0 &&
                    (after & WS_POPUP) != 0;

    if (first_time) {
        ENW_INFO("borderless: style 0x%08lX -> 0x%08lX, exstyle 0x%08lX -> 0x%08lX. "
                 "WS_CAPTION=%d WS_THICKFRAME=%d WS_BORDER=%d WS_POPUP=%d. "
                 "window rect %ldx%ld at (%ld,%ld), client %ldx%ld. %s",
                 before, after, before_ex, after_ex, (after & WS_CAPTION) ? 1 : 0,
                 (after & WS_THICKFRAME) ? 1 : 0, (after & WS_BORDER) ? 1 : 0,
                 (after & WS_POPUP) ? 1 : 0, wr.right - wr.left, wr.bottom - wr.top, wr.left,
                 wr.top, cr.right - cr.left, cr.bottom - cr.top,
                 ok ? "BORDERLESS." : "*** the frame bits did not clear ***");
    }
    return ok;
}

class borderless final : public component {
public:
    const char* name() const override { return "borderless"; }

    void post_init() override {
        // OFF unless asked. ENW_BORDERLESS=0 wins over everything.
        if (env_is("ENW_BORDERLESS", '0')) {
            ENW_INFO("borderless: OFF (ENW_BORDERLESS=0)");
            return;
        }
        char noborder[16] = {};
        const bool want_env = env_is("ENW_BORDERLESS", '1');
        const bool want_cmd = cmdline_set("r_noborder", noborder, sizeof noborder) &&
                              noborder[0] != '0';
        if (!want_env && !want_cmd) {
            ENW_INFO("borderless: not requested (set ENW_BORDERLESS=1, or pass "
                     "+set r_noborder 1 -- we match that text on the command line, we do not "
                     "read the dvar, because vanilla T4 has no r_noborder to read)");
            return;
        }

        // Exclusive fullscreen has no frame to remove and reshaping it fights
        // the renderer. r_fullscreen is a real vanilla dvar (0x89E710) and the
        // launcher always passes it.
        int fullscreen = 0;
        if (cmdline_int("r_fullscreen", &fullscreen) && fullscreen != 0) {
            ENW_INFO("borderless: skipped, the command line asks for r_fullscreen %d. "
                     "Borderless only applies to a windowed game (r_fullscreen 0).",
                     fullscreen);
            return;
        }

        g_enabled = true;
        ENW_INFO("borderless: armed (%s). Vanilla CoDWaW has no r_noborder dvar -- zero "
                 "occurrences of the string in the dump -- so the frame is removed here.",
                 want_env ? "ENW_BORDERLESS=1" : "+set r_noborder on the command line");

        frame::subscribe("borderless", [](uint64_t n) {
            if (!g_enabled) return;

            // The window does not exist at post_init; it arrives with the
            // renderer. Poll a few times a second rather than every frame.
            if ((n % 20) != 0) return;

            HWND h = *enw::ptr<HWND>(t4::var::g_wv_hwnd);
            if (!h || !::IsWindow(h)) return;

            if (h != g_hwnd) {
                // First window, or `vid_restart` gave us a new one.
                const bool restart = (g_hwnd != nullptr);
                g_hwnd = h;
                g_applied = false;
                resolve_target_rect();
                if (restart)
                    ENW_INFO("borderless: the game recreated its window (vid_restart); "
                             "re-applying.");
            }

            if (!g_applied) {
                g_applied = strip_frame(h, true);
                return;
            }

            // Alt-tab, restore, or anything else that puts the frame back.
            if (has_frame(h)) {
                strip_frame(h, false);
                if (++g_reapplied == 1)
                    ENW_INFO("borderless: the window got its frame back (alt-tab or a mode "
                             "change); removed it again. Further re-applications are counted, "
                             "not logged.");
            }
        });
    }

    void pre_destroy() override {
        if (g_reapplied)
            ENW_INFO("borderless: re-applied %ld time(s) this session", g_reapplied);
    }
};

#else

class borderless final : public component {
public:
    const char* name() const override { return "borderless"; }
};

#endif

ENW_REGISTER_COMPONENT(borderless)

}  // namespace
}  // namespace enw::client
