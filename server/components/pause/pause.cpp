// Pause: freeze the game engine-side and resume cleanly.
//
// Vault `11 - Implementation Reference` §6 lists the traps, and every one of them
// is visible in the scripts we extracted, so this component is built around
// avoiding them rather than discovering them:
//
//  * `timescale 0` stalls every GSC `wait` and the client reports "Connection
//    Interrupted". Never touch timescale.
//  * Map scripts re-enable player controls, so `freezecontrols` from script
//    loses a race with the map. Freeze in the engine instead.
//  * `round_spawn_failsafe()` (_zombiemode.gsc, the "hack shit DT#33203" loop)
//    is a stuck-zombie watchdog: a zombie that does not move for long enough is
//    teleported or killed. Frozen zombies look exactly like stuck zombies.
//  * Board-tearing is animation driven; a zombie mid-tear must keep its anim
//    state or the barrier bookkeeping desyncs.
//  * Box, trap, powerup and bleedout timers are `wait`-based and keep running.
//  * The configstring pool limits how much HUD text we can add.
//
// THE PLAN, in the order the frame hook does it:
//   1. skip the AI think for every zombie, and skip applying client usercmds --
//      that is the actual freeze, and it stalls nothing script-side;
//   2. make players invulnerable while frozen (a frozen player next to a zombie
//      that got one more think in is otherwise a free down);
//   3. push the deadlines we know about forward by the paused duration:
//      per-player bleedout (self.bleedout_time), the powerup timers, the box
//      timeout, and level.round_timer;
//   4. suppress the stuck-zombie failsafe for the paused window;
//   5. on resume, put everything back in one frame and emit `resume`.
//
// Paused time never counts for XP (vault 99 §4.6), so the host is told the exact
// ms window and does the excluding.
//
// WHAT IS HONESTLY NOT SOLVED HERE: spawning can only be delayed, not cancelled,
// so a zombie already queued to rise will rise on resume; and anything a custom
// map's own script threads on a bare `wait` keeps counting. Those are accepted.
#include "../../../shared/core/component.hpp"

#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../referee/t4_bind.hpp"

namespace enw {
namespace {

class pause final : public component {
public:
    const char* name() const override { return "pause"; }

    void post_load() override {
        auto& link = game_link::get();
        link.on("pause", [this](const json::value& m) { set_paused(true, m.str_or("id")); },
                /*want_game_thread=*/true);
        link.on("resume", [this](const json::value& m) { set_paused(false, m.str_or("id")); },
                /*want_game_thread=*/true);
    }

    void post_unpack() override {
        referee::bind();
        referee::on_frame([this](uint32_t ms) { on_frame(ms); });
    }

    bool paused() const { return paused_; }

    // Called by the (future) AI think / usercmd hooks. Returns true if the
    // engine should skip this entity's think this frame.
    bool should_freeze_ai() const { return paused_; }
    bool should_freeze_clients() const { return paused_; }

private:
    void set_paused(bool on, const std::string& id) {
        auto reply = [&](bool ok, const char* err) {
            if (!id.empty()) game_link::get().send_reply(id, ok, err ? err : "");
        };
        if (!referee::bound().frame_hook) return reply(false, "frame hook not bound");
        if (on == paused_) return reply(true, nullptr);

        paused_ = on;
        if (on) {
            paused_at_ms_ = last_ms_;
            // BIND: set players invulnerable, remember bleedout_time per player,
            // disarm the stuck-zombie failsafe (level.zombie_vars["zombie_use_failsafe"] = 0).
            saved_failsafe_ = referee::level_map_float("zombie_vars", "zombie_use_failsafe");
            referee::set_level_map_float("zombie_vars", "zombie_use_failsafe", 0.0f);
            ENW_INFO("pause: frozen at %u ms", paused_at_ms_);
        } else {
            const uint32_t held = last_ms_ - paused_at_ms_;
            total_paused_ms_ += held;
            if (saved_failsafe_) {
                referee::set_level_map_float("zombie_vars", "zombie_use_failsafe", *saved_failsafe_);
            }
            // BIND: push bleedout/powerup/box/round deadlines forward by `held`,
            // then drop invulnerability.
            ENW_INFO("pause: resumed after %u ms (total paused %u ms)", held, total_paused_ms_);
        }

        json::writer w;
        w.str("t", "log")
            .str("level", "info")
            .integer("ms", last_ms_)
            .str("msg", on ? "paused" : "resumed");
        game_link::get().send(w);
        reply(true, nullptr);
    }

    void on_frame(uint32_t ms) { last_ms_ = ms; }

    bool paused_ = false;
    uint32_t last_ms_ = 0;
    uint32_t paused_at_ms_ = 0;
    uint32_t total_paused_ms_ = 0;
    std::optional<float> saved_failsafe_;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::pause)
