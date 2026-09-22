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

// ---------------------------------------------------------------- weapon --
// `weapon` DISAGREED WITH ITSELF (replay.md section 3, gap 5): this file wrote the
// uint8 usercmd index while every replay on disk carries a string, because every
// replay on disk came from the simulator. The viewer showed neither.
//
// One type wins, and it has to be the string, because that is what is already in the
// files and in the track endpoint. Resolving the index to the engine's real weapon
// name needs `BG_GetWeaponDef`, which is not in shared/t4 yet, so until it is we emit
// the index AS a string with a `#` marker: `"#37"`. A consumer can tell a resolved
// name from an unresolved index at a glance, the type never changes under it, and the
// day the lookup lands only this function changes.
std::string weapon_name(uint8_t index) {
    char b[16];
    std::snprintf(b, sizeof(b), "#%u", static_cast<unsigned>(index));
    return b;
}

// ---------------------------------------------------------------- stance --
// The protocol table and referee.md both promise `stance` and this file never sent
// it, so the viewer passed `false` to setPose's `ducked` on every tick of every real
// replay (replay.md section 3, gap 6).
//
// The only stance signal we have bound today is the button mask on the last usercmd.
// **THE BIT VALUES ARE NOT VERIFIED BY US.** They are the CoD-family crouch/prone
// bits and they are consistent with every usercmd mask this server has logged, which
// is not the same as having watched a player crouch and seen the bit move. So:
//   * we emit "stand" / "crouch" / "prone" only for masks we recognise, and nothing
//     at all when both bits are set or the mask is one we have not seen;
//   * `log_unknown_button_masks` prints each distinct mask once, which is exactly the
//     evidence the next session needs -- crouch in a join run, read the log, and
//     either promote this to [V] or correct it.
constexpr int kButtonCrouch = 0x00000004;
constexpr int kButtonProne  = 0x00000008;

const char* stance_from_buttons(int buttons) {
    const bool crouch = (buttons & kButtonCrouch) != 0;
    const bool prone  = (buttons & kButtonProne) != 0;
    if (crouch && prone) return nullptr;         // contradictory: say nothing
    if (prone) return "prone";
    if (crouch) return "crouch";
    return "stand";
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
        ENW_INFO("replay: %llu snaps, %llu bytes of snap JSON, %llu kill events",
                 static_cast<unsigned long long>(snaps_),
                 static_cast<unsigned long long>(bytes_),
                 static_cast<unsigned long long>(kills_));
    }

private:
    void on_frame(uint32_t ms) {
        ++frame_;
        if (!referee::bound().entities) return;
        // Game over stops the replay. A dedicated server does NOT shut down at game
        // over any more (no_save_reload.cpp keeps it, the map and the clients alive),
        // so without this the sampler keeps writing snaps of an intermission -- and
        // then of the next match -- into a replay the host agent has already closed.
        // The referee turns it back on when a new match starts.
        if (!referee::recording()) {
            if (!stopped_said_) {
                stopped_said_ = true;
                ENW_INFO("replay: sampler stopped at game over after %llu snaps / %llu bytes. "
                         "It restarts when the referee reports a new match.",
                         static_cast<unsigned long long>(snaps_),
                         static_cast<unsigned long long>(bytes_));
            }
            return;
        }
        stopped_said_ = false;

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
                if (!prev.valid || cmd->weapon != prev.weapon) {
                    p.str("weapon", weapon_name(cmd->weapon));
                }
                prev.weapon = cmd->weapon;

                if (const char* st = stance_from_buttons(cmd->buttons)) {
                    if (!prev.valid || std::strcmp(st, prev.stance) != 0) p.str("stance", st);
                    prev.stance = st;
                }
                note_button_mask(cmd->buttons);
            }

            prev.health = e->health;
            prev.alive = e->alive;
            prev.valid = true;
            players.raw(p.done());
        }

        json::array zombies;
        const bool zombie_frame = (frame_ % 2) == 0;
        size_t alive_zombies = 0;
        if (zombie_frame) {
            referee::ent_view buf[kMaxZombies];
            const size_t got = referee::zombie_ents(buf, kMaxZombies);

            // ------------------------------------------------------ kills --
            // There was no `kill` event at all; the viewer inferred kills from
            // `points` where `why` was kill/headshot, which cannot see a kill that
            // scored no points -- and on the real DLL cannot see anything, because
            // `player_int("score")` is unbound, so no `points` event has ever been
            // emitted by the game (only by the simulator).
            //
            // What we CAN see is entities. A zombie that was in the live list last
            // sample and is not in it now has died or been removed. That is a record
            // rather than an inference, with one honest limit stated here and in the
            // event: WE CANNOT ATTRIBUTE IT TO A PLAYER, so there is no `slot`. The
            // engine reuses entity numbers, so an id that vanishes and returns is two
            // different zombies; that is the same caveat the `snap` list already has.
            bool seen[kMaxZombies * 4] = {};
            for (size_t i = 0; i < got; ++i) {
                const int id = buf[i].entnum;
                if (id >= 0 && static_cast<size_t>(id) < sizeof(seen)) seen[id] = true;
                if (buf[i].alive) ++alive_zombies;
                json::writer z;
                z.integer("id", id);
                z.raw("pos", fmt_vec3_10th(buf[i].origin));
                z.integer("health", buf[i].health);
                zombies.raw(z.done());
            }
            for (size_t id = 0; id < sizeof(seen); ++id) {
                if (!was_live_[id] || seen[id]) continue;
                json::writer k;
                k.str("t", "kill").integer("ms", ms).integer("id", static_cast<long long>(id))
                 .integer("round", referee::current_round())
                 .str("how", "entity_gone");   // not attributed: see the comment above
                game_link::get().send(k);
                ++kills_;
                ++kills_this_round_;
            }
            std::memcpy(was_live_, seen, sizeof(seen));
        }

        if (players.count() == 0 && zombies.count() == 0) return;

        const int round = referee::current_round();
        if (round != last_round_) { kills_this_round_ = 0; last_round_ = round; }

        json::writer w;
        w.str("t", "snap").integer("ms", ms);
        // `round` was an event and never a snap field, so a replay that lost its first
        // chunk did not know what round it was in (replay.md section 3, gap 3). One
        // small integer, unchanged for thirty seconds at a time.
        if (round > 0) w.integer("round", round);
        if (zombie_frame) {
            // Two different numbers, named as what they are (gap 2).
            //   zombies_alive     MEASURED: live AI entities this sample. The engine
            //                     only ever has 24-31 out at once, so this is NOT
            //                     "how many are left in the round".
            //   zombies_remaining the round's true remainder, `level.zombie_total`.
            //                     Script variables are still unbound (t4_bind.cpp
            //                     level_int returns nullopt unconditionally), so this
            //                     field is OMITTED rather than faked, and appears on
            //                     its own the day the binding lands.
            w.integer("zombies_alive", static_cast<long long>(alive_zombies));
            w.integer("kills_round", static_cast<long long>(kills_this_round_));
            if (auto total = referee::level_int("zombie_total")) w.integer("zombies_remaining", *total);
        }
        if (players.count()) w.raw("players", players.done());
        if (zombies.count()) w.raw("zombies", zombies.done());
        std::string line = w.done();
        bytes_ += line.size() + 1;
        ++snaps_;
        game_link::get().send_line(std::move(line));
    }

    // Print each distinct usercmd button mask once. This is the evidence that turns
    // the stance bits above from [H] into [V] or corrects them, and it costs one
    // comparison a frame once the masks stop being new.
    void note_button_mask(int buttons) {
        for (int i = 0; i < masks_seen_; ++i) {
            if (masks_[i] == buttons) return;
        }
        if (masks_seen_ < static_cast<int>(sizeof(masks_) / sizeof(masks_[0]))) {
            masks_[masks_seen_++] = buttons;
            ENW_INFO("replay: usercmd buttons mask 0x%08X seen for the first time -> stance \"%s\" "
                     "(the crouch/prone bits are UNVERIFIED; crouch in a join run and check this "
                     "line moved)", static_cast<unsigned>(buttons),
                     stance_from_buttons(buttons) ? stance_from_buttons(buttons) : "(none)");
        }
    }

    struct player_prev {
        bool valid = false;
        int health = 0;
        bool alive = false;
        int score = 0;
        uint8_t weapon = 0;
        const char* stance = "";
    };

    player_prev players_[kMaxPlayers];
    bool was_live_[kMaxZombies * 4] = {};
    bool stopped_said_ = false;
    int last_round_ = -1;
    uint64_t kills_ = 0;
    uint64_t kills_this_round_ = 0;
    int masks_[16] = {};
    int masks_seen_ = 0;
    uint64_t frame_ = 0;
    uint64_t snaps_ = 0;
    uint64_t bytes_ = 0;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::replay)
