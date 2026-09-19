// AFK: per-player input activity, reported, never judged.
//
// The vault (99 §4.6) makes active time a risk/trust score, not a stopwatch:
// "training without shooting counts; idling and scripts don't". That judgement
// is model-shaped and gets tuned on beta data, so it belongs host-side. This
// component's whole job is to emit an honest, cheap `input` event.
//
// The engine already stores the client's last usercmd_s in client_s, so there is
// nothing to hook: the frame callback diffs it. What we report per tick:
//   buttons  -- the raw button bitfield (attack/use/melee/jump/sprint/...)
//   moved    -- forwardmove or rightmove is non-zero
//   turned   -- the packed view angles changed by more than a dead band
//
// The dead band matters. A mouse at rest still jitters by a unit or two of the
// packed angle, and a "weapon bob" script or a rubber band on a stick would
// otherwise read as activity. kTurnDeadband is in packed-angle units
// (65536 == 360 degrees), so 40 is about 0.22 degrees per 100 ms.
#include "../../../shared/core/component.hpp"

#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../referee/t4_bind.hpp"

#include <cstdlib>

namespace enw {
namespace {

constexpr int kMaxPlayers = 4;
constexpr uint32_t kMinIntervalMs = 100;   // <= 10 Hz, per the protocol
constexpr int kTurnDeadband = 40;          // packed angle units

int packed_delta(int16_t a, int16_t b) {
    int d = static_cast<int>(a) - static_cast<int>(b);
    if (d > 32767) d -= 65536;
    if (d < -32768) d += 65536;
    return d < 0 ? -d : d;
}

class afk final : public component {
public:
    const char* name() const override { return "afk"; }

    void post_unpack() override {
        referee::bind();
        referee::on_frame([this](uint32_t ms) { on_frame(ms); });
        if (!referee::bound().clients) {
            ENW_WARN("afk: client_s not bound; no input events will be sent");
        }
    }

private:
    void on_frame(uint32_t ms) {
        const int n = referee::max_clients();
        for (int slot = 0; slot < n && slot < kMaxPlayers; ++slot) {
            auto cmd = referee::last_usercmd(slot);
            if (!cmd) continue;
            auto& p = state_[slot];

            const bool moved = cmd->forwardmove != 0 || cmd->rightmove != 0;
            const bool turned = p.valid && (packed_delta(cmd->view_pitch, p.pitch) > kTurnDeadband ||
                                            packed_delta(cmd->view_yaw, p.yaw) > kTurnDeadband);
            const bool buttons_changed = !p.valid || cmd->buttons != p.buttons;
            const bool changed = buttons_changed || moved != p.moved || turned;

            p.pitch = cmd->view_pitch;
            p.yaw = cmd->view_yaw;
            p.buttons = cmd->buttons;
            p.moved = moved;
            p.valid = true;

            // Only on change, and never faster than 10 Hz.
            if (!changed) continue;
            if (ms - p.last_sent_ms < kMinIntervalMs) {
                p.pending = true;
                continue;
            }
            p.pending = false;
            p.last_sent_ms = ms;

            json::writer w;
            w.str("t", "input")
                .integer("ms", ms)
                .integer("slot", slot)
                .integer("buttons", cmd->buttons)
                .boolean("moved", moved)
                .boolean("turned", turned);
            game_link::get().send(w);
        }
    }

    struct s {
        bool valid = false;
        int16_t pitch = 0;
        int16_t yaw = 0;
        int32_t buttons = 0;
        bool moved = false;
        bool pending = false;
        uint32_t last_sent_ms = 0;
    };
    s state_[kMaxPlayers];
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::afk)
