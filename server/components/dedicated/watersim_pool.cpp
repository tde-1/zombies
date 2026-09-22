// Give the dedicated server the water-simulation buffers the renderer would have
// allocated, because the SERVER reads them and a headless one has never had them.
//
// ---------------------------------------------------------------------------
// The bug, and why three sessions missed it
// ---------------------------------------------------------------------------
// About fifty seconds after a player spawns on `nazi_zombie_prototype` (5.6 s on
// Der Berg) the engine stops simulating: `com_frameTime` freezes, `SV_Frame` never
// runs again, and the client is dropped forty seconds later. dedi.md 11.1 measured
// that as "the frame body is entered and never returns". 11.2 measured the exit at
// the pacing loop's own `call Com_EventLoop` (0x59DD90) and ruled out `longjmp`
// (0x7AD57C hooked, zero calls, twice) and -- wrongly -- an SEH unwind.
//
// THE SEH FINDING WAS WRONG, AND THE REASON IS WORTH KEEPING. The vectored handler
// logged only its first six exceptions, and the first six of any run are
// DBG_PRINTEXCEPTION_C from init-time debug prints. The access violations start at
// exception #124. Run join61, with the handler counting by class instead of by
// budget:
//
//     Com_EventLoop in=3185 out=1871 MISSING=1314
//     Sys_GetEvent  in=3185 out=3185 MISSING=0        <- the pump is innocent
//     longjmps=0  seh-through=1314                    <- EXACTLY the missing frames
//     exception code=C0000005 at 006F3E6A, once per escaped frame
//
// `seh-through` is a logging `__except` filter in our own wrapper around
// Com_EventLoop: it runs in phase 1 for every exception that propagates past us. It
// equals MISSING to the frame. So every escaped frame is an SEH unwind out of an
// access violation, and the engine's own handler swallows it and returns to
// `Com_Frame` past the body -- which is why `Com_Frame` still returns to WinMain,
// why our tick still runs, and why the counter at 0x59E4DC ("the body returned")
// is the only one that stops.
//
// ---------------------------------------------------------------------------
// What faults
// ---------------------------------------------------------------------------
// join62, with the faulting context logged:
//
//     FAULT eip=006F3E6A edx=00000000 ecx=00000000
//     callers: 006F3FB9 0046DA85 0041853C 0041918D 00504380 00415DF8 0041A743
//              0041AF32 004E896A 004E8E15 00630C6A 00630F4C
//
//     006F3E5D  add edx, 0x4dd0a10           ; edx = i * 0x40E0, i in {0,1}
//     006F3E63  mov edx, [edx]               ; the buffer pointer -- NULL
//     006F3E6A  movq xmm0, [edx + ecx]       ; <- read of 0x00000000
//
// 0x6F3E00 samples a surface by interpolating between two ping-pong buffers, and
// 0x4DD0A10 / 0x4DD4AF0 (= 0x4DD0A10 + 0x40E0) are those two. They are allocated by
// **0x6F13B0**, which is reached only from 0x70EC00 -- the renderer's dynamic-buffer
// bring-up, the function that also carries "Couldn't create a %i-byte dynamic index
// buffer". `dedicated.cpp` skips renderer bring-up at 0x5FF799 on purpose, so on a
// headless server 0x6F13B0 never runs and those pointers stay NULL for ever.
//
// It is the WATER SIMULATION. 0x6F0D90, in the same unit, registers
// `r_watersim_enabled`, `r_watersim_debug`, `r_watersim_flatten`,
// `r_watersim_waveSeedDelay`, `r_watersim_curlAmount`... The `r_` prefix is exactly
// why nobody looked: it reads like renderer-only state. It is not. The chain above
// comes up through 0x630C70 -- the server's own per-client work, reached from
// Com_EventLoop's packet arm -- so the SERVER samples the water surface when a
// player is in or near water, whatever the renderer is doing. That is the whole
// bug, and it explains both timings: fifty seconds is how long it takes a player to
// wander into the water on prototype, and Der Berg puts something in it at once.
//
// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------
// Call 0x6F13B0 once, on a dedicated server, from the first frame. It is the
// engine's own allocator for this pool, it takes no arguments, it is guarded by its
// own `cmp byte [0x46E568C], 0` so calling it twice is a no-op, and every buffer it
// hands out is `memset` to zero before use:
//
//     006F13B0  cmp byte ptr [0x46e568c], 0
//     006F13B7  push esi
//     006F13B8  jne 0x6f1507                 ; already done -> ret
//     006F13BE  push 0x100080 / call malloc / memset 0 / mov [0x4dd0a10], esi
//     ... six buffers: 0x100080, 0x100080, 0x20080, 0x10080, 0x10080, 0x40080
//     006F1500  mov byte ptr [0x46e568c], 1
//     006F1507  pop esi
//     006F1508  ret
//
// So this is not a patch and not a suppression: it is the engine allocating its own
// pool with its own allocator, two megabytes, zeroed. A zeroed water field is a flat
// surface, which is precisely what an unseeded simulation reads as -- and nothing
// headless ever seeds a wave, because that happens in the renderer's frame.
//
// WHY NOT `r_watersim_enabled 0`: the sampler faults before any dvar test we can see
// on this path, and turning a subsystem off is a guess about what else reads it.
// Allocating the memory it was always meant to have cannot change any other answer.
//
// SELF-VERIFYING. We read the guard byte and all six pointers before and after, and
// say so. If the pointer is still NULL afterwards the log says that in as many words
// rather than leaving the next session to re-derive tonight.
//
// ENW_DEDI_NO_WATERSIM_POOL=1 turns it off; the escape comes straight back.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "frame.hpp"
#include "dedicated.hpp"

#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace enw::dedi {
namespace {

// R_AllocWaterSimBuffers, our name for it: the allocator at the top of the unit that
// registers the r_watersim_* dvars.
constexpr uintptr_t kAllocPool = 0x6F13B0;
constexpr uintptr_t kGuardByte = 0x46E568C;

// The six pointers it fills, in the order it fills them. The first two are the pair
// 0x6F3E00 interpolates between (0x4DD0A10 + i * 0x40E0).
constexpr uintptr_t kPointers[] = {
    0x4DD0A10, 0x4DD4AF0, 0x4DD8BD0, 0x4DD94B0, 0x4DD9990, 0x4DD9E70,
};

// `cmp byte ptr [0x46E568C], 0` -- the first seven bytes of the function. If this
// does not match we are not looking at the allocator and we call nothing.
constexpr uint8_t kSignature[] = {0x80, 0x3D, 0x8C, 0x56, 0x6E, 0x04, 0x00};

bool g_done = false;

void report(const char* when) {
    uint8_t guard = 0xFF;
    memory::read(enw::at(kGuardByte), &guard);
    char line[256];
    int n = std::snprintf(line, sizeof line, "guard=%u", guard);
    for (uintptr_t p : kPointers) {
        uint32_t v = 0;
        memory::read(enw::at(p), &v);
        n += std::snprintf(line + n, sizeof line - n, " [%08X]=%08X",
                           static_cast<unsigned>(p), v);
        if (n >= static_cast<int>(sizeof line) - 24) break;
    }
    ENW_INFO("dedi_watersim_pool: %s: %s", when, line);
}

void allocate_once() {
    if (g_done) return;
    g_done = true;

    const uintptr_t fn = enw::at(kAllocPool);
    uint8_t got[sizeof kSignature] = {};
    if (!memory::read_raw(fn, got, sizeof got) ||
        std::memcmp(got, kSignature, sizeof got) != 0) {
        ENW_ERROR("dedi_watersim_pool: NOT calling 0x%08X: expected the allocator's "
                  "`cmp byte ptr [0x%08X], 0` (%s), found %s. The water-sim buffers stay "
                  "NULL and the frame body will keep escaping -- dedi.md 12.",
                  static_cast<unsigned>(kAllocPool), static_cast<unsigned>(kGuardByte),
                  memory::hex_dump(reinterpret_cast<uintptr_t>(kSignature), sizeof kSignature)
                      .c_str(),
                  memory::hex_dump(fn, sizeof got).c_str());
        return;
    }

    report("before");
    reinterpret_cast<void(__cdecl*)()>(fn)();
    report("after ");

    uint32_t first = 0, second = 0;
    memory::read(enw::at(kPointers[0]), &first);
    memory::read(enw::at(kPointers[1]), &second);
    if (first && second) {
        ENW_INFO("dedi_watersim_pool: the water-simulation pool is allocated and zeroed "
                 "(0x%08X -> %08X, 0x%08X -> %08X). 0x006F3E6A can no longer read through a "
                 "NULL buffer, which is what stopped the frame body returning.",
                 static_cast<unsigned>(kPointers[0]), first,
                 static_cast<unsigned>(kPointers[1]), second);
    } else {
        ENW_ERROR("dedi_watersim_pool: 0x%08X returned but the buffers are still NULL "
                  "(%08X / %08X). The allocation failed; expect the escape of dedi.md 11.1.",
                  static_cast<unsigned>(kAllocPool), first, second);
    }
}

class watersim_pool_component final : public component {
public:
    const char* name() const override { return "dedi_watersim_pool"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_NO_WATERSIM_POOL")) {
            ENW_WARN("dedi_watersim_pool: OFF (ENW_DEDI_NO_WATERSIM_POOL). The water-sim "
                     "buffers stay NULL, 0x006F3E6A faults once a frame and the engine stops "
                     "simulating about fifty seconds after a player spawns. This is the "
                     "control for dedi.md 12.");
            g_done = true;
            return;
        }
        // From the first frame, not from post_init: the engine's allocator is
        // certainly up by then, and the fault we are heading off is twenty seconds
        // away at the earliest.
        enw::frame::subscribe("dedi_watersim_pool", [](uint64_t) { allocate_once(); });
    }
};

ENW_REGISTER_COMPONENT(watersim_pool_component)

}  // namespace
}  // namespace enw::dedi
