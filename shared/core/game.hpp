// The handful of game symbols the *core* needs. Everything else belongs in
// shared/t4/ (the `re` agent's tree) once they have verified it.
//
// Addresses come from vault `11 - Implementation Reference` §2 and are public
// (T4M-Enhanced and T4SP-Server-Plugin agree on them). They are NOT trusted:
// verify() checks each one against the decrypted image and disables anything
// that does not look right, rather than calling into the middle of some function
// and crashing the game with no log line.
#pragma once
#include "enw.hpp"

namespace enw::game {

// Vault addresses (image base 0x400000).
namespace addr {
inline constexpr uintptr_t Com_Printf = 0x59A2C0;
inline constexpr uintptr_t Dvar_FindVar = 0x5EDE30;
}  // namespace addr

// Com_Printf(channel, fmt, ...). Channel 0 == CON_CHANNEL_DONT_FILTER in T4;
// the engine's channel list is in the console log ("Adding channel: ...").
using Com_Printf_t = void(__cdecl*)(int channel, const char* format, ...);

// Run after SteamStub has decrypted. Logs what it found for the `re` agent to
// confirm. Returns true if Com_Printf passed its check.
bool verify();

// True once verify() has approved Com_Printf.
bool console_available();

// Opaque to us; the `re` agent owns the real dvar_t layout in shared/t4/.
struct dvar_s;
using Dvar_FindVar_t = dvar_s*(__cdecl*)(const char* name);

// Look a dvar up by name. Returns nullptr before the dvar system exists, which
// is exactly what we use to tell whether the engine has started.
dvar_s* find_dvar(const char* name);

// Block until the engine's dvar system is up, i.e. Com_Init has run.
//
// WHY THIS EXISTS: SteamStub decrypts ~100 ms into the process, long before the
// engine initialises. Com_Printf at that point is safe to call but the console
// does not exist yet, so the text is silently discarded. Anything user-visible
// has to wait for this.
//
// Polling Dvar_FindVar from our thread is safe: the function opens with
// `lock xadd` on a global (0x21ACF3C), i.e. the engine's own dvar lock, and an
// uninitialised hash table simply misses.
bool wait_for_engine(unsigned timeout_ms = 120000);
void abort_wait();
bool engine_ready();

// Safe printf to the in-game console. A no-op (bar the file log) until verify()
// has approved the address, so it is always safe to call.
void console_print(const char* format, ...);

// Same, but on an explicit Com_Printf channel. T4 filters console output by
// channel ("Adding channel: ..." / "Hiding channel: ..." in console.log), so the
// channel number decides whether anything is actually seen.
void console_print_channel(int channel, const char* format, ...);

// Diagnostic: hammer every plausible channel with a tagged line for a while, so
// we can grep the engine's own console.log afterwards and see which channel (and
// which moment in startup) actually lands. Enabled by ENW_PRINT_PROBE=1.
void run_print_probe();

// How many times a Com_Printf call has faulted. Non-zero means the address or
// the calling convention is wrong.
long printf_fault_count();

// What verify() saw, for the log and the board.
struct verification {
    bool com_printf_ok = false;
    uintptr_t com_printf_addr = 0;
    std::string com_printf_bytes;
    bool dvar_findvar_ok = false;
    uintptr_t dvar_findvar_addr = 0;
    std::string dvar_findvar_bytes;
};
verification last_verification();

}  // namespace enw::game
