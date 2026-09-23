// solo_parity: does a game on our server play like World at War solo? (lane G2, dedi.md section 28)
//
// Runs in every process that runs a server frame (a dedicated server, and a solo/listen game,
// which is what makes the listen game the reference). Read only; nothing here changes the game.
//
// WHAT IT WATCHES, per player, once per server frame:
//   * the spawn: position, health/maxhealth, what the player stands on;
//   * every health DROP: how much, and the last attacker G_Damage recorded (a zombie, or none:
//     drowning, falling and scripted damage have none);
//   * what the player stands on: playerState.groundEntityNum (1022 = the world, 1023 = nothing),
//     and when it is an entity, which one;
//   * how long a live PM_NORMAL player has been off the ground.
//
// THE SELF-CHECK (every map, every game): solo_parity_rules.hpp holds what solo WaW gives, read
// out of the stock scripts. A spawn below full health, a player off the ground for 5 s, and (at
// spawn + 5 s, after _gameskill has scaled for the player count) g_gameskill, g_player_maxhealth,
// player_damageMultiplier, player_meleeDamageMultiplier and, on a dedicated server,
// r_gfxopt_water_simulation are compared. A difference is a `solo_parity: MISMATCH` line in the
// DLL log (the telemetry rule `solo_parity` flags it) and a warn `log` on the game link.
//
// It exists because on 2026-09-23 B's games on nacht_reimagined and zm_nuked were decided by a
// server-only water surface at z=0 (water_sim_off.cpp) and nothing we had could see it: the
// replay showed "down", the host showed "game over", and the player was swimming.
//
// Offsets: T4SP-Server-Plugin `main` structs.hpp -- gclient_s is 0x2348 (the stride t4_bind.cpp
// verified) and starts with playerState_s; gentity_s fields as in shared/t4/structs.hpp.
//
// Clean room: our own code.
#include "../../../shared/core/component.hpp"
#include "../../../shared/core/game.hpp"
#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../../../shared/core/memory.hpp"
#include "../referee/t4_bind.hpp"
#include "dedicated.hpp"
#include "solo_parity_rules.hpp"

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace enw::dedi {

int water_sim_value();   // water_sim_off.cpp

namespace {

constexpr uintptr_t kGEntities = 0x176C6F0;
constexpr uintptr_t kGentityStride = 0x378;
constexpr size_t kGentClient = 0x180;
constexpr size_t kGentSentient = 0x188;
constexpr size_t kGentModel = 0x198;
constexpr size_t kGentClassname = 0x1A0;
constexpr size_t kGentTargetname = 0x1A8;
constexpr size_t kGentHealth = 0x1C8;
constexpr size_t kGentMaxHealth = 0x1CC;
constexpr size_t kGentLinked = 0x118;             // entityShared_s.linked
constexpr size_t kGentMins = 0x118 + 0x14;
constexpr size_t kGentMaxs = 0x118 + 0x20;
constexpr size_t kGentContents = 0x118 + 0x2C;
constexpr size_t kGentAbsMin = 0x118 + 0x30;
constexpr size_t kGentAbsMax = 0x118 + 0x3C;
constexpr size_t kGentOrigin = 0x160;
constexpr size_t kSentientLastAttacker = 0x2C;

// playerState_s (gclient + 0)
constexpr size_t kPsPmType = 0x4;
constexpr size_t kPsOrigin = 0x20;
constexpr size_t kPsVelocity = 0x2C;
constexpr size_t kPsGravity = 0x70;
constexpr size_t kPsSpeed = 0x78;
constexpr size_t kPsGroundEnt = 0x88;

constexpr uintptr_t kModelNames = 0x2350F40;   // uint16 script-string id per model index
constexpr uintptr_t kScrStringTablePtr = 0x3702390;

constexpr int kMaxClients = 4;
constexpr int kWorld = 1022;
constexpr int kNone = 1023;

template <typename T>
bool peek(uintptr_t addr, T* out) { return memory::read(enw::at(addr), out); }

std::string sl_string(uint16_t id) {
    if (!id) return {};
    uint32_t table = 0;
    if (!peek(kScrStringTablePtr, &table) || !table) return {};
    const uintptr_t node = table + static_cast<uintptr_t>(id) * 0xC + 4;
    char buf[96] = {};
    if (!memory::is_readable(reinterpret_cast<void*>(node), sizeof buf - 1)) return {};
    std::memcpy(buf, reinterpret_cast<const void*>(node), sizeof buf - 1);
    for (char& c : buf) { if (c == 0) break; if (c < 0x20 || c > 0x7E) return {}; }
    return buf;
}

std::string ent_desc(int e) {
    if (e == kWorld) return "world";
    if (e == kNone) return "nothing";
    if (e < 0 || e >= 1024) return "?" + std::to_string(e);
    const uintptr_t ent = kGEntities + static_cast<uintptr_t>(e) * kGentityStride;
    uint16_t cls = 0, model = 0;
    int32_t tn = 0;
    float o[3] = {0, 0, 0};
    peek(ent + kGentClassname, &cls);
    peek(ent + kGentTargetname, &tn);
    peek(ent + kGentModel, &model);
    peek(ent + kGentOrigin, &o);
    std::string m;
    if (model > 0 && model < 0x200) {
        uint16_t mid = 0;
        if (peek(kModelNames + static_cast<uintptr_t>(model) * 2, &mid)) m = sl_string(mid);
    }
    char b[320];
    std::snprintf(b, sizeof b, "ent %d '%s' targetname '%s' model '%s' at (%.1f %.1f %.1f)", e,
                  sl_string(cls).c_str(), sl_string(static_cast<uint16_t>(tn & 0xFFFF)).c_str(), m.c_str(),
                  o[0], o[1], o[2]);
    return b;
}

struct slot_state {
    bool spawned = false;
    uint32_t spawn_ms = 0;
    int health = -1;
    int ground = -2;
    int pm_type = -1;
    uint32_t last_summary = 0;
    uint32_t air_since = 0;
    int32_t cmd_time_at_air = 0;
    bool floating_flagged = false;
    bool env_checked = false;
    uint32_t frames = 0, on_world = 0, on_ent = 0, in_air = 0;
};

slot_state g_s[kMaxClients];
uint64_t g_mismatches = 0;

void say(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    ENW_INFO("%s", buf);
}

void mismatch(int slot, const std::string& what) {
    ++g_mismatches;
    ENW_WARN("solo_parity: MISMATCH slot %d: %s", slot, what.c_str());
    game_link::get().send_log("warn", "solo_parity: MISMATCH slot %d: %s", slot, what.c_str());
}

// Which linked entities does the player's box touch? Said once, when a player is found floating,
// so the next report names an entity if one is what holds them up.
void overlap_scan(int slot, const float org[3], const float mins[3], const float maxs[3]) {
    float pmin[3], pmax[3];
    for (int i = 0; i < 3; ++i) { pmin[i] = org[i] + mins[i] - 2.f; pmax[i] = org[i] + maxs[i] + 2.f; }
    int n = 0;
    for (int e = 0; e < kWorld && n < 8; ++e) {
        if (e == slot) continue;
        const uintptr_t ent = kGEntities + static_cast<uintptr_t>(e) * kGentityStride;
        uint8_t linked = 0;
        uint32_t contents = 0;
        float amin[3], amax[3];
        if (!peek(ent + kGentLinked, &linked) || !linked) continue;
        peek(ent + kGentContents, &contents);
        if (!peek(ent + kGentAbsMin, &amin) || !peek(ent + kGentAbsMax, &amax)) continue;
        bool hit = true;
        for (int i = 0; i < 3; ++i) if (amax[i] < pmin[i] || amin[i] > pmax[i]) hit = false;
        if (!hit) continue;
        ++n;
        say("solo_parity: slot %d box touches %s contents %08X", slot, ent_desc(e).c_str(), contents);
    }
    if (!n) say("solo_parity: slot %d box touches no linked entity", slot);
}

// dvar_s: type byte at +0x0A (0 bool, 1 float, 5 int, 6 enum), current value at +0x10.
int32_t dvar_int(const char* name, int32_t dflt = -1) {
    const auto d = reinterpret_cast<uintptr_t>(game::find_dvar(name));
    uint8_t type = 0xFF;
    int32_t v = dflt;
    if (!d || !memory::read(d + 0x0A, &type) || !memory::read(d + 0x10, &v)) return dflt;
    if (type == 0) return v & 0xFF;
    if (type == 1) { float f; std::memcpy(&f, &v, 4); return static_cast<int32_t>(f); }
    return v;
}
float dvar_float(const char* name, float dflt = -1.f) {
    const auto d = reinterpret_cast<uintptr_t>(game::find_dvar(name));
    uint8_t type = 0xFF;
    float f = dflt;
    if (!d || !memory::read(d + 0x0A, &type) || !memory::read(d + 0x10, &f)) return dflt;
    if (type == 5 || type == 6) { int32_t i; std::memcpy(&i, &f, 4); return static_cast<float>(i); }
    return type == 1 ? f : dflt;
}

int players_in_game() {
    // Not gclient != 0: a server leaves gclient set on unused slots (g2r3 counted 4 for 1).
    int n = 0;
    for (int s = 0; s < kMaxClients; ++s) {
        const auto c = referee::client(s);
        if (c && c->active) ++n;
    }
    return n ? n : 1;
}

void check_environment(int slot) {
    solo_parity::env e;
    e.dedicated = is_dedicated();
    e.water_sim = water_sim_value();
    e.gameskill = dvar_int("g_gameskill");
    e.g_player_maxhealth = dvar_int("g_player_maxhealth");
    e.damage_multiplier = dvar_float("player_damageMultiplier");
    e.melee_multiplier = dvar_float("player_meleeDamageMultiplier");
    e.players = players_in_game();
    say("solo_parity: slot %d environment: dedicated %d, r_gfxopt_water_simulation %d, g_gameskill %d, "
        "g_player_maxhealth %d, player_damageMultiplier %.4f (solo Regular for %d player(s): %.4f), "
        "player_meleeDamageMultiplier %.3f (a zombie hit costs %.0f; solo: 60), player_deathInvulnerableTime %d, "
        "player_swimTime %d, player_swimDamage %d",
        slot, e.dedicated ? 1 : 0, e.water_sim, e.gameskill, e.g_player_maxhealth, e.damage_multiplier, e.players,
        solo_parity::expected_damage_multiplier(e.players), e.melee_multiplier, e.melee_multiplier * 150.f,
        dvar_int("player_deathInvulnerableTime"), dvar_int("player_swimTime"), dvar_int("player_swimDamage"));
    for (const auto& m : solo_parity::check_env(e)) mismatch(slot, m);
}

void on_frame(uint32_t ms) {
    for (int slot = 0; slot < kMaxClients; ++slot) {
        slot_state& st = g_s[slot];
        const uintptr_t ent = kGEntities + static_cast<uintptr_t>(slot) * kGentityStride;
        uint32_t gc = 0;
        int32_t health = 0, maxhealth = 0;
        if (!peek(ent + kGentClient, &gc) || gc == 0 || !peek(ent + kGentHealth, &health)) {
            if (st.spawned) say("solo_parity: slot %d left", slot);
            st = slot_state{};
            continue;
        }
        peek(ent + kGentMaxHealth, &maxhealth);
        int32_t pm_type = 0, ground = 0, grav = 0, speed = 0;
        float org[3] = {0, 0, 0}, vel[3] = {0, 0, 0}, mins[3] = {0, 0, 0}, maxs[3] = {0, 0, 0};
        peek(gc + kPsPmType, &pm_type);
        peek(gc + kPsOrigin, &org);
        peek(gc + kPsVelocity, &vel);
        peek(gc + kPsGravity, &grav);
        peek(gc + kPsSpeed, &speed);
        peek(gc + kPsGroundEnt, &ground);
        peek(ent + kGentMins, &mins);
        peek(ent + kGentMaxs, &maxs);

        const bool alive = health > 0;
        if (alive && !st.spawned) {
            st.spawned = true;
            st.spawn_ms = ms;
            st.last_summary = ms;
            say("solo_parity: slot %d SPAWNED at (%.1f %.1f %.1f) health %d/%d pm_type %d on %s gravity %d speed %d "
                "box (%.0f %.0f %.0f)-(%.0f %.0f %.0f)",
                slot, org[0], org[1], org[2], health, maxhealth, pm_type, ent_desc(ground).c_str(), grav, speed,
                mins[0], mins[1], mins[2], maxs[0], maxs[1], maxs[2]);
            for (const auto& m : solo_parity::check_spawn(health, maxhealth)) mismatch(slot, m);
        }
        if (!st.spawned) continue;
        const uint32_t since = ms - st.spawn_ms;

        if (st.health >= 0 && health < st.health) {
            uint32_t sent = 0, att = 0;
            int att_num = -1;
            if (peek(ent + kGentSentient, &sent) && sent && memory::read(sent + kSentientLastAttacker, &att) && att) {
                const uintptr_t base = enw::at(kGEntities);
                if (att >= base && (att - base) % kGentityStride == 0)
                    att_num = static_cast<int>((att - base) / kGentityStride);
            }
            say("solo_parity: slot %d HEALTH %d -> %d (-%d) at +%u ms, last attacker %s, at (%.1f %.1f %.1f) on %s",
                slot, st.health, health, st.health - health, since,
                att_num >= 0 ? ent_desc(att_num).c_str() : "none", org[0], org[1], org[2], ent_desc(ground).c_str());
        } else if (st.health >= 0 && health > st.health) {
            say("solo_parity: slot %d health %d -> %d at +%u ms", slot, st.health, health, since);
        }
        if (ground != st.ground && ground != kWorld && ground != kNone && ground != slot) {
            say("solo_parity: slot %d stands on %s at (%.1f %.1f %.1f) +%u ms", slot, ent_desc(ground).c_str(), org[0],
                org[1], org[2], since);
        }
        if (pm_type != st.pm_type && st.pm_type >= 0)
            say("solo_parity: slot %d pm_type %d -> %d at +%u ms", slot, st.pm_type, pm_type, since);

        // Off the ground, as a live PM_NORMAL player, for longer than any jump or fall.
        if (ground == kNone && pm_type == 0 && alive) {
            if (!st.air_since) {
                st.air_since = ms ? ms : 1;
                const auto cmd = referee::last_usercmd(slot);
                st.cmd_time_at_air = cmd ? cmd->server_time : 0;
            }
        } else {
            st.air_since = 0;
        }
        if (st.air_since && !st.floating_flagged &&
            solo_parity::airborne_mismatch(ms - st.air_since, alive, pm_type)) {
            st.floating_flagged = true;
            // A client that stops sending usercmds (it hung: zm_nuked's GPU-query freeze, client.md
            // section 13) is never moved by pmove either, so it hangs in the air too. Say which.
            const auto cmd = referee::last_usercmd(slot);
            const bool frozen = cmd && st.cmd_time_at_air && cmd->server_time == st.cmd_time_at_air;
            char b[320];
            std::snprintf(b, sizeof b,
                          "%s: off the ground for %u ms at (%.1f %.1f %.1f), vel z %.0f -- %s",
                          frozen ? "CLIENT FROZEN" : "FLOATING", ms - st.air_since, org[0], org[1], org[2], vel[2],
                          frozen ? "its usercmd time has not moved, so the CLIENT stopped sending input (a hung "
                                   "game), not the server's physics"
                                 : "a solo player stands on the floor");
            mismatch(slot, b);
            overlap_scan(slot, org, mins, maxs);
        }

        ++st.frames;
        if (ground == kWorld) ++st.on_world;
        else if (ground == kNone) ++st.in_air;
        else ++st.on_ent;
        if (!st.env_checked && since >= 5000) {
            st.env_checked = true;   // after _gameskill's all_players_spawned scaling
            check_environment(slot);
        }
        const uint32_t every = since < 20000 ? 5000 : 30000;
        if (ms - st.last_summary >= every) {
            st.last_summary = ms;
            say("solo_parity: slot %d +%u ms at (%.1f %.1f %.1f) vel (%.0f %.0f %.0f) health %d/%d on %s | last %u "
                "frames: world %u, entity %u, nothing %u",
                slot, since, org[0], org[1], org[2], vel[0], vel[1], vel[2], health, maxhealth,
                ent_desc(ground).c_str(), st.frames, st.on_world, st.on_ent, st.in_air);
            st.frames = st.on_world = st.on_ent = st.in_air = 0;
        }
        st.health = health;
        st.ground = ground;
        st.pm_type = pm_type;
    }
}

class solo_parity_component final : public component {
public:
    const char* name() const override { return "solo_parity"; }
    void post_unpack() override {
        if (std::getenv("ENW_NO_SOLO_PARITY")) {
            ENW_INFO("solo_parity: off (ENW_NO_SOLO_PARITY)");
            return;
        }
        referee::bind();
        referee::on_frame([](uint32_t ms) { on_frame(ms); });
        ENW_INFO("solo_parity: armed -- per player: spawn health, every health drop and its attacker, what the "
                 "player stands on, time off the ground; at +5 s the difficulty constants against solo WaW's. "
                 "A difference is `solo_parity: MISMATCH` (dedi.md section 28).");
    }
    void pre_destroy() override {
        ENW_INFO("solo_parity: %llu mismatch(es) this process", static_cast<unsigned long long>(g_mismatches));
    }
};

ENW_REGISTER_COMPONENT(solo_parity_component)

}  // namespace
}  // namespace enw::dedi
