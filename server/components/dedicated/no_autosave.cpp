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
// We discard the request. A dedicated server has no profile to save into and
// nobody to load it back, so there is no file here worth having -- and an
// autosave that cannot succeed is not a feature we are suppressing, it is a
// single-player code path running in a place it was never going to work.
//
// FIRST ATTEMPT, AND WHY IT WAS WRONG. The first version of this component
// patched `G_WriteGame` to return AL = 1, so 0x512AC0 would take its success
// branch and whatever waits on the save would be released. Run join15 shows
// exactly what that buys:
//
//     dedi_no_autosave: skipped autosave #1 ... and reported it done
//     Attempting to commit an invalid save buffer
//     dvar set cl_network_warning 0        x390, while frame::count froze at 4496
//
// Reporting success sends the engine down the post-save path at 0x512B23 ->
// 0x512A80 -> 0x563FC0, which commits a buffer nothing ever filled. Lying to an
// engine about a thing it is about to use is not a fix; it just moves the crash
// somewhere with a less helpful message. So: drop the request before any of it
// runs, at the one call the frame-side drain makes per queued request.
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
// HOW IT IS TAKEN: the per-request handler 0x512AC0 has exactly ONE caller --
// the drain at 0x636D57 -- so we retarget that one `call` rel32 rather than
// detouring the function (hook.hpp's standing advice, and the difference between
// rewriting five bytes we have read and relocating a prologue we have not). The
// `add esp, 4` at 0x636D5E is checked before we write: that is the caller's own
// cleanup and it is what makes a bare `ret` stub safe.
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

constexpr uintptr_t kSaveRequest     = 0x512AC0;  // [V] handles one queued autosave request
constexpr uintptr_t kSaveRequestCall = 0x636D57;  // [V] its only caller, the frame-side drain
// The caller's cleanup is NOT the instruction straight after the call -- it takes
// the return value first:
//     00636D57  e8 64 bd ed ff   call 0x512AC0
//     00636D5C  8b e8            mov  ebp, eax     <- 2 bytes
//     00636D5E  83 c4 04         add  esp, 4       <- the cleanup, at call + 7
// Run join16 refused to patch because this was read as call + 5 and found
// `8B E8 83`. The guard was right and the constant was wrong; both are kept.
constexpr uintptr_t kCleanupOffset    = 7;
constexpr uint8_t   kCallerCleanup[3] = {0x83, 0xC4, 0x04};  // add esp, 4 at 0x636D5E

volatile long g_skipped = 0;

void __cdecl on_autosave_skipped() {
    const long n = ::InterlockedIncrement(&g_skipped);
    if (n == 1)
        ENW_INFO("dedi_no_autosave: dropped the first queued autosave. A dedicated server has no "
                 "profile to save into; the stock path cannot complete and hangs the frame loop.");
    else if (n == 200)
        ENW_WARN("dedi_no_autosave: 200 autosave requests dropped. The level script is still "
                 "asking every frame, which costs nothing now but means whatever it waits on is "
                 "still not arriving - see dedi.md 7i.");
}

// Return 0 ("nothing was saved") without touching the request. The caller cleans
// its one pushed argument at 0x636D5E, so a plain `ret` is the correct way not to
// call this function; and `esi` still holds the queue record the caller advances
// itself, so pushad/popad around the log keeps every register the engine owns.
__declspec(naked) void save_request_stub() {
    __asm { pushfd }
    __asm { pushad }
    __asm { call on_autosave_skipped }
    __asm { popad }
    __asm { popfd }
    __asm { xor  eax, eax }
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
        const uintptr_t target = memory::call_target(enw::at(kSaveRequestCall));
        if (target != enw::at(kSaveRequest)) {
            ENW_ERROR("dedi_no_autosave: NOT patching 0x%08X: it calls 0x%08X, expected "
                      "0x%08X. The level-start autosave will run and is expected to hang "
                      "the server.",
                      static_cast<unsigned>(kSaveRequestCall), static_cast<unsigned>(target),
                      static_cast<unsigned>(enw::at(kSaveRequest)));
            return;
        }
        // The `add esp, 4` after the call is what makes a bare `ret` stub safe: we
        // are not guessing a calling convention, we are reading the caller's own
        // cleanup. local_client.cpp learned this the same way.
        uint8_t after[3] = {};
        if (!memory::read_raw(enw::at(kSaveRequestCall) + kCleanupOffset, after, sizeof after) ||
            after[0] != kCallerCleanup[0] || after[1] != kCallerCleanup[1] ||
            after[2] != kCallerCleanup[2]) {
            ENW_ERROR("dedi_no_autosave: NOT patching 0x%08X: expected `add esp, 4` (83 C4 04) "
                      "after the call, found %02X %02X %02X. A `ret` stub would unbalance the "
                      "stack.", static_cast<unsigned>(kSaveRequestCall), after[0], after[1],
                      after[2]);
            return;
        }
        if (!memory::retarget_call(enw::at(kSaveRequestCall), &save_request_stub)) {
            ENW_ERROR("dedi_no_autosave: retarget_call on 0x%08X failed",
                      static_cast<unsigned>(kSaveRequestCall));
            return;
        }
        ENW_INFO("dedi_no_autosave: the frame-side autosave drain (0x%08X) now discards every "
                 "queued request instead of attempting it. Dedicated only.",
                 static_cast<unsigned>(kSaveRequestCall));
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
