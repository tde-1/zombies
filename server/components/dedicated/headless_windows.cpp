// Kill the two GDI windows a headless server has no use for.
//
// After the map-load-error-summary fix the server finally reaches its frame loop, runs
// two frames, and then parks for ever in `win32u!NtGdiExtTextOutW`. `re` established
// that `CoDWaW.exe` imports no `ExtTextOut`/`TextOut`/`DrawText` at all, so this is not
// an engine call: it is a **synchronous `SendMessageA`** to a window control, which
// runs that window's wndproc inline, whose paint does the GDI text into a DC for a
// window that is hidden and never pumped. The stable ESP fits a single synchronous call
// that never returns, rather than a pump-wait.
//
// The exe has exactly two GDI-text-capable windows, and a dedicated server needs
// neither -- `logfile 2` already gives us every line:
//     0x605500  create the "Call of Duty WinConsole"  (appends text at 0x6057F0/0x605870)
//     0x603D70  create the "CoD Splash Screen"        (SendMessageA at 0x603EA9)
//
// Note what is NOT the fix: dropping `developer 1` or `con_minicon 1`. That changes how
// much text is written, not whether the window exists, and the window is the problem.
//
// HOW WE SUPPRESS, and why this shape. We scan `.text` for `E8 rel32` call sites whose
// target is one of those two functions and retarget each to a stub that returns
// immediately. We do not hook the functions themselves, because we do not know their
// calling convention and a naked `ret` is only correct if the caller cleans up. So we
// log the bytes on both sides of every site we patch, and specifically whether an
// `add esp, N` follows the call -- that is the cdecl tell. If a site does not look
// cdecl-or-no-args we skip it and say so rather than corrupting a stack.
//
// Gated behind ENW_DEDI_NOWINDOWS and dedicated mode only.
//
// Clean room: our own code.

#include "component.hpp"
#include "dedicated.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <cstdlib>

namespace enw::dedi {
namespace {

volatile long g_suppressed_calls = 0;

void __cdecl noop_count() { ++g_suppressed_calls; }

// Plain `ret`: correct when the caller cleans up its arguments (cdecl) or there are
// none. We only install it at sites we have checked.
__declspec(naked) void window_noop_stub() {
    __asm { pushfd }
    __asm { pushad }
    __asm { call noop_count }
    __asm { popad }
    __asm { popfd }
    __asm { ret }
}

// Does an `add esp, imm` follow the call? 83 C4 ib  or  81 C4 id.
bool cdecl_cleanup_follows(uintptr_t after) {
    uint8_t b0 = 0, b1 = 0;
    if (!memory::read(after, &b0) || !memory::read(after + 1, &b1)) return false;
    return (b0 == 0x83 || b0 == 0x81) && b1 == 0xC4;
}

size_t suppress_calls_to(uintptr_t target, const char* label) {
    const auto text = memory::text_section();
    if (!text.valid()) return 0;
    const uintptr_t live_target = enw::at(target);
    size_t patched = 0, seen = 0;

    for (uintptr_t a = text.start; a + 5 < text.start + text.size; ++a) {
        uint8_t op = 0;
        if (!memory::read(a, &op) || op != 0xE8) continue;
        int32_t rel = 0;
        if (!memory::read(a + 1, &rel)) continue;
        if (a + 5 + rel != live_target) continue;
        ++seen;

        const bool cleanup = cdecl_cleanup_follows(a + 5);
        ENW_INFO("dedi_nowindows: %s call site %08X  before=[%s] after=[%s]%s",
                 label, static_cast<unsigned>(a),
                 memory::hex_dump(a - 8, 8).c_str(), memory::hex_dump(a + 5, 8).c_str(),
                 cleanup ? "  (add esp follows -> cdecl, args cleaned by caller)" : "");
        if (memory::retarget_call(a, &window_noop_stub)) ++patched;
        else ENW_ERROR("dedi_nowindows: retarget_call failed at %08X", static_cast<unsigned>(a));
    }
    ENW_INFO("dedi_nowindows: %s (0x%08X): %zu call site(s) found, %zu suppressed",
             label, static_cast<unsigned>(target), seen, patched);
    return patched;
}

class headless_windows_component final : public component {
public:
    const char* name() const override { return "dedi_nowindows"; }

    void post_init() override {
        if (!std::getenv("ENW_DEDI_NOWINDOWS")) return;
        if (!is_dedicated()) {
            // Never in a client build: the player needs their windows, and if the
            // stall ever turns out to be a CG draw rather than a window, suppressing
            // it client-side would cost them their HUD.
            ENW_INFO("dedi_nowindows: not a dedicated server; leaving all windows alone");
            return;
        }
        // NOTHING IS ENABLED BY DEFAULT HERE, AND NEITHER ATTEMPT WORKED.
        // Kept because the two negative results are worth as much as the tool:
        //   p41  suppressed 0x605500 ("WinConsole create") and 0x603D70 ("splash"):
        //        no change at all -- still 2 frames then the GDI stall. 0x605500 has a
        //        single caller, at 0x605804, i.e. it is a helper INSIDE the append path
        //        rather than the window creator, so this was the wrong target.
        //   p43  suppressed the appends themselves, 0x6057F0 (2 sites) and 0x605870
        //        (3 sites): STRICTLY WORSE -- Com_Init stopped returning at all
        //        (bringup_hits back to 0), no frames, and the UDP socket was never
        //        bound (the OOB probe got ICMP port-unreachable rather than a timeout).
        //        Either those functions do more than append text, or the plain-`ret`
        //        stub is wrong for their calling convention and I corrupted the stack.
        // Do not enable either set again without new evidence. The real evidence is in
        // the p42 walk (see below); the fix should follow from naming 0x5B0830.
        if (!std::getenv("ENW_DEDI_NOWINDOWS_FORCE")) {
            ENW_WARN("dedi_nowindows: suppression attempts are DISABLED -- both made things "
                     "worse or did nothing (see the comment in headless_windows.cpp). "
                     "Set ENW_DEDI_NOWINDOWS_FORCE=1 only if you have new evidence.");
            return;
        }
        // Revised after probes p41/p42. Suppressing 0x605500 changed nothing, and the
        // deep validated stack walk says why: the thread is NOT deadlocked in one call.
        // Its EIP moves between `NtUserExtTextOutW` and `NtUserScrollDC`, and the
        // validated callers are 0x60594E (WinConsole region) and 0x5B0830 repeatedly.
        // That is the console EDIT CONTROL being hammered: every appended line is a
        // synchronous SendMessage -> wndproc -> paint + scroll, which is quadratic and
        // hangs the frame loop rather than blocking it. 0x605500 turned out to have a
        // single caller at 0x605804, i.e. it is a helper inside the append path, not
        // the window creator.
        //
        // So target the appends themselves, which is `re`'s other suggestion.
        suppress_calls_to(0x6057F0, "WinConsole append text (a)");
        suppress_calls_to(0x605870, "WinConsole append text (b)");
        suppress_calls_to(0x603D70, "splash create");
        ENW_INFO("dedi_nowindows: done (a headless server needs neither; logfile 2 has the text)");
    }
};

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::headless_windows_component)
