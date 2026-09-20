// The main-thread pump.
//
// Nothing in this DLL runs on the game's thread by default: DllMain hands over
// to a loader thread and the game-link has its own. But the engine is not
// thread-safe, so anything that touches engine state needs a foothold on the
// game's thread. This is it.
//
// MEASURED: Com_Printf itself IS callable from any thread (203 probe lines from
// the loader thread reached the engine's console.log). What is NOT reliable is
// output in the first instants after the engine comes up -- an off-thread line
// from that moment is dropped while the identical main-thread line is kept.
// Host commands (exec, dvar set, pause) are a different matter again and must
// be on the game thread regardless.
//
// WHERE THE PUMP LIVES: `Dvar_FindVar` (0x5EDE30). Verified, trivially
// `__cdecl dvar*(const char*)`, and called ~90 times while the engine boots.
//
// ITS LIMIT, MEASURED: it is a STARTUP pump. The engine stops calling it once it
// settles at the menu, so work queued after that may sit indefinitely (the queue
// is bounded at 256 and drops oldest). Good enough for post_init, not for
// steady-state host commands.
//
// WHY NOT Com_Frame (0x59E330) yet: I hooked it and measured **zero calls in
// 20 s**. `re` then found the root cause (board 01:35) and the address is fine --
// WinMain never reaches its loop. `0x5FF4E0` (called at WinMain+0x199, right
// after Com_Init and BEFORE the loop at 0x5FF7B1) runs renderer/D3D bring-up
// unconditionally, and it is NOT gated by com_dedicated. Our solo runs stall
// there too, on the "Set Optimal Settings?" modal. So there is no per-frame tick
// of any kind until that init is unblocked -- the same blocker as dedi's.
//
// Com_Frame is also the hook `referee` takes, and MinHook allows ONE hook per
// target: taking it here silently disabled theirs. Left alone on both counts.
//
// WHEN 0x5FF4E0 IS BYPASSED: move the pump to Com_Frame -- but via a single
// core-owned hook with `on_frame(fn)` subscribers, not by racing referee for the
// address. `ENW_PUMP=frame` runs the experiment in the meantime.
#include "../component.hpp"

#include "../game.hpp"
#include "../game_link.hpp"
#include "../hook.hpp"
#include "../logger.hpp"
#include "../scheduler.hpp"

// The `re` agent's verified address map.
#include "t4/addresses.hpp"

namespace enw {
namespace {

hook g_frame_hook;
hook g_dvar_hook;
volatile LONG g_pump_calls = 0;

// A pumped job that looks a dvar up (or runs a frame's worth of work) lands
// straight back in here. One guard for both queues, since game_link::pump has
// no re-entrancy guard of its own.
thread_local bool tl_in_pump = false;

void drain() {
    if (tl_in_pump || !scheduler::on_main_thread()) return;
    tl_in_pump = true;
    ::InterlockedIncrement(&g_pump_calls);
    scheduler::pump(8);
    game_link::get().pump(8);
    tl_in_pump = false;
}

using Com_Frame_t = void(__cdecl*)();

void __cdecl com_frame_detour() {
    g_frame_hook.original<Com_Frame_t>()();
    drain();
}

game::dvar_s* __cdecl dvar_findvar_detour(const char* name) {
    auto* result = g_dvar_hook.original<game::Dvar_FindVar_t>()(name);
    drain();  // cheap guards inside; this is one of the hottest paths in the engine
    return result;
}

class main_thread final : public component {
public:
    const char* name() const override { return "main_thread"; }

    void post_unpack() override {
        // ENW_PUMP=frame opts back in to the Com_Frame experiment. Off by
        // default: it fires zero times in SP and it steals referee's hook.
        char pick[16]{};
        ::GetEnvironmentVariableA("ENW_PUMP", pick, sizeof(pick));
        if (_stricmp(pick, "frame") == 0) {
            if (g_frame_hook.create(t4::fn::Com_Frame, reinterpret_cast<void*>(&com_frame_detour),
                                    "Com_Frame")) {
                ENW_WARN("main_thread: EXPERIMENT - pump on Com_Frame (%08X). This disables the "
                         "referee's frame hook and measured zero calls last time.",
                         static_cast<unsigned>(t4::fn::Com_Frame));
                return;
            }
            ENW_WARN("main_thread: ENW_PUMP=frame asked for Com_Frame but it would not hook");
        }

        const auto v = game::last_verification();
        if (!v.dvar_findvar_ok) {
            ENW_ERROR("main_thread: Dvar_FindVar did not verify either; there is NO main-thread "
                      "pump. Anything queued with scheduler::run_on_main() will never run.");
            return;
        }
        if (!g_dvar_hook.create(game::addr::Dvar_FindVar,
                                reinterpret_cast<void*>(&dvar_findvar_detour), "Dvar_FindVar")) {
            ENW_ERROR("main_thread: could not hook Dvar_FindVar; no main-thread pump");
            return;
        }
        ENW_INFO("main_thread: pump installed on Dvar_FindVar (startup only), main thread id %lu",
                 scheduler::main_thread_id());
    }

    void post_init() override {
        const auto s = scheduler::snapshot();
        ENW_INFO("main_thread: %ld pump calls so far (queued=%llu ran=%llu dropped=%llu)",
                 ::InterlockedCompareExchange(&g_pump_calls, 0, 0),
                 static_cast<unsigned long long>(s.queued), static_cast<unsigned long long>(s.ran),
                 static_cast<unsigned long long>(s.dropped));
    }

    void pre_destroy() override {
        g_frame_hook.remove();
        g_dvar_hook.remove();
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::main_thread)
