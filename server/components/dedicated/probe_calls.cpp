// A general-purpose "which of these functions gets entered, and in what order?" probe.
//
// Built for the Com_Init gate (docs/kickstart/dedi.md §4 site 3): `Com_Init` 0x59D710
// never returns in dedicated mode, `re` mapped its 77 calls and found no spin and no
// WaitForSingleObject, so the gate is a pumping/awaiting callee. Bisecting it means
// asking "did this one get entered, and did the next one?" over a shortlist -- and the
// last one entered, whose successor never is, is the gate.
//
// Deliberately generic and env-driven so a round of bisecting costs a probe and no
// rebuild:
//
//     ENW_DEDI_PROBE=570B80,42FDE0,5A8B30,6C0BC0,479370,6DC5D0
//
// Counters are logged every 5 s with a first-seen ordinal, so the log shows both what
// ran and the order it ran in.
//
// The stubs are NAKED and signature-agnostic: pushfd/pushad, call a no-argument
// counter, popad/popfd, tail-jump to MinHook's trampoline. Correct for any calling
// convention and any arguments, which matters because we know nothing about these
// functions yet -- guessing a C signature is how you corrupt a stack. Same pattern as
// server/components/net/net.cpp.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "hook.hpp"

#include <cstdlib>
#include <thread>

namespace enw::dedi {
namespace {

constexpr size_t kMaxSlots = 12;

struct slot {
    uintptr_t   address = 0;
    enw::hook   hook;
    volatile long count = 0;
    volatile long order = 0;   // first-seen ordinal, 0 = never entered
};

slot  g_slots[kMaxSlots];
void* g_tramp[kMaxSlots] = {};
volatile long g_seq = 0;
size_t g_used = 0;

void bump(size_t i) {
    if (++g_slots[i].count == 1) g_slots[i].order = ++g_seq;
}

#define ENW_SLOT(n)                                                        \
    void __cdecl cnt##n() { bump(n); }                                     \
    __declspec(naked) void stub##n() {                                     \
        __asm { pushfd }                                                   \
        __asm { pushad }                                                   \
        __asm { call cnt##n }                                              \
        __asm { popad }                                                    \
        __asm { popfd }                                                    \
        __asm { jmp dword ptr [g_tramp + n * 4] }                          \
    }

ENW_SLOT(0) ENW_SLOT(1) ENW_SLOT(2)  ENW_SLOT(3)
ENW_SLOT(4) ENW_SLOT(5) ENW_SLOT(6)  ENW_SLOT(7)
ENW_SLOT(8) ENW_SLOT(9) ENW_SLOT(10) ENW_SLOT(11)
#undef ENW_SLOT

void* const kStubs[kMaxSlots] = {&stub0, &stub1, &stub2,  &stub3,
                                 &stub4, &stub5, &stub6,  &stub7,
                                 &stub8, &stub9, &stub10, &stub11};

class probe_calls_component final : public component {
public:
    const char* name() const override { return "dedi_probe_calls"; }

    void post_init() override {
        const char* list = std::getenv("ENW_DEDI_PROBE");
        if (!list || !*list) return;
        ENW_INFO("dedi_probe_calls: ENW_DEDI_PROBE=%s", list);

        for (const char* p = list; *p && g_used < kMaxSlots;) {
            char* end = nullptr;
            const auto addr = static_cast<uintptr_t>(std::strtoul(p, &end, 16));
            if (end == p) break;
            p = (*end == ',') ? end + 1 : end;
            if (!addr) continue;

            const size_t i = g_used;
            const uintptr_t live = enw::at(addr);
            if (!memory::looks_like_function(live)) {
                ENW_WARN("dedi_probe_calls: 0x%08X does not look like a function (%s); skipped",
                         static_cast<unsigned>(addr), memory::hex_dump(live, 8).c_str());
                continue;
            }
            g_slots[i].address = addr;
            if (!g_slots[i].hook.create(live, kStubs[i], "probe") || !g_slots[i].hook.enable()) {
                ENW_WARN("dedi_probe_calls: could not hook 0x%08X (already hooked by someone else?)",
                         static_cast<unsigned>(addr));
                g_slots[i].address = 0;
                continue;
            }
            g_tramp[i] = g_slots[i].hook.original<void*>();
            ++g_used;
            ENW_INFO("dedi_probe_calls: slot %zu watching 0x%08X", i, static_cast<unsigned>(addr));
        }
        if (g_used == 0) return;

        std::thread([] {
            for (int t = 0; t < 600; ++t) {
                ::Sleep(5000);
                std::string line;
                char buf[64];
                for (size_t i = 0; i < g_used; ++i) {
                    std::snprintf(buf, sizeof buf, "%08X:%ld(#%ld) ",
                                  static_cast<unsigned>(g_slots[i].address),
                                  g_slots[i].count, g_slots[i].order);
                    line += buf;
                }
                ENW_INFO("dedi_probe_calls: t=%ds  %s", (t + 1) * 5, line.c_str());
            }
        }).detach();
    }
};

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::probe_calls_component)
