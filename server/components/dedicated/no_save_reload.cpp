// A dedicated server has no save game to reload when the game ends.
//
// ---------------------------------------------------------------------------
// What this is fixing, and why it only became visible tonight
// ---------------------------------------------------------------------------
// With `watersim_pool.cpp` in, the headless server simulates for the first time:
// run join64 held 59.2 Hz with `com_frameTime` advancing for 121 s, the client
// played, and the referee logged
//
//     referee: game over at round 1 (stop_intermission notify)
//
// which is the game ENDING, correctly, because an idle client gets eaten in round
// one. Seven seconds later:
//
//     === Com_Error TRAPPED ===  called from 0050E21F
//       arg2 = "Unable to find save."
//     ShutdownGame:  ->  slot 0 went back to CS_FREE from CS_ACTIVE -- it was dropped
//     Com_Error "Exceeded limit of 1 'snddriverglobals' assets."  ->  Sys_Error
//
// The last two lines are the restart chain `next-session.md` already warns about:
// the ERR_DROP sends the engine to the front end, the front end re-loads the same
// mod, the singleton asset limit trips, `Sys_Error` parks the thread. The FIRST
// error is the real one, and it is T4's single-player death flow:
//
//     0062C0D0  SV_LoadGame
//       0062C0DB  call 0x563F50        ; find the save by name
//       0062C0E5  jne  0x62C115        ; found -> return
//       0062C0EC  call 0x563750        ; the fallback
//       0062C0F3  jne  0x62C115        ; found -> return
//       0062C0F7  push 0x8864CC        ; "Unable to find save."
//       0062C0FC  push 1               ; ERR_DROP
//       0062C10D  call 0x50E1E0        ; G_Error(code, fmt, ...) -> Com_Error
//       0062C112  add  esp, 8          ; THE CALLER CLEANS -- a bare `ret` is safe
//
// On death, single-player reloads the last save. A headless server never wrote one
// (`no_autosave.cpp` makes sure of that, for its own good reasons), so the reload
// cannot succeed and the drop takes the whole server down with it.
//
// ---------------------------------------------------------------------------
// What this does, and what it does NOT do
// ---------------------------------------------------------------------------
// It retargets that one `call` to a counting `ret`, dedicated only, so SV_LoadGame
// returns "nothing loaded" instead of dropping the server. The stub is a bare `ret`
// for the same reason `no_autosave.cpp`'s is: the caller's own `add esp, 8` is
// visible two instructions later and is verified before we patch, so there is no
// calling convention being guessed at.
//
// THIS IS NOT "GAME OVER HANDLED". It keeps the server, the map and the connected
// clients alive through a failed save reload; it does not restart the round, and
// nothing here decides what a dedicated server SHOULD do when the game ends. That
// is a real feature (a `map_restart` on game over, or the restore-path GSC of
// referee.md 3.3) and it is not built. What this buys is that the next session can
// see what happens after game over instead of watching the process die.
//
// ENW_DEDI_ALLOW_SAVE_RELOAD=1 restores the stock behaviour, which is the control.
//
// Clean room: our own code.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "dedicated.hpp"

#include <cstdlib>
#include <cstdint>

namespace enw::dedi {
namespace {

constexpr uintptr_t kErrorCall   = 0x62C10D;   // call G_Error inside SV_LoadGame
constexpr uintptr_t kGError      = 0x50E1E0;
constexpr uintptr_t kCleanupOff  = 5;          // the `add esp, 8` right after it
constexpr uint8_t   kCallerClean[3] = {0x83, 0xC4, 0x08};

volatile long g_suppressed = 0;

void __cdecl on_suppressed() {
    if (++g_suppressed <= 5)
        ENW_WARN("dedi_no_save_reload: SV_LoadGame's ERR_DROP \"Unable to find save.\" "
                 "suppressed (#%ld). The game ended and single-player wanted to reload a save "
                 "a dedicated server never wrote. The server stays up; nothing has restarted "
                 "the round. dedi.md 12.", g_suppressed);
}

// G_Error is cdecl and the caller cleans its two pushed arguments, so a plain `ret`
// is the correct way to not-call it.
__declspec(naked) void suppress_stub() {
    __asm { pushfd }
    __asm { pushad }
    __asm { call on_suppressed }
    __asm { popad }
    __asm { popfd }
    __asm { ret }
}

class no_save_reload_component final : public component {
public:
    const char* name() const override { return "dedi_no_save_reload"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_ALLOW_SAVE_RELOAD")) {
            ENW_WARN("dedi_no_save_reload: OFF (ENW_DEDI_ALLOW_SAVE_RELOAD). Expect "
                     "Com_Error(ERR_DROP, \"Unable to find save.\") the first time the game "
                     "ends, then the snddriverglobals restart chain and a parked thread.");
            return;
        }

        const uintptr_t site = enw::at(kErrorCall);
        const uintptr_t target = memory::call_target(site);
        if (target != enw::at(kGError)) {
            ENW_ERROR("dedi_no_save_reload: NOT patching 0x%08X: it calls 0x%08X, expected "
                      "G_Error 0x%08X. The save-reload drop will fire on game over.",
                      static_cast<unsigned>(kErrorCall), static_cast<unsigned>(target),
                      static_cast<unsigned>(enw::at(kGError)));
            return;
        }
        uint8_t after[3] = {};
        if (!memory::read_raw(site + kCleanupOff, after, sizeof after) ||
            after[0] != kCallerClean[0] || after[1] != kCallerClean[1] ||
            after[2] != kCallerClean[2]) {
            ENW_ERROR("dedi_no_save_reload: NOT patching 0x%08X: expected `add esp, 8` "
                      "(83 C4 08) after the call, found %02X %02X %02X. A `ret` stub would "
                      "unbalance the stack.", static_cast<unsigned>(kErrorCall),
                      after[0], after[1], after[2]);
            return;
        }
        if (!memory::retarget_call(site, &suppress_stub)) {
            ENW_ERROR("dedi_no_save_reload: retarget_call on 0x%08X failed",
                      static_cast<unsigned>(kErrorCall));
            return;
        }
        ENW_INFO("dedi_no_save_reload: SV_LoadGame's \"Unable to find save.\" ERR_DROP at "
                 "0x%08X now returns instead of dropping the server. Dedicated only.",
                 static_cast<unsigned>(kErrorCall));
    }

    void pre_destroy() override {
        if (g_suppressed)
            ENW_INFO("dedi_no_save_reload: %ld save-reload drop(s) suppressed this session",
                     g_suppressed);
    }
};

ENW_REGISTER_COMPONENT(no_save_reload_component)

}  // namespace
}  // namespace enw::dedi
