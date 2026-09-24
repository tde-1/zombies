// Disconnect -> pause -> reconnect: the rules, with no engine in them, so they can be tested on
// their own (server/tests/reconnect_rules_test.cpp) and read in one sitting.
//
// B, 2026-09-24: "If someone disconnects from the game, it pauses and allows people to reconnect
// and continue as if nothing happened." The spec is vault 10 §5 (the policy table) and vault 15
// "Games": casual/badge games auto-pause and restore the player ("Resumed"); record games get the
// pause and a vanilla rejoin. The HOST decides the policy (infra/host-agent/lib/referee.js); this
// file is the part only the game process can do:
//
//   1. NOTICE THE DROP EARLY. A crashed or frozen client is not dropped by the engine for ~40 s
//      (sv_timeout; dedi.md §28.8 measured "the server dropping a client that had sent nothing for
//      ~40 s"). For those 40 s its body stands in a live world and is eaten. So we watch each
//      client's last usercmd (client_s.lastUsercmd +0x11108, [V] dedi.md §7h) and call the link
//      LOST after `lost_ms` of no change -- the host then holds the pause. While the world is
//      frozen the engine's own timeout cannot run either (svs.time is held, pause.cpp), so the
//      body stays exactly as it was until the player is back or the host gives up.
//   2. KEEP THE STATE AS OF THE LAST INPUT. A snapshot taken after the drop is a snapshot of a
//      body that stood still for five seconds in front of zombies. The cache is refreshed only
//      when the client's input changes, so it is the state the player last had in hand.
//   3. LET THE SAME ACCOUNT BACK IN while its old body is still seated (a lost slot), instead of
//      refusing `steamid_already_seated`: the old slot is the ghost, and it is kicked.
//   4. PUT THEM BACK: the points and the scoreboard counters (gclient +0x20BC.., [V] referee.md
//      §16) once the new body has spawned and the level's own spawn scripts have finished with it.
//      Weapons, perks and position are NOT restored by this file -- they need the co-loaded GSC of
//      referee.md §3.3, which does not exist yet -- and the reply says so rather than pretending.
//
// Kill switch: ENW_NO_RECONNECT=1 (referee.cpp) -- no lost/back/ready events, no ghost eviction,
// `restore` refused. The roster events are unchanged either way.
#pragma once

#include <cstdint>
#include <string>

namespace enw::reconnect {

// ------------------------------------------------------------------ 1. the link watch --
enum class link_phase { none, loading, playing, lost };
enum class link_edge { none, ready, lost, back };

inline const char* to_string(link_phase p) {
    switch (p) {
        case link_phase::loading: return "loading";
        case link_phase::playing: return "playing";
        case link_phase::lost: return "lost";
        default: return "none";
    }
}

struct link_cfg {
    uint32_t lost_ms = 5000;   // no input change for this long, world running -> lost
    int ready_changes = 2;     // input changes after the connect edge before we call it "in the world"
};

// A usercmd folded into one number. Any field moving counts as the client being alive: the
// serverTime normally advances every client frame, and while the world is frozen (when the
// client's clock may stand still) a player who touches the mouse still moves the angles.
inline uint64_t cmd_signature(int32_t server_time, int32_t buttons, int16_t pitch, int16_t yaw,
                              int8_t forward, int8_t right) {
    uint64_t h = 1469598103934665603ull;   // FNV-1a over the fields, in a fixed order
    auto mix = [&h](uint64_t v, int bytes) {
        for (int i = 0; i < bytes; ++i) { h ^= (v >> (8 * i)) & 0xFF; h *= 1099511628211ull; }
    };
    mix(static_cast<uint32_t>(server_time), 4);
    mix(static_cast<uint32_t>(buttons), 4);
    mix(static_cast<uint16_t>(pitch), 2);
    mix(static_cast<uint16_t>(yaw), 2);
    mix(static_cast<uint8_t>(forward), 1);
    mix(static_cast<uint8_t>(right), 1);
    return h;
}

struct link_slot {
    link_phase phase = link_phase::none;
    bool have_sig = false;
    uint64_t sig = 0;
    uint32_t last_change_ms = 0;   // wall ms of the last input change (or of the connect)
    int changes = 0;               // input changes seen while loading
    uint32_t lost_at_ms = 0;
    bool changed_now = false;      // this step saw an input change (the snapshot cache keys on it)
};

// One poll of one slot. `connected`: the roster says the slot is active. `have_cmd`: the usercmd
// was readable (false for a soak bot or an unbound client array -- such a slot is never judged).
// `frozen`: the pause gate is holding the world, so no NEW loss is called (the client's own clock
// may stand still then) -- a slot already lost stays lost until its input moves.
inline link_edge step(link_slot& s, bool connected, bool have_cmd, uint64_t sig, uint32_t now_ms,
                      bool frozen, const link_cfg& c = link_cfg{}) {
    s.changed_now = false;
    if (!connected) {
        s = link_slot{};
        return link_edge::none;
    }
    if (s.phase == link_phase::none) {
        s.phase = link_phase::loading;
        s.have_sig = have_cmd;
        s.sig = sig;
        s.last_change_ms = now_ms;
        s.changes = 0;
        return link_edge::none;
    }
    if (!have_cmd) return link_edge::none;
    const bool changed = !s.have_sig || sig != s.sig;
    if (changed && s.have_sig) s.changed_now = true;
    s.have_sig = true;
    s.sig = sig;
    if (s.changed_now) s.last_change_ms = now_ms;

    switch (s.phase) {
        case link_phase::loading:
            if (s.changed_now && ++s.changes >= c.ready_changes) {
                s.phase = link_phase::playing;
                return link_edge::ready;
            }
            return link_edge::none;
        case link_phase::playing:
            if (frozen && !s.changed_now) {
                // The silence clock does not run while the world is held.
                s.last_change_ms = now_ms;
                return link_edge::none;
            }
            if (!s.changed_now && now_ms - s.last_change_ms >= c.lost_ms) {
                s.phase = link_phase::lost;
                s.lost_at_ms = now_ms;
                return link_edge::lost;
            }
            return link_edge::none;
        case link_phase::lost:
            if (s.changed_now) {
                s.phase = link_phase::playing;
                return link_edge::back;
            }
            return link_edge::none;
        default:
            return link_edge::none;
    }
}

// ------------------------------------------------ 2. the state as of the last input --
struct counters {
    bool have = false;
    int score = 0, kills = 0, assists = 0, downs = 0, revives = 0, headshots = 0;
};

// The snapshot is refreshed while the slot is playing and the input just moved, at most every
// `min_gap_ms`, and never while the slot is lost (a ghost's numbers are the zombies', not his).
inline bool should_sample(const link_slot& s, bool have_sample, uint32_t last_sample_ms,
                          uint32_t now_ms, uint32_t min_gap_ms = 250) {
    if (s.phase != link_phase::playing) return false;
    if (!have_sample) return true;
    return s.changed_now && now_ms - last_sample_ms >= min_gap_ms;
}

// Counters only ever go up within one connection. Any of them going DOWN on a slot we believed
// was one continuous connection means the engine re-seated the slot (a reconnect from the same
// address can reuse it without the slot ever reading inactive) -- a new person-session, whatever
// the roster edge said.
inline bool counters_reset(const counters& before, const counters& now) {
    if (!before.have || !now.have) return false;
    return now.kills < before.kills || now.downs < before.downs || now.revives < before.revives ||
           now.headshots < before.headshots || now.assists < before.assists;
}

// ------------------------------------------------------- 3. the same account, twice --
enum class seat_action { admit, evict_ghost, refuse };

// A connecting client presents a steamid another slot already holds. If that other slot is a
// LOST link (the crashed body still seated because the world is frozen, or the engine's 40 s have
// not run out), it is the same person coming back: kick the ghost, admit the new connection.
// Anything else is two live clients claiming one account and stays refused.
inline seat_action seat_conflict(int other_slot, link_phase other_phase, bool enabled) {
    if (other_slot < 0) return seat_action::admit;
    if (enabled && other_phase == link_phase::lost) return seat_action::evict_ghost;
    return seat_action::refuse;
}

// ------------------------------------------------------------------ 4. the restore --
constexpr int kCounterMax = 100000000;   // the same bound player_stats() reads with
inline bool plausible_counter(long long v) { return v >= 0 && v <= kCounterMax; }

// What gets written. Score is put back exactly (a rejoin's 500, or the "died" penalty, is what we
// are undoing). The other counters only ever go up, so the new connection keeps anything it has
// already earned above the old value.
inline counters merge_restore(const counters& current, const counters& restored) {
    counters out = current;
    if (!restored.have) return out;
    out.have = true;
    out.score = restored.score;
    auto up = [](int a, int b) { return a > b ? a : b; };
    out.kills = up(current.kills, restored.kills);
    out.assists = up(current.assists, restored.assists);
    out.downs = up(current.downs, restored.downs);
    out.revives = up(current.revives, restored.revives);
    out.headshots = up(current.headshots, restored.headshots);
    return out;
}

struct restore_cfg {
    uint32_t settle_ms = 1500;          // world-running time after the spawn before we write
    uint32_t expire_ms = 15 * 60000;    // a restore nobody could apply is dropped after this
};

enum class restore_step { idle, wait, apply, expire };

struct pending_restore {
    bool active = false;
    counters values;
    std::string id;                // the host's command id (for the log; the reply went at once)
    uint32_t queued_ms = 0;
    bool alive_seen = false;
    uint32_t settled_ms = 0;       // world-running ms accumulated since the spawn was seen
    uint32_t last_ms = 0;
};

// One poll. `alive`: the slot's player entity is alive (it spawned). Settling counts only while
// the world runs -- a frozen world runs no spawn script, so there is nothing to wait for then.
inline restore_step step_restore(pending_restore& p, bool connected, bool alive, bool frozen,
                                 uint32_t now_ms, const restore_cfg& c = restore_cfg{}) {
    if (!p.active) return restore_step::idle;
    if (now_ms - p.queued_ms >= c.expire_ms) {
        p.active = false;
        return restore_step::expire;
    }
    if (!connected || !alive) {
        p.alive_seen = false;
        p.settled_ms = 0;
        p.last_ms = now_ms;
        return restore_step::wait;
    }
    if (!p.alive_seen) {
        p.alive_seen = true;
        p.settled_ms = 0;
        p.last_ms = now_ms;
        return restore_step::wait;
    }
    if (!frozen) p.settled_ms += now_ms - p.last_ms;
    p.last_ms = now_ms;
    if (p.settled_ms >= c.settle_ms) {
        p.active = false;
        return restore_step::apply;
    }
    return restore_step::wait;
}

}  // namespace enw::reconnect
