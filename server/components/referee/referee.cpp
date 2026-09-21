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

#include "../../../shared/core/frame.hpp"
#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "logprint_mirror.hpp"
#include "t4_bind.hpp"

#include <algorithm>
#include <cstdlib>
#include <map>
#include <set>
#include <string>

#include <windows.h>

namespace enw {
namespace {

using referee::notify_event;

// ---------------------------------------------------------- our command line --
//
// WHY THE COMMAND LINE AND NOT A DVAR. The host agent cannot open a replay until it
// is told `map_loaded`, and NOTHING HAS EVER SENT ONE -- `grep -rn map_loaded shared/
// server/ client-dll/` found zero hits before this. The consequence is worse than a
// missing field: `Game.openReplay()` is what CREATES the replay file, so every local
// game so far would have recorded to nowhere and produced no replay at all, with no
// error anywhere.
//
// The map name could come from the `sv_mapname` dvar, but `dvar_get()` is still
// unbound (t4_bind.cpp) and reading a dvar_s means trusting a struct layout nobody
// has verified. Our own command line needs no engine binding, and the launcher always
// puts `+map <bsp>` and `+set fs_game <x>` on it -- see launcher/src/main/launch.js.
// A hand-launched game with neither simply reports nothing, which is honest.
std::string cmdline_value(const char* flag, const char* word) {
    const char* cmd = ::GetCommandLineA();
    if (!cmd) return {};
    const std::string s(cmd);
    std::string needle = flag;
    needle += ' ';
    if (word && *word) { needle += word; needle += ' '; }
    const size_t p = s.find(needle);
    if (p == std::string::npos) return {};
    size_t i = p + needle.size();
    while (i < s.size() && s[i] == ' ') ++i;
    const bool quoted = i < s.size() && s[i] == '"';
    if (quoted) ++i;
    std::string out;
    for (; i < s.size(); ++i) {
        const char c = s[i];
        if (quoted ? c == '"' : (c == ' ' || c == '\t')) break;
        out.push_back(c);
    }
    return out;
}

std::string env_str(const char* name) {
    char buf[512]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    if (n == 0 || n >= sizeof(buf)) return {};
    return std::string(buf, n);
}

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

        // A SECOND ROUTE TO map_loaded, and it is not belt and braces -- it is the
        // difference between a run that leaves a replay and one that leaves nothing.
        //
        // MEASURED 2026-09-21 on `nazi_zombie_dt2`: the map loaded, the engine ran at
        // 62.5 fps for 90 seconds, and SV_Frame NEVER TICKED, because a GSC runtime
        // error ("entity already has linkTo enabled") killed the server script at load.
        // No SV_Frame meant no map_loaded, and no map_loaded meant the host agent never
        // opened a replay file, so a 90-second game produced a summary with a null map
        // and no recording at all.
        //
        // The engine's own tick keeps running through that, so it is what we fall back
        // on. Rule 12: subscribe to the core's frame source, never hook Com_Frame.
        enw::frame::subscribe("referee_mapload", [this](uint64_t) {
            if (map_announced_) return;
            if (++core_frames_ < 300) return;   // ~5 s at 60 fps: give SV_Frame its chance
            ENW_WARN("referee: the server frame has not ticked in %llu engine frames -- "
                     "announcing the map anyway so the run is still recorded. Something "
                     "is wrong with this map's scripts; check the console for a GSC error.",
                     static_cast<unsigned long long>(core_frames_));
            announce_map(game_link::now_ms());
        });

        // Degraded-mode transport, off unless asked for (coordinator approved
        // 2026-09-20). NDJSON over TCP stays the contract; this mirrors the event
        // subset as IW4MAdmin GSE lines so an ENW server is readable by a log
        // tailer when no socket is available. Never mirrors snap or input.
        // The dvar is the documented switch. It is also unreadable today -- dvar_get()
        // is unbound -- so the mirror could never be turned on at all, which made the
        // one channel that works without a socket useless. ENW_LOGPRINT=1 in the
        // environment does the same job, needs no engine binding, and is something the
        // launcher can set. Either turns it on.
        bool lp = false;
        if (auto v = referee::dvar_get("enw_logprint_events")) lp = (*v == "1" || *v == "on" || *v == "true");
        if (!lp) { const auto e = env_str("ENW_LOGPRINT"); lp = (e == "1" || e == "on" || e == "true"); }
        referee::set_logprint_enabled(lp);
        ENW_INFO("referee: armed (%s), logprint mirror %s",
                 referee::bound().describe().c_str(),
                 referee::logprint_enabled() ? "on" : "off");
    }

private:
    // ------------------------------------------------------------- notifies --
    void on_notify(const notify_event& ev) {
        // NAMELESS MODE. VM_Notify gives us a script-string *id*, and
        // SL_ConvertToString is not published yet, so ev.name is empty. Rather than
        // report nothing, report the ids: a level notify that fires exactly once
        // per round IS `between_round_over`, and the host can identify it from the
        // timing alone. Bounded so a per-frame notify cannot flood the link.
        if (ev.name.empty()) {
            if (ev.who != notify_event::owner::level) { ++suppressed_; return; }
            ++level_notify_count_;
            auto& n = id_counts_[ev.name_id];
            ++n;
            if (level_notify_emitted_ >= kIdBudget) { ++suppressed_; return; }
            ++level_notify_emitted_;
            json::writer w;
            w.str("t", "notify")
                .integer("ms", ev.game_ms)
                .str("ent", "level")
                .integer("name_id", ev.name_id)
                .integer("nth", static_cast<long long>(n));
            game_link::get().send(w);
            return;
        }

        // `trigger` is the engine's own notify on every trigger_use/trigger_multiple,
        // so it is both the most useful (doors, perks, the ali buyable ending) and
        // by far the most frequent. Handle it separately: only the ones with a
        // purchase-shaped entity go on the wire, with the fields that identify them.
        if (ev.name == "trigger") {
            on_trigger(ev);
            return;
        }

        // ---------------------------------------------------------- ROUNDS --
        //
        // THIS IS HOW A ROUND IS COUNTED, and it is worth saying exactly why, because
        // the obvious answer does not work and the documented answer is wrong.
        //
        //   * `level.round_number` is the real number, and we CANNOT READ IT: script
        //     variable access is unbound (t4_bind.cpp -- level_int() returns nullopt
        //     unconditionally), so the frame poll below has never once fired.
        //   * `new_zombie_round` DOES NOT EXIST in stock World at War. It is a
        //     Plutonium T4SP addition. Waiting on it means waiting forever.
        //   * `between_round_over` IS the round boundary. From the game's own scripts
        //     (`maps/_zombiemode.gsc :: round_think()`, prototype :1224-1226):
        //         level.round_number++;
        //         level notify( "between_round_over" );
        //     and the same two lines are in asylum, factory and ali.
        //
        // Cross-checked against two independently-written MIT projects that solve this
        // exact problem on this exact engine (checked 2026-09-21):
        //   * Xeptix/ZPauseT4 `zpause.gsc:1486` -- `level waittill("between_round_over")`,
        //     and it never reads level.round_number at all.
        //   * RaidMax/IW4M-Admin `GameFiles/ZombieStats/_zm_stats_t4.gsc:371` --
        //     `waittill_any_return("intermission", "between_round_over")`.
        //
        // The notify carries no number, so we count. round 1 is live before the first
        // notify, and the notify fires AFTER the increment, so round = count + 1 --
        // the same value `level.round_number` holds at that instant.
        //
        // THE ONE WEAKNESS, stated plainly: counting cannot recover an absolute round
        // if the DLL attaches late or a mod sets level.round_number itself. Both MIT
        // implementations read the variable instead, for exactly that reason. When
        // script vars are bound, level_int() below takes over and this becomes the
        // fallback; until then it is this or nothing, and nothing is what we had.
        if (ev.name == "between_round_over") {
            // Two script instances (server and client) share one notify hook. A round
            // boundary is many seconds wide, so anything arriving within half a second
            // of the last one is the same event seen twice.
            if (ev.game_ms >= last_round_ms_ && ev.game_ms - last_round_ms_ < 500 && round_notifies_ > 0) {
                ++suppressed_;
                return;
            }
            last_round_ms_ = ev.game_ms;
            ++round_notifies_;
            emit_round(static_cast<int>(round_notifies_) + 1, ev.game_ms, "between_round_over");
        }

        // ------------------------------------------------------- GAME OVER --
        //
        // `end_game()` sets `level.intermission = true` as its first statement on every
        // map, which would be the portable signal if we could read script variables.
        // We cannot. What we CAN see is the notifies on the way out, and there are two:
        //
        //   `end_game`          only on Der Riese and maps derived from it
        //   `stop_intermission` on EVERY map -- `_zombiemode.gsc:1740`, after the
        //                       GAME OVER card and the intermission wait, and before
        //                       ExitLevel()/MissionFailed(). It is the last thing the
        //                       scripts do that we can see.
        //
        // `stop_intermission` lands roughly `zombie_intermission_time` after the player
        // actually died. That is late, and it is also certain, which matters more: the
        // alternative is guessing from a down that might still be revived.
        if (ev.name == "stop_intermission") emit_game_over("stop_intermission notify");

        // Round 1 is live before any `between_round_over` has fired, so without this
        // a player who dies on round 1 produces a game whose round is never reported
        // at all. `all_players_connected` is the flag `_zombiemode` waits on before it
        // starts round_think(), which is exactly "round 1 has begun".
        if (ev.name == "all_players_connected") emit_round(1, ev.game_ms, "all_players_connected");

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
        } else if (frames_ % 1200 == 0) {
            log_id_histogram();
        }
        if (frames_ % 2000 == 0) {
            const uint32_t span = ms - first_frame_ms_;
            ENW_INFO("referee: %llu frames in %u ms (%.1f fps)",
                     static_cast<unsigned long long>(frames_), span,
                     span ? (frames_ * 1000.0) / span : 0.0);
        }
        if (frames_ == 1) first_frame_ms_ = ms;

        // The server is running a map: that IS map_loaded. SV_Frame does not tick
        // before a server exists, so the first tick is the earliest honest moment,
        // and it is the message that makes the host agent open the replay file.
        if (!map_announced_) announce_map(ms);

        // When script variables become readable this takes over from the notify
        // counter: an absolute value beats a derived one, and it survives a late
        // attach. It has never fired -- level_int() returns nullopt unconditionally
        // today -- so the notify path above is what actually reports rounds.
        if (auto r = referee::level_int("round_number")) {
            if (*r != round_) emit_round(*r, ms, "level.round_number");
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

    void log_id_histogram() {
        // The identification aid for `re` and the host: which level-notify ids fired,
        // and how often. An id with a count equal to the round count is
        // between_round_over; an id that fired once near the end is end_game.
        ENW_INFO("referee: chat captured so far: %llu (MUST be 0 in an idle game - that is the "
                 "sanity check that caught the bad G_Say hook)",
                 static_cast<unsigned long long>(referee::chat_capture_count()));
        ENW_INFO("referee: %llu level notifies over %zu distinct ids (%llu emitted, %llu suppressed)",
                 static_cast<unsigned long long>(level_notify_count_), id_counts_.size(),
                 static_cast<unsigned long long>(level_notify_emitted_),
                 static_cast<unsigned long long>(suppressed_));
        int shown = 0;
        for (const auto& [id, n] : id_counts_) {
            if (++shown > 40) break;
            ENW_INFO("referee:   level notify id %d fired %llu times", id,
                     static_cast<unsigned long long>(n));
        }
    }

    // --------------------------------------------------------- map_loaded --
    void announce_map(uint32_t ms) {
        map_announced_ = true;
        // `+map <bsp>` is how the launcher starts a local game; ENW_MAP is the belt
        // and braces it sets alongside, for the day somebody starts the game a
        // different way. Neither present = a hand-launched game, and we say so rather
        // than inventing a map name that would end up inside a signed replay header.
        std::string map = cmdline_value("+map", nullptr);
        if (map.empty()) map = cmdline_value("+devmap", nullptr);
        if (map.empty()) map = env_str("ENW_MAP");
        std::string fs_game = cmdline_value("+set", "fs_game");

        json::writer w;
        w.str("t", "map_loaded").integer("ms", ms);
        w.str("map", map.empty() ? "unknown" : map);
        if (!fs_game.empty()) w.str("fs_game", fs_game);
        w.str("mode", "zombies");
        w.integer("sv_maxclients", referee::max_clients());
        game_link::get().send(w);
        ENW_INFO("referee: map_loaded map=%s fs_game=%s (from our own command line)",
                 map.empty() ? "unknown" : map.c_str(), fs_game.empty() ? "-" : fs_game.c_str());
    }

    // --------------------------------------------------------------- round --
    void emit_round(int n, uint32_t ms, const char* how) {
        if (n <= round_) return;   // never go backwards; the host treats round as a high-water mark
        round_ = n;
        json::writer w;
        w.str("t", "round").integer("ms", ms).integer("n", round_);
        game_link::get().send(w);
        // The IW4MAdmin-shaped mirror in the game's own log. Off unless
        // enw_logprint_events is set, and free when it is off -- but when it IS on it
        // is a human-readable trace of exactly this decision, in a file B can open.
        referee::lp_round_complete(round_);
        ENW_INFO("referee: ROUND %d (%s)", round_, how);
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
    std::map<int, uint64_t> id_counts_;
    uint64_t level_notify_count_ = 0;
    uint64_t level_notify_emitted_ = 0;
    static constexpr uint64_t kIdBudget = 3000;
    int novel_forwarded_ = 0;
    uint64_t suppressed_ = 0;
    int round_ = 0;
    uint64_t round_notifies_ = 0;
    uint32_t last_round_ms_ = 0;
    bool map_announced_ = false;
    bool game_over_ = false;
    uint32_t game_ms_ = 0;
    uint64_t frames_ = 0;
    uint64_t core_frames_ = 0;
    uint32_t first_frame_ms_ = 0;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::referee_component)
