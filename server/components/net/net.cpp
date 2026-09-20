// Stage C networking: is anything reaching the server's socket, and does it reply?
//
// The one thing still blocking Stage C (docs/kickstart/dedi.md §4, site 3) is that a
// headless CoDWaW answers nothing on 127.0.0.1: `getstatus`, `getinfo` and
// `getchallenge` all time out, with and without a map, with and without sp_minplayers,
// and posting WM_NULL to its windows changes nothing. A clean UDP timeout (rather than
// an ICMP port-unreachable) tells us the socket IS bound and the datagram WAS accepted
// by the stack -- so either the engine never reads it, or it reads it and declines.
//
// This component settles which, by counting entries into the engine's own packet
// handlers. `re` verified:
//     SV_PacketEvent            0x635540   top-level packet handler
//     SV_ConnectionlessPacket   0x634E90   OOB dispatcher (getstatus/getinfo/
//                                          getchallenge/connect/stats/disconnect)
//     SV_DirectConnect          0x62E3A0   "protocol"/"challenge"/"qport"/"password"
//     SVC_GetChallenge          0x62DB60   emits "challengeResponse %i %s"
//
// The detours are NAKED and signature-agnostic on purpose. We do not know these
// functions' calling conventions or argument shapes (SV_ConnectionlessPacket almost
// certainly takes a 24-byte netadr_s by value), and guessing wrong corrupts the stack.
// A naked stub that saves flags and registers, calls a no-argument C counter and then
// tail-jumps to MinHook's trampoline is correct for any convention and any arguments.
//
// Clean room: our own code. No T4M, no decompiled Activision code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "hook.hpp"

#include <thread>

#if __has_include("t4/addresses.hpp")
#include "t4/addresses.hpp"
#define ENW_HAVE_T4_ADDRESSES 1
#endif

#if __has_include("../dedicated/dedicated.hpp")
#include "../dedicated/dedicated.hpp"
#define ENW_HAVE_DEDI 1
#endif

namespace enw::net {
namespace {

#ifdef ENW_HAVE_T4_ADDRESSES

struct counted_hook {
    const char* name;
    uintptr_t   address;
    enw::hook   hook;
    volatile long count;
    void*       trampoline;
};

// One entry per handler we want to see fire. Order matters only for the log.
counted_hook g_hooks[] = {
    {"SV_PacketEvent",          t4::fn::SV_PacketEvent,          {}, 0, nullptr},
    {"SV_ConnectionlessPacket", t4::fn::SV_ConnectionlessPacket, {}, 0, nullptr},
    {"SVC_GetChallenge",        t4::fn::SVC_GetChallenge,        {}, 0, nullptr},
    {"SV_DirectConnect",        t4::fn::SV_DirectConnect,        {}, 0, nullptr},
};
constexpr size_t kHookCount = sizeof(g_hooks) / sizeof(g_hooks[0]);

// The tail jump goes through a plain array of trampoline pointers, because the inline
// assembler cannot compute C++ member offsets.
void* g_tramp[kHookCount] = {nullptr, nullptr, nullptr, nullptr};

void __cdecl count0() { ++g_hooks[0].count; }
void __cdecl count1() { ++g_hooks[1].count; }
void __cdecl count2() { ++g_hooks[2].count; }
void __cdecl count3() { ++g_hooks[3].count; }

// pushfd/pushad save every flag and register, the counter takes no arguments and
// cleans up after itself, and the tail jump leaves the original stack frame exactly as
// the engine built it. Correct for cdecl, stdcall, thiscall and by-value structs alike.
__declspec(naked) void stub0() { __asm { pushfd
                                         pushad
                                         call count0
                                         popad
                                         popfd
                                         jmp  dword ptr [g_tramp + 0] } }
__declspec(naked) void stub1() { __asm { pushfd
                                         pushad
                                         call count1
                                         popad
                                         popfd
                                         jmp  dword ptr [g_tramp + 4] } }
__declspec(naked) void stub2() { __asm { pushfd
                                         pushad
                                         call count2
                                         popad
                                         popfd
                                         jmp  dword ptr [g_tramp + 8] } }
__declspec(naked) void stub3() { __asm { pushfd
                                         pushad
                                         call count3
                                         popad
                                         popfd
                                         jmp  dword ptr [g_tramp + 12] } }

void* const kStubs[kHookCount] = {&stub0, &stub1, &stub2, &stub3};

class net_component final : public component {
public:
    const char* name() const override { return "net"; }

    bool is_supported() override {
#ifdef ENW_HAVE_DEDI
        return true;  // the dedicated flag is only known after post_load
#else
        return true;
#endif
    }

    void post_init() override {
#ifdef ENW_HAVE_DEDI
        if (!enw::dedi::is_dedicated()) {
            ENW_INFO("net: not a dedicated server; packet counters off");
            return;
        }
#endif
        size_t installed = 0;
        for (size_t i = 0; i < kHookCount; ++i) {
            auto& h = g_hooks[i];
            const uintptr_t live = enw::at(h.address);
            if (!memory::looks_like_function(live)) {
                ENW_ERROR("net: %s 0x%08X does not look like a function (%s)",
                          h.name, static_cast<unsigned>(h.address),
                          memory::hex_dump(live, 8).c_str());
                continue;
            }
            if (!h.hook.create(live, kStubs[i], h.name) || !h.hook.enable()) {
                ENW_ERROR("net: could not hook %s at 0x%08X", h.name,
                          static_cast<unsigned>(h.address));
                continue;
            }
            g_tramp[i] = h.hook.original<void*>();
            ++installed;
        }
        ENW_INFO("net: %zu of %zu packet handlers hooked", installed, kHookCount);
        if (installed == 0) return;

        std::thread([] {
            for (int i = 0; i < 600; ++i) {
                ::Sleep(5000);
                ENW_INFO("net: t=%ds  SV_PacketEvent=%ld  SV_ConnectionlessPacket=%ld  "
                         "SVC_GetChallenge=%ld  SV_DirectConnect=%ld",
                         (i + 1) * 5,
                         g_hooks[0].count, g_hooks[1].count, g_hooks[2].count, g_hooks[3].count);
            }
        }).detach();
    }
};

#else  // !ENW_HAVE_T4_ADDRESSES

class net_component final : public component {
public:
    const char* name() const override { return "net"; }
    void post_load() override { ENW_WARN("net: shared/t4/addresses.hpp missing; component disabled"); }
};

#endif

}  // namespace
}  // namespace enw::net

ENW_REGISTER_COMPONENT(enw::net::net_component)
