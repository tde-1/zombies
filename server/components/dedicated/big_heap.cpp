// Raise the engine's main memory reserve so big custom maps can load.
//
// ---------------------------------------------------------------------------
// Why
// ---------------------------------------------------------------------------
// Stock WaW reserves 0x12C00000 (300 MB) for its main allocator at three sites in
// the startup path, verified by `re` and recorded in shared/t4/addresses.hpp ::
// t4::mem:
//
//     0x5F5491   push 0x12C00000          ; the size argument to VirtualAlloc
//     0x5F54CB   mov [0x224FAEC], 0x12C00000
//     0x5F54D5   mov [0x224FBF0], 0x12C00000
//
// Custom maps from 2012 onwards routinely exceed it, and the symptom is not "out of
// memory": the asset load gives up quietly and the map runs with holes in it. That is
// exactly the shape of the failure mvp-client recorded for `nazi_zombie_leviathan`
// (board 17:12) -- about forty `Could not load xmodel` lines, and then a GSC runtime
// error `unknown item 'napalmblob'` for an item whose asset never arrived.
//
// T4M exists to fix this and rewrites the same three constants to 0x19600000 (422 MB).
// We re-implement it from that fact; no code is copied (dev-box.md rule 7).
//
// ---------------------------------------------------------------------------
// Why it is off by default
// ---------------------------------------------------------------------------
// It changes the memory map of every allocation the engine makes, which is not a
// thing to have running under an unrelated experiment. `ENW_DEDI_BIG_HEAP=1` turns
// it on; `tools\dev\maptest.ps1 -BigHeap` passes it. Each site is verified byte for
// byte before it is written and refused otherwise, so a moved address is a log line
// and not a corrupted instruction.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "dedicated.hpp"
#include "t4/addresses.hpp"

#include <cstdlib>

namespace enw::dedi {
namespace {

class big_heap_component final : public component {
public:
    const char* name() const override { return "dedi_big_heap"; }

    // NOT gated on is_dedicated(): component::is_supported() is evaluated during
    // post_load, and the dedicated component only sets its flag partway through that
    // same phase, so this one reported "not supported here, skipped" on a server that
    // very much was dedicated (run map01). The env var is the gate, and the env var is
    // only ever set by a harness that knows it is launching a server.
    bool is_supported() override { return true; }

    void post_unpack() override {
        if (!std::getenv("ENW_DEDI_BIG_HEAP")) return;

        // The reserve happens in Sys_/Com_ init, before post_init runs, so this has to
        // be at post_unpack -- the earliest point at which the image is decrypted.
        // CORRECTION, measured in run map02 and confirmed against the dump:
        // shared/t4/addresses.hpp :: t4::mem carries the INSTRUCTION starts and calls
        // them "the true operand starts", and says the vault's 0x5F5492/0x5F54D1/
        // 0x5F54DB "land mid-instruction". It is the other way round. Disassembled:
        //     0x5F5491  68 00 00 C0 12                push 0x12C00000
        //     0x5F54CB  C7 05 EC FA 24 02 00 00 C0 12 mov [0x224FAEC], 0x12C00000
        //     0x5F54D5  C7 05 F0 FB 24 02 00 00 C0 12 mov [0x224FBF0], 0x12C00000
        // so the immediates are at +1, +6 and +6. Reading t4::mem's numbers gives
        // 0xC0000068 and 0xFAEC05C7 -- which is exactly what this component refused to
        // patch, and why the guard is worth having. The vault was right.
        // `re` owns shared/t4; this is a note for that lane, not an edit to its file.
        const uintptr_t sites[3] = {
            enw::at(t4::mem::reserve_site_1) + 1,
            enw::at(t4::mem::reserve_site_2) + 6,
            enw::at(t4::mem::reserve_site_3) + 6,
        };

        int done = 0;
        for (int i = 0; i < 3; ++i) {
            uint32_t got = 0;
            if (!memory::read(sites[i], &got)) {
                ENW_ERROR("dedi_big_heap: cannot read site %d at 0x%08X", i + 1,
                          static_cast<unsigned>(sites[i]));
                continue;
            }
            if (got == t4::mem::t4me_value) { ++done; continue; }   // already raised
            if (got != t4::mem::stock_value) {
                ENW_ERROR("dedi_big_heap: NOT patching site %d at 0x%08X. Expected 0x%08X, "
                          "found 0x%08X. Context: %s", i + 1, static_cast<unsigned>(sites[i]),
                          t4::mem::stock_value, got, memory::hex_dump(sites[i] - 8, 20).c_str());
                continue;
            }
            if (memory::write<uint32_t>(sites[i], t4::mem::t4me_value)) { ++done; }
        }

        if (done == 3) {
            ENW_INFO("dedi_big_heap: main memory reserve raised 300 MB -> 422 MB at all three "
                     "sites (0x%08X/0x%08X/0x%08X). ENW_DEDI_BIG_HEAP was set.",
                     static_cast<unsigned>(t4::mem::reserve_site_1),
                     static_cast<unsigned>(t4::mem::reserve_site_2),
                     static_cast<unsigned>(t4::mem::reserve_site_3));
        } else {
            ENW_ERROR("dedi_big_heap: only %d of 3 sites raised. The engine is now in a MIXED "
                      "state; treat any measurement from this run as void.", done);
        }
    }
};

ENW_REGISTER_COMPONENT(big_heap_component)

}  // namespace
}  // namespace enw::dedi
