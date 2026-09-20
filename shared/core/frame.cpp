#include "frame.hpp"

#include "logger.hpp"
#include "memory.hpp"
#include "scheduler.hpp"

#include <mutex>
#include <vector>

#include "t4/addresses.hpp"

namespace enw::frame {
namespace {

struct entry {
    int token = 0;
    std::string name;
    callback fn;
    unsigned faults = 0;
};

std::mutex g_mutex;
std::vector<entry> g_subs;
int g_next_token = 1;

volatile LONG g_installed = 0;
volatile LONG64 g_count = 0;

using Com_Frame_t = void(__cdecl*)();
Com_Frame_t g_original = nullptr;

thread_local bool tl_in_frame = false;

// SEH in its own function: MSVC will not allow __try where C++ objects unwind.
unsigned call_guarded(const callback* fn, uint64_t n) {
    __try {
        (*fn)(n);
        return 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return static_cast<unsigned>(GetExceptionCode());
    }
}

unsigned call_original() {
    __try {
        if (g_original) g_original();
        return 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return static_cast<unsigned>(GetExceptionCode());
    }
}

void dispatch() {
    const auto n = static_cast<uint64_t>(::InterlockedIncrement64(&g_count));

    // Copy out under the lock: a callback may subscribe or unsubscribe, and we
    // must not hold the lock across untrusted code anyway.
    std::vector<entry> snapshot;
    {
        std::lock_guard<std::mutex> lk(g_mutex);
        snapshot = g_subs;
    }

    for (const auto& e : snapshot) {
        const unsigned code = call_guarded(&e.fn, n);
        if (!code) continue;
        // A callback that faults every frame would bury the log and the game.
        // One line, then it is gone.
        ENW_ERROR("frame: subscriber '%s' faulted (%08X) on frame %llu - unsubscribing it",
                  e.name.c_str(), code, static_cast<unsigned long long>(n));
        unsubscribe(e.token);
    }
}

// This is what WinMain's `call Com_Frame` now points at.
void __cdecl com_frame_stub() {
    call_original();

    if (tl_in_frame) return;  // a subscriber re-entering the frame: ignore
    tl_in_frame = true;
    dispatch();
    tl_in_frame = false;
}

}  // namespace

int subscribe(const char* name, callback fn) {
    if (!name || !*name || !fn) return 0;
    std::lock_guard<std::mutex> lk(g_mutex);
    entry e;
    e.token = g_next_token++;
    e.name = name;
    e.fn = std::move(fn);
    g_subs.push_back(std::move(e));
    return g_subs.back().token;
}

void unsubscribe(int token) {
    if (token <= 0) return;
    std::lock_guard<std::mutex> lk(g_mutex);
    for (auto it = g_subs.begin(); it != g_subs.end(); ++it) {
        if (it->token == token) {
            g_subs.erase(it);
            return;
        }
    }
}

bool installed() { return ::InterlockedCompareExchange(&g_installed, 0, 0) != 0; }
uint64_t count() { return static_cast<uint64_t>(::InterlockedCompareExchange64(&g_count, 0, 0)); }

size_t subscriber_count() {
    std::lock_guard<std::mutex> lk(g_mutex);
    return g_subs.size();
}

// Called by components/frame_dispatch.cpp at post_unpack.
bool install() {
    if (installed()) return true;

    const uintptr_t site = at(t4::fn::Com_Frame_callsite);
    const uintptr_t expected = at(t4::fn::Com_Frame);

    // The call site must really be `call Com_Frame`. If the address map has
    // moved, or somebody has already retargeted it, we stop rather than send
    // WinMain's frame loop somewhere interesting.
    const uintptr_t current = memory::call_target(site);
    if (current == 0) {
        ENW_ERROR("frame: %08X is not a call instruction (%s) - no per-frame tick",
                  static_cast<unsigned>(site), memory::hex_dump(site, 8).c_str());
        return false;
    }
    if (current != expected) {
        ENW_ERROR("frame: call site %08X points at %08X, expected Com_Frame %08X. Somebody else "
                  "has already retargeted it, or shared/t4/addresses.hpp has moved. Refusing.",
                  static_cast<unsigned>(site), static_cast<unsigned>(current),
                  static_cast<unsigned>(expected));
        return false;
    }

    g_original = reinterpret_cast<Com_Frame_t>(current);
    if (!memory::retarget_call(site, reinterpret_cast<void*>(&com_frame_stub))) {
        ENW_ERROR("frame: could not retarget the call at %08X", static_cast<unsigned>(site));
        g_original = nullptr;
        return false;
    }

    ::InterlockedExchange(&g_installed, 1);
    ENW_INFO("frame: tick installed by retargeting the call at %08X (Com_Frame %08X left "
             "un-detoured, so a component that hooks it still works)",
             static_cast<unsigned>(site), static_cast<unsigned>(expected));
    return true;
}

void uninstall() {
    if (!installed() || !g_original) return;
    memory::retarget_call(at(t4::fn::Com_Frame_callsite), reinterpret_cast<void*>(g_original));
    ::InterlockedExchange(&g_installed, 0);
}

}  // namespace enw::frame
