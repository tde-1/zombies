// Replay sampling: players AND zombies at 20 Hz, straight onto the game link, plus the
// replay-events-v1 gameplay events (weapon, fire, hit, damage, pap, powerup).
//
// The server runs at sv_fps 20 (confirmed in dedi's dvar dump), so "20 Hz" is
// exactly one sample per server frame. No extra thread, no interpolation, no timer drift.
//
// 2026-09-23 (lane R1, B's ask "the replay rate looks too low"): zombies and grenades were
// every OTHER frame (10 Hz); they are every frame now. Measured on the box's real games
// before the change: players 20.0 Hz, zombies ~8 Hz average (10 Hz while any are up),
// 1.43 MB per game-hour pooled over 18 games (0.68-2.17 each). After: ~2.3 projected,
// replay-events-v1.md section 4.
//
// The wire shape is `snap` from docs/protocol/game-link-v0.md; the new events are
// docs/protocol/replay-events-v1.md. The event logic is pure and unit-tested
// (replay_events_model.hpp, server/tests/replay_events_test.cpp); this file only reads.
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
#include "replay_events_model.hpp"

#include <cstdio>
#include <cstring>

#include <windows.h>

namespace enw {
namespace {

// THE CONTROL ARM. `ENW_NO_SAMPLERS=1` takes the replay sampler and the referee's
// per-frame state read out of a run without a second build, so "is the map dying
// because of something WE do every frame?" is one environment variable and a
// re-run rather than a bisect over the component list. Added 2026-09-22 for the
// custom-map bisect (dedi.md 14); it is a measurement knob, never a shipping one.
bool samplers_disabled() {
    char buf[8]{};
    return ::GetEnvironmentVariableA("ENW_NO_SAMPLERS", buf, sizeof(buf)) && buf[0] == '1';
}

constexpr int kMaxPlayers = 4;
constexpr size_t kMaxZombies = 64;
constexpr size_t kMaxNades = 16;
constexpr size_t kMaxPowerups = 16;
constexpr int kNadeIds = 1024;   // level.zombie_vars max_ai is 24 stock; headroom for customs
constexpr size_t kEntIds = 1024; // MAX_GENTITIES

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
//
// 2026-09-22 (late), replay.md 8.11: THE OLD VALUES WERE WRONG. 0x4 and 0x8 are IW3's
// BUTTON_MELEE and BUTTON_USE (KisakCOD src/qcommon/msg.h, the CoD4 reimplementation T4
// descends from), and B's own game shows it: on m_0afb449b "prone" (0x8) was held for the
// nine seconds he spent rebuilding boards and on the frame he bought the carbine, and
// "crouch" (0x4) was one frame beside a knife kill. The stance bits are 0x200 (crouch, set
// every frame from the current stance by CL_AddCurrentStanceToCmd) and 0x100 (prone, held),
// and 0x100 is held on that file for the whole last stand, which is prone. Still [H] until a
// join run crouches on purpose, but now [H] with evidence rather than against it.
constexpr int kButtonCrouch = 0x00000200;
constexpr int kButtonProne  = 0x00000100;

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
        if (samplers_disabled()) {
            ENW_INFO("replay: sampler NOT armed -- ENW_NO_SAMPLERS=1. This run records nothing; "
                     "it exists to answer whether the sampler is what a map is dying on.");
            return;
        }
        referee::bind();
        referee::on_frame([this](uint32_t ms) { on_frame(ms); });
        ENW_INFO("replay: sampler armed (players 20 Hz, zombies 20 Hz, replay-events v%d: %s)",
                 replay_ev::kVersion, referee::combat_bound().describe().c_str());
    }

    void pre_destroy() override {
        ENW_INFO("replay: %llu snaps, %llu bytes of snap JSON, %llu kill events",
                 static_cast<unsigned long long>(snaps_),
                 static_cast<unsigned long long>(bytes_),
                 static_cast<unsigned long long>(kills_));
        log_event_counts();
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
        if (stopped_said_ || !started_) {
            // A new match (or the first): the event tracker and the per-match name caches
            // start again, so nothing from the last game is carried into this replay.
            if (started_) log_event_counts();
            events_.reset();
            referee::combat_new_match();
            for (auto& pp : players_) pp = player_prev{};
            started_ = true;
        }
        stopped_said_ = false;
        replay_ev::frame_in fin;
        fin.ms = ms;

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

            replay_ev::player_in& pin = fin.players[slot];
            pin.present = true;
            pin.alive = e->alive;
            pin.health = e->health;
            std::memcpy(pin.pos, e->origin, sizeof pin.pos);
            if (const auto combat = referee::player_combat_state(slot)) {
                pin.weapon = combat->weapon;
                pin.weapon_raw = combat->weapon_raw;
                pin.have_ammo = combat->have_ammo;
                pin.clip = combat->clip;
                pin.ammo = combat->ammo;
                pin.have_events = combat->have_events;
                pin.event_seq = combat->event_seq;
                std::memcpy(pin.events, combat->events, sizeof pin.events);
                pin.last_attacker = combat->last_attacker;
                // The gun and its ammo on every snap (replay-events-v1 section 3), delta-coded
                // like everything else. `weapon` is the engine's own name now; the usercmd
                // index below stays the fallback ("#37") when the weapon table is not bound.
                if (!combat->weapon_raw.empty()) {
                    if (!prev.valid || combat->weapon_raw != prev.weapon_raw) p.str("weapon", combat->weapon_raw);
                    prev.weapon_raw = combat->weapon_raw;
                }
                if (combat->have_ammo) {
                    if (!prev.valid || !prev.have_ammo || combat->clip != prev.clip) p.integer("clip", combat->clip);
                    if (!prev.valid || !prev.have_ammo || combat->ammo != prev.ammo) p.integer("ammo", combat->ammo);
                    prev.clip = combat->clip;
                    prev.ammo = combat->ammo;
                    prev.have_ammo = true;
                }
            }

            // The game's own scoreboard counters (referee.md 16), each omitted when
            // unchanged like everything else here. `kills` is what lets the viewer's Tab
            // scoreboard credit kills per player with company; the `kill` events below
            // are entity deaths and name nobody.
            if (auto st = referee::player_stats(slot)) {
                pin.have_stats = true;
                pin.kills = st->kills;
                pin.headshots = st->headshots;
                if (!prev.valid || !prev.have_stats || st->score != prev.score) p.integer("score", st->score);
                if (!prev.valid || !prev.have_stats || st->kills != prev.kills) p.integer("kills", st->kills);
                if (!prev.valid || !prev.have_stats || st->downs != prev.downs) p.integer("downs", st->downs);
                if (!prev.valid || !prev.have_stats || st->revives != prev.revives) p.integer("revives", st->revives);
                if (!prev.valid || !prev.have_stats || st->headshots != prev.headshots) p.integer("headshots", st->headshots);
                prev.score = st->score;
                prev.kills = st->kills;
                prev.downs = st->downs;
                prev.revives = st->revives;
                prev.headshots = st->headshots;
                prev.have_stats = true;
            }
            if (auto cmd = referee::last_usercmd(slot)) {
                // VIEW PITCH (replay.md 8.11). `ang` above is the player ENTITY's angles, and
                // the engine keeps an entity's pitch at 0 for a player: every in-game `ang[0]`
                // on m_0afb449b is 0, so first person never looked up or down. The usercmd
                // carries the view as the client sent it, BEFORE ps.delta_angles (which is
                // not bound). So this is the raw usercmd angle pair; the host calibrates
                // delta from the entity yaw it already has (routes/replay.js). One pair of
                // one-decimal floats, omitted when unchanged.
                const float cp = static_cast<float>(static_cast<uint16_t>(cmd->view_pitch)) * (360.0f / 65536.0f);
                const float cy = static_cast<float>(static_cast<uint16_t>(cmd->view_yaw)) * (360.0f / 65536.0f);
                if (!prev.valid || cmd->view_pitch != prev.cmd_pitch || cmd->view_yaw != prev.cmd_yaw) {
                    char ca[48];
                    std::snprintf(ca, sizeof(ca), "[%.1f,%.1f]", cp, cy);
                    p.raw("cmd_ang", ca);
                }
                prev.cmd_pitch = cmd->view_pitch;
                prev.cmd_yaw = cmd->view_yaw;
                if (prev.weapon_raw.empty() && (!prev.valid || cmd->weapon != prev.weapon)) {
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
        json::array nades;
        // Every frame since lane R1 (was `(frame_ % 2) == 0`, 10 Hz). The name is kept so
        // the blocks below read as they did.
        const bool zombie_frame = true;
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
            // Sized to MAX_GENTITIES (1024), not kMaxZombies*4 = 256 as it was: on
            // m_0afb449b the zombies were entnums 254-273, so every zombie from 256 up was
            // never marked live, never "left the list", and never produced a `kill` --
            // round 1 there had 4 zombies die and kills_round said 1 (replay.md 8.11).
            bool seen[kEntIds] = {};
            for (size_t i = 0; i < got; ++i) {
                const int id = buf[i].entnum;
                if (id >= 0 && static_cast<size_t>(id) < sizeof(seen)) seen[id] = true;
                if (buf[i].alive) ++alive_zombies;
                {
                    const auto dmg = referee::ent_damage(id);
                    replay_ev::zombie_in zi;
                    zi.id = id;
                    zi.health = buf[i].health;
                    zi.last_attacker = dmg.last_attacker;
                    zi.hit = replay_ev::part_from_hitloc(dmg.hitloc);
                    fin.zombies.push_back(zi);
                }
                json::writer z;
                z.integer("id", id);
                z.raw("pos", fmt_vec3_10th(buf[i].origin));
                // Facing, so the viewer can turn a zombie (replay.md 8.4). One decimal.
                char yaw[16];
                std::snprintf(yaw, sizeof(yaw), "%.1f", buf[i].angles[1]);
                z.raw("yaw", yaw);
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

            // What can still be read about the zombies that just left the live list: the
            // last attacker G_Damage recorded and the actor's lethal hit location (Actor_Die
            // writes it). The tracker falls back on the native kills/headshots counters when
            // the actor is already gone.
            for (int id : events_.live_ids()) {
                if (id >= 0 && static_cast<size_t>(id) < sizeof(seen) && seen[id]) continue;
                const auto dmg = referee::ent_damage(id);
                replay_ev::zombie_in zi;
                zi.id = id;
                zi.health = dmg.health;
                zi.last_attacker = dmg.last_attacker;
                zi.hit = replay_ev::part_from_hitloc(dmg.hitloc);
                fin.gone.push_back(zi);
            }

            // ---------------------------------------------------- grenades --
            // replay.md 8.6. `grenade` is CoD's G_FireGrenade classname through CoD4;
            // on T4 it is UNVERIFIED, which is what the census below is for: the first
            // game with a throw in it logs the real name. A nade that leaves the list
            // has exploded (or been picked up / deleted -- the event says "gone", the
            // viewer draws it as a blast either way).
            referee::ent_view nb[kMaxNades];
            const size_t ng = referee::classname_ents("grenade", nb, kMaxNades);
            bool nseen[kNadeIds] = {};
            for (size_t i = 0; i < ng; ++i) {
                const int id = nb[i].entnum;
                if (id < 0 || id >= kNadeIds) continue;
                nseen[id] = true;
                std::memcpy(nade_pos_[id], nb[i].origin, sizeof(nade_pos_[id]));
                json::writer g;
                g.integer("id", id);
                g.raw("pos", fmt_vec3_10th(nb[i].origin));
                nades.raw(g.done());
            }
            for (int id = 0; id < kNadeIds; ++id) {
                if (!nade_live_[id] || nseen[id]) continue;
                json::writer x;
                x.str("t", "explode").integer("ms", ms).integer("id", id)
                 .raw("pos", fmt_vec3_10th(nade_pos_[id]));
                game_link::get().send(x);
            }
            std::memcpy(nade_live_, nseen, sizeof(nseen));

            // The census walks all 1024 entities with a readability check each, so once a
            // second is plenty for "log a classname the first time it exists".
            if (frame_ % 20 == 0) {
                referee::classname_census([](const char* cls, int entnum) {
                    ENW_INFO("replay: classname census: first \"%s\" (ent %d)", cls, entnum);
                });
            }
        }

        // ------------------------------------------------------------ power-ups --
        if (referee::combat_bound().models) {
            referee::model_ent_view mv[kMaxPowerups];
            const size_t nm = referee::model_ents(
                [](const char* m) { return replay_ev::powerup_kind(m) != nullptr; }, mv, kMaxPowerups);
            fin.powerups_valid = true;
            for (size_t i = 0; i < nm; ++i) {
                replay_ev::powerup_in pu;
                pu.id = mv[i].entnum;
                pu.kind = replay_ev::powerup_kind(mv[i].model);
                std::memcpy(pu.pos, mv[i].origin, sizeof pu.pos);
                fin.powerups.push_back(std::move(pu));
            }
        }

        // ------------------------------------------------------- gameplay events --
        ev_lines_.clear();
        events_.step(fin, ev_lines_);
        for (auto& l : ev_lines_) game_link::get().send_line(std::move(l));

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
        if (nades.count()) w.raw("nades", nades.done());
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

    void log_event_counts() {
        const auto& c = events_.stats();
        ENW_INFO("replay: events weapon %llu fire %llu (capped %llu) hit %llu (kills %llu, "
                 "unattributed deaths %llu) damage %llu pap %llu powerup %llu",
                 static_cast<unsigned long long>(c.weapon), static_cast<unsigned long long>(c.fire),
                 static_cast<unsigned long long>(c.fire_capped), static_cast<unsigned long long>(c.hit),
                 static_cast<unsigned long long>(c.kill_hit),
                 static_cast<unsigned long long>(c.kill_unattributed),
                 static_cast<unsigned long long>(c.damage), static_cast<unsigned long long>(c.pap),
                 static_cast<unsigned long long>(c.powerup));
    }

    struct player_prev {
        bool valid = false;
        std::string weapon_raw;
        bool have_ammo = false;
        int clip = 0;
        int ammo = 0;
        int health = 0;
        bool alive = false;
        int score = 0;
        bool have_stats = false;
        int kills = 0;
        int downs = 0;
        int revives = 0;
        int headshots = 0;
        uint8_t weapon = 0;
        const char* stance = "";
        int16_t cmd_pitch = 0;
        int16_t cmd_yaw = 0;
    };

    player_prev players_[kMaxPlayers];
    replay_ev::tracker events_;
    std::vector<std::string> ev_lines_;
    bool started_ = false;
    bool was_live_[kEntIds] = {};
    bool nade_live_[kNadeIds] = {};
    float nade_pos_[kNadeIds][3] = {};
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
