// Round 1 waits for the whole party, and a late spawn that lands outside the map is moved to
// where a teammate stood (dedi.md section 29/30, docs/kickstart/cloud-brief-parties.md task 1).
// PURE: no engine, no Windows. Unit-tested in server/tests/expected_players_test.cpp; the engine
// side is expected_players.cpp (the getnumexpectedplayers stub) and spawn_rescue.cpp.
//
// THE BUG: `_load.gsc all_players_connected()` sets its flag when getnumconnectedplayers() ==
// getnumexpectedplayers(). getnumexpectedplayers (0x52E910) counts PARTY members when
// `onlinegame` is set, and returns 1 when there is no party. The box runs onlinegame 1 with no
// party, so round 1 started as soon as the FIRST player had loaded (Hijacked, m_10ca7b6b).
//
// THE FIX: the host tells the game how many players the lease names (game link
// `{"t":"expected_players","n":N}`), and we answer getnumexpectedplayers ourselves:
//   * before the deadline: max(1, lease_n, clients_connecting)
//   * after it:            max(1, clients_connecting)   -- a no-show stops blocking; a client that
//                                                          is mid-load is still waited for, as the
//                                                          stock LAN path does
//   * lease_n unknown (0): max(1, clients_connecting)   -- the stock non-online branch
#pragma once

#include <cstddef>
#include <cstdint>

namespace enw::expected {

// B's default (cloud-brief-parties.md section 3): round 1 waits up to 90 s for the lease's players.
inline constexpr uint32_t kRound1WaitMs = 90000;
// The largest party a lease can name (4 players, WaW co-op).
inline constexpr int kMaxPlayers = 4;

inline int imax(int a, int b) { return a > b ? a : b; }

// lease_n: players the lease names, 0 = unknown. clients_connecting: svs.clients with state > 1.
inline int expected_players(int lease_n, int clients_connecting, uint32_t ms_since_map_loaded,
                            uint32_t deadline_ms = kRound1WaitMs) {
    if (lease_n < 0) lease_n = 0;
    if (lease_n > kMaxPlayers) lease_n = kMaxPlayers;
    if (clients_connecting < 0) clients_connecting = 0;
    const int stock = imax(1, clients_connecting);
    if (lease_n == 0 || ms_since_map_loaded >= deadline_ms) return stock;
    return imax(stock, lease_n);
}

// When the wait started. The engine gives us no "map loaded" clock we trust, so the window is
// anchored to what we can see: the first time the script asks (the _load.gsc poll starts right
// after the map loads), or the lease message arriving, whichever is LATER (a warm instance sits
// in the poll with nobody expected until a lease is handed to it). Once round 1 has started,
// the answer is the stock one. A poll that restarts after a quiet gap is a new map load
// (map_restart re-runs _load.gsc), so it opens a new window.
struct wait_window {
    // A quiet gap longer than this between two polls means the poll loop ended and a new one began.
    static constexpr uint32_t kNewPollGapMs = 5000;

    bool open = false;
    bool round_started = false;
    uint32_t anchor_ms = 0;
    uint32_t last_call_ms = 0;
    bool called = false;

    // The script asked. Returns ms since the window opened; `deadline + 1` when there is no open window.
    uint32_t on_call(uint32_t now, uint32_t deadline_ms = kRound1WaitMs) {
        if (called && now - last_call_ms > kNewPollGapMs && round_started) {
            round_started = false;   // map_restart: _load.gsc polls again
            open = false;
        }
        called = true;
        last_call_ms = now;
        if (round_started) return deadline_ms + 1;
        if (!open) { open = true; anchor_ms = now; }
        return now - anchor_ms;
    }
    // A lease was handed to this instance: the wait for its players starts now.
    void on_lease(uint32_t now) {
        if (round_started) return;
        open = true;
        anchor_ms = now;
    }
    void on_round_started() { round_started = true; open = false; }
};

}  // namespace enw::expected

// ---------------------------------------------------------------------------------------------
// Late-spawn rescue. A player who spawns AFTER round 1 started (a mid-game joiner, by design once
// a party member can join a running game) on a map with no usable fallback spawn lands at the
// map origin: Hijacked put the friend at (0, 0, -4), on nothing, and they fell to z -272 under the
// floor where zombies cannot reach. We move such a player to a spot a living teammate stood on (on
// the world) at least 1 s ago and at least 40 units from every player now.
// ---------------------------------------------------------------------------------------------
namespace enw::rescue {

inline constexpr uint32_t kCrumbEveryMs = 250;      // one breadcrumb per player per 250 ms
inline constexpr size_t kCrumbs = 32;               // 8 s of history
inline constexpr uint32_t kCrumbMinAgeMs = 1000;    // a spot stood on at least 1 s ago
inline constexpr float kClearance = 40.f;           // from every player now
inline constexpr uint32_t kWatchMs = 3000;          // watch a late spawn for 3 s
inline constexpr float kFallLimit = 128.f;          // more than 128 units below the spawn point
// "On nothing at spawn": a spawn point a little above the floor is on nothing for a frame or two
// while the player drops onto it. The rescue fires only when the player is STILL on nothing this
// long after spawning (a choice made here, not in the brief; set 0 for the brief's literal rule).
inline constexpr uint32_t kOnNothingGraceMs = 500;

struct vec3 { float x = 0, y = 0, z = 0; };

inline float dist2(const vec3& a, const vec3& b) {
    const float dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

struct crumb { vec3 at; uint32_t ms = 0; bool used = false; };

// A small ring of where one player stood on the world.
struct crumb_ring {
    crumb c[kCrumbs];
    size_t next = 0;
    uint32_t last_ms = 0;
    bool any = false;

    // Called every frame; keeps a crumb every kCrumbEveryMs while the player is alive and on the world.
    void offer(const vec3& at, uint32_t now, bool alive, bool on_world) {
        if (!alive || !on_world) return;
        if (any && now - last_ms < kCrumbEveryMs) return;
        c[next] = crumb{at, now, true};
        next = (next + 1) % kCrumbs;
        last_ms = now;
        any = true;
    }
    void clear() { *this = crumb_ring{}; }
};

// What we know about a late spawn over its first kWatchMs.
struct spawn_watch {
    bool active = false;
    bool late = false;          // spawned after round 1 started
    vec3 spawn;
    uint32_t spawn_ms = 0;
    bool on_nothing_at_spawn = false;
    bool rescued = false;

    void start(const vec3& at, uint32_t now, bool after_round1, bool on_nothing) {
        *this = spawn_watch{};
        active = true;
        late = after_round1;
        spawn = at;
        spawn_ms = now;
        on_nothing_at_spawn = on_nothing;
    }
};

enum class why { none, origin, on_nothing, fell };

inline const char* why_name(why w) {
    switch (w) {
        case why::origin: return "spawned at the map origin";
        case why::on_nothing: return "spawned on nothing";
        case why::fell: return "fell more than 128 units below the spawn point";
        default: return "none";
    }
}

// Should this player be rescued now? `at` and `on_nothing_now` are this frame's.
inline why needs_rescue(const spawn_watch& w, const vec3& at, bool on_nothing_now, uint32_t now) {
    if (!w.active || !w.late || w.rescued) return why::none;
    const uint32_t since = now - w.spawn_ms;
    if (since > kWatchMs) return why::none;
    if (w.spawn.x == 0.f && w.spawn.y == 0.f) return why::origin;
    if (w.on_nothing_at_spawn && on_nothing_now && since >= kOnNothingGraceMs) return why::on_nothing;
    if (w.spawn.z - at.z > kFallLimit) return why::fell;
    return why::none;
}

// The spot: the NEWEST crumb of any other living teammate that is at least kCrumbMinAgeMs old and
// at least kClearance from every player now. `now_at` holds every player's position this frame
// (the rescued player's included: the spot must not be where they already are).
inline bool pick_spot(const crumb_ring* rings, const bool* teammate_alive, size_t n_players, size_t self,
                      const vec3* now_at, const bool* present, uint32_t now, vec3* out) {
    bool found = false;
    uint32_t best_ms = 0;
    const float clear2 = kClearance * kClearance;
    for (size_t p = 0; p < n_players; ++p) {
        if (p == self || !present[p] || !teammate_alive[p]) continue;
        for (const crumb& cr : rings[p].c) {
            if (!cr.used || now - cr.ms < kCrumbMinAgeMs) continue;
            if (found && cr.ms <= best_ms) continue;
            bool clear = true;
            for (size_t q = 0; q < n_players && clear; ++q)
                if (present[q] && dist2(cr.at, now_at[q]) < clear2) clear = false;
            if (!clear) continue;
            found = true;
            best_ms = cr.ms;
            *out = cr.at;
        }
    }
    return found;
}

}  // namespace enw::rescue
