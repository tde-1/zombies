// Who writes into the script-variable pool that is not the script-variable code.
//
// OFF unless ENW_DEDI_VARWATCH=1. It changes nothing: four hardware watchpoints and
// a vectored exception handler that records and continues.
//
// ---------------------------------------------------------------------------
// Why (dedi.md 7j, runs join33-join37)
// ---------------------------------------------------------------------------
// tools/dev/varcheck.py sweeps the child-variable pool from outside the process and
// checks one invariant: every slot whose record is a live chain member must be named
// by exactly one record's `v.next`. Runs join33, join36 and join37 all show the same
// thing -- the pool is clean while the map runs, and then, about three seconds after
// the player reaches CS_ACTIVE, a handful of slots break that invariant in a single
// step and never recover. The freeze follows four to six seconds later, and join37
// closed the loop: the hash slot the spin is hunting for (`index` = 0x16C0) is one of
// the slots the sweep had already flagged.
//
// The byte diff is the interesting part. The damaged slots are not damaged in a way
// the allocator could produce. Sixteen bytes are overwritten at slot 0x16C0 and again
// at 0x36C0, 0x56C0, 0x76C0, 0x96C0, 0xB6C0 and 0xD6C0 -- a stride of exactly 0x2000
// entries, which is 0x20000 bytes, 128 KB -- with the same 16 bytes each time bar a
// couple of fields that step along:
//
//     slot 0x36C0 was C0 36 C4 36 AC 04 00 00 41 4A 32 00 C0 36 C6 36   (a live entry)
//     slot 0x36C0 now 69 3C 10 00 00 00 00 00 00 D4 43 F6 97 8D 41 A0
//     slot 0x56C0 was C0 56 BD 56 C3 56 00 00 00 00 00 00 C0 56 00 00   (a free entry)
//     slot 0x56C0 now 69 3C 11 00 00 00 00 00 00 D4 43 B5 15 8A 41 B1
//
// A regular 128 KB stride over three quarters of a megabyte is not a hash table
// losing a link; it is something else's buffer being written through this memory.
// Nothing in the variable allocator walks memory at a fixed stride, so the useful
// question is no longer "which scr_variable path is wrong" but "which instruction
// stores here at all".
//
// ---------------------------------------------------------------------------
// How
// ---------------------------------------------------------------------------
// Four 4-byte write watchpoints in DR0-DR3, covering the `w` field of the four slots
// the damage has started from in every run so far (0x16BF..0x16C2 -- the family base
// has been in that four-slot window in join33, join36 and join37), and a vectored
// handler that records EIP plus the nearest return addresses and continues.
//
// The debug registers are set WITHOUT suspending anything: the main thread raises a
// private exception code, the handler writes Dr0-Dr7 into the CONTEXT it is given and
// returns EXCEPTION_CONTINUE_EXECUTION, so the kernel reloads them on the way back.
// dedi.md 7j records what suspending this thread does (`where_is_main.cpp`, join18:
// the server died instead of freezing), and this does not do it.
//
// Hardware watchpoints are PER THREAD. These are armed on the main thread only, which
// makes a silent run informative rather than a failure: if the pool is damaged while
// nothing here fires, the writer is on another thread, and that is the answer.
//
// The handler never logs; it fills a ring. The ring is printed from the frame tick
// (main thread, frame boundary) and from a watchdog once frame::count stops.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "frame.hpp"
#include "dedicated.hpp"

#include <windows.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace enw::dedi {
namespace {

// Our own code for "arm the debug registers on this thread". The 0x2000'0000 bit
// marks it as a customer (non-Microsoft) code so nothing else claims it.
constexpr DWORD kArmException = 0xE0575701u;

// The pool. childVariables[0] for script instance 0; a slot's entry is 16 bytes and
// its `w` (type | status | name) is at +8, which is where the garbage lands.
constexpr uintptr_t kChildVars = 0x3974700;
constexpr uint32_t  kFirstSlot = 0x16BF;   // the four slots the damage starts from

constexpr int kRing = 256;

struct hit {
    uint32_t eip;
    uint32_t addr;
    uint32_t value;
    uint32_t ret[4];
};

constexpr int kForeign = 64;

hit g_ring[kRing];
hit g_foreign_ring[kForeign];      // kept separately: these are the whole point and
                                   // must not be pushed out of the ring by the
                                   // thousands of ordinary writes around them
volatile long g_total = 0;
volatile long g_foreign = 0;       // hits from outside the script-variable code
volatile long g_foreign_shown = 0;
volatile long g_armed = 0;
volatile long g_printed = 0;
volatile long g_stop = 0;
HANDLE g_watchdog = nullptr;
PVOID g_veh = nullptr;
uintptr_t g_watch[4] = {};
uint32_t g_dr7 = 0;
// Only record writes whose new value is at least this. The temp-stack offset is
// written thousands of times a second at depth 1 and 2, all of it balanced; the
// interesting writes are the ones that go deeper and stay there.
uint32_t g_min_value = 0;

// The script VM and the variable allocator live here. A store from inside this range
// is the engine doing its own bookkeeping and is not what we are looking for; a store
// from outside it is.
bool is_script_code(uint32_t eip) {
    return eip >= enw::at(0x00689000) && eip < enw::at(0x0069C000);
}

LONG CALLBACK on_exception(EXCEPTION_POINTERS* ep) {
    auto* er = ep->ExceptionRecord;
    auto* cx = ep->ContextRecord;

    if (er->ExceptionCode == kArmException) {
        cx->Dr0 = g_watch[0];
        cx->Dr1 = g_watch[1];
        cx->Dr2 = g_watch[2];
        cx->Dr3 = g_watch[3];
        cx->Dr6 = 0;
        // Per watchpoint: local-enable bit (2*i), and R/W = 01 (write) with LEN = 11
        // (4 bytes) in the nibble at 16 + 4*i -- 0xD per nibble. Built in post_init
        // so that fewer than four can be armed.
        cx->Dr7 = g_dr7;
        ::InterlockedExchange(&g_armed, 1);
        return EXCEPTION_CONTINUE_EXECUTION;
    }

    if (er->ExceptionCode != EXCEPTION_SINGLE_STEP) return EXCEPTION_CONTINUE_SEARCH;
    const DWORD which = cx->Dr6 & 0xF;
    if (!which) return EXCEPTION_CONTINUE_SEARCH;

    cx->Dr6 = 0;   // cleared first: every path out of here must leave it clear, or
                   // the next trap reports a stale bit and we blame the wrong slot
    const int i = (which & 1) ? 0 : (which & 2) ? 1 : (which & 4) ? 2 : 3;
    const long n = ::InterlockedIncrement(&g_total) - 1;
    hit h{};
    h.eip = cx->Eip;
    h.addr = static_cast<uint32_t>(g_watch[i]);
    h.value = 0;
    memory::read(g_watch[i], &h.value);
    // The store may well be in a runtime memcpy, so the caller matters more than EIP.
    int found = 0;
    for (uintptr_t p = cx->Esp; p < cx->Esp + 0x80 && found < 4; p += 4) {
        uint32_t v = 0;
        if (!memory::read(p, &v)) break;
        if (memory::text_section().contains(v)) h.ret[found++] = v;
    }
    if (h.value < g_min_value) return EXCEPTION_CONTINUE_EXECUTION;
    g_ring[n % kRing] = h;
    if (!is_script_code(h.eip)) {
        const long f = ::InterlockedIncrement(&g_foreign) - 1;
        if (f < kForeign) g_foreign_ring[f] = h;
    }

    return EXCEPTION_CONTINUE_EXECUTION;
}

void show(const char* tag, long idx, const hit& h) {
    ENW_WARN("dedi_varwatch:   %s[%ld] addr 0x%08X <- 0x%08X from EIP 0x%08X "
             "(callers 0x%08X 0x%08X 0x%08X 0x%08X)", tag, idx, h.addr, h.value, h.eip,
             h.ret[0], h.ret[1], h.ret[2], h.ret[3]);
}

// Print any foreign write we have not printed yet. Called from the frame tick, so
// the handler itself never does I/O.
void drain_foreign() {
    long f = g_foreign;
    if (f > kForeign) f = kForeign;
    while (g_foreign_shown < f) {
        const long k = g_foreign_shown;
        show("foreign", k, g_foreign_ring[k]);
        ::InterlockedIncrement(&g_foreign_shown);
    }
}

void dump(const char* why) {
    if (::InterlockedExchange(&g_printed, 1)) return;
    const long total = g_total;
    ENW_WARN("dedi_varwatch: %s. %ld writes to the four watched slots, %ld of them from "
             "outside the script-variable code.", why, total, g_foreign);
    drain_foreign();
    const long n = total < kRing ? total : kRing;
    for (long k = n > 48 ? n - 48 : 0; k < n; ++k)
        show("", total - n + k, g_ring[(total - n + k) % kRing]);
}

DWORD WINAPI watchdog(LPVOID) {
    uint64_t last = 0;
    int still = 0;
    while (!g_stop) {
        ::Sleep(1000);
        const uint64_t now = enw::frame::count();
        if (now != 0 && now == last) {
            if (++still == 4) dump("frame::count has not moved for 4 s");
        } else {
            still = 0;
        }
        last = now;
    }
    return 0;
}

class var_watch_component final : public component {
public:
    const char* name() const override { return "dedi_varwatch"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        char buf[8]{};
        if (!::GetEnvironmentVariableA("ENW_DEDI_VARWATCH", buf, sizeof buf) || buf[0] != '1')
            return;

        uintptr_t first = enw::at(kChildVars) + static_cast<uintptr_t>(kFirstSlot) * 0x10;
        char over[32]{};
        if (::GetEnvironmentVariableA("ENW_DEDI_VARWATCH_ADDR", over, sizeof over) && over[0])
            first = std::strtoul(over, nullptr, 0);

        // How many of the four to use, and how far apart. The default walks the `w`
        // field of four consecutive pool entries; ENW_DEDI_VARWATCH_N=1 with
        // ENW_DEDI_VARWATCH_ADDR watches a single dword anywhere, which is what you
        // want for a global such as the temp-stack offset at 0x046E5054.
        int n = 4;
        char nbuf[8]{};
        if (::GetEnvironmentVariableA("ENW_DEDI_VARWATCH_N", nbuf, sizeof nbuf) && nbuf[0])
            n = std::atoi(nbuf);
        if (n < 1 || n > 4) n = 4;
        char mbuf[24]{};
        if (::GetEnvironmentVariableA("ENW_DEDI_VARWATCH_MIN", mbuf, sizeof mbuf) && mbuf[0])
            g_min_value = std::strtoul(mbuf, nullptr, 0);
        const bool raw = over[0] != '\0';
        for (int i = 0; i < 4; ++i) {
            const uintptr_t a = raw ? first + static_cast<uintptr_t>(i) * 4
                                    : first + static_cast<uintptr_t>(i) * 0x10 + 8;
            g_watch[i] = (i < n) ? a : g_watch[0];
        }
        g_dr7 = 0x100u;   // LE
        for (int i = 0; i < n; ++i) g_dr7 |= (1u << (2 * i)) | (0xDu << (16 + 4 * i));

        // A watchpoint whose address is not 4-byte aligned silently watches the wrong
        // dword, so check rather than assume.
        for (int i = 0; i < 4; ++i) {
            if (g_watch[i] & 3u) {
                ENW_ERROR("dedi_varwatch: NOT arming: 0x%08X is not 4-byte aligned",
                          static_cast<unsigned>(g_watch[i]));
                return;
            }
            if (!memory::is_readable(reinterpret_cast<const void*>(g_watch[i]), 4)) {
                ENW_ERROR("dedi_varwatch: NOT arming: 0x%08X is not readable",
                          static_cast<unsigned>(g_watch[i]));
                return;
            }
        }

        g_veh = ::AddVectoredExceptionHandler(1, &on_exception);
        if (!g_veh) {
            ENW_ERROR("dedi_varwatch: AddVectoredExceptionHandler failed (%lu)",
                      ::GetLastError());
            return;
        }

        // Arm from this thread, in this thread's own context, without suspending it.
        ::RaiseException(kArmException, 0, 0, nullptr);
        if (!g_armed) {
            ENW_ERROR("dedi_varwatch: the arming exception was not handled; no watchpoints");
            ::RemoveVectoredExceptionHandler(g_veh);
            g_veh = nullptr;
            return;
        }

        g_watchdog = ::CreateThread(nullptr, 0, &watchdog, nullptr, 0, nullptr);
        // Print each foreign write as it is seen -- that is the whole question, and it
        // is rare. The handler never logs; this runs on the main thread at a frame
        // boundary.
        enw::frame::subscribe("dedi_varwatch", [](uint64_t) { drain_foreign(); });
        ENW_WARN("dedi_varwatch: ON. Watching 0x%08X 0x%08X 0x%08X 0x%08X for writes, on the "
                 "main thread only. Diagnostic; nothing is changed.",
                 static_cast<unsigned>(g_watch[0]), static_cast<unsigned>(g_watch[1]),
                 static_cast<unsigned>(g_watch[2]), static_cast<unsigned>(g_watch[3]));
    }

    void pre_destroy() override {
        ::InterlockedExchange(&g_stop, 1);
        if (g_watchdog) {
            ::WaitForSingleObject(g_watchdog, 2000);
            ::CloseHandle(g_watchdog);
            g_watchdog = nullptr;
        }
        if (g_total) dump("shutdown");
        if (g_veh) {
            ::RemoveVectoredExceptionHandler(g_veh);
            g_veh = nullptr;
        }
    }
};

}  // namespace
}  // namespace enw::dedi

ENW_REGISTER_COMPONENT(enw::dedi::var_watch_component)
