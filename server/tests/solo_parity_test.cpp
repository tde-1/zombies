// Unit test for server/components/dedicated/solo_parity_rules.hpp and the addresses
// water_sim_off.cpp relies on (dedi.md section 28).
//
// Not under server/components/: CMake globs that directory into the DLL. Build and run:
//
//     cl /nologo /EHsc /std:c++17 server\tests\solo_parity_test.cpp /Fe:build\solo_parity_test.exe
//     build\solo_parity_test.exe [path\to\codwaw-1.7-a.exe]
//
// Part 1 is pure. Part 2 reads the decrypted dump (default C:\Users\b\ZombiesDev\dumps\
// codwaw-1.7-a.exe) and checks the water-height gate, the dvar's registration and the "no
// water" constant; it is skipped, and says so, when the dump is not there.
#include "../components/dedicated/solo_parity_rules.hpp"

#include <cstdio>
#include <cstring>
#include <vector>

using namespace enw::solo_parity;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}
static bool has(const std::vector<std::string>& v, const char* needle) {
    for (const auto& s : v) if (s.find(needle) != std::string::npos) return true;
    return false;
}

static void test_rules() {
    // Solo Regular: 100 / 310 for one player, and the co-op scalars after.
    check(std::fabs(expected_damage_multiplier(1) - 0.32258f) < 1e-4f, "solo damage multiplier 100/310");
    check(std::fabs(expected_damage_multiplier(4) - 100.f / (310.f * 0.7f)) < 1e-4f, "4p damage multiplier");
    check(std::fabs(expected_damage_multiplier(0) - expected_damage_multiplier(1)) < 1e-6f, "0 players clamps to 1");

    // 100 health takes one zombie hit (to 40); the second inside the regen delay is the down.
    check(hits_survived(100) == 1, "100 hp survives one 60 hit");
    check(hits_survived(160) == 2, "juggernog 160 survives two");
    check(hits_survived(40) == 0, "40 hp survives none");

    // B's zm_nuked spawn (drowning in phantom water): 95/100 at the first frame.
    check(has(check_spawn(95, 100), "spawned HURT"), "a hurt spawn is a mismatch");
    check(check_spawn(100, 100).empty(), "a full-health spawn is fine");
    check(has(check_spawn(150, 150), "maxhealth"), "maxhealth 150 at spawn is not solo");

    // nacht_reimagined: never on the ground.
    check(airborne_mismatch(5000, true, 0), "5 s off the ground, alive, PM_NORMAL");
    check(!airborne_mismatch(4999, true, 0), "a long jump is not floating");
    check(!airborne_mismatch(60000, false, 0), "a dead player is not floating");
    check(!airborne_mismatch(60000, true, 5), "a linked/laststand pm_type is not floating");

    env ok;
    ok.dedicated = true; ok.water_sim = 0; ok.gameskill = 1; ok.g_player_maxhealth = 100;
    ok.damage_multiplier = 0.3226f; ok.melee_multiplier = 0.4f; ok.players = 1;
    check(check_env(ok).empty(), "stock solo environment has no mismatch");
    env water = ok; water.water_sim = 1;
    check(has(check_env(water), "phantom water"), "water sim on a dedi is the section 28 bug");
    env listen = ok; listen.dedicated = false; listen.water_sim = 1;
    check(check_env(listen).empty(), "a listen server keeps its water simulation");
    env skill = ok; skill.gameskill = 3;
    check(has(check_env(skill), "g_gameskill 3"), "veteran is not solo zombies");
    env melee = ok; melee.melee_multiplier = 1.0f;
    check(has(check_env(melee), "costs 150"), "a melee multiplier of 1 makes a zombie hit 150");
    env two = ok; two.players = 2; two.damage_multiplier = 0.3226f;
    check(has(check_env(two), "2 player"), "the 1-player multiplier in a 2-player game is wrong");
    two.damage_multiplier = 100.f / (310.f * 0.9f);
    check(check_env(two).empty(), "the 2-player multiplier in a 2-player game is right");
    env unknown;   // nothing read: nothing claimed, except the water switch on a dedi
    unknown.dedicated = false;
    check(check_env(unknown).empty(), "unknown values are not mismatches");
}

static bool read_at(const std::vector<unsigned char>& img, unsigned va, void* out, size_t n) {
    const unsigned off = va - 0x400000u;
    if (va < 0x400000u || off + n > img.size()) return false;
    std::memcpy(out, img.data() + off, n);
    return true;
}

static void test_dump(const char* path) {
    FILE* f = std::fopen(path, "rb");
    if (!f) { std::printf("SKIP part 2: no dump at %s\n", path); return; }
    std::vector<unsigned char> img;
    unsigned char buf[1 << 16];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) img.insert(img.end(), buf, buf + n);
    std::fclose(f);

    // 0x6F3F77: mov eax,[0x42B721C] ; cmp byte [eax+0x10],0 ; je 0x6F3FE8
    const unsigned char gate[] = {0xA1, 0x1C, 0x72, 0x2B, 0x04, 0x80, 0x78, 0x10, 0x00, 0x57, 0x74, 0x65};
    unsigned char have[sizeof gate] = {};
    check(read_at(img, 0x6F3F77, have, sizeof have) && !std::memcmp(have, gate, sizeof gate),
          "0x6F3F77 is the water-height gate on [0x42B721C]");
    // 0x70BB59: mov edi, 0x8A5614 ("r_gfxopt_water_simulation"); 0x70BB66: mov [0x42B721C], eax
    unsigned char reg[5] = {}, store[5] = {};
    check(read_at(img, 0x70BB59, reg, 5) && reg[0] == 0xBF && !std::memcmp(reg + 1, "\x14\x56\x8A\x00", 4),
          "0x70BB59 loads the dvar name 0x8A5614");
    char name[32] = {};
    check(read_at(img, 0x8A5614, name, 26) && !std::strcmp(name, "r_gfxopt_water_simulation"),
          "0x8A5614 is \"r_gfxopt_water_simulation\"");
    check(read_at(img, 0x70BB66, store, 5) && store[0] == 0xA3 && !std::memcmp(store + 1, "\x1C\x72\x2B\x04", 4),
          "0x70BB66 stores the registered dvar into 0x42B721C");
    // the static path's "no water here" answer
    float none = 0.f;
    check(read_at(img, 0x8AF860, &none, 4) && none == -32768.f, "0x8AF860 is -32768 (no water)");
    // 0x6F3FB9: the sim path adds the window's int16 base height at [0x4DD8BD0]
    unsigned char base[6] = {};
    check(read_at(img, 0x6F3FB9, base, 6) && base[0] == 0x8B && base[1] == 0x15 && !std::memcmp(base + 2, "\xD0\x8B\xDD\x04", 4),
          "0x6F3FB9 reads the sim window's base heights [0x4DD8BD0]");
}

int main(int argc, char** argv) {
    test_rules();
    test_dump(argc > 1 ? argv[1] : "C:\\Users\\b\\ZombiesDev\\dumps\\codwaw-1.7-a.exe");
    std::printf("%d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
