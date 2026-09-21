// A dedicated server does not write single-player save games.
//
// ---------------------------------------------------------------------------
// What this is fixing
// ---------------------------------------------------------------------------
// Runs join12 and join13 both got a real client to spawn in on the headless
// server -- `Going from CS_CLIENTLOADING to CS_ACTIVE`, then
// `referee: ROUND 1 (all_players_connected)`. Both then died, within twenty
// seconds, in two different ways with one thing in common: the last thing the
// server ever printed, over and over, was
//
//     G_WriteGame 'nazi_zombie_prototype-zombie_start' 'AUTOSAVE_LEVELSTART'
//
// join12: 31 of them, then `Sys_Error("Internal script stack overflow")` and a
//         680,000-line script thread dump.
// join13: 195 of them, then the frame loop stopped dead -- `frame::count`
//         frozen at 4183 for the remaining 110 s while the process burned a
//         whole core. No error, no exit. Just gone.
//
// T4 queues an autosave request from script and drains the queue from the
// server frame, right after SV_Frame:
//
//     00636654  call 0x635CC0        ; SV_Frame
//     0063666D  call 0x636CC0        ; drain the autosave queue  <- and again at 0x636695
//     00636D57  call 0x512AC0        ;   ... per queued request
//     00512B14  call 0x512850        ;       ... G_WriteGame, which prints the line above
//
// and `0x512AC0` only proceeds past the save when G_WriteGame returns AL != 0:
//
//     00512B14  call 0x512850        ; G_WriteGame
//     00512B19  add  esp, 4          ; THE CALLER CLEANS -- one stack argument
//     00512B1C  test al, al
//     00512B1E  je   0x512AD4        ; failed -> return 0, nothing is marked done
//     00512B23  call 0x512A80        ; succeeded -> the post-save bookkeeping,
//                                    ;   including [0x1F2F6D4] = 1 and 0x563FC0
//
// On a headless server with no player profile the save never completes, so that
// post-save step never runs, so whatever is waiting on it asks again next
// frame, for ever. Once per server frame, which is exactly the rate we measured.
//
// ---------------------------------------------------------------------------
// What we do about it, and what we are NOT claiming
// ---------------------------------------------------------------------------
// We report the save as done without writing anything. A dedicated server has
// no profile to save into and nobody to load it back, so there is no file here
// worth having -- and an autosave that cannot succeed is not a feature we are
// suppressing, it is a single-player code path running in a place it was never
// going to work.
//
// This is a deliberate behaviour change and it is dedicated-only. A player's own
// client, and a local solo run, keep the stock autosave exactly as it is --
// is_supported() sees to that.
//
// It is NOT a claim that saving is impossible on a server, and it is NOT a
// silent swallow: every skipped save is counted, the first few are logged with
// the checkpoint name, and the count is printed at shutdown. If a future feature
// wants real server-side saves, this is the component to delete.
//
// ENW_DEDI_ALLOW_AUTOSAVE=1 puts the stock behaviour back, for comparison runs.
//
// HOW IT IS TAKEN: `G_WriteGame` 0x512850 has exactly ONE caller, so we retarget
// that one `call` rel32 rather than detouring the function (hook.hpp's standing
// advice, and the difference between rewriting five bytes we have read and
// relocating a prologue we have not).
//
// Clean room: our own code, from our own dump and our own logs.

#include "component.hpp"
#include "logger.hpp"
#include "memory.hpp"
#include "dedicated.hpp"

#include <cstdlib>

#if __has_include("t4/addresses.hpp")
#include "t4/addresses.hpp"
#define ENW_HAVE_T4_ADDRESSES 1
#endif

namespace enw::dedi {
namespace {

#ifdef ENW_HAVE_T4_ADDRESSES

constexpr uintptr_t kGWriteGame     = 0x512850;  // [V] sole ref to "G_WriteGame '%s' '%s'\n"
constexpr uintptr_t kGWriteGameCall = 0x512B14;  // [V] its only caller
constexpr uintptr_t kNameOffset     = 0x40;      // [V] 0x51285C: `lea ebp, [edi + 0x40]` is the
                                                 //     second `%s`; edi is the first.

volatile long g_skipped = 0;

// ECX held the checkpoint record when the engine reached the call; the two
// strings G_WriteGame would have printed live at [ecx] and [ecx + 0x40].
void __cdecl on_autosave_skipped(uint32_t record) {
    const long n = ::InterlockedIncrement(&g_skipped);
    if (n > 5) return;

    const char* a = "?";
    const char* b = "?";
    if (record && memory::is_readable(reinterpret_cast<const void*>(record), kNameOffset + 1)) {
        a = reinterpret_cast<const char*>(record);
        b = reinterpret_cast<const char*>(record + kNameOffset);
    }
    ENW_INFO("dedi_no_autosave: skipped autosave #%ld '%s' '%s' and reported it done "
             "(a dedicated server has no profile to save into; the stock path never "
             "completes and the level script asks again every frame)", n, a, b);
}

// Returns AL = 1 so 0x512AC0 takes its success branch. The caller cleans the one
// pushed argument at 0x512B19, so we must NOT touch esp -- a plain `ret` is the
// correct way not to call a function whose caller cleans up.
__declspec(naked) void write_game_stub() {
    __asm { pushfd }
    __asm { pushad }
    __asm { push ecx }
    __asm { call on_autosave_skipped }
    __asm { add  esp, 4 }
    __asm { popad }
    __asm { popfd }
    __asm { mov  al, 1 }
    __asm { ret }
}

class no_autosave_component final : public component {
public:
    const char* name() const override { return "dedi_no_autosave"; }

    bool is_supported() override { return is_dedicated(); }

    void post_init() override {
        if (std::getenv("ENW_DEDI_ALLOW_AUTOSAVE")) {
            ENW_WARN("dedi_no_autosave: OFF (ENW_DEDI_ALLOW_AUTOSAVE). The server will attempt "
                     "the level-start autosave, which in runs join12 and join13 hung it within "
                     "20 s of the first player spawning in.");
            return;
        }

        // Verify the call site really is the one we read, before rewriting it.
        // Two labels in this project were wrong because one cross-reference was
        // taken as an identification, and this check costs one memory read.
        const uintptr_t target = memory::call_target(enw::at(kGWriteGameCall));
        if (target != enw::at(kGWriteGame)) {
            ENW_ERROR("dedi_no_autosave: NOT patching 0x%08X: it calls 0x%08X, expected "
                      "G_WriteGame 0x%08X. The level-start autosave will run and is expected "
                      "to hang the server.",
                      static_cast<unsigned>(kGWriteGameCall), static_cast<unsigned>(target),
                      static_cast<unsigned>(enw::at(kGWriteGame)));
            return;
        }
        if (!memory::retarget_call(enw::at(kGWriteGameCall), &write_game_stub)) {
            ENW_ERROR("dedi_no_autosave: retarget_call on 0x%08X failed",
                      static_cast<unsigned>(kGWriteGameCall));
            return;
        }
        ENW_INFO("dedi_no_autosave: G_WriteGame's only call site (0x%08X) now reports every "
                 "autosave as done without writing one. Dedicated only.",
                 static_cast<unsigned>(kGWriteGameCall));
    }

    void pre_destroy() override {
        if (g_skipped)
            ENW_INFO("dedi_no_autosave: %ld autosave(s) skipped this session", g_skipped);
    }
};

#else

class no_autosave_component final : public component {
public:
    const char* name() const override { return "dedi_no_autosave"; }
};

#endif

ENW_REGISTER_COMPONENT(no_autosave_component)

}  // namespace
}  // namespace enw::dedi
