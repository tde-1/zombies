// Replay sampling: players at 20 Hz, zombies at 10 Hz, straight onto the game link.
//
// The server runs at sv_fps 20 (confirmed in dedi's dvar dump), so "20 Hz" is
// exactly one sample per server frame and "10 Hz" is every other frame. No extra
// thread, no interpolation, no timer drift.
//
// The wire shape is `snap` from docs/protocol/game-link-v0.md. Either list may be
// omitted, so an odd frame sends players only.
//
// SIZE. This is the number the host agent needs for "bytes per game-hour", so the
// encoder is written to be measurable rather than clever:
//   * positions to 0.1 unit, angles to 0.1 degree -- WaW units are ~1 inch, so
//     0.1 is well under what a replay viewer can show, and it halves the digits
//     against %f;
//   * a field is omitted when it has not changed since the previous snap for that
//     slot (health, score, weapon, stance are near-static between frames);
//   * zombies are keyed by entity number, which the engine reuses, so the host
//     must treat (id, first-seen) as the identity, not id alone.
// v0 is NDJSON because the host writes NDJSON-inside-zstd chunks; the columnar
// CBOR format in vault 99 §5.4 replaces this encoder, not this sampler.
#include "../../../shared/core/component.hpp"

#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../referee/t4_bind.hpp"

#include <cstdio>
#include <cstring>

namespace enw {
namespace {

constexpr int kMaxPlayers = 4;
constexpr size_t kMaxZombies = 64;   // level.zombie_vars max_ai is 24 stock; headroom for customs

std::string fmt_vec3_10th(const float v[3]) {
    char b[80];
    std::snprintf(b, sizeof(b), "[%.1f,%.1f,%.1f]", v[0], v[1], v[2]);
    return b;
}

class replay final : public component {
public:
    const char* name() const override { return "replay"; }

    void post_unpack() override {
        referee::bind();
        referee::on_frame([this](uint32_t ms) { on_frame(ms); });
        ENW_INFO("replay: sampler armed (players 20 Hz, zombies 10 Hz)");
    }

    void pre_destroy() override {
        ENW_INFO("replay: %llu snaps, %llu bytes of snap JSON",
                 static_cast<unsigned long long>(snaps_),
                 static_cast<unsigned long long>(bytes_));
    }

private:
    void on_frame(uint32_t ms) {
        ++frame_;
        if (!referee::bound().entities) return;

        json::array players;
        const int n = referee::max_clients();
        for (int slot = 0; slot < n && slot < kMaxPlayers; ++slot) {
            auto c = referee::client(slot);
            if (!c || !c->active) continue;   // a listen server leaves gclient set on unused slots
            auto e = referee::player_ent(slot);
            if (!e) continue;
            auto& prev = players_[slot];

            json::writer p;
            p.integer("slot", slot);
            p.raw("pos", fmt_vec3_10th(e->origin));
            char ang[48];
            std::snprintf(ang, sizeof(ang), "[%.1f,%.1f]", e->angles[0], e->angles[1]);
            p.raw("ang", ang);

            if (!prev.valid || e->health != prev.health) p.integer("health", e->health);
            if (!prev.valid || e->alive != prev.alive) p.boolean("alive", e->alive);

            if (auto s = referee::player_int(slot, "score")) {
                if (!prev.valid || *s != prev.score) p.integer("score", *s);
                prev.score = *s;
            }
            if (auto cmd = referee::last_usercmd(slot)) {
                if (!prev.valid || cmd->weapon != prev.weapon) p.integer("weapon", cmd->weapon);
                prev.weapon = cmd->weapon;
            }

            prev.health = e->health;
            prev.alive = e->alive;
            prev.valid = true;
            players.raw(p.done());
        }

        json::array zombies;
        const bool zombie_frame = (frame_ % 2) == 0;
        if (zombie_frame) {
            referee::ent_view buf[kMaxZombies];
            const size_t got = referee::zombie_ents(buf, kMaxZombies);
            for (size_t i = 0; i < got; ++i) {
                json::writer z;
                z.integer("id", buf[i].entnum);
                z.raw("pos", fmt_vec3_10th(buf[i].origin));
                z.integer("health", buf[i].health);
                zombies.raw(z.done());
            }
        }

        if (players.count() == 0 && zombies.count() == 0) return;

        json::writer w;
        w.str("t", "snap").integer("ms", ms);
        if (players.count()) w.raw("players", players.done());
        if (zombies.count()) w.raw("zombies", zombies.done());
        std::string line = w.done();
        bytes_ += line.size() + 1;
        ++snaps_;
        game_link::get().send_line(std::move(line));
    }

    struct player_prev {
        bool valid = false;
        int health = 0;
        bool alive = false;
        int score = 0;
        uint8_t weapon = 0;
    };

    player_prev players_[kMaxPlayers];
    uint64_t frame_ = 0;
    uint64_t snaps_ = 0;
    uint64_t bytes_ = 0;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::replay)
