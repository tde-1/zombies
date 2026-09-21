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
#include "dedicated.hpp"

#include <cstdlib>

namespace enw::dedi {
namespace {

constexpr uintptr_t kDedicatedSkip = 0x59DD35;   // jne 0x59DD4B
constexpr uint8_t   kExpected[2]   = {0x75, 0x14};
constexpr uint8_t   kNops[2]       = {0x90, 0x90};

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
    }
};

ENW_REGISTER_COMPONENT(frame_pacing_component)

}  // namespace
}  // namespace enw::dedi
