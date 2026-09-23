// Pause: freeze the whole game world on the dedicated server, and resume it seamlessly.
//
// docs/kickstart/dedi.md §18 and referee.md §15 are the write-ups; this header is the short form.
//
// WHO ASKS FOR A PAUSE
//   * the PLAYERS, through two userinfo keys every client carries (the contract is in
//     docs/kickstart/chat-overlay.md, "Client -> server: the pause contract"):
//         enw_ui    paused | typing | clear        enw_pchat  1 | 0
//     The rule is pause_policy.hpp: solo pauses on the Esc menu, and on typing when enw_pchat is
//     1; two or more pause only when EVERY connected client is `paused`; typing never pauses a
//     co-op game; a disconnect counts as unpaused. Read from svs.clients[i].userinfo, which the
//     engine's own `userinfo` command keeps current -- no new hook, no new client command.
//   * the HOST, with the link's `pause` / `resume` (crash grace, everyone-AFK, an operator).
//     That hold is OR-ed on top of the players' wish and only the host releases it.
//
// HOW THE WORLD IS FROZEN (all addresses read from our own dump with tools/re/t4map.py)
//
//   SV_Frame 0x636610:   svs.time += frameMsec   (0x63664E)
//                        call 0x635CC0           SV_RunGameFrame, hooked by t4_bind at entry
//                          ...
//                          0x635D54  call G_RunFrame 0x503AB0   (eax = svs.time; void; plain ret)
//                        call 0x639BD0           SV_SendClientMessages (x2, and 0x636CC0 etc.)
//
//   We retarget the ONE call at 0x635D54. While frozen the stub does not run G_RunFrame, puts
//   svs.time back to the frozen value, and pulls every client's nextSnapshotTime
//   (client_s+0x1161C, the gate in 0x639BD0: `svs.time < next - 10 -> skip`) down to it.
//   So, while frozen:
//     - G_RunFrame never runs: AI, the script VM (every `wait`, bleedout, powerup and box timer,
//       round_spawn_failsafe), physics and entity think all hold, with nothing to push forward.
//       This is what vault 11 §6 wanted and could not get from script.
//     - level.time (0x18F6DC8) and svs.time both hold, so on resume the next frame is
//       frozen + frameMsec: NO catch-up burst, no timer expires because a pause happened.
//     - ClientThink_real clamps a usercmd to level.time + 200 (0x4E8784), so a player can move
//       at most 200 ms and is then held. No invulnerability hack needed: nothing runs to hurt him.
//     - snapshots keep flowing (same serverTime, frame rate), so clients do not time out
//       (cl_timeout) the way they would under the engine's own SP pause (see below).
//
//   WHY NOT THE ENGINE'S OWN PAUSE. T4 has Q3's SV_CheckPaused at 0x635BB0: when cl_paused is
//   set it pauses ONLY if every connected client is loopback (netchan type 2); any remote client
//   unpauses it. And its paused branch (0x6360E0) skips the whole server frame, snapshots
//   included, which drops remote clients after cl_timeout. It is a listen-server feature.
//
//   WHY NOT `timescale 0` (vault 11 §6): it stalls every GSC wait and the client reports
//   "Connection Interrupted". We never touch timescale.
//
//   `sv_paused` (dvar ptr 0x1F9645C) is set to 1 while frozen and 0 after, as a MARKER any
//   operator or `get sv_paused` can read. On this dedi it is inert: every engine reader of it
//   also requires cl_paused, which stays 0 here.
//
// WHAT IS NOT PROVEN (dedi.md §18): what a real remote client DRAWS while frozen. The world
// stops; the client's clock resets to the frozen snapshot time about every 500 ms; the stock
// "Connection Interrupted" banner may flicker. The game link carries `pause_state` so the site,
// the launcher and the overlay can draw PAUSED themselves -- that is the visible state we own.
//
// Paused time never counts for XP (vault 99 §4.6) and is excluded from in-game time: the host
// referee accounts every pause, whoever asked for it (referee.md §15).
#include "../../../shared/core/component.hpp"

#include "../../../shared/core/frame.hpp"
#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../../../shared/core/memory.hpp"
#include "../dedicated/dedicated.hpp"
#include "../referee/t4_bind.hpp"
#include "pause_policy.hpp"

#include <cstdlib>
#include <string>

#if __has_include("t4/addresses.hpp")
#include "t4/addresses.hpp"
#include "t4/structs.hpp"
#define ENW_HAVE_T4_ADDRESSES 1
#endif

namespace enw {
namespace {

using pause_rule::reason;

#ifdef ENW_HAVE_T4_ADDRESSES
// Local on purpose: shared/t4 is the `re` lane's file. Every row is [V] from the dump.
constexpr uintptr_t kGRunFrameCall = 0x635D54;   // `call G_RunFrame` inside SV_RunGameFrame
constexpr uintptr_t kGRunFrame = 0x503AB0;       // G_RunFrame(eax = levelTime), void, `ret`
constexpr uintptr_t kLevelTime = 0x18F6DC8;      // level.time, written by G_RunFrame from eax
constexpr uintptr_t kSvPausedDvar = 0x1F9645C;   // dvar_s* sv_paused (Com_InitDvars 0x59CBEB)
constexpr size_t kDvarCurrent = 0x10;            // dvar_s.current (int), as SV_CheckPaused reads
constexpr size_t kClientState = 0x0;             // client_s.state: 4 = CS_ACTIVE (0x639C13)
constexpr size_t kNextSnapshotTime = 0x1161C;    // client_s.nextSnapshotTime (0x639693, 0x639C2D)
constexpr int kCsActive = 4;
constexpr int kMaxClients = 4;
constexpr uintptr_t kSvMaxclientsDvar = 0x23D5C30; // dvar_s* sv_maxclients (SV_CheckPaused 0x635BBC)
constexpr uintptr_t kScrVmLocalVars = 0x3BD4700;   // gScrVmPub[0] first dword: localVars (dedi.md §13.2)

uintptr_t svs_time_addr() { return at(t4::var::svs) + t4::svs_off::time; }
uintptr_t client_addr(int i) {
    return at(t4::var::svs) + t4::svs_off::clients + static_cast<size_t>(i) * t4::client_off::stride;
}
#endif

// ------------------------------------------------------------------ the gate --
// All of this runs on the main thread: the gate from inside the server frame, the rest from
// the Com_Frame subscriber and the link handlers (want_game_thread). No locks.
bool g_armed = false;
bool g_frozen = false;           // what the gate enforces
bool g_frozen_applied = false;   // the gate has seen at least one frozen frame
int g_frozen_time = 0;           // level.time == svs.time held here
int g_last_level_time = 0;       // the last value G_RunFrame was given
uint64_t g_skipped = 0;          // G frames not run in the current pause
uint64_t g_skipped_total = 0;
int g_first_after_resume = -1;   // level.time of the first frame after a resume, for the log
uintptr_t g_grunframe = 0;       // live address of G_RunFrame, for the stub's jump
int g_slots = 0;                 // sv_maxclients clamped to 4, read once when a pause starts
uint64_t g_refused_writes = 0;   // guard refusals this pause (a value that was not a time)
bool g_guard_tripped = false;    // svs.time was not what we expected: stop freezing

void set_sv_paused_marker(int v) {
#ifdef ENW_HAVE_T4_ADDRESSES
    uintptr_t dvar = 0;
    if (!memory::read(at(kSvPausedDvar), &dvar) || !dvar) return;
    if (!memory::is_readable(reinterpret_cast<void*>(dvar + kDvarCurrent), 4)) return;
    *reinterpret_cast<volatile int*>(dvar + kDvarCurrent) = v;
#else
    (void)v;
#endif
}

int read_sv_paused_marker() {
#ifdef ENW_HAVE_T4_ADDRESSES
    uintptr_t dvar = 0;
    int v = -1;
    if (!memory::read(at(kSvPausedDvar), &dvar) || !dvar) return -1;
    if (!memory::read(dvar + kDvarCurrent, &v)) return -1;
    return v;
#else
    return -1;
#endif
}

// scrVmPub.localVars, the scratch pointer 0x697B60 pushes into with no bound (dedi.md §13.2).
// Only READ, and only logged: if it creeps across a pause, the next repro shows it.
uintptr_t read_local_vars() {
#ifdef ENW_HAVE_T4_ADDRESSES
    uintptr_t v = 0;
    return memory::read(at(kScrVmLocalVars), &v) ? v : 0;
#else
    return 0;
#endif
}

// Returns true to run G_RunFrame this frame.
bool __cdecl enw_pause_gate(int svs_time) {
#ifdef ENW_HAVE_T4_ADDRESSES
    if (!g_frozen) {
        if (g_frozen_applied) {
            // First frame after a resume: svs.time is frozen + frameMsec, so G continues from
            // exactly where it stopped.
            g_frozen_applied = false;
            g_first_after_resume = svs_time;
        }
        g_last_level_time = svs_time;
        return true;
    }
    if (!g_frozen_applied) {
        // The level's own clock is the authority: G_RunFrame copied eax into it last frame.
        int lt = 0;
        const int held = memory::read(at(kLevelTime), &lt) && lt ? lt : g_last_level_time;
        if (held <= 0) {
            // No level has run a frame yet (a hold that arrived during the load): there is
            // nothing to freeze, and pinning svs.time to 0 would be a lie to every client.
            g_last_level_time = svs_time;
            return true;
        }
        g_frozen_applied = true;
        g_frozen_time = held;
        int maxc = 0;
        uintptr_t dv = 0;
        if (memory::read(at(kSvMaxclientsDvar), &dv) && dv) memory::read(dv + kDvarCurrent, &maxc);
        g_slots = pause_rule::client_slots(maxc, kMaxClients);
    }
    // GUARDS (referee.md §15.4): write only where the value already there is a time near the
    // frozen one. If svs.time is not, something else moved it -- stop freezing rather than fight.
    auto* svs_time_p = reinterpret_cast<volatile int*>(svs_time_addr());
    if (!pause_rule::plausible_svs_time(*svs_time_p, g_frozen_time)) {
        ++g_refused_writes;
        g_guard_tripped = true;
        g_last_level_time = *svs_time_p;
        return true;
    }
    *svs_time_p = g_frozen_time;
    for (int i = 0; i < g_slots; ++i) {
        const uintptr_t c = client_addr(i);
        if (*reinterpret_cast<volatile int*>(c + kClientState) != kCsActive) continue;
        auto* next = reinterpret_cast<volatile int*>(c + kNextSnapshotTime);
        const int prior = *next;
        if (prior <= g_frozen_time) continue;
        if (!pause_rule::plausible_next_snapshot(prior, g_frozen_time)) {
            ++g_refused_writes;
            continue;
        }
        *next = g_frozen_time;
    }
    ++g_skipped;
    ++g_skipped_total;
    return false;
#else
    (void)svs_time;
    return true;
#endif
}

// The call site's contract: eax = levelTime, no stack arguments, callee returns with `ret`.
// Everything except eax is scratch at that point (the caller reloads what it needs).
__declspec(naked) void g_run_frame_gate() {
    __asm {
        push eax
        push eax
        call enw_pause_gate
        add  esp, 4
        test al, al
        pop  eax
        jz   skip
        jmp  dword ptr [g_grunframe]
    skip:
        ret
    }
}

// ------------------------------------------------------------- the component --
class pause final : public component {
public:
    const char* name() const override { return "pause"; }

    void post_load() override {
        auto& link = game_link::get();
        link.on("pause", [this](const json::value& m) { host_hold(true, m.str_or("id")); },
                /*want_game_thread=*/true);
        link.on("resume", [this](const json::value& m) { host_hold(false, m.str_or("id")); },
                /*want_game_thread=*/true);
    }

    void post_unpack() override { referee::bind(); }

    void post_init() override {
#ifdef ENW_HAVE_T4_ADDRESSES
        if (!dedi::is_dedicated()) {
            ENW_INFO("pause: not a dedicated server; the engine's own SP pause applies. Off.");
            return;
        }
        if (std::getenv("ENW_NO_PAUSE")) {
            ENW_WARN("pause: OFF (ENW_NO_PAUSE). Esc/typing will not pause and a host `pause` "
                     "will be refused.");
            return;
        }
        const uintptr_t site = at(kGRunFrameCall);
        const uintptr_t target = memory::call_target(site);
        if (target != at(kGRunFrame)) {
            ENW_ERROR("pause: NOT arming: 0x%08X calls 0x%08X, expected G_RunFrame 0x%08X",
                      static_cast<unsigned>(kGRunFrameCall), static_cast<unsigned>(target),
                      static_cast<unsigned>(at(kGRunFrame)));
            return;
        }
        if (!memory::is_readable(reinterpret_cast<void*>(svs_time_addr()), 4) ||
            !memory::is_readable(reinterpret_cast<void*>(client_addr(kMaxClients - 1) +
                                                         kNextSnapshotTime), 4)) {
            ENW_ERROR("pause: NOT arming: svs is not readable");
            return;
        }
        g_grunframe = target;
        if (!memory::retarget_call(site, reinterpret_cast<const void*>(&g_run_frame_gate))) {
            ENW_ERROR("pause: retarget_call on 0x%08X failed", static_cast<unsigned>(site));
            return;
        }
        g_armed = true;
        frame::subscribe("pause", [this](uint64_t) { tick(); });
        ENW_INFO("pause: armed -- G_RunFrame gate at 0x%08X; players pause through userinfo "
                 "enw_ui/enw_pchat, the host through `pause`/`resume`. sv_paused=%d",
                 static_cast<unsigned>(kGRunFrameCall), read_sv_paused_marker());
#else
        ENW_WARN("pause: built without t4/addresses.hpp; off");
#endif
    }

    void pre_destroy() override {
        if (g_armed)
            ENW_INFO("pause: %u pause(s) this session, %llu G frame(s) held in total",
                     pauses_, static_cast<unsigned long long>(g_skipped_total));
    }

private:
    // -------------------------------------------------------------- host hold --
    void host_hold(bool on, const std::string& id) {
        auto reply = [&](bool ok, const char* err) {
            if (!id.empty()) game_link::get().send_reply(id, ok, err ? err : "");
        };
        if (!g_armed) return reply(false, "pause not armed (not dedicated, or the gate failed)");
        if (host_hold_ != on)
            ENW_INFO("pause: host %s", on ? "HOLD (the host paused the game)" : "released its hold");
        host_hold_ = on;
        evaluate();
        reply(true, nullptr);
    }

    // ----------------------------------------------------------- per-frame poll --
    void tick() {
        const uint32_t now = game_link::now_ms();
        if (now - last_poll_ms_ >= kPollMs) {
            last_poll_ms_ = now;
            poll_clients();
            evaluate();
        }
        if (g_guard_tripped && g_frozen) {
            // svs.time was not a time near the frozen one: something else owns that frame.
            // Give the world back rather than write into it (referee.md §15.4).
            ENW_ERROR("pause: GUARD - svs.time was not frozen+frameMsec; refusing to write, "
                      "releasing the freeze (%llu refused write(s))",
                      static_cast<unsigned long long>(g_refused_writes));
            host_hold_ = false;
            force_release_ = true;
            evaluate();
        }
        if (after_resume_logs_ > 0 && now - last_after_log_ms_ >= kFrozenLogMs) {
            last_after_log_ms_ = now;
            --after_resume_logs_;
            ENW_INFO("pause: after resume +%u s: localVars %08X (at pause %08X)",
                     (now - resumed_at_ms_) / 1000, static_cast<unsigned>(read_local_vars()),
                     static_cast<unsigned>(local_vars_at_pause_));
        }
        if (g_first_after_resume >= 0) {
            ENW_INFO("pause: first G frame after resume at level.time %d (held at %d, so +%d ms: "
                     "no catch-up)", g_first_after_resume, g_frozen_time,
                     g_first_after_resume - g_frozen_time);
            g_first_after_resume = -1;
        }
        if (g_frozen && now - last_frozen_log_ms_ >= kFrozenLogMs) {
            last_frozen_log_ms_ = now;
            int lt = 0, st = 0;
#ifdef ENW_HAVE_T4_ADDRESSES
            memory::read(at(kLevelTime), &lt);
            memory::read(svs_time_addr(), &st);
#endif
            ENW_INFO("pause: FROZEN %u s (%s, %d player(s)): level.time %d, svs.time %d, "
                     "%llu G frame(s) held, sv_paused %d, localVars %08X, refused writes %llu",
                     (now - frozen_at_ms_) / 1000, pause_rule::to_string(reason_), connected_,
                     lt, st, static_cast<unsigned long long>(g_skipped), read_sv_paused_marker(),
                     static_cast<unsigned>(read_local_vars()),
                     static_cast<unsigned long long>(g_refused_writes));
            if (connected_ > 1 && now - frozen_at_ms_ >= kLongPauseMs &&
                now - last_long_log_ms_ >= kLongPauseMs) {
                last_long_log_ms_ = now;
                ENW_WARN("pause: a %d-player pause has lasted %u min. There is no ceiling on "
                         "this by design (B, 2026-09-22); logged, not ended.",
                         connected_, (now - frozen_at_ms_) / 60000);
            }
        }
    }

    void poll_clients() {
        connected_ = 0;
        for (int i = 0; i < kSlots; ++i) {
            bool active = false;
            std::string info;
#ifdef ENW_HAVE_T4_ADDRESSES
            int state = 0;
            if (memory::read(client_addr(i) + kClientState, &state) && state == kCsActive) {
                if (auto v = referee::client(i)) {
                    active = true;
                    info = v->userinfo;
                }
            }
#endif
            const auto r = pause_rule::from_userinfo(active, info);
            if (active) ++connected_;
            auto& was = clients_[i];
            const bool changed = was.connected != r.connected || was.ui != r.ui ||
                                 (r.connected && was.pause_on_chat != r.pause_on_chat);
            if (changed && r.connected) {
                json::writer w;
                w.str("t", "ui")
                    .integer("ms", game_link::now_ms())
                    .integer("slot", i)
                    .str("ui", pause_rule::to_string(r.ui))
                    .boolean("pchat", r.pause_on_chat);
                game_link::get().send(w);
                ENW_INFO("pause: slot %d ui=%s pchat=%d", i, pause_rule::to_string(r.ui),
                         r.pause_on_chat ? 1 : 0);
            } else if (changed && was.connected) {
                ENW_INFO("pause: slot %d left (counts as unpaused)", i);
            }
            was = r;
        }
    }

    // An operator's trigger, for proving the freeze on the box where there is no dashboard and
    // no real client: a file `enw_pause.trigger` next to CoDWaW.exe holds the game frozen for as
    // long as it exists. Reported as reason `operator` and accounted by the host like the
    // players' own pause (it is not our `host` hold), so it can never hide paused time.
    bool operator_trigger() {
        const uint32_t now = game_link::now_ms();
        if (now - last_trigger_check_ms_ < 1000) return trigger_on_;
        last_trigger_check_ms_ = now;
        if (trigger_path_.empty()) {
            char exe[MAX_PATH] = {};
            const DWORD n = ::GetModuleFileNameA(nullptr, exe, MAX_PATH);
            std::string dir(exe, n);
            const size_t cut = dir.find_last_of("/\\");
            trigger_path_ = (cut == std::string::npos ? std::string() : dir.substr(0, cut + 1)) +
                            "enw_pause.trigger";
        }
        const bool on = ::GetFileAttributesA(trigger_path_.c_str()) != INVALID_FILE_ATTRIBUTES;
        if (on != trigger_on_)
            ENW_INFO("pause: operator trigger %s (%s)", on ? "PRESENT" : "removed",
                     trigger_path_.c_str());
        trigger_on_ = on;
        return on;
    }

    void evaluate() {
        reason want = pause_rule::decide(host_hold_, clients_, kSlots);
        if (want == reason::none && operator_trigger()) want = reason::operator_file;
        if (force_release_) {
            // A tripped guard holds the world released until every asker has let go.
            if (want == reason::none) force_release_ = false, g_guard_tripped = false;
            want = reason::none;
        }
        const bool freeze = want != reason::none;
        if (freeze == g_frozen) {
            if (freeze && want != reason_) {
                // Still paused, for a different reason (e.g. one of two left and the other is
                // now solo in the menu). Tell the host so the badge is right; no clock change.
                reason_ = want;
                emit_state();
            }
            return;
        }
        const uint32_t now = game_link::now_ms();
        if (freeze) {
            g_frozen = true;
            reason_ = want;
            frozen_at_ms_ = now;
            last_frozen_log_ms_ = now;
            last_long_log_ms_ = now;
            g_skipped = 0;
            g_refused_writes = 0;
            local_vars_at_pause_ = read_local_vars();
            after_resume_logs_ = 0;
            ++pauses_;
            set_sv_paused_marker(1);
            ENW_INFO("pause: PAUSED (%s, %d player(s)) at level.time %d", pause_rule::to_string(want),
                     connected_, g_last_level_time);
        } else {
            g_frozen = false;
            const uint32_t held = now - frozen_at_ms_;
            set_sv_paused_marker(0);
            ENW_INFO("pause: RESUMED after %u ms (was %s, %d player(s) now): %llu G frame(s) held, "
                     "level.time held at %d, localVars %08X (at pause %08X), refused writes %llu",
                     held, pause_rule::to_string(reason_), connected_,
                     static_cast<unsigned long long>(g_skipped), g_frozen_time,
                     static_cast<unsigned>(read_local_vars()),
                     static_cast<unsigned>(local_vars_at_pause_),
                     static_cast<unsigned long long>(g_refused_writes));
            resumed_at_ms_ = now;
            last_after_log_ms_ = now;
            after_resume_logs_ = 12;   // a minute of localVars after every resume
            last_held_ms_ = held;
            reason_ = reason::none;
        }
        emit_state();
    }

    void emit_state() {
        json::writer w;
        w.str("t", "pause_state")
            .integer("ms", game_link::now_ms())
            .boolean("paused", g_frozen)
            .str("reason", pause_rule::to_string(g_frozen ? reason_ : reason::none))
            .integer("players", connected_);
        if (!g_frozen) w.integer("held_ms", last_held_ms_);
        game_link::get().send(w);
    }

    static constexpr int kSlots = 4;
    static constexpr uint32_t kPollMs = 50;
    static constexpr uint32_t kFrozenLogMs = 5000;
    static constexpr uint32_t kLongPauseMs = 5 * 60 * 1000;

    pause_rule::client_report clients_[kSlots] = {};
    bool host_hold_ = false;
    reason reason_ = reason::none;
    int connected_ = 0;
    uint32_t last_poll_ms_ = 0;
    uint32_t frozen_at_ms_ = 0;
    uint32_t last_frozen_log_ms_ = 0;
    uint32_t last_long_log_ms_ = 0;
    uint32_t last_held_ms_ = 0;
    unsigned pauses_ = 0;
    uint32_t last_trigger_check_ms_ = 0;
    bool force_release_ = false;
    uintptr_t local_vars_at_pause_ = 0;
    uint32_t resumed_at_ms_ = 0;
    uint32_t last_after_log_ms_ = 0;
    int after_resume_logs_ = 0;
    bool trigger_on_ = false;
    std::string trigger_path_;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::pause)
