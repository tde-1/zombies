// replay-events-v1: the pure half. No engine, no windows.h, no json.hpp (which pulls
// windows.h and asserts x86), so server/tests/replay_events_test.cpp builds with any C++17
// compiler and proves the rules without a game.
//
// The DLL half (replay.cpp + t4_bind.cpp) reads the engine once per server frame and fills a
// `frame_in`; `tracker::step` turns consecutive frames into the events the 3D viewer needs:
//
//   weapon  {t,ms,slot,name,pap,raw}          spawn + every weapon switch
//   fire    {t,ms,slot,name}                  one per shot (EV_FIRE_WEAPON / _LASTSHOT)
//   hit     {t,ms,slot,zid,part,dmg[,kill]}   a player's damage to zombie `zid`
//   damage  {t,ms,slot,by,hp}                 the player took damage; hp after
//   pap     {t,ms,slot,name,raw,state}        pack-a-punch start / done
//   powerup {t,ms,id,kind,x,y,z,state[,by][,until]}
//
// Wire conventions are the existing game-link ones (docs/protocol/replay-events-v1.md):
// `t` is the event TYPE, `ms` is the time (ms since the game link started, the same clock
// every other event and every `snap` uses), `slot` is the player slot. The lane brief wrote
// these as `t` (time) and `pid`; the stream already used those two names for something
// else, so the brief's `t` is our `ms` and its `pid` is our `slot`. Every other field name
// is exactly the brief's.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

namespace enw::replay_ev {

// The `replay_events` value in map_loaded / the .enwr header. 1: replay-events-v1. 2 (2026-09-23,
// lane RV): v1 + the per-player `ads` snap field (ps.fWeaponPosFrac, replay-events-v1.md section 3).
// Additive: a v1 reader ignores the field, and nothing compares the number for equality.
constexpr int kVersion = 2;
constexpr int kMaxPlayers = 4;

// ps.fWeaponPosFrac (0 = hip, 1 = fully aimed down the sights) as the snap writes it: tenths,
// 0..10, so a 0.2-0.4 s transition is a handful of values and a held aim is one. -1 = unusable
// (NaN, or a read that is not a fraction at all), and then nothing is written.
inline int ads_tenths(float frac) {
    if (!(frac == frac)) return -1;               // NaN
    if (frac < -0.01f || frac > 1.01f) return -1; // not a fraction: the offset is wrong, say nothing
    if (frac < 0.0f) frac = 0.0f;
    if (frac > 1.0f) frac = 1.0f;
    return static_cast<int>(frac * 10.0f + 0.5f);
}
constexpr int kMaxEnt = 1024;               // MAX_GENTITIES
constexpr int kEvFireWeapon = 0x1C;         // [V] 0x420C8A: `mov ecx,0x1D / jne / mov ecx,0x1C / call BG_AddEvent`
constexpr int kEvFireWeaponLastShot = 0x1D; // [V] same site; T4SP enums.hpp agrees
constexpr int kFireCapPerSec = 40;          // per player, per wall second (the brief's cap)
constexpr uint32_t kTimedPowerupMs = 30000; // zombie_powerup_{insta_kill,point_doubler}_time = 30
constexpr float kPickupRadius = 110.0f;     // script grabs at < 64; + 0.1 s wait + a sprint step
constexpr int kDeathWaitFrames = 2;         // how long a death waits for the kills/headshots counters

// ------------------------------------------------------------------ JSON --
// A minimal line builder. Every string here is an engine identifier or one of ours, but
// escape anyway: a custom map can name a weapon anything.
class line {
public:
    explicit line(const char* type) { s_ = "{\"t\":\""; s_ += type; s_ += '"'; }
    line& i(const char* k, long long v) { key(k); s_ += std::to_string(v); return *this; }
    line& b(const char* k, bool v) { key(k); s_ += v ? "true" : "false"; return *this; }
    line& n(const char* k) { key(k); s_ += "null"; return *this; }
    line& f1(const char* k, float v) {   // one decimal, like every position in a snap
        key(k);
        char buf[32];
        std::snprintf(buf, sizeof buf, "%.1f", static_cast<double>(v));
        s_ += buf;
        return *this;
    }
    line& s(const char* k, std::string_view v) {
        key(k);
        s_ += '"';
        for (char c : v) {
            const unsigned char u = static_cast<unsigned char>(c);
            if (c == '"' || c == '\\') { s_ += '\\'; s_ += c; }
            else if (u < 0x20) { char e[8]; std::snprintf(e, sizeof e, "\\u%04x", u); s_ += e; }
            else s_ += c;
        }
        s_ += '"';
        return *this;
    }
    std::string done() { s_ += '}'; return std::move(s_); }

private:
    void key(const char* k) { s_ += ",\""; s_ += k; s_ += "\":"; }
    std::string s_;
};

// ---------------------------------------------------------------- labels --
inline bool starts_with(std::string_view s, std::string_view p) {
    return s.size() >= p.size() && s.compare(0, p.size(), p) == 0;
}
inline bool ends_with(std::string_view s, std::string_view p) {
    return s.size() >= p.size() && s.compare(s.size() - p.size(), p.size(), p) == 0;
}

struct weapon_label {
    std::string name;   // "thompson", "ray_gun", "30cal_bipod"
    bool pap = false;   // the raw name ended in _upgraded
};

// The engine names a weapon `zombie_thompson_upgraded`, `ray_gun`, `ptrs41_zombie`,
// `colt`. The viewer wants the gun: strip `_upgraded` (-> pap), then a `zombie_` prefix or a
// `_zombie` suffix. `raw` always travels beside it, so nothing is lost.
inline weapon_label label_weapon(std::string_view raw) {
    weapon_label out;
    std::string_view s = raw;
    if (ends_with(s, "_upgraded")) { s.remove_suffix(9); out.pap = true; }
    if (starts_with(s, "zombie_") && s.size() > 7) s.remove_prefix(7);
    if (ends_with(s, "_zombie") && s.size() > 7) s.remove_suffix(7);
    out.name.assign(s.data(), s.size());
    return out;
}

// The knuckle-crack "weapon" do_knuckle_crack() gives the player for the pack-a-punch
// animation (_zombiemode_perks.gsc on every stock map that has the machine).
inline bool is_pap_animation(std::string_view raw) { return raw == "zombie_knuckle_crack"; }

enum class part { unknown, head, body };

// The actor's damageHitLoc is a SCRIPT STRING ("head", "helmet", "torso_upper", ...), set
// by Actor_Pain 0x4B697D and Actor_Die 0x4B6BAD from the hit-location name table.
inline part part_from_hitloc(std::string_view loc) {
    if (loc.empty() || loc == "none") return part::unknown;
    if (loc == "head" || loc == "helmet" || loc == "neck") return part::head;
    return part::body;
}
inline const char* part_name(part p) { return p == part::head ? "head" : "body"; }

// The stock power-up models (add_zombie_powerup in _zombiemode_powerups.gsc; the fire sale
// and death machine are from later games and appear on custom maps only). nullptr = not a
// power-up.
inline const char* powerup_kind(std::string_view model) {
    if (model == "zombie_ammocan") return "max_ammo";
    if (model == "zombie_skull") return "insta_kill";
    if (model == "zombie_x2_icon") return "double_points";
    if (model == "zombie_bomb") return "nuke";
    if (model == "zombie_carpenter") return "carpenter";
    if (model == "zombie_firesale" || model == "zombie_pickup_firesale") return "fire_sale";
    if (model == "zombie_pickup_minigun" || model == "zombie_pickup_death_machine") return "death_machine";
    if (starts_with(model, "zombie_pickup_")) return "other";
    return nullptr;
}
inline bool powerup_is_timed(std::string_view kind) {
    return kind == "insta_kill" || kind == "double_points";
}

// ----------------------------------------------------------------- input --
struct player_in {
    bool present = false;      // connected, has an entity this frame
    bool alive = false;
    int health = 0;
    float pos[3] = {0, 0, 0};
    int weapon = 0;            // ps.weapon; 0 = none
    std::string weapon_raw;    // bg_weaponDefs[weapon]->szInternalName; empty = unresolved
    bool have_ammo = false;
    int clip = 0, ammo = 0;
    bool have_events = false;  // ps.eventSequence / ps.events[4] were read
    int event_seq = 0;
    int events[4] = {0, 0, 0, 0};
    int last_attacker = -1;    // sentient->lastAttacker as an entity number, -1 none
    bool have_stats = false;   // the native kills / headshots counters (referee.md 16)
    int kills = 0, headshots = 0;
};

struct zombie_in {
    int id = -1;               // entity number
    int health = 0;
    int last_attacker = -1;    // entity number, -1 unknown
    part hit = part::unknown;  // the actor's last damageHitLoc
};

struct powerup_in {
    int id = -1;
    std::string kind;
    float pos[3] = {0, 0, 0};
};

struct frame_in {
    uint32_t ms = 0;
    player_in players[kMaxPlayers];
    std::vector<zombie_in> zombies;   // live this frame (health > 0)
    std::vector<zombie_in> gone;      // live last frame, not now: what could still be read
    bool powerups_valid = false;      // false = the model table is not bound; no powerup events
    std::vector<powerup_in> powerups;
};

struct counters {
    uint64_t weapon = 0, fire = 0, fire_capped = 0, hit = 0, kill_hit = 0, kill_unattributed = 0,
             damage = 0, pap = 0, powerup = 0;
};

// --------------------------------------------------------------- tracker --
class tracker {
public:
    tracker() { reset(); }

    // A new match: everything is forgotten, the next frame is a baseline.
    void reset() {
        for (auto& p : p_) p = player_prev{};
        for (int i = 0; i < kMaxEnt; ++i) { zhp_[i] = -1; pu_[i] = pu_prev{}; scenery_[i] = false; }
        live_.clear();
        pending_.clear();
        pu_baseline_ = false;
        c_ = counters{};
    }

    // Zombies that were live after the previous step. The DLL reads what it still can for
    // the ones missing now and hands them back in `frame_in::gone`.
    const std::vector<int>& live_ids() const { return live_; }
    const counters& stats() const { return c_; }

    void step(const frame_in& f, std::vector<std::string>& out) {
        for (int s = 0; s < kMaxPlayers; ++s) step_player(s, f, out);
        step_zombies(f, out);
        if (f.powerups_valid) step_powerups(f, out);
        for (int s = 0; s < kMaxPlayers; ++s) {
            const auto& in = f.players[s];
            if (in.present && in.have_stats) { p_[s].kills = in.kills; p_[s].headshots = in.headshots; p_[s].have_stats = true; }
        }
    }

private:
    struct player_prev {
        bool seen = false;
        bool alive = false;
        int health = 0;
        int weapon = 0;
        std::string raw;
        bool have_seq = false;
        int seq = 0;
        bool have_stats = false;
        int kills = 0, headshots = 0;
        int credit_kills = 0, credit_hs = 0, credit_age = 0;   // counter moves not yet matched to a death
        uint32_t fire_window = 0;
        int fire_in_window = 0;
        std::vector<std::string> upgraded;   // raw names already announced as `pap done`
    };
    struct pending_death {
        zombie_in z;
        uint32_t ms = 0;
        int dmg = 0;
        int frames = 0;
    };
    struct pu_prev {
        bool live = false;
        std::string kind;
        float pos[3] = {0, 0, 0};
    };

    std::string weapon_name_for_fire(const player_in& in) const {
        if (!in.weapon_raw.empty()) return label_weapon(in.weapon_raw).name;
        return "#" + std::to_string(in.weapon);
    }

    void step_player(int s, const frame_in& f, std::vector<std::string>& out) {
        const player_in& in = f.players[s];
        player_prev& p = p_[s];
        if (!in.present) {
            // Gone: the next time the slot is filled is a spawn, and the fire baseline restarts.
            const auto keep = std::move(p.upgraded);
            p = player_prev{};
            p.upgraded = keep;   // a reconnect does not re-announce a gun it already upgraded
            return;
        }
        const bool spawn = !p.seen || (!p.alive && in.alive);

        // ---- weapon + pap -------------------------------------------------------
        if (in.weapon != 0 && !in.weapon_raw.empty() && (spawn || in.weapon != p.weapon || in.weapon_raw != p.raw)) {
            const weapon_label l = label_weapon(in.weapon_raw);
            out.push_back(line("weapon").i("ms", f.ms).i("slot", s).s("name", l.name).b("pap", l.pap)
                              .s("raw", in.weapon_raw).done());
            ++c_.weapon;
            if (is_pap_animation(in.weapon_raw) && !p.raw.empty() && !is_pap_animation(p.raw)) {
                const weapon_label from = label_weapon(p.raw);
                out.push_back(line("pap").i("ms", f.ms).i("slot", s).s("name", from.name).s("raw", p.raw)
                                  .s("state", "start").done());
                ++c_.pap;
            }
            if (l.pap && !contains(p.upgraded, in.weapon_raw)) {
                p.upgraded.push_back(in.weapon_raw);
                out.push_back(line("pap").i("ms", f.ms).i("slot", s).s("name", l.name).s("raw", in.weapon_raw)
                                  .s("state", "done").done());
                ++c_.pap;
            }
            p.weapon = in.weapon;
            p.raw = in.weapon_raw;
        } else if (in.weapon == 0) {
            p.weapon = 0;   // switching back from "no weapon" is a switch
        }

        // ---- fire ---------------------------------------------------------------
        if (in.have_events) {
            if (p.have_seq) {
                const int n = (in.event_seq - p.seq) & 0xFF;   // T4 wraps eventSequence at 0xFF (0x410341)
                const int k = n < 4 ? n : 4;                    // the ring only holds the last four
                for (int i = 0; i < k; ++i) {
                    const int e = in.events[(in.event_seq - k + i) & 3];
                    if (e != kEvFireWeapon && e != kEvFireWeaponLastShot) continue;
                    const uint32_t win = f.ms / 1000;
                    if (win != p.fire_window) { p.fire_window = win; p.fire_in_window = 0; }
                    if (p.fire_in_window >= kFireCapPerSec) { ++c_.fire_capped; continue; }
                    ++p.fire_in_window;
                    out.push_back(line("fire").i("ms", f.ms).i("slot", s).s("name", weapon_name_for_fire(in)).done());
                    ++c_.fire;
                }
            }
            p.have_seq = true;
            p.seq = in.event_seq;
        } else {
            p.have_seq = false;
        }

        // ---- damage taken -------------------------------------------------------
        if (p.seen && p.alive && in.health < p.health) {
            line l("damage");
            l.i("ms", f.ms).i("slot", s);
            if (in.last_attacker >= kMaxPlayers && in.last_attacker < kMaxEnt && is_zombie_id(in.last_attacker, f))
                l.i("by", in.last_attacker);
            else
                l.n("by");
            l.i("hp", in.health > 0 ? in.health : 0);
            out.push_back(l.done());
            ++c_.damage;
        }

        // ---- kill credits for step_zombies --------------------------------------
        if (in.have_stats && p.have_stats) {
            const int dk = in.kills - p.kills, dh = in.headshots - p.headshots;
            if (dk > 0) { p.credit_kills += dk; p.credit_age = 0; }
            if (dh > 0) { p.credit_hs += dh; p.credit_age = 0; }
        }

        p.seen = true;
        p.alive = in.alive;
        p.health = in.health;
    }

    bool is_zombie_id(int id, const frame_in& f) const {
        if (zhp_[id] >= 0) return true;
        for (const auto& z : f.zombies) if (z.id == id) return true;
        for (const auto& z : f.gone) if (z.id == id) return true;
        return false;
    }

    void step_zombies(const frame_in& f, std::vector<std::string>& out) {
        // Deaths first: their remaining health is what the last hit took.
        for (const auto& g : f.gone) {
            if (g.id < 0 || g.id >= kMaxEnt) continue;
            pending_death d;
            d.z = g;
            d.ms = f.ms;
            d.dmg = zhp_[g.id] > 0 ? zhp_[g.id] : 0;
            pending_.push_back(d);
            zhp_[g.id] = -1;
        }

        live_.clear();
        for (const auto& z : f.zombies) {
            if (z.id < 0 || z.id >= kMaxEnt) continue;
            const int prev = zhp_[z.id];
            if (prev >= 0 && z.health < prev && z.last_attacker >= 0 && z.last_attacker < kMaxPlayers &&
                f.players[z.last_attacker].present) {
                out.push_back(line("hit").i("ms", f.ms).i("slot", z.last_attacker).i("zid", z.id)
                                  .s("part", part_name(z.hit)).i("dmg", prev - z.health).done());
                ++c_.hit;
            }
            zhp_[z.id] = z.health;
            live_.push_back(z.id);
        }

        // Resolve deaths against the attacker the engine recorded and the counters the
        // scripts move (kills / headshots can land a frame later: they are bumped by a
        // script thread waiting on the death notify).
        for (size_t i = 0; i < pending_.size();) {
            pending_death& d = pending_[i];
            int who = (d.z.last_attacker >= 0 && d.z.last_attacker < kMaxPlayers) ? d.z.last_attacker : -1;
            if (who < 0) {
                int only = -1, n = 0;
                for (int s = 0; s < kMaxPlayers; ++s) if (p_[s].credit_kills > 0) { only = s; ++n; }
                if (n == 1) who = only;
            }
            part pt = d.z.hit;
            bool ready = false;
            // With the counters bound, a death is only a player's kill once that player's
            // `kills` moved: a zombie the round-end cleanup deletes still carries the last
            // player who shot it, and that is not a kill.
            const bool credited = who >= 0 && (!p_[who].have_stats || p_[who].credit_kills > 0);
            if (credited) {
                if (pt == part::unknown) {
                    if (p_[who].credit_hs > 0) pt = part::head;
                    else if (d.frames >= kDeathWaitFrames) pt = part::body;
                }
                ready = pt != part::unknown;
            }
            if (ready) {
                if (p_[who].credit_kills > 0) --p_[who].credit_kills;
                if (pt == part::head && p_[who].credit_hs > 0) --p_[who].credit_hs;
                out.push_back(line("hit").i("ms", d.ms).i("slot", who).i("zid", d.z.id).s("part", part_name(pt))
                                  .i("dmg", d.dmg).b("kill", true).done());
                ++c_.hit;
                ++c_.kill_hit;
                pending_.erase(pending_.begin() + static_cast<long>(i));
                continue;
            }
            if (++d.frames > kDeathWaitFrames) {   // nuke, trap, fall, a mod's own kill: nobody's hit
                ++c_.kill_unattributed;
                pending_.erase(pending_.begin() + static_cast<long>(i));
                continue;
            }
            ++i;
        }
        // Counter moves nobody claimed within a few frames are dropped, so a stale credit
        // can never be pinned on a later death.
        for (auto& p : p_) {
            if ((p.credit_kills || p.credit_hs) && ++p.credit_age > kDeathWaitFrames + 1) {
                p.credit_kills = p.credit_hs = 0;
                p.credit_age = 0;
            }
        }
    }

    void step_powerups(const frame_in& f, std::vector<std::string>& out) {
        bool now[kMaxEnt] = {};
        if (!pu_baseline_) {
            // Whatever is on the map at the first look is scenery (a model a mapper placed),
            // never a drop. Only entities that appear later are power-ups.
            for (const auto& p : f.powerups) if (p.id >= 0 && p.id < kMaxEnt) scenery_[p.id] = true;
            pu_baseline_ = true;
            return;
        }
        for (const auto& p : f.powerups) {
            if (p.id < 0 || p.id >= kMaxEnt) continue;
            now[p.id] = true;
            if (scenery_[p.id]) continue;
            pu_prev& q = pu_[p.id];
            if (q.live && q.kind != p.kind) finish_powerup(p.id, f, out);   // an id reused inside one frame
            if (!q.live) {
                q.live = true;
                q.kind = p.kind;
                out.push_back(line("powerup").i("ms", f.ms).i("id", p.id).s("kind", p.kind)
                                  .f1("x", p.pos[0]).f1("y", p.pos[1]).f1("z", p.pos[2]).s("state", "spawn").done());
                ++c_.powerup;
            }
            std::memcpy(q.pos, p.pos, sizeof q.pos);
        }
        for (int id = 0; id < kMaxEnt; ++id) {
            if (now[id]) continue;
            scenery_[id] = false;
            if (pu_[id].live) finish_powerup(id, f, out);
        }
    }

    void finish_powerup(int id, const frame_in& f, std::vector<std::string>& out) {
        pu_prev& q = pu_[id];
        int by = -1;
        float best = kPickupRadius * kPickupRadius;
        for (int s = 0; s < kMaxPlayers; ++s) {
            const auto& pl = f.players[s];
            if (!pl.present) continue;
            const float dx = pl.pos[0] - q.pos[0], dy = pl.pos[1] - q.pos[1], dz = pl.pos[2] - q.pos[2];
            const float d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < best) { best = d2; by = s; }
        }
        line l("powerup");
        l.i("ms", f.ms).i("id", id).s("kind", q.kind).f1("x", q.pos[0]).f1("y", q.pos[1]).f1("z", q.pos[2]);
        if (by >= 0) {
            l.s("state", "pickup").i("by", by);
            if (powerup_is_timed(q.kind)) l.i("until", static_cast<long long>(f.ms) + kTimedPowerupMs);
        } else {
            l.s("state", "expire");
        }
        out.push_back(l.done());
        ++c_.powerup;
        q = pu_prev{};
    }

    static bool contains(const std::vector<std::string>& v, const std::string& s) {
        for (const auto& x : v) if (x == s) return true;
        return false;
    }

    player_prev p_[kMaxPlayers];
    int zhp_[kMaxEnt];
    std::vector<int> live_;
    std::vector<pending_death> pending_;
    pu_prev pu_[kMaxEnt];
    bool scenery_[kMaxEnt];
    bool pu_baseline_ = false;
    counters c_;
};

}  // namespace enw::replay_ev
