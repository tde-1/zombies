#include "game.hpp"

#include "logger.hpp"
#include "memory.hpp"
#include "scheduler.hpp"

#include <cstdarg>

namespace enw::game {
namespace {

Com_Printf_t g_com_printf = nullptr;
Dvar_FindVar_t g_dvar_findvar = nullptr;
verification g_result;
volatile LONG g_abort = 0;
volatile LONG g_engine_ready = 0;
volatile LONG g_printf_faults = 0;
constexpr int kMaxPrintfFaults = 40;

}  // namespace

dvar_s* find_dvar(const char* name) {
    if (!g_dvar_findvar || !name) return nullptr;
    __try {
        return g_dvar_findvar(name);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return nullptr;
    }
}

void abort_wait() { ::InterlockedExchange(&g_abort, 1); }

bool engine_ready() { return ::InterlockedCompareExchange(&g_engine_ready, 0, 0) != 0; }

bool wait_for_engine(unsigned timeout_ms) {
    if (!g_dvar_findvar) {
        ENW_ERROR("game: Dvar_FindVar is not usable, so we cannot tell when the engine is up. "
                  "post_init will not run.");
        return false;
    }
    ::InterlockedExchange(&g_abort, 0);
    const DWORD started = ::GetTickCount();
    while (::GetTickCount() - started < timeout_ms) {
        if (::InterlockedCompareExchange(&g_abort, 0, 0) != 0) {
            ENW_WARN("game: engine wait abandoned after %u ms", ::GetTickCount() - started);
            return false;
        }
        // `logfile` is registered by the engine's own early init. Its presence
        // means the dvar system -- and with it the console -- exists.
        if (find_dvar("logfile") != nullptr) {
            const unsigned waited = ::GetTickCount() - started;
            ::InterlockedExchange(&g_engine_ready, 1);
            ENW_INFO("game: engine up after %u ms (dvar 'logfile' exists)", waited);
            return true;
        }
        ::Sleep(10);
    }
    ENW_ERROR("game: engine never came up within %u ms", timeout_ms);
    return false;
}

bool verify() {
    g_result = {};

    g_result.com_printf_addr = at(addr::Com_Printf);
    g_result.dvar_findvar_addr = at(addr::Dvar_FindVar);
    g_result.com_printf_bytes = memory::hex_dump(g_result.com_printf_addr, 16);
    g_result.dvar_findvar_bytes = memory::hex_dump(g_result.dvar_findvar_addr, 16);

    g_result.com_printf_ok = memory::looks_like_function(g_result.com_printf_addr);
    g_result.dvar_findvar_ok = memory::looks_like_function(g_result.dvar_findvar_addr);

    ENW_INFO("game: Com_Printf    @ %08X %s  bytes: %s", static_cast<unsigned>(g_result.com_printf_addr),
             g_result.com_printf_ok ? "LOOKS OK" : "*** SUSPECT ***", g_result.com_printf_bytes.c_str());
    ENW_INFO("game: Dvar_FindVar  @ %08X %s  bytes: %s", static_cast<unsigned>(g_result.dvar_findvar_addr),
             g_result.dvar_findvar_ok ? "LOOKS OK" : "*** SUSPECT ***", g_result.dvar_findvar_bytes.c_str());

    g_dvar_findvar = g_result.dvar_findvar_ok
                         ? reinterpret_cast<Dvar_FindVar_t>(g_result.dvar_findvar_addr)
                         : nullptr;

    if (g_result.com_printf_ok) {
        g_com_printf = reinterpret_cast<Com_Printf_t>(g_result.com_printf_addr);
    } else {
        g_com_printf = nullptr;
        ENW_ERROR("game: Com_Printf at %08X did not pass the sanity check. In-game printing is OFF; "
                  "the file log still works. Ask the `re` agent for the real address.",
                  static_cast<unsigned>(g_result.com_printf_addr));
    }
    return g_result.com_printf_ok;
}

bool console_available() { return g_com_printf != nullptr; }

void console_print(const char* format, ...) {
    if (!g_com_printf) return;

    // Format on our side and hand Com_Printf a literal "%s". The engine's own
    // varargs buffer is small and we never want a caller's text interpreted as a
    // format string.
    char buf[1024];
    va_list args;
    va_start(args, format);
    _vsnprintf_s(buf, sizeof(buf), _TRUNCATE, format, args);
    va_end(args);

    console_print_channel(0, "%s", buf);
}

namespace {
// SEH in its own function, and it REPORTS. An earlier version swallowed the
// fault and nulled the pointer, which turned "Com_Printf crashed" into
// "Com_Printf silently does nothing" -- a genuinely expensive hour.
unsigned call_com_printf(int channel, const char* text) {
    __try {
        g_com_printf(channel, "%s", text);
        return 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return static_cast<unsigned>(GetExceptionCode());
    }
}
}  // namespace

void console_print_channel(int channel, const char* format, ...) {
    if (!g_com_printf) return;
    char buf[1024];
    va_list args;
    va_start(args, format);
    _vsnprintf_s(buf, sizeof(buf), _TRUNCATE, format, args);
    va_end(args);

    const unsigned code = call_com_printf(channel, buf);
    if (code) {
        const LONG n = ::InterlockedIncrement(&g_printf_faults);
        if (n == 1) {
            ENW_ERROR("game: Com_Printf FAULTED (%08X) on channel %d from thread %lu (main is %lu). "
                      "Not disabling yet; will give up after %d faults.",
                      code, channel, ::GetCurrentThreadId(), scheduler::main_thread_id(),
                      kMaxPrintfFaults);
        }
        if (n >= kMaxPrintfFaults) {
            g_com_printf = nullptr;
            ENW_ERROR("game: Com_Printf faulted %ld times - in-game printing is OFF. "
                      "The address or the calling convention is wrong; ask `re`.",
                      n);
        }
    }
}

long printf_fault_count() { return ::InterlockedCompareExchange(&g_printf_faults, 0, 0); }

void run_print_probe() {
    if (!g_com_printf) {
        ENW_ERROR("print-probe: Com_Printf unavailable, nothing to probe");
        return;
    }
    ENW_INFO("print-probe: 30 rounds x 1 s, channels 0-7, from BOTH threads");
    const DWORD t0 = ::GetTickCount();
    for (int round = 0; round < 30; ++round) {
        const unsigned elapsed = ::GetTickCount() - t0;
        for (int ch = 0; ch <= 7; ++ch) {
            // Off-thread (this is the loader thread).
            console_print_channel(ch, "ENWPROBE off r%02d ch%d t%ums\n", round, ch, elapsed);
            // ...and the same line from the game's own thread, for comparison.
            const int round_copy = round;
            const int ch_copy = ch;
            scheduler::run_on_main([round_copy, ch_copy, elapsed]() {
                console_print_channel(ch_copy, "ENWPROBE main r%02d ch%d t%ums\n", round_copy,
                                      ch_copy, elapsed);
            });
        }
        ::Sleep(1000);
    }
    ENW_INFO("print-probe: done (%llu jobs ran on the main thread, %llu dropped)",
             static_cast<unsigned long long>(scheduler::snapshot().ran),
             static_cast<unsigned long long>(scheduler::snapshot().dropped));
}

verification last_verification() { return g_result; }

}  // namespace enw::game
