// gpu_query_guard: the engine's wait for a GPU query result can no longer wait forever.
//
// FOUND 2026-09-23, lane CL (B: "my game crashed while launching Town of the Dead",
// zombie_town, launcher 0.2.27, DLL 04a3ad6d; client.md §13). Not a crash: a HANG about
// 0.3 s after the first in-game frame; Windows closed the frozen window (exit 0xCFFFFFFF).
// Reproduced locally 3 of 3 (invisible client + local dedi, with and without our chat
// overlay). The threads, read out of the live hung process:
//   * the RENDER thread (entry 0x6FC6F0) holds the engine's render lock (CS 0x2298EA0,
//     0x70E340) and is looping in 0x7255D0:
//         while (query->GetData(&n, 4, D3DGETDATA_FLUSH) == S_FALSE) Sleep(0);
//     called from 0x72C670, the SUN VISIBILITY occlusion query (0x72CE70 runs it only when
//     the map's world has a sun flare: [[0x3BF392C]+0x194]). GetData keeps returning
//     S_FALSE -- the query never completes on B's AMD driver (amdxn32.dll, RX 9070 XT,
//     32.0.31041) -- and the loop has no way out;
//   * the MAIN thread waits for that render lock in the screen update (0x479370) -- the
//     "not responding" window;
//   * CPU ~1.4 cores for as long as it lasts (the spin).
// The same class explains B's earlier unexplained hang on zm_nuked (0.2.18, ~200 ms after
// the first frame, chat-overlay.md §12.4): zm_nuked's world has a sun flare too.
//
// FIX: 0x7255D0 has exactly four call sites (0x72C71C sun visibility; 0x725B71 and 0x725B7E
// the sun sprite calibration pair; 0x72DF6B), each `call 0x7255D0` with the query in ESI and
// the answer in EAX (the pixel count, or -1). Every caller already handles -1: it is what
// the engine itself returns for a failed GetData, and the sun code then keeps last frame's
// visibility ([ebp+0x1C] = 1). We retarget the four calls to the same wait with a budget:
//   * up to kBudgetMs of GetData(FLUSH) + Sleep(0), as the engine did -- a healthy query
//     answers within a frame, so nothing changes on a healthy machine;
//   * past the budget: -1 (the engine's own "no answer"), logged;
//   * after kTripAfter timeouts: no more waiting at all -- one GetData, -1 if it is not
//     ready. The sun flare may then lag or hold still; the game runs.
// So a GPU query that never answers costs, at worst, one 50 ms hitch per timeout until it
// trips, on ANY map and any driver -- never a hang.
//
// Byte-checked: the target's prologue and each call site's rel32 must match, or nothing is
// patched and it says so. Client only (the dedicated server has no renderer).
// Off switch: ENW_GPU_QUERY_GUARD=0 (restores the engine's unbounded wait).
// ENW_GPU_QUERY_TEST=1 (harness only): the guard behaves as if every query timed out,
// so its log lines and the trip can be seen on any machine.
#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"

#include <windows.h>
#include <d3d9.h>

#include <atomic>
#include <cstdlib>
#include <cstring>

namespace enw::client {
namespace {

constexpr uintptr_t kQueryWait = 0x7255D0;
// 51 8B 06 8B 50 1C 6A 01 6A 04 8D 4C 24 08 51 56 FF D2 83 F8 01
// push ecx; mov eax,[esi]; mov edx,[eax+1Ch] (GetData); push 1 (FLUSH); push 4; lea ecx,[esp+8];
// push ecx; push esi; call edx; cmp eax,1 (S_FALSE)
constexpr uint8_t kQueryWaitSig[] = {0x51, 0x8B, 0x06, 0x8B, 0x50, 0x1C, 0x6A, 0x01, 0x6A, 0x04, 0x8D,
                                     0x4C, 0x24, 0x08, 0x51, 0x56, 0xFF, 0xD2, 0x83, 0xF8, 0x01};
constexpr uintptr_t kCallSites[] = {0x72C71C, 0x725B71, 0x725B7E, 0x72DF6B};
constexpr const char* kSiteNames[] = {"sun visibility", "sun calibration A", "sun calibration B", "0x72DF10"};

constexpr DWORD kBudgetMs = 50;
constexpr long kTripAfter = 3;

std::atomic<long> g_timeouts{0};
std::atomic<long> g_waits{0};
std::atomic<long> g_slow{0};   // answered, but after more than 5 ms
std::atomic<bool> g_nowait{false};
bool g_test = false;

LONGLONG qpc() {
    LARGE_INTEGER t;
    ::QueryPerformanceCounter(&t);
    return t.QuadPart;
}
LONGLONG qpf() {
    static const LONGLONG f = [] { LARGE_INTEGER t; ::QueryPerformanceFrequency(&t); return t.QuadPart; }();
    return f;
}

// The engine's 0x7255D0 with a budget. Runs on the render thread.
int __cdecl bounded_query_wait(IDirect3DQuery9* q) {
    if (!q) return -1;
    DWORD n = 0;
    HRESULT hr = q->GetData(&n, sizeof n, D3DGETDATA_FLUSH);
    if (hr == S_FALSE) {
        ++g_waits;
        if (g_nowait.load(std::memory_order_relaxed)) return -1;
        const LONGLONG t0 = qpc();
        const LONGLONG limit = qpf() * kBudgetMs / 1000;
        while (hr == S_FALSE && (qpc() - t0) < limit && !g_test) {
            ::Sleep(0);
            hr = q->GetData(&n, sizeof n, D3DGETDATA_FLUSH);
        }
        if (hr == S_FALSE) {
            const long t = ++g_timeouts;
            if (t <= kTripAfter)
                ENW_WARN("gpu_query_guard: a GPU query (0x%p) did not answer in %lu ms -- the engine would have "
                         "waited forever here (the zombie_town freeze); returning 'no answer' (-1), which the "
                         "sun code already handles (timeout %ld of %ld before the wait is switched off)",
                         static_cast<void*>(q), kBudgetMs, t, kTripAfter);
            if (t == kTripAfter) {
                g_nowait = true;
                ENW_WARN("gpu_query_guard: TRIPPED -- %ld GPU queries never answered on this driver; from now on "
                         "the engine does not wait for them at all (the sun flare may lag or hold still). "
                         "ENW_GPU_QUERY_GUARD=0 restores the engine's unbounded wait.", t);
            }
            return -1;
        }
        if ((qpc() - t0) * 1000 > qpf() * 5) ++g_slow;
    }
    if (FAILED(hr)) return -1;
    return static_cast<int>(n);
}

// Same contract as 0x7255D0: the query in ESI, the answer in EAX; EBX/ESI/EDI/EBP kept.
__declspec(naked) void query_wait_thunk() {
    __asm {
        push esi
        call bounded_query_wait
        add esp, 4
        ret
    }
}

bool is_dedicated_process() {
    const char* cmd = ::GetCommandLineA();
    return cmd && std::strstr(cmd, "dedicated 1");
}

class gpu_query_guard final : public component {
public:
    const char* name() const override { return "gpu_query_guard"; }
    bool is_supported() override { return !is_dedicated_process(); }

    void post_unpack() override {
        const char* v = std::getenv("ENW_GPU_QUERY_GUARD");
        if (v && v[0] == '0' && !v[1]) {
            ENW_WARN("gpu_query_guard: OFF (ENW_GPU_QUERY_GUARD=0) -- a GPU query that never answers hangs the game");
            return;
        }
        const char* t = std::getenv("ENW_GPU_QUERY_TEST");
        g_test = t && t[0] == '1';
        uint8_t got[sizeof kQueryWaitSig] = {};
        if (!memory::read_raw(kQueryWait, got, sizeof got) || std::memcmp(got, kQueryWaitSig, sizeof got) != 0) {
            ENW_ERROR("gpu_query_guard: 0x%08X is not the engine's GPU query wait on this image (%s). OFF.",
                      static_cast<unsigned>(kQueryWait), memory::hex_dump(kQueryWait, 12).c_str());
            return;
        }
        for (uintptr_t site : kCallSites) {
            if (memory::call_target(site) != kQueryWait) {
                ENW_ERROR("gpu_query_guard: 0x%08X is not `call 0x%08X` on this image (%s). OFF.",
                          static_cast<unsigned>(site), static_cast<unsigned>(kQueryWait),
                          memory::hex_dump(site, 5).c_str());
                return;
            }
        }
        int bound = 0;
        for (size_t i = 0; i < sizeof kCallSites / sizeof kCallSites[0]; ++i) {
            if (memory::retarget_call(kCallSites[i], reinterpret_cast<const void*>(&query_wait_thunk))) ++bound;
            else ENW_ERROR("gpu_query_guard: retarget of 0x%08X (%s) failed", static_cast<unsigned>(kCallSites[i]),
                           kSiteNames[i]);
        }
        ENW_INFO("gpu_query_guard: %d of 4 calls to the engine's GPU query wait (0x%08X: sun visibility, sun "
                 "calibration x2, 0x72DF10) now give up after %lu ms instead of spinning forever; after %ld "
                 "timeouts they stop waiting%s. Off: ENW_GPU_QUERY_GUARD=0.",
                 bound, static_cast<unsigned>(kQueryWait), kBudgetMs, kTripAfter,
                 g_test ? " (ENW_GPU_QUERY_TEST=1: every wait times out)" : "");
    }

    void pre_destroy() override {
        if (g_waits || g_timeouts)
            ENW_INFO("gpu_query_guard: this session %ld query wait(s), %ld slower than 5 ms, %ld timed out%s",
                     g_waits.load(), g_slow.load(), g_timeouts.load(), g_nowait ? " (tripped)" : "");
    }
};

ENW_REGISTER_COMPONENT(gpu_query_guard)

}  // namespace
}  // namespace enw::client
