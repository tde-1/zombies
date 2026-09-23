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
#include "../../../shared/core/json.hpp"
#include "../../../shared/core/logger.hpp"
#include "logprint_mirror.hpp"
#include "name_lock.hpp"
#include "t4_bind.hpp"
#include "verified_env.hpp"

#include <algorithm>
#include <cstdlib>
#include <map>
#include <set>
#include <string>

#include <windows.h>

namespace enw {

// `name_lock.hpp` lives in enw::referee::namelock alongside the other referee bindings;
// this is the short spelling used below, to match `referee::client()` and friends.
namespace namelock = ::enw::referee::namelock;

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

// The engine's userinfo string is a run of backslash-delimited key/value pairs.
// Returns the value for `key`, or empty when it is not there.
std::string userinfo_value(const std::string& userinfo, const char* key) {
    if (userinfo.empty()) return {};
    const std::string k = std::string("\\") + key + "\\";
    const size_t p = userinfo.find(k);
    if (p == std::string::npos) return {};
    const size_t b = p + k.size();
    const size_t e = userinfo.find('\\', b);
    return userinfo.substr(b, e == std::string::npos ? std::string::npos : e - b);
}

std::string env_str(const char* name) {
    char buf[512]{};
    const DWORD n = ::GetEnvironmentVariableA(name, buf, sizeof(buf));
    if (n == 0 || n >= sizeof(buf)) return {};
    return std::string(buf, n);
}

// ------------------------------------------------------------- identity --
//
// THE CANONICAL IDENTITY PATH, and it is the site's invite token -- not the
// engine's userinfo, which carries no id at all (referee.md §12.3, join87).
//
//   site  web/server/lib/tokens.js :: issue()   Ed25519 over a canonical payload
//         -> `<payload-b64url>.<sig-b64url>`, bound to (sid, m), 5-minute TTL
//   launcher  one-shot named pipe (ENW_TOKEN_PIPE), never argv, never the env
//   client    client-dll/components/auth_token.cpp writes `setu enw_token "<t>"`
//             so the token is a USERINFO dvar and rides the connect packet
//   server    HERE: `\enw_token\` out of client_s.userinfo at the connect edge
//   host      infra/host-agent/lib/tokens.js :: TokenGuard.admit() verifies the
//             SIGNATURE and answers `auth {slot, allow, reason}`
//
// This function PARSES; it does not verify. There is no Ed25519 in this DLL (the
// core has sha256 and nothing else) and there must not be a signing key on a game
// box in any case -- the site issues, the box verifies, so a stolen box cannot mint
// a join for anybody. What the parse is for is the half the host cannot do for us:
// binding a steamid64 and a party slot TO A CLIENT SLOT, so the roster events and
// the game_over rows carry an account instead of a name.
//
// The unverified `sid` is therefore never trusted on its own. It travels as
// `identity:"claimed"` until the host answers `auth allow:true`, and only a
// `verified` row carries a steamid into `game_over`. A forged token cannot survive
// that: the signature covers the payload, sid included, so changing sid changes the
// body and `check()` returns `bad_signature`.
struct token_claims {
    bool parsed = false;
    std::string sid;    // steamid64, as a string -- 2^64 does not fit a double
    std::string match;  // the match id the site bound this token to
    std::string jti;    // unique per issue: the single-use key
    long long exp = 0;
    int slot = -1;      // the party slot the site seated this player in
    std::string name;
};

// b64url -> bytes. Rejects anything outside the alphabet rather than skipping it:
// a token that is not shaped like ours is not one of ours.
bool b64url_decode(std::string_view in, std::string* out) {
    auto sextet = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '-') return 62;
        if (c == '_') return 63;
        return -1;
    };
    out->clear();
    out->reserve(in.size() * 3 / 4 + 3);
    uint32_t acc = 0;
    int bits = 0;
    for (const char c : in) {
        if (c == '=') break;  // the site never pads, but a padded token is still readable
        const int v = sextet(c);
        if (v < 0) return false;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->push_back(static_cast<char>((acc >> bits) & 0xFF));
        }
    }
    return !out->empty();
}

// `<payload>.<sig>` -> the payload's claims. Bounded: a userinfo string is attacker
// controlled, so everything here is size-checked before it is decoded or parsed.
token_claims parse_token(const std::string& token) {
    token_claims c;
    if (token.size() < 32 || token.size() > 1024) return c;
    const size_t dot = token.find('.');
    if (dot == std::string::npos || dot == 0 || dot + 1 >= token.size()) return c;
    if (token.find('.', dot + 1) != std::string::npos) return c;  // exactly one dot
    std::string body;
    if (!b64url_decode(std::string_view(token).substr(0, dot), &body)) return c;
    if (body.size() > 4096) return c;
    json::value v;
    if (!json::parse(body, &v) || v.type != json::kind::object) return c;
    if (v.int_or("v", -1) != 0) return c;
    c.sid = v.str_or("sid");
    c.match = v.str_or("m");
    c.jti = v.str_or("jti");
    c.exp = v.int_or("exp", 0);
    c.name = v.str_or("n");
    const long long slot = v.int_or("slot", -1);
    c.slot = (slot >= 0 && slot < 64) ? static_cast<int>(slot) : -1;
    // A steamid64 is 17 digits. Anything else is not an account and must never be
    // written into a roster row, however well signed it is.
    if (c.sid.size() < 15 || c.sid.size() > 20) return c;
    for (const char ch : c.sid) {
        if (ch < '0' || ch > '9') return c;
    }
    if (c.jti.empty() || c.match.empty()) return c;
    c.parsed = true;
    return c;
}

// What a roster row's `steamid` is worth. The site already refuses a player row with
// no steamid (web/server/lib/results.js: "a row keyed on a made-up id would attach
// somebody's badge to nobody"), so this marker is what keeps the OTHER mistake from
// happening -- a row that has an id nobody checked.
const char* identity_word(int state) {
    switch (state) {
        case 1: return "claimed";   // a token was presented and parsed; unverified
        case 2: return "verified";  // the host verified the signature: `auth allow:true`
        case 3: return "refused";   // the host said no, or we refused it locally
        default: return "none";     // no token at all -- Local/dev. Attendance only.
    }
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
                [this](const json::value& msg) {
                    do_end(msg.str_or("id"), msg.str_or("reason"), msg.str_or("match"));
                },
                /*want_game_thread=*/true);

        // `exec` is in the protocol (host->game, "run a console command") and nothing
        // has ever implemented it. It is implemented here and it is DEV-ONLY:
        // ENW_DEV_KNOBS=1 in the game process's environment, off everywhere else, and
        // never set by anything that runs a Verified game. A host that can run an
        // arbitrary console command on a server that certifies records can change the
        // rules of a run after it has started, so the switch is deliberately not a
        // dvar a host can set over this same link.
        dev_knobs_ = env_str("ENW_DEV_KNOBS") == "1";
        link.on("exec",
                [this](const json::value& msg) { do_exec(msg.str_or("id"), msg.str_or("cmd")); },
                /*want_game_thread=*/true);

        // The answer to a player_connect's token check. See do_auth().
        link.on("auth",
                [this](const json::value& msg) {
                    do_auth(static_cast<int>(msg.int_or("slot", -1)), msg.bool_or("allow", false),
                            msg.str_or("reason"));
                },
                /*want_game_thread=*/true);

        // The lease this process is serving. The host agent sets it when it starts an
        // instance (infra/host-agent: ENW_MATCH), and it is what binds an invite token
        // to THIS match rather than to any match this box ever runs.
        match_id_ = env_str("ENW_MATCH");
        ENW_INFO("referee: identity gate armed, match=%s",
                 match_id_.empty() ? "(none - tokens will not be lease-checked here)"
                                   : match_id_.c_str());
    }

    void post_unpack() override {
        // THE CONTROL ARM -- see replay.cpp. ENW_NO_SAMPLERS=1 leaves the engine
        // entirely alone: no SV_Frame hook, no per-frame entity read, no notify
        // handler. The map then boots with nothing of ours running inside the game
        // loop, which is the only way to say "ours" or "the map's" with evidence.
        if (env_str("ENW_NO_SAMPLERS") == "1") {
            ENW_INFO("referee: NOT armed -- ENW_NO_SAMPLERS=1. No SV_Frame hook and no "
                     "per-frame state read; rounds and game over will not be reported.");
            return;
        }
        referee::bind();
        // THE NAME LOCK (B, 2026-09-23; name_lock.cpp). Armed with the rest of the
        // bindings and BEFORE any client can connect, because the first thing it has to
        // survive is a connect. It owns exactly one address, SV_UpdateUserinfo_f
        // 0x6307E0, and takes it through the same one-hook-per-address rule everything
        // else does (README rule 9). A failure to bind is loud and is not fatal: the
        // referee still referees, the identity gate still refuses forged tokens, and the
        // name is simply advisory -- which is what it was before today.
        if (!namelock::bind()) {
            ENW_WARN("referee: the name lock is NOT armed. A verified client can still "
                     "rename itself in game; the site's own pages are unaffected.");
        }
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

        // Revives are a notify (revive_success -> player_revived), unlike downs which
        // are a poll of self.downs. Counting them here is what lets the final result
        // carry a revives column without the host having to fold the event stream.
        if (ev.name == "player_revived" && ev.slot >= 0 && ev.slot < kMaxPlayers) {
            ++players_[ev.slot].revives;
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
        } else if (frames_ % 1200 == 0) {
            log_id_histogram();
            // The name lock's own counters, every ~20 s. `userinfo commands seen` is the
            // number that settles whether the SV_UpdateUserinfo_f hook is firing at all:
            // a client that never changes a userinfo dvar after connect sends exactly one,
            // and re-setting a dvar to the value it already holds is not a change, so a
            // zero here is a statement about the CLIENT, not about the hook.
            ENW_INFO("referee: %s", namelock::report().c_str());
        }
        if (frames_ % 2000 == 0) {
            const uint32_t span = ms - first_frame_ms_;
            ENW_INFO("referee: %llu frames in %u ms (%.1f fps)",
                     static_cast<unsigned long long>(frames_), span,
                     span ? (frames_ * 1000.0) / span : 0.0);
        }
        if (frames_ == 1) { first_frame_ms_ = ms; match_start_ms_ = ms; }

        // The name lock's safety net. The hook covers the `userinfo` command, which is
        // every path we KNOW of; this is a 32-byte compare per locked slot that would
        // catch a path we do not. It does nothing at all when nothing is wrong.
        namelock::tick();

        // The server is running a map: that IS map_loaded. SV_Frame does not tick
        // before a server exists, so the first tick is the earliest honest moment,
        // and it is the message that makes the host agent open the replay file.
        if (!map_announced_) announce_map(ms);
        poll_environment(ms);

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

    // ----------------------------------------------------------- identity --

    // Single use, per match. Returns false if this jti has already seated somebody
    // in this match (and is not simply this same slot reconnecting the same token).
    bool claim_jti(const std::string& jti, int slot) {
        auto it = jti_seen_.find(jti);
        if (it == jti_seen_.end()) { jti_seen_[jti] = slot; return true; }
        return it->second == slot;
    }

    // Is this steamid already seated somewhere else? Two clients cannot be the same
    // account, and a token replayed across two PCs would otherwise produce two rows.
    int slot_holding_sid(const std::string& sid, int slot) const {
        if (sid.empty()) return -1;
        for (int i = 0; i < kMaxPlayers; ++i) {
            if (i == slot) continue;
            if (players_[i].connected && players_[i].steamid == sid &&
                players_[i].identity != 3) {
                return i;
            }
        }
        return -1;
    }

    // A refused identity keeps its SLOT -- the player is still in the world until the
    // kick lands, and the replay should show that honestly -- but it keeps no steamid.
    // Nothing downstream may award anything to a row without one.
    void refuse(int slot, const char* why) {
        auto& p = players_[slot];
        p.identity = 3;
        p.steamid.clear();
        p.jti.clear();
        p.party_slot = -1;
        p.refusal = why;
        ENW_WARN("referee: slot %d REFUSED (%s) -- its roster row carries no steamid and "
                 "nothing may be awarded to it. referee.md 13.", slot, why);
        kick_slot(slot, why);
    }

    // The engine's own front door, through the command buffer we already bind
    // (t4_bind.cpp :: console_command / Cbuf_AddText). THE KICK IS THE SECOND LINE OF
    // DEFENCE, NOT THE FIRST: the guarantee that matters for records is that a refused
    // slot carries no identity, and that holds whether or not `clientkick` exists on
    // this exe. If it does not, the console says so and the log line above still stands.
    void kick_slot(int slot, const char* why) {
        const bool ok = referee::console_command("clientkick " + std::to_string(slot));
        ENW_INFO("referee: clientkick %d (%s) %s", slot, why,
                 ok ? "queued" : "REFUSED by the command buffer - the slot keeps playing, "
                                "but with no identity");
    }

    // `auth {slot, allow, reason}` -- host->game, in the protocol since v0 and, until
    // now, IGNORED BY THIS SIDE. The host agent answers every single player_connect
    // with one (infra/host-agent/host.js :: authPlayer), so a DENY was being sent on
    // every forged or replayed token and the client stayed in the game anyway. This is
    // what makes the signature check mean something inside the match.
    void do_auth(int slot, bool allow, const std::string& reason) {
        if (slot < 0 || slot >= kMaxPlayers) return;
        auto& p = players_[slot];
        if (!allow) {
            if (p.identity != 3) refuse(slot, reason.empty() ? "auth_denied" : reason.c_str());
            return;
        }
        // An ALLOW that the host reached without checking anything is not a
        // verification. `token_check_disabled` is what TokenGuard answers when it has
        // no site key or when --require-token is off; the row stays `claimed`, which
        // the site already treats as unawardable.
        if (p.identity == 1 && reason != "token_check_disabled") {
            p.identity = 2;
            ENW_INFO("referee: slot %d identity VERIFIED by the host (steamid=%s, %s)", slot,
                     p.steamid.c_str(), reason.empty() ? "ok" : reason.c_str());
            // THE NAME LOCK ARMS HERE, and only here (B, 2026-09-23; name_lock.cpp).
            //
            // The token's `n` is the account's ENW name -- the site reads it from the
            // users row at lease time and signs it, so it is not the launcher's to
            // choose and not the player's. From this line on, the server's copy of this
            // client's userinfo says that name whatever the client sends, which is what
            // stops the spoof. A slot that never reaches `verified` is never locked:
            // Play Local and the dev harness keep whatever name they launched with.
            //
            // `token_name` is kept separately from `p.name` on purpose. `p.name` is what
            // the ENGINE reports and is therefore the spoofable one; binding the lock to
            // it would lock the slot to the lie.
            if (!p.token_name.empty()) {
                namelock::lock_slot(slot, p.token_name);
                if (p.name != p.token_name) {
                    ENW_INFO("referee: slot %d connected as '%s' but the token says '%s' -- "
                             "the token wins; the roster and the scoreboard both say '%s'",
                             slot, p.name.c_str(), p.token_name.c_str(), p.token_name.c_str());
                }
                // The roster row follows the enforced name, so game_over, player_down and
                // the chat lines cannot disagree with what the scoreboard shows.
                p.name = p.token_name;
            } else {
                ENW_WARN("referee: slot %d is verified but its token carried no name (`n`) -- "
                         "the name is NOT locked and this client can still rename itself. "
                         "The site must issue tokens with a name (web/server/lib/tokens.js).",
                         slot);
            }
        } else {
            ENW_WARN("referee: slot %d allowed with reason='%s' and identity=%s -- NOT promoted "
                     "to verified; nothing may be awarded to this row.",
                     slot, reason.c_str(), identity_word(p.identity));
        }
    }

    // ------------------------------------------------------------- roster --
    //
    // THE EVENTS THE HOST BUILDS ITS RESULT FROM, and until now nothing in the game
    // ever sent them. `player_connect` / `player_spawn` / `player_disconnect` have
    // been in docs/protocol/game-link-v0.md since v0 and were emitted only by
    // infra/host-agent/sim/engine.js, so every integration test passed and every
    // REAL game scored nobody: `lib/referee.js` builds `this.players` in
    // ev_player_connect alone, and ev_player_spawn / ev_player_disconnect both bail
    // out when the row does not exist. Game id 2 on the box -- a real player,
    // CS_ACTIVE, `slot 0 ENTERED THE WORLD`, a signed replay -- reported
    // game_players = 0 with result_mismatch for exactly this reason.
    //
    // There is no connect callback bound (no Scr_NotifyNum, no SV_ClientConnect
    // hook), so this is an EDGE DETECTOR over the same per-frame client poll that
    // already runs. `client(slot).active` is `gentity != 0 && name non-empty`,
    // which a client has from CS_CONNECTED onward, so the connect edge lands early
    // -- which is what the host wants, since it opens the replay on the first
    // player_connect. `player_spawn` waits for a live player entity, which is the
    // honest signal for "in the world".
    void poll_roster(int slot, uint32_t ms) {
        auto& p = players_[slot];
        auto c = referee::client(slot);
        const bool active = c && c->active;

        if (active && !p.connected) {
            p.connected = true;
            p.spawned = false;
            // A new connection reports its FPS cap afresh (the slot may be somebody
            // else now). The host keeps the whole history per account, across reconnects.
            p.fps = -1;
            p.fps_first = -1;
            p.fps_changes = 0;
            p.name = c->name;
            // client_view already pulls xuid/steamid/guid out of userinfo; the host
            // reads `ev.steamid || ev.xuid` and keys identity on it, so send both
            // names for the one value rather than making the host guess.
            p.steamid = c->xuid;
            p.identity = 0;
            p.jti.clear();
            p.party_slot = -1;
            p.refusal.clear();
            // A new connection starts its own baseline: whoever held this slot before
            // (or this player before a reconnect) must not turn into a negative delta.
            p.have_score = false;
            p.have_downs = false;
            p.have_stats = false;
            p.is_down = false;
            const std::string token = userinfo_value(c->userinfo, "enw_token").empty()
                                          ? userinfo_value(c->userinfo, "token")
                                          : userinfo_value(c->userinfo, "enw_token");

            // THE IDENTITY BIND. Everything the engine offers is a name; the account
            // is in the token and nowhere else. Parse it, refuse the two things a
            // server can refuse WITHOUT a key -- a replayed token and a token for
            // somebody else's match -- and leave the signature to the host.
            if (!token.empty()) {
                const token_claims tc = parse_token(token);
                if (!tc.parsed) {
                    refuse(slot, "malformed_token");
                } else if (!match_id_.empty() && tc.match != match_id_) {
                    // RECORDS SAFETY 2: bound to the lease. A token minted for match A
                    // is worthless on match B even before the host looks at it.
                    refuse(slot, "wrong_match");
                } else if (!claim_jti(tc.jti, slot)) {
                    // RECORDS SAFETY 1: single use per match. The host's TokenGuard
                    // keeps a jti set per BOOT; this one is per MATCH and lives in the
                    // process that actually seats the client, so a second client
                    // presenting the same token is refused here even if the host link
                    // is down.
                    refuse(slot, "replayed_token");
                } else if (const int other = slot_holding_sid(tc.sid, slot); other >= 0) {
                    ENW_WARN("referee: slot %d presents a steamid already seated in slot %d",
                             slot, other);
                    refuse(slot, "steamid_already_seated");
                } else {
                    p.steamid = tc.sid;   // the token's sid IS the canonical steamid64
                    p.jti = tc.jti;
                    p.party_slot = tc.slot;
                    p.identity = 1;       // claimed -- until `auth allow:true` lands
                    // The name the SITE signed. Kept apart from p.name, which is what the
                    // engine reports and is therefore the one a client can lie about.
                    // do_auth() promotes it to the enforced name once the host verifies
                    // the signature -- never before, because an unverified `n` is just a
                    // string somebody put in a packet.
                    p.token_name = tc.name;
                    if (p.name.empty() && !tc.name.empty()) p.name = tc.name;
                }
            }

            json::writer w;
            w.str("t", "player_connect").integer("ms", ms).integer("slot", slot);
            w.str("name", p.name);
            // `steamid` and `xuid` carry the same value: lib/referee.js reads
            // `ev.steamid || ev.xuid` and keys identity on it, and web's results.js
            // inserts game_players on `steamid`, so this one field name is the whole
            // contract. `identity` says what it is WORTH.
            if (!p.steamid.empty()) { w.str("steamid", p.steamid).str("xuid", p.steamid); }
            w.str("identity", identity_word(p.identity));
            if (p.party_slot >= 0) w.integer("party_slot", p.party_slot);
            if (!p.refusal.empty()) w.str("identity_reason", p.refusal);
            if (!token.empty()) w.str("token", token);
            game_link::get().send(w);
            ENW_INFO("referee: player_connect slot %d name='%s' steamid=%s identity=%s%s%s",
                     slot, p.name.c_str(),
                     p.steamid.empty() ? "(none)" : p.steamid.c_str(),
                     identity_word(p.identity),
                     p.refusal.empty() ? "" : " reason=",
                     p.refusal.empty() ? "" : p.refusal.c_str());
            // MEASURED join85: the steamid came back EMPTY on a real client, so the
            // host gets a roster row it cannot attach XP or a record to. client_view
            // looks for \xuid\, \steamid\ and \guid\ and this client's userinfo has
            // none of them. Print the KEY NAMES once per connect -- not the values,
            // which carry the player's id -- so the next session can name the right
            // key instead of guessing at three.
            if (p.steamid.empty() && !c->userinfo.empty()) {
                std::string keys;
                // userinfo starts WITH a backslash, so the first field after the first
                // separator is a key: start outside and let the separator flip us in.
                bool is_key = false;
                for (size_t i = 0; i < c->userinfo.size(); ++i) {
                    if (c->userinfo[i] == '\\') { is_key = !is_key; if (is_key) keys += ' '; continue; }
                    if (is_key) keys += c->userinfo[i];
                }
                ENW_WARN("referee: slot %d has NO steam id (identity=%s). userinfo keys: %s -- "
                         "no \\enw_token\\, so this client was not launched through the ENW "
                         "launcher (or was launched without a lease). The row is ATTENDANCE "
                         "ONLY and nothing downstream may award XP or a record to it. "
                         "referee.md 13.", slot, identity_word(p.identity), keys.c_str());
            }
            referee::lp_player_event(slot, "player_connect", p.name);
        }

        if (p.connected && !p.spawned) {
            if (auto e = referee::player_ent(slot); e && e->alive) {
                p.spawned = true;
                json::writer w;
                w.str("t", "player_spawn").integer("ms", ms).integer("slot", slot);
                game_link::get().send(w);
                ENW_INFO("referee: player_spawn slot %d ('%s')", slot, p.name.c_str());
            }
        }

        if (!active && p.connected) {
            p.connected = false;
            p.spawned = false;
            json::writer w;
            w.str("t", "player_disconnect").integer("ms", ms).integer("slot", slot);
            w.str("reason", "slot no longer active");
            game_link::get().send(w);
            ENW_INFO("referee: player_disconnect slot %d ('%s')", slot, p.name.c_str());
            referee::lp_player_event(slot, "player_disconnect", p.name);
            // The slot is free. Whoever lands in it next is a different account and gets
            // its own lock (or none), so a lock left behind here would rename them.
            namelock::unlock_slot(slot);
            p.token_name.clear();
        }
    }

    void poll_players(uint32_t ms) {
        const int n = referee::max_clients();
        for (int slot = 0; slot < n && slot < kMaxPlayers; ++slot) {
            auto& p = players_[slot];

            poll_roster(slot, ms);

            // THE SCOREBOARD COUNTERS (referee.md §16). One 24-byte read of the player's
            // gclient per server frame: score, kills, assists, downs, revives, headshots,
            // the same ints the game's own Tab scoreboard shows. Until 2026-09-23 these
            // came from player_int(), which was a stub returning nullopt, so no `points`,
            // `down` or kill count ever left a real game and every result said 0.
            //
            // Only while the player is connected: a free slot's gclient is zeroed or
            // reused, and a leaver keeps the last values we saw (the game_over row).
            const auto st = p.connected ? referee::player_stats(slot) : std::nullopt;
            if (!st) continue;

            // Points: no script notify exists, so this is the only way. Sampling
            // at server-frame rate is exact enough to attribute a purchase.
            if (!p.have_score || st->score != p.score) {
                json::writer w;
                w.str("t", "points").integer("ms", ms).integer("slot", slot).integer("score", st->score);
                if (p.have_score) w.integer("delta", st->score - p.score);
                game_link::get().send(w);
                p.score = st->score;
                p.have_score = true;
            }

            // Revive: `reviver.revives++` in revive_success. The `player_revived` notify
            // fires on the REVIVED player (`self notify`), so the counter is what names
            // the reviver; the revived one is the single connected player we saw go down
            // and not come back yet, when there is exactly one, else it is left off.
            if (p.have_stats && st->revives > p.revives_native) {
                for (int k = p.revives_native; k < st->revives; ++k) {
                    json::writer w;
                    w.str("t", "revive").integer("ms", ms).integer("by", slot);
                    int downed = -1, count = 0;
                    for (int o = 0; o < kMaxPlayers; ++o) {
                        if (o != slot && players_[o].connected && players_[o].is_down) { downed = o; ++count; }
                    }
                    if (count == 1) { w.integer("slot", downed); players_[downed].is_down = false; }
                    game_link::get().send(w);
                }
            }

            // Down: _laststand.gsc bumps self.downs and defines self.revivetrigger.
            {
                const int* d = &st->downs;
                if (p.have_downs && *d > p.downs) {
                    p.is_down = true;
                    json::writer w;
                    w.str("t", "down").integer("ms", ms).integer("slot", slot);
                    game_link::get().send(w);
                    // `player_down` is the SAME EDGE, said in full. `down` carries a
                    // slot and nothing else, which is everything the referee's own fold
                    // needs and nothing a sentence needs: by the time a line reaches the
                    // site's chat ring the slot is a number belonging to a game nobody
                    // reading it is in. So this one carries the name, the round and the
                    // map, and the two are emitted together rather than one replacing
                    // the other — `down` is in the protocol table, hosts fold it, and a
                    // rename would silently stop counting downs on every box not
                    // redeployed the same night. (2026-09-23, game-link-v0.)
                    json::writer pw;
                    pw.str("t", "player_down").integer("ms", ms).integer("slot", slot);
                    if (!p.name.empty()) pw.str("name", p.name);
                    // Only a verified row carries an account anywhere else in this
                    // file, and a chat line is not the place to start.
                    pw.integer("round", round_).integer("downs", *d);
                    if (!map_.empty()) pw.str("map", map_);
                    game_link::get().send(pw);
                }
                p.downs = *d;
                p.have_downs = true;
            }
            // A downed player whose entity is no longer alive bled out; nobody revives them.
            if (p.is_down) {
                if (auto e = referee::player_ent(slot); e && !e->alive) p.is_down = false;
            }

            // `stats`: the absolute counters, whenever one of them moves. Sent AFTER the
            // `down` / `revive` edges of the same frame so a host that folds both sees the
            // edge first and the absolute value second (lib/referee.js takes the max).
            // This is the only place kills and headshots exist on the wire: the game has
            // no kill event that names a player, and `points` carries no reason.
            if (!p.have_stats || st->kills != p.kills || st->headshots != p.headshots ||
                st->revives != p.revives_native || st->assists != p.assists ||
                st->downs != p.downs_sent) {
                json::writer w;
                w.str("t", "stats").integer("ms", ms).integer("slot", slot)
                    .integer("score", st->score).integer("kills", st->kills)
                    .integer("headshots", st->headshots).integer("downs", st->downs)
                    .integer("revives", st->revives).integer("assists", st->assists);
                game_link::get().send(w);
            }
            p.kills = st->kills;
            p.headshots = st->headshots;
            p.assists = st->assists;
            p.revives_native = st->revives;
            p.downs_sent = st->downs;
            p.have_stats = true;
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
        // Kept, because `player_down` says which map somebody went down on and this
        // is the only place the name is derived.
        map_ = map;

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
        // Publish it for the replay sampler, which stamps it on every snap so a
        // chunk that arrives alone knows what round it is in (replay.md 3, gap 3).
        referee::set_current_round(round_);
        json::writer w;
        w.str("t", "round").integer("ms", ms).integer("n", round_);
        game_link::get().send(w);
        // The IW4MAdmin-shaped mirror in the game's own log. Off unless
        // enw_logprint_events is set, and free when it is off -- but when it IS on it
        // is a human-readable trace of exactly this decision, in a file B can open.
        referee::lp_round_complete(round_);
        ENW_INFO("referee: ROUND %d (%s)", round_, how);
    }

    // ----------------------------------------------------------- game over --
    //
    // WHAT GAME OVER DOES ON A DEDICATED SERVER, AND WHY IT HAD TO CHANGE.
    //
    // Until tonight this sent `{"t":"game_over","round":N,"reason":…}` and stopped.
    // That was adequate while a dedicated server DIED at game over: T4's single-player
    // death flow reloads the last save, a headless server never wrote one, and the
    // ERR_DROP took the whole process into the front end and parked it (dedi.md 12.3).
    // `no_save_reload.cpp` fixed that, and it created a new problem: the server, the
    // map and the connected clients now live on past game over for ever. Nothing
    // stops the replay, nothing tells the host the match is finished, nothing frees
    // the instance, and nothing starts the next one.
    //
    // So game over is now three things, in this order:
    //
    //   1. THE RESULT. One `game_over` carrying everything the host needs to post a
    //      result without reconstructing it from the event stream: the round reached,
    //      the finish reason, how long the match ran, and a per-player row of points,
    //      downs, revives and whether they were alive at the end. The host's referee
    //      can still derive all of this from the stream -- that is the design, and it
    //      is why the replay is the record of truth -- but a summary that is one
    //      message cannot be half-lost to a dropped connection.
    //   2. THE REPLAY STOPS. `referee::set_recording(false)`; the sampler in
    //      replay.cpp returns immediately from then on.
    //   3. THE LEASE. One `match_end`, which is the message that says "this game
    //      process is idle and the instance can be reclaimed". The host agent answers
    //      it with `end` (we `map_restart` for the next lease and report a fresh
    //      `map_loaded`) or by tearing the process down. If it answers with neither we
    //      do NOTHING: a server that restarted its own map would destroy the evidence
    //      of a game the host had not finished writing down. The exact contract is in
    //      referee.md.
    void emit_game_over(const char* reason) {
        if (game_over_) return;
        game_over_ = true;

        const uint32_t duration = (game_ms_ >= match_start_ms_) ? game_ms_ - match_start_ms_ : 0;

        json::array players;
        int total_points = 0, total_downs = 0, total_kills = 0, alive = 0;
        bool any_stats = false;
        const int n = referee::max_clients();
        for (int slot = 0; slot < n && slot < kMaxPlayers; ++slot) {
            auto c = referee::client(slot);
            const auto& p = players_[slot];
            // A player who left mid-match is still part of the result, so we report a
            // row for anyone we ever saw, not just anyone connected at the end.
            if ((!c || !c->active) && !p.have_score && !p.have_downs) continue;
            json::writer pw;
            pw.integer("slot", slot);
            // Identity on the row as well as on player_connect. A host that lost the
            // link mid-match, or that only stores the final result, still has to be
            // able to attach XP and records to an account, and a name cannot do that.
            const std::string nm = (c && !c->name.empty()) ? c->name : p.name;
            // THE STEAMID COMES FROM THE INVITE TOKEN, AND ONLY WHEN THE HOST VERIFIED
            // IT. The engine's xuid is empty on every real WaW client (referee.md
            // §12.3), and an unverified claim on the one message a host may post a
            // result from is exactly how a forged token would buy somebody else's XP.
            // A `claimed` or `refused` row still appears -- attendance is a fact -- but
            // with no id, and results.js drops an id-less row before it reaches
            // game_players.
            const std::string sid = (p.identity == 2) ? p.steamid : std::string();
            if (!nm.empty()) pw.str("name", nm);
            if (c) pw.boolean("connected", c->active);
            if (!sid.empty()) pw.str("steamid", sid).str("xuid", sid);
            pw.str("identity", identity_word(p.identity));
            if (p.identity == 2 && p.party_slot >= 0) pw.integer("party_slot", p.party_slot);
            if (!p.refusal.empty()) pw.str("identity_reason", p.refusal);
            // A fresh read for a player still here (game over can land between two frame
            // polls, and the last kill is usually in that frame); the last values we saw
            // for one who left.
            auto& ps = players_[slot];
            if (ps.connected) {
                if (const auto st = referee::player_stats(slot)) {
                    ps.score = st->score; ps.have_score = true;
                    ps.downs = st->downs; ps.have_downs = true;
                    ps.kills = st->kills; ps.headshots = st->headshots; ps.assists = st->assists;
                    ps.revives_native = st->revives; ps.have_stats = true;
                }
            }
            if (p.have_score) { pw.integer("score", p.score); total_points += p.score; }
            if (p.have_downs) { pw.integer("downs", p.downs); total_downs += p.downs; }
            // The native counter names the REVIVER (`reviver.revives++`); the notify count
            // is only the fallback for a build where the field table did not verify.
            pw.integer("revives", p.have_stats ? p.revives_native : p.revives);
            if (p.have_stats) {
                pw.integer("kills", p.kills).integer("headshots", p.headshots)
                    .integer("assists", p.assists);
                total_kills += p.kills;
                any_stats = true;
            }
            if (auto s = referee::player_int(slot, "score_total")) pw.integer("score_total", *s);
            if (auto e = referee::player_ent(slot)) {
                pw.boolean("alive", e->alive);
                if (e->alive) ++alive;
            }
            // The FPS cap this client reported (verified-rules.md): absent = never reported.
            if (p.fps >= 0) {
                pw.integer("com_maxfps", p.fps).integer("com_maxfps_first", p.fps_first)
                    .integer("com_maxfps_changes", p.fps_changes);
            }
            players.raw(pw.done());
        }
        // The server's environment as last reported, so the one message a host may post a
        // result from carries the settings the result was played under.
        json::writer env;
        for (const auto& [k, v] : env_.values()) env.str(k.c_str(), v);

        const size_t rows = players.count();
        json::writer w;
        w.str("t", "game_over")
            .integer("ms", game_ms_)
            .integer("round", round_)
            .str("reason", reason)
            .integer("duration_ms", static_cast<long long>(duration))
            .integer("points_total", total_points)
            .integer("downs_total", total_downs)
            .integer("players_alive", alive);
        if (any_stats) w.integer("kills_total", total_kills);
        w.raw("players", players.done())
         .raw("dvars", env.done());
        game_link::get().send(w);
        referee::lp_player_event(-1, "match_end", std::to_string(round_));

        // 2. the replay stops.
        referee::set_recording(false);

        // 3. the lease. Sent after game_over so the host can never see "you may reuse
        // this instance" before the result it is supposed to post.
        json::writer m;
        m.str("t", "match_end")
            .integer("ms", game_ms_)
            .integer("round", round_)
            .str("reason", reason)
            .integer("duration_ms", static_cast<long long>(duration))
            .boolean("replay_closed", true)
            .boolean("server_alive", true)
            .str("awaiting", "end|teardown");
        game_link::get().send(m);

        ENW_INFO("referee: GAME OVER at round %d (%s) after %u ms; %d point(s) over %d player "
                 "row(s), %d down(s), %d kill(s)%s, %d alive. Replay sampler stopped. match_end "
                 "sent: the server is ALIVE and idle, waiting for the host to send `end` "
                 "(map_restart) or to tear the instance down.",
                 round_, reason, duration, total_points,
                 static_cast<int>(rows), total_downs, total_kills,
                 any_stats ? "" : " (native stats not bound)", alive);
        ENW_INFO("referee: %zu distinct notifies seen, %llu suppressed", seen_.size(),
                 static_cast<unsigned long long>(suppressed_));
    }

    // Everything a second match on the same process must not inherit from the first.
    // Called only from do_end(), and only when the map_restart actually went in.
    void reset_for_next_match(const std::string& next_match) {
        for (auto& p : players_) p = player_state{};
        // The invite tokens of the FINISHED match must not admit anybody to the next
        // one, and the finished match's id must not be used to lease-check the next
        // one's tokens. ENW_MATCH was read at process start and a warm instance serves
        // a match the process has never heard of, so the host has to say which one it
        // is: `end {..., "match":"m_xxxx"}`. Until it does we clear the id rather than
        // keep a stale one -- a stale id would refuse every legitimate token in the
        // successor game with `wrong_match`, which is the worse failure.
        jti_seen_.clear();
        // Match A's name locks must not survive into match B on a warm instance: the
        // slots are re-seated from scratch and a stale lock would rename whoever lands
        // in slot 0 next to the previous game's player.
        namelock::reset();
        match_id_ = next_match;
        ENW_INFO("referee: identity gate reset; next match = %s",
                 match_id_.empty() ? "(not stated by the host - tokens will not be "
                                     "lease-checked in this game)"
                                   : match_id_.c_str());
        seen_.clear();
        id_counts_.clear();
        level_notify_count_ = 0;
        level_notify_emitted_ = 0;
        novel_forwarded_ = 0;
        suppressed_ = 0;
        round_ = 0;
        round_notifies_ = 0;
        last_round_ms_ = 0;
        game_over_ = false;
        match_start_ms_ = game_ms_;
        // The next match's replay must carry its own starting environment, not rely on
        // the previous match's events: forget what was sent and report it all again.
        env_.clear();
        last_env_ms_ = 0;
        last_client_env_ms_ = 0;
        map_announced_ = false;   // the next frame re-announces, so the host opens a new replay
        core_frames_ = 0;
        referee::set_current_round(0);
        referee::set_recording(true);
        ENW_INFO("referee: state reset for the next match; map_loaded will be re-announced "
                 "and the replay sampler is recording again.");
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

    // The host's answer to `match_end` -- and also the way it ends a game early.
    //
    // A clean end from inside the game would be the scripts' own end_game(), and Der
    // Riese reaches it through level notify("end_game"); we cannot fire a script
    // notify from C++ yet, so `map_restart` is what we have. What IS new is what
    // happens around it: if the match had not already ended we report it first, so a
    // host-forced end still produces a result and a closed replay rather than a hole
    // in the record; and on success we reset for the next lease, which is the whole
    // point of answering `match_end` with `end` instead of killing the process.
    void do_end(const std::string& id, const std::string& reason, const std::string& next_match) {
        if (!game_over_) emit_game_over(reason.empty() ? "host end" : reason.c_str());

        const bool ok = referee::console_command("map_restart");
        if (!id.empty()) {
            game_link::get().send_reply(id, ok, ok ? "" : "no command buffer bound");
        }
        if (ok) {
            reset_for_next_match(next_match);
        } else {
            ENW_WARN("referee: host asked to end the game (%s) but the command buffer is not "
                     "bound, so map_restart could not be issued. The instance is finished and "
                     "the host must tear it down rather than reuse it.",
                     reason.c_str());
        }
        ENW_INFO("referee: host asked to end the game (%s) -> %s", reason.c_str(),
                 ok ? "map_restart, ready for the next match" : "unavailable");
    }

    // Dev-only. See the registration in post_load() for why.
    void do_exec(const std::string& id, const std::string& cmd) {
        if (!dev_knobs_) {
            ENW_WARN("referee: refused host exec \"%s\": dev knobs are off. Set "
                     "ENW_DEV_KNOBS=1 in the server process to allow it, and never in a "
                     "Verified game.",
                     cmd.c_str());
            if (!id.empty()) game_link::get().send_reply(id, false, "dev knobs off (ENW_DEV_KNOBS)");
            return;
        }
        if (cmd.empty()) {
            if (!id.empty()) game_link::get().send_reply(id, false, "empty cmd");
            return;
        }
        // One line only: a newline would let one `exec` smuggle in a second command.
        if (cmd.find('\n') != std::string::npos || cmd.find('\r') != std::string::npos) {
            if (!id.empty()) game_link::get().send_reply(id, false, "cmd must be a single line");
            return;
        }
        const bool ok = referee::console_command(cmd);
        ENW_WARN("referee: DEV KNOB exec \"%s\" -> %s", cmd.c_str(), ok ? "queued" : "unavailable");
        if (!id.empty()) {
            game_link::get().send_reply(id, ok, ok ? "" : "no command buffer bound");
        }
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
        int revives = 0;      // counted off the player_revived notify (fallback only)
        // --- the native scoreboard counters (2026-09-23, referee.md 16) -----------
        bool have_stats = false;
        int kills = 0;
        int headshots = 0;
        int assists = 0;
        int revives_native = 0;   // gclient revives: the REVIVER's count
        int downs_sent = 0;       // the downs value the last `stats` carried
        bool is_down = false;     // went down, not yet revived or bled out
        // --- identity and presence (2026-09-22, referee.md 12) ------------------
        // Without these the host agent has no roster at all: `lib/referee.js`
        // creates a player row ONLY in ev_player_connect, and ev_player_spawn /
        // ev_player_disconnect both `return` when the row is missing. That is why
        // the box's first real game (replay m_5de3842b, site game id 2) finished
        // with game_players = 0 and result_mismatch while the SIMULATOR, which does
        // emit player_connect, produces full rosters.
        // The name the invite token carried (`n`), i.e. the account's ENW name as the
        // site signed it. EMPTY for an untokened client. It is what the name lock
        // enforces once identity reaches `verified`; see do_auth() and name_lock.cpp.
        std::string token_name;
        bool connected = false;   // last seen state, for edge detection
        bool spawned = false;     // player_spawn already sent for this connection
        std::string name;
        std::string steamid;
        // --- identity (2026-09-22, referee.md 13) -------------------------------
        // 0 none / 1 claimed / 2 verified / 3 refused -- see identity_word(). Only
        // a `verified` row carries a steamid into game_over, because only a verified
        // row has had its signature checked by something holding the site's key.
        int identity = 0;
        std::string jti;        // the token's single-use id, for the replay guard
        int party_slot = -1;    // the seat the SITE gave this player, when it said one
        std::string refusal;    // why, when identity == refused
        // --- the client's FPS cap (2026-09-23, verified-rules.md) ---------------
        // From userinfo `enw_fps` (client-dll fps_guard.cpp). -1 = never reported.
        int fps = -1;
        int fps_first = -1;
        int fps_changes = 0;    // changes after the first report
    };

    // ------------------------------------------------ the Verified environment --
    // verified_env.hpp says what and why. Server dvars every 5 s (24 lookups), each
    // client's reported FPS cap every 1 s (a userinfo string search). Both send only on
    // first sight and on change, so a steady game costs the link nothing.
    void poll_environment(uint32_t ms) {
        if (last_env_ms_ == 0 || ms - last_env_ms_ >= 5000 || ms < last_env_ms_) {
            last_env_ms_ = ms ? ms : 1;
            for (const char* name : verified::kServerWatch) {
                auto v = referee::dvar_get(name);
                if (!v || !env_.observe(name, *v)) continue;
                json::writer w;
                w.str("t", "dvar").integer("ms", ms).str("name", name).str("value", *v);
                game_link::get().send(w);
                ENW_INFO("referee: dvar %s = \"%s\"", name, v->c_str());
            }
        }
        if (last_client_env_ms_ != 0 && ms - last_client_env_ms_ < 1000 && ms >= last_client_env_ms_) return;
        last_client_env_ms_ = ms ? ms : 1;
        const int n = referee::max_clients();
        for (int slot = 0; slot < n && slot < kMaxPlayers; ++slot) {
            auto c = referee::client(slot);
            if (!c || !c->active) continue;
            const int fps = verified::parse_client_fps(userinfo_value(c->userinfo, verified::kClientFpsKey));
            auto& p = players_[slot];
            if (fps < 0 || fps == p.fps) continue;
            if (p.fps_first < 0) p.fps_first = fps; else ++p.fps_changes;
            p.fps = fps;
            json::writer w;
            w.str("t", "client_dvar").integer("ms", ms).integer("slot", slot)
                .str("name", "com_maxfps").integer("value", fps)
                .integer("effective_fps", verified::effective_fps(fps));
            game_link::get().send(w);
            ENW_INFO("referee: slot %d reports com_maxfps %d (runs at %d fps)%s", slot, fps,
                     verified::effective_fps(fps), p.fps_changes ? " -- CHANGED mid-game" : "");
        }
    }

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
    std::string map_;                        // the bsp name announced in map_loaded
    bool game_over_ = false;
    uint32_t game_ms_ = 0;
    uint64_t frames_ = 0;
    uint64_t core_frames_ = 0;
    uint32_t first_frame_ms_ = 0;
    uint32_t match_start_ms_ = 0;
    bool dev_knobs_ = false;
    std::string match_id_;                   // ENW_MATCH: the lease this process serves
    std::map<std::string, int> jti_seen_;    // single-use invite tokens, per match
    verified::change_tracker env_;           // server dvars as last reported
    uint32_t last_env_ms_ = 0;
    uint32_t last_client_env_ms_ = 0;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::referee_component)
