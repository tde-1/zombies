// The Verified environment, as the game itself can see it: which dvars the referee
// reports, how a dvar_s value is turned into text, and what a client says its FPS cap is.
//
// PURE: no engine, no Windows. Unit-tested in server/tests/verified_env_test.cpp. The
// engine reads live in t4_bind.cpp (dvar_get) and referee.cpp (the watch loop).
//
// The rules themselves (what value is allowed) are NOT here. The DLL reports; the host
// judges (infra/host-agent/lib/verified.js), because the host is where a result becomes a
// record and where the rules can change without a DLL deploy. docs/kickstart/verified-rules.md
// is the rulebook and says where every value comes from.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>

namespace enw::verified {

// ------------------------------------------------------------ server dvars --
//
// Reported on the link as `dvar {name, value}` once at load and again on every change
// (game-link-v0 has had the `dvar` event since 2026-09-20; until this nothing sent one).
// Every name was checked present in the decrypted 1.7 image, and the stock value of each is
// the one a real dedicated server printed in its own dvar dump
// (ZombiesDev\logs\dedi\maps\nazi_zombie_leviathan.console.log) -- verified-rules.md §3.
inline constexpr const char* kServerWatch[] = {
    // cheats and time
    "sv_cheats", "timescale", "fixedtime", "developer", "developer_script",
    // difficulty and the player's movement / survival constants
    "g_gameskill", "g_player_maxhealth", "jump_height", "player_backSpeedScale",
    "player_strafeSpeedScale", "player_sprintSpeedScale", "player_sprintUnlimited",
    "player_sustainAmmo", "player_meleeRange", "player_lastStandBleedoutTime",
    "perk_weapReloadMultiplier", "bg_fallDamageMaxHeight", "arcademode",
    // the server's clock and network, for the record's proof (not rules)
    "sv_fps", "sv_maxRate", "com_maxfps", "onlinegame", "systemlink", "zombiemode",
};

// dvar_s.type (uint16 at +0x0A). 5/6/7 are MEASURED (dedicated.cpp: com_maxfps, dedicated,
// fs_homepath). The rest follow the same order as the CoD4 enum those three match, and are
// therefore [inferred] -- which is why an unexpected type is reported raw, never guessed.
enum : uint16_t {
    T_BOOL = 0, T_FLOAT = 1, T_VEC2 = 2, T_VEC3 = 3, T_VEC4 = 4,
    T_INT = 5, T_ENUM = 6, T_STRING = 7, T_COLOR = 8,
};

// `raw` is the 16-byte current value at dvar_s+0x10. `str` is what its char* points at,
// already read by the caller (only used for T_STRING). Returns the text the referee sends.
inline std::string format_value(uint16_t type, const uint8_t raw[16], const std::string& str = {}) {
    char b[96];
    auto f = [&](int i) { float v; std::memcpy(&v, raw + 4 * i, 4); return v; };
    switch (type) {
        case T_BOOL: return raw[0] ? "1" : "0";
        case T_FLOAT: std::snprintf(b, sizeof b, "%g", f(0)); return b;
        case T_VEC2: std::snprintf(b, sizeof b, "%g %g", f(0), f(1)); return b;
        case T_VEC3: std::snprintf(b, sizeof b, "%g %g %g", f(0), f(1), f(2)); return b;
        case T_VEC4: std::snprintf(b, sizeof b, "%g %g %g %g", f(0), f(1), f(2), f(3)); return b;
        case T_INT:
        case T_ENUM: {  // an enum's current value is its index; the domain strings are not bound
            int32_t v; std::memcpy(&v, raw, 4);
            std::snprintf(b, sizeof b, "%d", v); return b;
        }
        case T_STRING: return str;
        case T_COLOR:
            std::snprintf(b, sizeof b, "%u %u %u %u", raw[0], raw[1], raw[2], raw[3]); return b;
        default: {
            std::snprintf(b, sizeof b, "?type%u:%02x%02x%02x%02x", type, raw[0], raw[1], raw[2], raw[3]);
            return b;
        }
    }
}

// Remembers the last value sent per key and says whether a new one is worth sending.
// First sight counts as a change: the host needs the starting value, not just the edits.
class change_tracker {
public:
    bool observe(const std::string& key, const std::string& value) {
        auto it = last_.find(key);
        if (it != last_.end() && it->second == value) return false;
        last_[key] = value;
        return true;
    }
    const std::map<std::string, std::string>& values() const { return last_; }
    void clear() { last_.clear(); }
private:
    std::map<std::string, std::string> last_;
};

// ------------------------------------------------------------ the client --
//
// The FPS cap is a CLIENT dvar: the server never sees it. The client DLL
// (client-dll/components/fps_guard.cpp) puts its effective `com_maxfps` in userinfo as
// `enw_fps`, the same channel `enw_ui` already proved arrives mid-game.
inline constexpr const char* kClientFpsKey = "enw_fps";

// -1 = not reported (an older client, or a hand-run exe). Otherwise the dvar value,
// 0 meaning uncapped. Garbage is "not reported", never a number.
inline int parse_client_fps(const std::string& value) {
    if (value.empty() || value.size() > 6) return -1;
    for (char c : value) if (c < '0' || c > '9') return -1;
    return std::atoi(value.c_str());
}

// The FPS rule every board we checked agrees on (verified-rules.md §2): 20..250, with 250
// also Plutonium's own cheat line. 0 is "uncapped" and is outside it.
inline constexpr int kFpsMin = 20;
inline constexpr int kFpsMax = 250;

// What the client should set com_maxfps to, or -1 to leave it. `cap` <= 0 = no lock (a
// launch that did not ask for one). Uncapped (<= 0) and anything above the cap go to the
// cap; anything under kFpsMin goes to kFpsMin.
inline int fps_target(int value, int cap) {
    if (cap <= 0) return -1;
    if (cap > kFpsMax) cap = kFpsMax;
    if (value <= 0 || value > cap) return cap;
    if (value < kFpsMin) return kFpsMin;
    return -1;
}

// The frame rate the engine actually runs at for a given com_maxfps. The cap is an integer
// number of milliseconds, 1000 / com_maxfps (docs/re/t4-sp-map.md, 0x59DD37), so 240 runs
// at 250 and 334..500 all run at 500. 0 (or less) is uncapped: returns 0.
inline int effective_fps(int maxfps) {
    if (maxfps <= 0) return 0;
    int ms = 1000 / maxfps;
    if (ms < 1) ms = 1;
    return 1000 / ms;
}

}  // namespace enw::verified
