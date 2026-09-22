// Give a headless server a sane frame rate instead of letting it free-run.
//
// ---------------------------------------------------------------------------
// What the engine does, read from the instructions
// ---------------------------------------------------------------------------
// The frame body 0x59DCF0 computes a minimum frame time into [esp+0x14] and then
// sleeps 1 ms at a time (bounded to 50) until that much has elapsed:
//
//     0059DD10  mov edx, [0x1F96488]     ; the com_maxfps dvar
//     0059DD1C  mov ecx, [edx+0x10]      ; its int value
//     0059DD1F  test ecx, ecx
//     0059DD21  mov ebx, 1
//     0059DD26  mov [esp+0x14], ebx      ; target = 1 ms
//     0059DD2A  jle 0059DD4B             ; com_maxfps <= 0 -> uncapped, keep 1
//     0059DD2C  mov eax, [0x212B2F4]     ; com_dedicated
//     0059DD31  cmp dword ptr [eax+0x10], 0
//     0059DD35  jne 0059DD4B             ; DEDICATED -> skip the maths, keep 1  <-- here
//     0059DD37  mov eax, 0x3E8           ; 1000
//     0059DD3D  idiv ecx                 ; target = 1000 / com_maxfps
//     0059DD41  mov [esp+0x14], eax
//
// So **a dedicated server deliberately ignores com_maxfps** and paces to 1 ms. That
// is why `+set com_maxfps 0` changed nothing when it was tried as a cure for the
// 4-frame stop (dedi.md §7b): the dvar is not consulted on this path at all.
//
// Measured with the loop actually running (run r04, 90 s): Com_Frame free-runs at a
// very steady **515 Hz** and costs ~12.5% of one core, while `SV_Frame` -- the tick
// that does the real work -- runs at **20.3 fps**, because it paces itself to sv_fps.
// So ~495 of every 515 frames per second are Com_Frame doing nothing but asking the
// OS what time it is. Harmless on one box; silly on a box meant to host several
// instances.
//
// ---------------------------------------------------------------------------
// The patch
// ---------------------------------------------------------------------------
// NOP the two bytes of the `jne` at 0x59DD35 (`75 14`). Dedicated then takes the
// same 1000/com_maxfps path the client already takes -- no new code, no new
// constant, just the branch that excludes us. The `jle` at 0x59DD2A still catches
// com_maxfps <= 0, so "uncapped" remains reachable by setting the dvar to 0.
//
// We verify the exact two bytes before writing and refuse otherwise, so a moved
// address turns into a log line rather than a corrupted branch.
//
// ENW_DEDI_UNCAPPED=1 leaves the engine alone.
// The rate itself is then just `+set com_maxfps N` on the command line; dediprobe.ps1
// passes 60, which is 3x sv_fps and plenty of headroom.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "frame.hpp"
#include "dedicated.hpp"

#include <cstdlib>

#include <mmsystem.h>
#pragma comment(lib, "winmm.lib")

namespace enw::dedi {
namespace {

constexpr uintptr_t kDedicatedSkip = 0x59DD35;   // jne 0x59DD4B
constexpr uint8_t   kExpected[2]   = {0x75, 0x14};
constexpr uint8_t   kNops[2]       = {0x90, 0x90};

// ---------------------------------------------------------------------------
// Instrument: which of the three counters is actually moving at 5,900 Hz?
// ---------------------------------------------------------------------------
// The frame body 0x59DCF0 cannot free-run: the target it computes is clamped to a
// minimum of 1 ms (0x59DD3F `test eax,eax` / 0x59DD47 puts ebx=1 back), so with
// timeBeginPeriod(1) the Sleep(1) loop bounds it to ~1000 Hz however com_maxfps
// reads. 5,900 Hz therefore means either the body is being entered without the
// loop running, or Com_Frame is returning before it reaches the body.
//
// Three engine counters tell those apart, read-only:
//   [0x1F552D4]  incremented at 0x59DD72, INSIDE the body, before the pacing loop
//   [0x1F964BC]  incremented at 0x59E4DC, in Com_Frame, only if the body was called
//                (the setjmp at 0x59E4C1 returning non-zero skips both)
//   [0x1F96488]  the com_maxfps dvar; +0x10 is its int value
constexpr uintptr_t kComMaxfpsDvar  = 0x1F96488;
constexpr uintptr_t kComFrameTime   = 0x1F9648C;
constexpr uintptr_t kLastFrameTime  = 0x1F964B8;
constexpr uintptr_t kComFrameNumber = 0x1F964BC;  // Com_Frame, body ran
constexpr uintptr_t kBodyCounter    = 0x1F552D4;  // frame body entered

uint64_t g_outer_sleeps = 0;
uint64_t g_outer_slept_ms = 0;

class frame_pacing_component final : public component {
public:
    const char* name() const override { return "dedi_frame_pacing"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_UNCAPPED")) {
            ENW_WARN("dedi_frame_pacing: ENW_DEDI_UNCAPPED set - leaving the 1 ms dedicated pacing "
                     "target alone. Expect Com_Frame at ~500 Hz and ~12%% of a core.");
            return;
        }

        const uintptr_t site = enw::at(kDedicatedSkip);
        uint8_t got[2] = {};
        if (!memory::read_raw(site, got, sizeof got) ||
            got[0] != kExpected[0] || got[1] != kExpected[1]) {
            ENW_ERROR("dedi_frame_pacing: NOT patching 0x%08X. Expected `jne` (75 14), found "
                      "%02X %02X. Context: %s",
                      static_cast<unsigned>(kDedicatedSkip), got[0], got[1],
                      memory::hex_dump(site - 9, 20).c_str());
            return;
        }
        if (!memory::write_raw(site, kNops, sizeof kNops)) {
            ENW_ERROR("dedi_frame_pacing: could not write to 0x%08X",
                      static_cast<unsigned>(kDedicatedSkip));
            return;
        }
        ENW_INFO("dedi_frame_pacing: dedicated mode now honours com_maxfps (nopped the `jne` at "
                 "0x%08X that skipped the 1000/com_maxfps computation). Set the rate with "
                 "+set com_maxfps N; 0 restores free-running.",
                 static_cast<unsigned>(kDedicatedSkip));

        install_rate_probe();
        install_outer_pacer();
    }

private:
    // -----------------------------------------------------------------------
    // The engine's pacing is INSIDE the thing that stops working
    // -----------------------------------------------------------------------
    // The nop above makes 0x59DCF0 compute a 1000/com_maxfps target, and the sleep
    // that honours it is the loop at 0x59DD90..0x59DDE4. `Com_EventLoop` is called
    // from INSIDE that loop, at 0x59DD90 -- so when a frame leaves through
    // Com_EventLoop rather than returning from it (measured: join55/join56, the
    // engine's own frame number and com_frameTime both stop dead while the body is
    // still entered 5,300 times a second), the sleep never runs. The cap is not
    // "not applying": the instructions that would apply it are being jumped over.
    //
    // So the cap has to also exist somewhere a longjmp cannot skip, and there is
    // exactly one such place: outside Com_Frame, in WinMain's loop, which is where
    // enw::frame already runs. This tops the frame up to the same 1000/com_maxfps
    // target the engine would have used, measuring across our own tick:
    //
    //   * a frame the engine paced properly arrives ~16 ms after the last one and we
    //     sleep 0 -- no double pacing, self-correcting, nothing to tune;
    //   * a frame that escaped arrives in ~0.2 ms and we sleep the remaining ~16.
    //
    // Bounded to 50 ms of sleep per frame, the same bound the engine's own loop uses
    // (`cmp edi, 0x32` at 0x59DDE1), so a stall cannot turn into a long sleep.
    // ENW_DEDI_NO_OUTER_PACE=1 turns it off and the 5,300 Hz spin comes straight back.
    void install_outer_pacer() {
        if (std::getenv("ENW_DEDI_NO_OUTER_PACE")) {
            ENW_WARN("dedi_frame_pacing: ENW_DEDI_NO_OUTER_PACE set - the only cap is the "
                     "engine's own, which a frame that leaves through Com_EventLoop skips.");
            return;
        }
        enw::frame::subscribe("dedi_outer_pace", [](uint64_t) {
            int maxfps = 0;
            uintptr_t dv = 0;
            if (memory::read(enw::at(kComMaxfpsDvar), &dv) && dv) memory::read(dv + 0x10, &maxfps);
            if (maxfps <= 0) return;                        // uncapped, on purpose

            const DWORD target = static_cast<DWORD>(1000 / maxfps ? 1000 / maxfps : 1);
            static DWORD last = 0;
            const DWORD now = ::timeGetTime();
            if (last == 0) { last = now; return; }

            const DWORD elapsed = now - last;
            if (elapsed < target) {
                DWORD wait = target - elapsed;
                if (wait > 50) wait = 50;
                ::Sleep(wait);
                ++g_outer_sleeps;
                g_outer_slept_ms += wait;
            }
            last = ::timeGetTime();
        });
        ENW_INFO("dedi_frame_pacing: outer pacer installed (WinMain-level top-up to "
                 "1000/com_maxfps). The engine's own cap lives inside the loop that a frame "
                 "leaving through Com_EventLoop skips; this one cannot be skipped.");
    }

    // Read-only, one subscriber, a log line every 5 s. Costs five dword reads a
    // frame. ENW_DEDI_NO_RATE_PROBE=1 turns it off.
    void install_rate_probe() {
        if (std::getenv("ENW_DEDI_NO_RATE_PROBE")) return;

        enw::frame::subscribe("dedi_rate_probe", [](uint64_t n) {
            static uint32_t last_body = 0, last_com = 0;
            static uint64_t last_ours = 0;
            static DWORD    last_tick = 0;

            const DWORD now = ::GetTickCount();
            if (last_tick == 0) { last_tick = now; }
            if (now - last_tick < 5000) return;

            uint32_t body = 0, com = 0, ft = 0, lft = 0;
            int maxfps = -1;
            memory::read(enw::at(kBodyCounter), &body);
            memory::read(enw::at(kComFrameNumber), &com);
            memory::read(enw::at(kComFrameTime), &ft);
            memory::read(enw::at(kLastFrameTime), &lft);
            uintptr_t dv = 0;
            if (memory::read(enw::at(kComMaxfpsDvar), &dv) && dv) {
                memory::read(dv + 0x10, &maxfps);
            }

            const double secs = (now - last_tick) / 1000.0;
            ENW_INFO("dedi_rate_probe: com_maxfps=%d target=%dms | ours %.1f Hz | "
                     "Com_Frame-body %.1f Hz | frame-body-entered %.1f Hz | "
                     "com_frameTime=%u lastFrameTime=%u delta=%d | outer-pace %llu sleeps %llu ms",
                     maxfps, (maxfps > 0 ? (1000 / maxfps ? 1000 / maxfps : 1) : 1),
                     (n - last_ours) / secs,
                     (com - last_com) / secs,
                     (body - last_body) / secs,
                     com_unsigned(ft), com_unsigned(lft),
                     static_cast<int>(ft - lft),
                     static_cast<unsigned long long>(g_outer_sleeps),
                     static_cast<unsigned long long>(g_outer_slept_ms));

            last_body = body; last_com = com; last_ours = n; last_tick = now;
        });
    }

    static unsigned com_unsigned(uint32_t v) { return static_cast<unsigned>(v); }
};

ENW_REGISTER_COMPONENT(frame_pacing_component)

}  // namespace
}  // namespace enw::dedi
