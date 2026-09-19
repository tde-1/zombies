// The in-process referee: rounds, game over, flags, downs, revives, points.
//
// The whole design rests on one fact from the extracted scripts
// (docs/kickstart/referee.md §2.8):
//
//     common_scripts/utility.gsc:435
//     flag_set( message ) { level.flag[message] = true; level notify( message ); ... }
//
// Every flag in every CoD script -- Treyarch's and every modder's -- announces
// itself as a level notify named after the flag. So one hook on the script
// notify path sees every easter-egg step, zone unlock and power switch on every
// map with no per-map code. The per-map manifests in referee/manifests/ only say
// which of those names *mean* something; the host agent evaluates them.
//
// This component deliberately does NOT decide badges. It reports facts. The
// referee state machine lives host-side so it survives a game crash and can be
// re-run over a stored replay.
#include "../../../shared/core/component.hpp"

#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "logprint_mirror.hpp"
#include "t4_bind.hpp"

#include <algorithm>
#include <set>
#include <string>

namespace enw {
namespace {

using referee::notify_event;

// Notifies we always forward. Everything else is subject to the novelty budget.
// Sources: docs/kickstart/referee.md §2.
const char* const kAlways[] = {
    "between_round_over",        // round advanced (AFTER level.round_number++)
    "end_game",                  // Der Riese only; other maps use level.intermission
    "intermission",
    "stop_intermission",
    "player_revived",            // _laststand.gsc revive_success
    "player_downed",             // only fires with a collectible, but free to watch
    "zombified",                 // bled out -> spectator/zombie
    "spawned_player",
    "spawned_spectator",
    "user_grabbed_weapon",       // magic box taken
    "weapon_grabbed",
    "trigger",                   // every trigger_use: doors, debris, perks, buyable endings
    "master_switch_activated",
    "nuke_triggered",
    "perk_used",
    "all_players_connected",
};

// Names that look like map state worth reporting even though we have never seen
// them before: this is how an unknown custom map's easter egg surfaces without
// anyone reading its scripts.
bool looks_interesting(const std::string& n) {
    static const char* const kPrefixes[] = {"ee_", "easter", "quest", "power", "electric",
                                            "switch", "unlock", "opened", "buy", "end",
                                            "escape", "win", "step", "part", "piece"};
    static const char* const kSuffixes[] = {"_on", "_open", "_opened", "_done", "_complete",
                                            "_activated", "_unlocked", "_used", "_bought"};
    for (const char* p : kPrefixes) {
        if (n.rfind(p, 0) == 0) return true;
    }
    for (const char* s : kSuffixes) {
        const size_t l = std::strlen(s);
        if (n.size() > l && n.compare(n.size() - l, l, s) == 0) return true;
    }
    return false;
}

class referee_component final : public component {
public:
    const char* name() const override { return "referee"; }

    void post_load() override {
        auto& link = game_link::get();
        link.on("snapshot_state",
                [this](const json::value& msg) { reply_snapshot(msg.str_or("id")); },
                /*want_game_thread=*/true);
        link.on("end",
                [this](const json::value& msg) { do_end(msg.str_or("id"), msg.str_or("reason")); },
                /*want_game_thread=*/true);
    }

    void post_unpack() override {
        referee::bind();
        referee::on_notify([this](const notify_event& ev) { on_notify(ev); });
        referee::on_frame([this](uint32_t ms) { on_frame(ms); });

        // Degraded-mode transport, off unless asked for (coordinator approved
        // 2026-09-20). NDJSON over TCP stays the contract; this mirrors the event
        // subset as IW4MAdmin GSE lines so an ENW server is readable by a log
        // tailer when no socket is available. Never mirrors snap or input.
        if (auto v = referee::dvar_get("enw_logprint_events")) {
            referee::set_logprint_enabled(*v == "1" || *v == "on" || *v == "true");
        }
        ENW_INFO("referee: armed (%s), logprint mirror %s",
                 referee::bound().describe().c_str(),
                 referee::logprint_enabled() ? "on" : "off");
    }

private:
    // ------------------------------------------------------------- notifies --
    void on_notify(const notify_event& ev) {
        // `trigger` is the engine's own notify on every trigger_use/trigger_multiple,
        // so it is both the most useful (doors, perks, the ali buyable ending) and
        // by far the most frequent. Handle it separately: only the ones with a
        // purchase-shaped entity go on the wire, with the fields that identify them.
        if (ev.name == "trigger") {
            on_trigger(ev);
            return;
        }

        const bool always = std::any_of(std::begin(kAlways), std::end(kAlways),
                                        [&](const char* a) { return ev.name == a; });
        bool forward = always;
        if (!forward && seen_.find(ev.name) == seen_.end()) {
            // A name we have not seen. Forward it once if it looks like map state,
            // and keep a lid on the total so a per-frame animation notify on some
            // custom map cannot flood the link.
            if (looks_interesting(ev.name) && novel_forwarded_ < kNovelBudget) {
                forward = true;
                ++novel_forwarded_;
            }
        }
        seen_.insert(ev.name);
        if (!forward) {
            ++suppressed_;
            return;
        }

        json::writer w;
        w.str("t", "notify");
        w.integer("ms", ev.game_ms);
        switch (ev.who) {
            case notify_event::owner::level: w.str("ent", "level"); break;
            case notify_event::owner::player:
                w.str("ent", "player:" + std::to_string(ev.slot));
                break;
            case notify_event::owner::entity:
                w.str("ent", "ent:" + std::to_string(ev.entnum));
                break;
            default: w.str("ent", "unknown"); break;
        }
        w.str("name", ev.name);

        game_link::get().send(w);

        // A level notify that is not one of the generic names is, by construction
        // (referee.md 2.8), a flag_set() -- i.e. a step of whatever this map calls
        // progress. Mirror those as EE steps; the host's manifest decides which
        // ones actually mean something.
        if (!always && ev.who == notify_event::owner::level) {
            referee::lp_easter_egg_step(ev.name);
        }

        if (ev.name == "end_game") emit_game_over("end_game notify");
    }

    // A trigger fired. Report it only if its script fields say it is a purchase,
    // a perk machine or a mapper-declared flag; skip the ambient trigger_multiples.
    void on_trigger(const notify_event& ev) {
        if (ev.entnum < 0) return;
        auto tn = referee::ent_string_field(ev.entnum, "targetname");
        auto cost = referee::ent_int_field(ev.entnum, "zombie_cost");
        auto flag = referee::ent_string_field(ev.entnum, "script_flag");
        if (!cost && !flag && (!tn || !interesting_targetname(*tn))) {
            ++suppressed_;
            return;
        }
        json::writer w;
        w.str("t", "notify")
            .integer("ms", ev.game_ms)
            .str("ent", "ent:" + std::to_string(ev.entnum))
            .str("name", "trigger");
        if (tn) w.str("targetname", *tn);
        if (cost) w.integer("zombie_cost", *cost);
        if (flag) w.str("script_flag", *flag);
        if (auto nw = referee::ent_string_field(ev.entnum, "script_noteworthy")) {
            w.str("script_noteworthy", *nw);
        }
        if (ev.slot >= 0) w.integer("slot", ev.slot);
        game_link::get().send(w);
    }

    static bool interesting_targetname(const std::string& tn) {
        static const char* const kNames[] = {"zombie_door",   "zombie_debris",  "zombie_perks",
                                             "weapon_upgrade", "treasure_chest_use", "buy_powerup",
                                             "use_master_switch", "power_switch"};
        for (const char* n : kNames) {
            if (tn == n) return true;
        }
        return false;
    }

    // ---------------------------------------------------------- frame poll --
    // Two script reads per server frame (20/s). Everything else is derived.
    void on_frame(uint32_t ms) {
        game_ms_ = ms;

        // Proof of life for the frame hook, and a cheap frame-rate reading, until
        // there is real state to report. First tick, then every ~30 s of frames.
        ++frames_;
        if (frames_ == 1) {
            ENW_INFO("referee: first frame tick (%s)", referee::bound().describe().c_str());
        } else if (frames_ % 2000 == 0) {
            const uint32_t span = ms - first_frame_ms_;
            ENW_INFO("referee: %llu frames in %u ms (%.1f fps)",
                     static_cast<unsigned long long>(frames_), span,
                     span ? (frames_ * 1000.0) / span : 0.0);
        }
        if (frames_ == 1) first_frame_ms_ = ms;

        if (auto r = referee::level_int("round_number")) {
            if (*r != round_) {
                round_ = *r;
                json::writer w;
                w.str("t", "round").integer("ms", ms).integer("n", round_);
                game_link::get().send(w);
                referee::lp_round_complete(round_);
            }
        }

        if (!game_over_) {
            if (auto i = referee::level_bool("intermission"); i && *i) {
                emit_game_over("level.intermission");
            }
        }

        poll_players(ms);
    }

    void poll_players(uint32_t ms) {
        const int n = referee::max_clients();
        for (int slot = 0; slot < n && slot < kMaxPlayers; ++slot) {
            auto& p = players_[slot];

            // Points: no script notify exists, so this is the only way. Sampling
            // at server-frame rate is exact enough to attribute a purchase.
            if (auto s = referee::player_int(slot, "score")) {
                if (!p.have_score || *s != p.score) {
                    json::writer w;
                    w.str("t", "points").integer("ms", ms).integer("slot", slot).integer("score", *s);
                    if (p.have_score) w.integer("delta", *s - p.score);
                    game_link::get().send(w);
                    p.score = *s;
                    p.have_score = true;
                }
            }

            // Down: _laststand.gsc bumps self.downs and defines self.revivetrigger.
            if (auto d = referee::player_int(slot, "downs")) {
                if (p.have_downs && *d > p.downs) {
                    json::writer w;
                    w.str("t", "down").integer("ms", ms).integer("slot", slot);
                    game_link::get().send(w);
                }
                p.downs = *d;
                p.have_downs = true;
            }
            // Revive is a notify (player_revived); the host pairs it with the down.
        }
    }

    void emit_game_over(const char* reason) {
        if (game_over_) return;
        game_over_ = true;
        json::writer w;
        w.str("t", "game_over").integer("ms", game_ms_).integer("round", round_).str("reason", reason);
        game_link::get().send(w);
        referee::lp_player_event(-1, "match_end", std::to_string(round_));
        ENW_INFO("referee: game over at round %d (%s); %zu distinct notifies seen, %llu suppressed",
                 round_, reason, seen_.size(), static_cast<unsigned long long>(suppressed_));
    }

    // ----------------------------------------------------------- host cmds --
    void reply_snapshot(const std::string& id) {
        if (id.empty()) return;
        if (!referee::bound().script_vars) {
            game_link::get().send_reply(id, false, "script vars not bound yet");
            return;
        }
        // Per-player restorable state. Weapons and perks need the co-loaded GSC
        // (docs/kickstart/referee.md §3.3); positions and score do not.
        json::array players;
        const int n = referee::max_clients();
        for (int slot = 0; slot < n; ++slot) {
            auto c = referee::client(slot);
            if (!c || !c->active) continue;
            json::writer pw;
            pw.integer("slot", slot).str("name", c->name);
            if (auto s = referee::player_int(slot, "score")) pw.integer("score", *s);
            if (auto s = referee::player_int(slot, "score_total")) pw.integer("score_total", *s);
            if (auto d = referee::player_int(slot, "downs")) pw.integer("downs", *d);
            if (auto r = referee::player_int(slot, "revives")) pw.integer("revives", *r);
            if (auto e = referee::player_ent(slot)) {
                pw.raw("pos", vec3(e->origin));
                pw.raw("ang", vec3(e->angles));
                pw.integer("health", e->health);
                pw.boolean("alive", e->alive);
            }
            players.raw(pw.done());
        }
        json::writer v;
        v.integer("round", round_).raw("players", players.done());
        game_link::get().send_reply(id, true, {}, v.done());
    }

    void do_end(const std::string& id, const std::string& reason) {
        // A clean end: the scripts' own path is end_game(), and Der Riese reaches
        // it through level notify("end_game"). We cannot fire a script notify from
        // C++ yet, so for now this is honest about what it can do.
        const bool ok = referee::console_command("map_restart");
        if (!id.empty()) {
            game_link::get().send_reply(id, ok, ok ? "" : "no command buffer bound");
        }
        ENW_INFO("referee: host asked to end the game (%s) -> %s", reason.c_str(),
                 ok ? "map_restart" : "unavailable");
    }

    static std::string vec3(const float v[3]) {
        char buf[96];
        std::snprintf(buf, sizeof(buf), "[%.2f,%.2f,%.2f]", v[0], v[1], v[2]);
        return buf;
    }

    static constexpr int kMaxPlayers = 4;   // serverStatic_s.clients[4]
    static constexpr int kNovelBudget = 64; // per game, forwarded unknown names

    struct player_state {
        int score = 0;
        bool have_score = false;
        int downs = 0;
        bool have_downs = false;
    };

    player_state players_[kMaxPlayers];
    std::set<std::string> seen_;
    int novel_forwarded_ = 0;
    uint64_t suppressed_ = 0;
    int round_ = -1;
    bool game_over_ = false;
    uint32_t game_ms_ = 0;
    uint64_t frames_ = 0;
    uint32_t first_frame_ms_ = 0;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::referee_component)
