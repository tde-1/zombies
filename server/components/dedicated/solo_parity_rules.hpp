// solo_parity's rules: what World at War solo gives a player, and when a game on our server
// does not look like it (lane G2, dedi.md section 27). PURE: no engine, no Windows. Unit-tested
// in server/tests/solo_parity_test.cpp; the engine reads live in solo_parity.cpp.
//
// Every number is read out of the stock scripts (ZombiesDev\scripts\common\maps\_gameskill.gsc,
// nazi_zombie_factory_patch\maps\_zombiemode.gsc) and confirmed against a solo listen game:
//   * g_gameskill 1 (Regular): _gameskill starts autodifficulty at frac 0.75 ("normal"), so
//     playerDifficultyHealth = 310, and coop_damage_and_accuracy_scaling sets
//     player_damageMultiplier = 100 / (310 * coopPlayerDifficultyHealth[normal][players-1]),
//     coopPlayerDifficultyHealth[normal] = 1.0 / 0.9 / 0.8 / 0.7.
//   * player_meleeDamageMultiplier = 100 / 250 = 0.4, so an AI melee (150) costs the player 60:
//     _zombiemode's zombiemode_melee_miss hands a turret exactly `60 / player_damageMultiplier`.
//   * g_player_maxhealth 100 and a player spawns with full health.
//   * playerHealth_RegularRegenDelay 2400 ms at frac 0.75: a player hit to 40 is back to 100
//     2.4 s later, so a SECOND zombie hit inside 2.4 s is a down, and solo has no revive.
//   * A player standing in a map is on the ground (groundEntityNum != ENTITYNUM_NONE) apart
//     from jumps and falls; nothing in stock zombies keeps a player off the ground for seconds.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace enw::solo_parity {

inline constexpr int kGameskill = 1;
inline constexpr int kMaxHealth = 100;
inline constexpr float kMeleeDamageMultiplier = 0.4f;
inline constexpr float kPlayerDifficultyHealthNormal = 310.f;
inline constexpr int kRegenDelayMs = 2400;
inline constexpr int kZombieHit = 60;
// How long a live, normally-moving player may be off the ground before it is not a jump.
inline constexpr uint32_t kAirborneLimitMs = 5000;

// player_damageMultiplier that solo/co-op WaW Regular sets for `players` players (1..4).
inline float expected_damage_multiplier(int players) {
    static const float coop[4] = {1.0f, 0.9f, 0.8f, 0.7f};
    if (players < 1) players = 1;
    if (players > 4) players = 4;
    return 100.f / (kPlayerDifficultyHealthNormal * coop[players - 1]);
}

// How many zombie hits in a row (inside the regen delay) a player with `health` survives.
inline int hits_survived(int health, int per_hit = kZombieHit) {
    if (per_hit <= 0 || health <= 0) return 0;
    return (health - 1) / per_hit;   // the hit that takes health to 0 or below is the down
}

inline std::string fmt(const char* f, double a = 0, double b = 0, double c = 0) {
    char buf[256];
    std::snprintf(buf, sizeof buf, f, a, b, c);
    return buf;
}

// A spawn is full health. Anything less means the map (or the server) hurt the player before
// they could move -- zm_nuked's phantom water drowned them in the first 150 ms.
inline std::vector<std::string> check_spawn(int health, int maxhealth) {
    std::vector<std::string> out;
    if (maxhealth != kMaxHealth)
        out.push_back(fmt("spawn maxhealth %.0f, solo gives %.0f", maxhealth, kMaxHealth));
    if (health < maxhealth)
        out.push_back(fmt("spawned HURT: health %.0f of %.0f before the player could move", health, maxhealth));
    return out;
}

// pm_type 0 is PM_NORMAL: a live player the pmove code moves. Off the ground that long is
// floating (nacht_reimagined swam at a phantom water surface for the whole game).
inline bool airborne_mismatch(uint32_t airborne_ms, bool alive, int pm_type) {
    return alive && pm_type == 0 && airborne_ms >= kAirborneLimitMs;
}

struct env {
    bool dedicated = true;
    int water_sim = -1;               // r_gfxopt_water_simulation, -1 unknown
    int gameskill = -1;
    int g_player_maxhealth = -1;
    float damage_multiplier = -1.f;   // player_damageMultiplier, <0 unknown
    float melee_multiplier = -1.f;    // player_meleeDamageMultiplier, <0 unknown
    int players = 1;
};

inline std::vector<std::string> check_env(const env& e) {
    std::vector<std::string> out;
    if (e.dedicated && e.water_sim != 0)
        out.push_back(fmt("r_gfxopt_water_simulation %.0f on a dedicated server: every map below z=0 is under "
                          "phantom water (dedi.md section 27)", e.water_sim));
    if (e.gameskill >= 0 && e.gameskill != kGameskill)
        out.push_back(fmt("g_gameskill %.0f, solo zombies runs %.0f (Regular)", e.gameskill, kGameskill));
    if (e.g_player_maxhealth >= 0 && e.g_player_maxhealth != kMaxHealth)
        out.push_back(fmt("g_player_maxhealth %.0f, solo gives %.0f", e.g_player_maxhealth, kMaxHealth));
    if (e.melee_multiplier >= 0.f && std::fabs(e.melee_multiplier - kMeleeDamageMultiplier) > 0.001f)
        out.push_back(fmt("player_meleeDamageMultiplier %.3f, solo sets %.3f (a zombie hit costs %.0f)",
                          e.melee_multiplier, kMeleeDamageMultiplier, e.melee_multiplier * 150.f));
    if (e.damage_multiplier >= 0.f) {
        const float want = expected_damage_multiplier(e.players);
        if (std::fabs(e.damage_multiplier - want) > 0.002f)
            out.push_back(fmt("player_damageMultiplier %.4f, solo Regular sets %.4f for %.0f player(s)",
                              e.damage_multiplier, want, e.players));
    }
    return out;
}

}  // namespace enw::solo_parity
