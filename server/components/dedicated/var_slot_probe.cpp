// What the script VM was asked to remove, in the moments before the frame loop
// stops. Diagnostic only: OFF unless ENW_DEDI_VARPROBE=1, and it never changes
// what the engine does.
//
// ---------------------------------------------------------------------------
// Why this exists (dedi.md 7j, runs join19-join25)
// ---------------------------------------------------------------------------
// The freeze is a spin, and it has been located from outside the process (six
// runs, tools/dev/freeze_probe.py):
//
//     main thread, 150/150 samples, EIP in 0x0068F090
//     the tight loop is 0x0068F3B4..0x0068F3DB:
//         cur = childVar[ childVar[cur].v ].id     ; follow the chain
//         until childVar[cur].v == target          ; find the target's predecessor
//
// It is a predecessor search over a CIRCULAR list of script variables, and it
// spins because the id it wants is not in the list it is searching. join24 caught
// it exactly: target id 0x1534 name 'minval', cursor sitting on id 0x347E name
// 'levels' whose own `v` points at itself -- a one-node ring that can never
// contain the target.
//
// Neither pool is full when this happens, which kills the obvious explanation:
// join25 measured child 13,534/65,536 with a live free list and parent
// 2,672/24,576 with a live free list, at the freeze. 0x0068F090 is ALSO one of the
// three functions that raise "exceeded maximum number of script variables"
// (0x0068F235, 0x0068F301), which is why 7j's two failure modes are one function.
//
// So the remaining question is how a removal is asked for on a list that does not
// hold the variable. The likeliest shape is a double removal: the first unlinks
// it, the second searches for a predecessor that no longer exists. That is a
// statement about a SEQUENCE of calls, and nothing outside the process can see a
// sequence -- by the time the freeze is detectable the calls are over.
//
// So: hook the one entry point, 0x0068F4A0, keep the last 128 calls in a ring with
// the caller's return address, and have a watchdog thread print the ring the moment
// enw::frame::count() stops moving. The hook does no I/O and no allocation on the
// game thread; the printing happens on our own thread, after the spin has already
// started.
//
// WHAT THE ARGUMENTS ARE -- and this was read wrong once, so the correction is
// here rather than deleted. join28 was reported as "the same id removed twice, a
// DOUBLE REMOVAL". It is not. The hottest call sites compute a3 immediately before
// pushing it:
//     00694F3C  xor  edx, edx
//     00694F3E  mov  ecx, 0xfffd
//     00694F43  div  ecx                  ; a hash, mod 65533
//     00694F4E  add  edx, 1
//     00694F51  push edx                  ; a3 = A HASH SLOT, not a variable id
//     00694F52  push eax                  ; a2 = the owner object, from gScrVmPub
//     00694F53  push esi                  ; a1 = script instance
//     00694F54  call 0x68F4A0
//     00694F65  add  esp, 0xc             ; the caller cleans -> cdecl, 3 stack args
// So 0x0068F4A0 is "claim this hash slot for this object", the slot-eviction half
// of creating a variable -- and two calls with the same (owner, slot) are ordinary,
// because that is just the same name hashing to the same place twice.
//
// ECX is also live across the call (`mov ecx,[ebp-0x78]` at 0x00694B1D at another
// site), which is why this is a naked thunk with pushad/popad and not a typed
// prototype: a C++ detour would clobber it. dedi.md's standing rule -- read the
// call site, do not guess the convention -- is what caught both of these.
//
// Clean room: our own code, from our own dump and our own logs.

#include "component.hpp"
#include "logger.hpp"
#include "hook.hpp"
#include "memory.hpp"
#include "frame.hpp"
#include "dedicated.hpp"

#include <windows.h>
#include <cstdlib>
#include <cstdint>

#if __has_include("t4/addresses.hpp")
#include "t4/addresses.hpp"
#define ENW_HAVE_T4_ADDRESSES 1
#endif

namespace enw::dedi {
namespace {

#ifdef ENW_HAVE_T4_ADDRESSES

// [V] the only non-recursive entry to the relink/remove helper 0x0068F090, and the
// frame we are always stopped inside (return address 0x0068F4B9 in every sample).
constexpr uintptr_t kClaimVariableSlot = 0x68F4A0;

struct record {
    uint32_t seq;
    uint32_t instance;
    uint32_t a2;
    uint32_t id;
    uint32_t ret;   // the caller's return address: which call site asked
};

constexpr int kRing = 128;
record g_ring[kRing];
volatile long g_next = 0;      // total calls; index is (g_next - 1) % kRing
enw::hook g_hook;
void* g_trampoline = nullptr;
volatile long g_dumped = 0;
HANDLE g_watchdog = nullptr;
volatile long g_stop = 0;

// join26 measured 190,297 calls in 33 s -- about 5,700 a second -- so a 128-entry
// ring is 22 ms of history and cannot answer "when was this slot last claimed?".
// A flat per-slot table can, and costs one array write per call.
uint32_t g_last_seq[0x10000];
uint32_t g_last_a2[0x10000];
volatile uint32_t g_hang_id = 0, g_hang_prev_seq = 0, g_hang_prev_a2 = 0;

void __cdecl observe(uint32_t instance, uint32_t a2, uint32_t id, uint32_t ret) {
    const long n = ::InterlockedIncrement(&g_next);
    record& r = g_ring[(n - 1) % kRing];
    r.seq = static_cast<uint32_t>(n);
    r.instance = instance;
    r.a2 = a2;
    r.id = id;
    r.ret = ret;
    const uint32_t k = id & 0xFFFF;
    // The call that never returns is the last one recorded, so stash what we knew
    // about this id BEFORE overwriting it.
    g_hang_id = id;
    g_hang_prev_seq = g_last_seq[k];
    g_hang_prev_a2 = g_last_a2[k];
    g_last_seq[k] = static_cast<uint32_t>(n);
    g_last_a2[k] = a2;
}

// pushad+pushfd, then a 16-byte-aligned frame before calling into C++ -- MSVC will
// emit SSE in anything it inlines and movaps on an unaligned address is an access
// violation that arrives tens of seconds later. referee/t4_bind.cpp learned this
// the hard way and the note is repeated here on purpose.
__declspec(naked) void claim_slot_detour() {
    __asm {
        pushad
        pushfd
        mov  eax, [esp + 0x28]      // a1, script instance
        mov  ebx, [esp + 0x2C]      // a2
        mov  esi, [esp + 0x30]      // a3, the id being removed
        mov  edi, [esp + 0x24]      // the caller's return address
        push ebp
        mov  ebp, esp
        and  esp, -16
        push edi
        push esi
        push ebx
        push eax
        call observe
        mov  esp, ebp
        pop  ebp
        popfd
        popad
        cmp  dword ptr [g_trampoline], 0
        je   no_trampoline
        jmp  [g_trampoline]
no_trampoline:
        ret
    }
}

void dump_ring(const char* why) {
    if (::InterlockedExchange(&g_dumped, 1) != 0) return;
    const long total = g_next;
    ENW_WARN("dedi_varprobe: %s. %ld call(s) to ClaimVariableSlot(0x%08X) this session; the last "
             "%d, oldest first. a2 is the owner object, a3 the hash slot being claimed, "
             "and `from` is the call site.", why, total, static_cast<unsigned>(enw::at(kClaimVariableSlot)),
             total < kRing ? static_cast<int>(total) : kRing);
    ENW_WARN("dedi_varprobe: the call that did not return is #%ld: slot=0x%05X owner=0x%05X, "
             "called from 0x%08X. This slot was last claimed at #%u (%ld calls earlier) by "
             "owner=0x%05X. A repeat is NOT in itself a fault -- the same name hashes to the "
             "same slot every time. What hangs is evicting whoever is sitting in it.",
             total, g_hang_id, g_ring[(total - 1) % kRing].a2,
             g_ring[(total - 1) % kRing].ret, g_hang_prev_seq,
             g_hang_prev_seq ? total - static_cast<long>(g_hang_prev_seq) : 0, g_hang_prev_a2);
    const long first = total > kRing ? total - kRing : 0;
    for (long i = first; i < total; ++i) {
        const record& r = g_ring[i % kRing];
        ENW_INFO("dedi_varprobe:   #%u inst=%u owner=0x%05X slot=0x%05X from 0x%08X", r.seq,
                 r.instance, r.a2, r.id, r.ret);
    }
}

DWORD WINAPI watchdog(LPVOID) {
    uint64_t last = 0;
    int still = 0;
    while (!g_stop) {
        ::Sleep(1000);
        const uint64_t now = enw::frame::count();
        if (now != 0 && now == last) {
            if (++still == 4) {          // 4 s unchanged: past any map-load hitch
                dump_ring("frame::count has not moved for 4 s");
            }
        } else {
            still = 0;
        }
        last = now;
    }
    return 0;
}

class var_slot_probe_component final : public component {
public:
    const char* name() const override { return "dedi_varprobe"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        char buf[8]{};
        if (!::GetEnvironmentVariableA("ENW_DEDI_VARPROBE", buf, sizeof buf) || buf[0] != '1')
            return;
        // The uintptr_t overload applies at() itself (hook.cpp:112), so this takes
        // the raw vault address, not an already-translated one.
        if (!g_hook.create(kClaimVariableSlot,
                           reinterpret_cast<void*>(&claim_slot_detour), "ClaimVariableSlot") ||
            !g_hook.enable()) {
            ENW_WARN("dedi_varprobe: could not hook 0x%08X; no removal history will be kept",
                     static_cast<unsigned>(enw::at(kClaimVariableSlot)));
            return;
        }
        g_trampoline = g_hook.original<void*>();
        g_watchdog = ::CreateThread(nullptr, 0, &watchdog, nullptr, 0, nullptr);
        ENW_INFO("dedi_varprobe: ON. Recording the last %d script-variable slot claims; the ring is "
                 "printed if frame::count stops for 4 s. Diagnostic only - nothing is changed.",
                 kRing);
    }

    void pre_destroy() override {
        ::InterlockedExchange(&g_stop, 1);
        if (g_watchdog) {
            ::WaitForSingleObject(g_watchdog, 2000);
            ::CloseHandle(g_watchdog);
            g_watchdog = nullptr;
        }
        if (g_next) dump_ring("shutdown");
    }
};

#else

class var_slot_probe_component final : public component {
public:
    const char* name() const override { return "dedi_varprobe"; }
};

#endif

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::var_slot_probe_component)
