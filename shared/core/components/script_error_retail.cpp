// A GSC runtime error must not kill the game -- and on retail it does not.
//
// ---------------------------------------------------------------------------
// The question this answers
// ---------------------------------------------------------------------------
// Four popular custom maps (Zombie Desert `nazi_zombie_test1`, Project Viking
// `nazi_zombie_test`, MW2 Rust `mw2rust`, Clinic of Evil `sanatorium`) die for us
// on the same shape: a map script calls `flag_wait` before `maps/_load::main()`
// has run `flag_init`, the VM raises "undefined is not an array, string, or
// vector", and the game takes `Com_Error(5)` and shuts the server down.
//
// Three sessions proved this was not ours: it happens with the samplers off, with
// the referee overlay gone, with the third-party add-on IWDs excluded, and on a
// STOCK `CoDWaW.exe` with the binkw32 proxy reverted (dedi.md 14.2, archive.md 9).
// Every one of those runs left the same question open: **the community plays these
// maps every day.** So the difference is in HOW the game is run.
//
// It is. And it is one dvar: **`logfile`**.
//
// ---------------------------------------------------------------------------
// The mechanism, read out of our own decrypted dump
// ---------------------------------------------------------------------------
// `Com_SetScriptSettings` 0x59C840 -- called from Com_Init and again whenever the
// dvars are re-applied -- computes the script VM's error policy from two dvars:
//
//     0059C840  mov eax, [0x1F55288]      ; the `developer` dvar_s*
//     0059C846  mov esi, [eax + 0x10]     ;   its int value
//     0059C84B  jne 0x59C85C              ; developer != 0  -> eax = 1
//     0059C84D  mov ecx, [0x1F552BC]      ; the `logfile` dvar_s*
//     0059C853  cmp [ecx + 0x10], esi     ;   logfile != 0   -> eax = 1
//     ...
//     0059C880  mov byte [0x3882B76], al  ; scrVarPub[0].developer = developer || logfile
//     0059C885  mov byte [0x3BD4715], cl  ; scrVmPub[0].abort_on_error = developer
//
// So **`+set logfile 2` sets `scrVarPub.developer`**, the same flag `+set developer 1`
// sets. That is the whole difference between our game and the community's.
//
// What that flag then does, in `Scr_ErrorInternal` 0x693CF0:
//
//     00693CF9  cmp byte [edx + 0x3882B78], 0   ; scrVarPub.evaluate      -> skip
//     00693D0A  cmp byte [ecx + 0x36DFF94], 0   ; scrCompilePub.script_loading -> skip
//     00693D13  cmp byte [edx + 0x3882B76], 0   ; scrVarPub.developer
//     00693D1A  je  0x693D3C                    ;   retail (0): NOTHING HAPPENS HERE
//     00693D24  cmp dword [ecx + 0x3BDDE0C], 0
//     00693D2B  je  0x693D3C
//     00693D35  mov byte [ecx + 0x3BD4716], 1   ; <<< scrVmPub.terminal_error = 1
//     00693D3C  ...                             ; function_count != 0 -> longjmp to the
//                                               ;   VM's catch in VM_Execute
//
// and then, in `RuntimeError` 0x68B790, which the VM's catch calls:
//
//     0068B7A1  cmp byte [eax + 0x3882B76], 0   ; scrVarPub.developer
//     0068B7A8  jne 0x68B7BF                    ;   set -> report
//     0068B7B2  cmp byte [ecx + 0x3BD4716], 0   ; terminal_error
//     0068B7B9  je  0x68B85A                    ;   RETAIL PATH: return, in silence
//     0068B7EF  cmp byte [esi + 0x3BD4715], 0   ; abort_on_error (= `developer`)
//     0068B7F8  cmp byte [esi + 0x3BD4716], 0   ; terminal_error
//     0068B801  xor bl, bl                      ; bl = abort_on_error || terminal_error
//     0068B820  call 0x68B6D0                   ; RuntimeErrorInternal -- prints the trace
//     0068B82A  je  0x68B85A                    ; bl == 0 -> return, error reported only
//     0068B83D  cmp byte [esi + 0x3BD4716], dl  ; terminal_error
//     0068B84E  add edx, 4                      ; errParm = terminal_error + 4
//     0068B852  call 0x59AC50                   ; Com_Error(5 = ERR_SCRIPT_DROP, ...)
//
// and when `RuntimeError` returns without erroring, the VM at 0x6971D6 repairs its
// own stack for the faulting opcode and **the thread carries on**. That is why the
// community's game plays these maps: on retail the error is raised, swallowed, and
// forgotten, and `flag_wait`'s `while( !level.flag[msg] )` simply spins until
// `_load::main()` creates the array a few frames later.
//
// Our runs are not retail, because every ENW launch line passes `+set logfile 2`
// (tools\dev\launch.ps1, jointest.ps1, maptest.ps1, dediprobe.ps1 and
// launcher\src\main\launch.js). **Including `maptest.ps1 -NoEnw`, the "stock exe,
// zero ENW code" control.** dedi.md 14.2's control run was contaminated by the one
// dvar that causes the failure it was measuring, and its conclusion -- "the maps do
// this on their own" -- is retracted by this file. The maps do raise the error on
// their own. The engine only kills the game for it when `logfile` is on.
//
// ---------------------------------------------------------------------------
// What this component does
// ---------------------------------------------------------------------------
// It NOPs the seven bytes at 0x693D35 -- the one store that promotes a script
// runtime error to `terminal_error` -- after verifying they are exactly
// `C6 81 16 47 BD 03 01`.
//
// That is the smallest change that makes a logging game behave like a retail one:
//
//   * the store is reachable ONLY when `scrVarPub.developer` is set, so on a real
//     retail launch it never executes. Removing it cannot change retail behaviour;
//     it can only stop `logfile` from changing it.
//   * `terminal_error` keeps every other meaning it has. The four other writers --
//     "failed memory allocation for script usage" (0x68A5BA), the two "exceeded
//     maximum number of script variables" sites (0x68FD16, 0x68FE56) and
//     `Scr_TerminalError` (0x69ABEB) -- are untouched, so a genuinely
//     unrecoverable VM state still ends the game the way it always did.
//   * `scrVarPub.developer` itself is left alone, so `RuntimeErrorInternal` still
//     prints the full `******* script runtime error *******` block with the call
//     stack into console.log. **We keep the diagnostics and lose only the kill.**
//
// The alternative -- dropping `+set logfile` -- would also work and is strictly
// worse: it would take console.log away from every lane that depends on it.
//
// ENW_NO_SCRIPT_ERROR_RETAIL=1 leaves the store in place. That is the control arm;
// with it set, the four maps die again. Use it to bisect, never in a real game.
//
// Clean room: our own code, written from our own dump. No T4M and no KisakCOD code
// is copied here -- KisakCOD (CoD4 SP, the parent engine) was read only to name
// `Scr_ErrorInternal`, `RuntimeError` and the `terminal_error` field.

#include "../component.hpp"

#include "../logger.hpp"
#include "../memory.hpp"

#include "t4/addresses.hpp"

#include <cstdint>
#include <cstring>

#include <windows.h>

namespace enw {
namespace {

// Scr_ErrorInternal 0x693CF0 + 0x45: `mov byte ptr [ecx + 0x3BD4716], 1`,
// i.e. scrVmPub[instance].terminal_error = 1, reached only when
// scrVarPub[instance].developer is set. [V] read off our own dump.
constexpr std::uintptr_t kTerminalErrorStore = 0x693D35;
constexpr std::uint8_t kStoreBytes[] = {0xC6, 0x81, 0x16, 0x47, 0xBD, 0x03, 0x01};

// RuntimeError 0x68B790's own first bytes, checked as a second, independent
// confirmation that this really is the build the comment above was read from:
// `push ecx / push ebx / push ebp / mov ebp,[esp+0x18]`.
constexpr std::uintptr_t kRuntimeError = 0x68B790;
constexpr std::uint8_t kRuntimeErrorBytes[] = {0x51, 0x53, 0x55, 0x8B, 0x6C, 0x24, 0x18};

// The two dvar_s* slots Com_SetScriptSettings reads. [V] 0x59C840/0x59C84D.
constexpr std::uintptr_t kDvarDeveloper = 0x1F55288;
constexpr std::uintptr_t kDvarLogfile = 0x1F552BC;
constexpr std::size_t kDvarValue = 0x10;

// scrVarPub[0].developer and scrVmPub[0].{abort_on_error,terminal_error}.
constexpr std::uintptr_t kScrVarPubDeveloper = 0x3882B76;
constexpr std::uintptr_t kScrVmPubAbortOnError = 0x3BD4715;
constexpr std::uintptr_t kScrVmPubTerminalError = 0x3BD4716;

bool g_patched = false;
bool g_disabled = false;

bool env_is(const char* name, char want) {
    char buf[8]{};
    return ::GetEnvironmentVariableA(name, buf, sizeof buf) && buf[0] == want;
}

int dvar_int(std::uintptr_t slot) {
    std::uint32_t p = 0;
    if (!memory::read(enw::at(slot), &p) || !p) return -1;
    std::int32_t v = 0;
    if (!memory::read(static_cast<std::uintptr_t>(p) + kDvarValue, &v)) return -1;
    return v;
}

std::uint8_t byte_at(std::uintptr_t addr) {
    std::uint8_t v = 0xFF;
    memory::read(enw::at(addr), &v);
    return v;
}

class script_error_retail final : public component {
public:
    const char* name() const override { return "script_error_retail"; }

    void post_unpack() override {
        if (env_is("ENW_NO_SCRIPT_ERROR_RETAIL", '1')) {
            g_disabled = true;
            ENW_WARN("script_error_retail: ENW_NO_SCRIPT_ERROR_RETAIL=1 -- the engine keeps its "
                     "`logfile`-only promotion of a GSC runtime error to terminal_error, so the "
                     "first script error in a map will Com_Error(5) and end the game. "
                     "Control arm only.");
            return;
        }

        const std::uintptr_t store = enw::at(kTerminalErrorStore);
        std::uint8_t got[sizeof kStoreBytes]{};
        std::uint8_t re[sizeof kRuntimeErrorBytes]{};

        if (!memory::read_raw(store, got, sizeof got) ||
            std::memcmp(got, kStoreBytes, sizeof got) != 0) {
            ENW_ERROR("script_error_retail: NOT patching 0x%08X. Expected Scr_ErrorInternal's "
                      "`mov byte [ecx+0x3BD4716], 1` (%s), found %s. A GSC runtime error will "
                      "still kill this game whenever `logfile` is set -- see the header of this "
                      "file before changing the address.",
                      static_cast<unsigned>(kTerminalErrorStore),
                      memory::hex_dump(reinterpret_cast<std::uintptr_t>(kStoreBytes),
                                       sizeof kStoreBytes)
                          .c_str(),
                      memory::hex_dump(store, sizeof got).c_str());
            return;
        }
        if (!memory::read_raw(enw::at(kRuntimeError), re, sizeof re) ||
            std::memcmp(re, kRuntimeErrorBytes, sizeof re) != 0) {
            ENW_ERROR("script_error_retail: NOT patching. 0x%08X does not look like RuntimeError "
                      "(%s), so this is not the build the store at 0x%08X was read from.",
                      static_cast<unsigned>(kRuntimeError),
                      memory::hex_dump(enw::at(kRuntimeError), sizeof re).c_str(),
                      static_cast<unsigned>(kTerminalErrorStore));
            return;
        }

        if (!memory::nop(store, sizeof kStoreBytes)) {
            ENW_ERROR("script_error_retail: could not write over 0x%08X",
                      static_cast<unsigned>(kTerminalErrorStore));
            return;
        }

        g_patched = true;
        ENW_INFO("script_error_retail: 0x%08X NOPed (7 bytes). Scr_ErrorInternal no longer sets "
                 "scrVmPub.terminal_error when `logfile` is on, so a GSC runtime error is "
                 "reported into console.log and the thread's stack is repaired -- exactly what "
                 "a retail launch does -- instead of Com_Error(ERR_SCRIPT_DROP). The four other "
                 "writers of terminal_error are untouched.",
                 static_cast<unsigned>(kTerminalErrorStore));
    }

    void post_init() override {
        // Measured, not assumed: this line is the evidence that `logfile` and not
        // `developer` is what arms the script VM's developer mode in our runs.
        const int developer = dvar_int(kDvarDeveloper);
        const int logfile = dvar_int(kDvarLogfile);
        ENW_INFO("script_error_retail: dvars developer=%d logfile=%d -> scrVarPub.developer=%u "
                 "scrVmPub.abort_on_error=%u terminal_error=%u; promotion store %s",
                 developer, logfile, byte_at(kScrVarPubDeveloper),
                 byte_at(kScrVmPubAbortOnError), byte_at(kScrVmPubTerminalError),
                 g_disabled ? "LEFT IN PLACE (control arm)"
                            : (g_patched ? "removed" : "NOT removed -- see the error above"));
        if (!g_disabled && developer == 0 && logfile != 0 && byte_at(kScrVarPubDeveloper) != 0) {
            ENW_INFO("script_error_retail: confirmed -- `developer` is 0 and the script VM is in "
                     "developer mode anyway, because `logfile` is %d. That is the whole of "
                     "dedi.md 16.",
                     logfile);
        }
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::script_error_retail)
