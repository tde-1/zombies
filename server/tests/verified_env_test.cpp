// Unit test for server/components/referee/verified_env.hpp -- no engine.
//
// Not under server/components/ (CMake globs that into the DLL). Build and run from a VS x86
// prompt, or any C++17 compiler:
//
//     cl /nologo /EHsc /std:c++17 server\tests\verified_env_test.cpp /Fe:build\verified_env_test.exe
//     build\verified_env_test.exe
#include "../components/referee/verified_env.hpp"

#include <cstdio>
#include <cstring>
#include <set>
#include <string>

using namespace enw::verified;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}

static void raw_int(uint8_t r[16], int32_t v) { std::memset(r, 0, 16); std::memcpy(r, &v, 4); }
static void raw_float(uint8_t r[16], float v) { std::memset(r, 0, 16); std::memcpy(r, &v, 4); }

int main() {
    uint8_t r[16];

    // The three types that are measured, with the values the real dedi dump printed.
    raw_int(r, 85);   check(format_value(T_INT, r) == "85", "int com_maxfps 85");
    raw_int(r, 0);    check(format_value(T_INT, r) == "0", "int 0");
    raw_int(r, -1);   check(format_value(T_INT, r) == "-1", "negative int");
    raw_int(r, 1);    check(format_value(T_ENUM, r) == "1", "enum is its index");
    check(format_value(T_STRING, r, "C:\\home") == "C:\\home", "string passes through");

    // The inferred ones, formatted the way the engine's own dump writes them.
    raw_float(r, 0.7f); check(format_value(T_FLOAT, r) == "0.7", "float 0.7 like the dump");
    raw_float(r, 1.0f); check(format_value(T_FLOAT, r) == "1", "timescale 1");
    raw_float(r, 1.5f); check(format_value(T_FLOAT, r) == "1.5", "float 1.5");
    std::memset(r, 0, 16); r[0] = 1; check(format_value(T_BOOL, r) == "1", "bool true");
    r[0] = 0;                       check(format_value(T_BOOL, r) == "0", "bool false");

    // Unknown type: reported raw, never guessed.
    raw_int(r, 0x11223344);
    check(format_value(99, r).rfind("?type99:", 0) == 0, "unknown type is raw and marked");

    // change_tracker: first sight is a change, a repeat is not, a new value is.
    change_tracker t;
    check(t.observe("sv_cheats", "0"), "first sight reported");
    check(!t.observe("sv_cheats", "0"), "repeat not reported");
    check(t.observe("sv_cheats", "1"), "change reported");
    check(t.observe("timescale", "1"), "keys are independent");
    check(t.values().at("sv_cheats") == "1", "last value kept");
    t.clear();
    check(t.observe("sv_cheats", "1"), "clear forgets (a new match reports its start values)");

    // Client fps report.
    check(parse_client_fps("250") == 250, "250");
    check(parse_client_fps("0") == 0, "0 = uncapped, still a report");
    check(parse_client_fps("") == -1, "absent = not reported");
    check(parse_client_fps("25O") == -1, "garbage = not reported");
    check(parse_client_fps("-5") == -1, "sign = not reported");
    check(parse_client_fps("1234567") == -1, "too long = not reported");

    // The engine's integer-millisecond cap.
    check(effective_fps(250) == 250, "250 -> 4 ms -> 250");
    check(effective_fps(240) == 250, "240 runs at 250");
    check(effective_fps(125) == 125, "125 -> 8 ms");
    check(effective_fps(200) == 200, "200 -> 5 ms");
    check(effective_fps(333) == 333, "333 -> 3 ms");
    check(effective_fps(400) == 500, "400 runs at 500");
    check(effective_fps(0) == 0, "0 uncapped");
    check(effective_fps(5000) == 1000, "above 1000 floors at 1 ms");

    // The client lock.
    check(fps_target(250, 250) == -1, "250 under a 250 lock is left");
    check(fps_target(125, 250) == -1, "125 is allowed");
    check(fps_target(333, 250) == 250, "333 goes to the cap");
    check(fps_target(1000, 250) == 250, "1000 goes to the cap");
    check(fps_target(0, 250) == 250, "uncapped goes to the cap");
    check(fps_target(-1, 250) == 250, "negative goes to the cap");
    check(fps_target(10, 250) == kFpsMin, "under 20 goes to 20");
    check(fps_target(333, 0) == -1, "no lock asked for: never touched");
    check(fps_target(333, 400) == 250, "a lock above the rule is held to the rule");
    check(fps_target(200, 125) == 125, "a lower lock is honoured");

    // Every watched name is unique (a duplicate would send two events per change).
    std::set<std::string> names;
    for (const char* n : kServerWatch) names.insert(n);
    check(names.size() == sizeof(kServerWatch) / sizeof(kServerWatch[0]), "watch list has no duplicates");
    check(names.count("sv_cheats") && names.count("timescale") && names.count("developer"),
          "the three cheat dvars are watched");

    std::printf("verified_env_test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
