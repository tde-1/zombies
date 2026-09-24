// Unit test for server/components/dedicated/expected_players_rules.hpp: the answer our
// getnumexpectedplayers gives, its wait window, and the late-spawn rescue's choices
// (dedi.md section 29/30, docs/kickstart/cloud-brief-parties.md task 1).
//
// Not under server/components/: CMake globs that directory into the DLL. Build and run:
//
//     cl /nologo /EHsc /std:c++17 server\tests\expected_players_test.cpp /Fe:build\expected_players_test.exe
//     build\expected_players_test.exe
//
// or, anywhere: g++ -std=c++17 -O1 -o /tmp/ep server/tests/expected_players_test.cpp && /tmp/ep
//
// Pure: no dump, no engine.
#include "../components/dedicated/expected_players_rules.hpp"

#include <cstdio>

using namespace enw;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}

static void test_expected() {
    using expected::expected_players;
    const uint32_t D = expected::kRound1WaitMs;
    check(D == 90000, "B's default wait is 90 s");
    // Tonight's case: lease of 2, one client connecting, map just loaded -> wait for 2.
    check(expected_players(2, 1, 1000, D) == 2, "lease 2, 1 connecting, before deadline -> 2");
    check(expected_players(2, 2, 1000, D) == 2, "lease 2, both connecting -> 2");
    // A no-show stops blocking after the deadline.
    check(expected_players(2, 1, D, D) == 1, "lease 2, 1 connecting, AT deadline -> 1");
    check(expected_players(2, 1, D + 5000, D) == 1, "lease 2, 1 connecting, after deadline -> 1");
    // A client mid-load is still waited for after the deadline (stock LAN path).
    check(expected_players(2, 2, D + 5000, D) == 2, "after deadline, 2 still connecting -> 2");
    // Lease unknown: the stock non-online branch, which alone fixes tonight's case.
    check(expected_players(0, 2, 0, D) == 2, "lease unknown, 2 connecting -> 2");
    check(expected_players(0, 0, 0, D) == 1, "lease unknown, nobody -> 1 (never 0)");
    check(expected_players(0, 1, D + 1, D) == 1, "lease unknown after deadline -> 1");
    // More connecting than the lease names (a mid-game joiner's token): count them.
    check(expected_players(2, 3, 1000, D) == 3, "3 connecting on a lease of 2 -> 3");
    // Garbage in.
    check(expected_players(-5, -1, 0, D) == 1, "negative inputs -> 1");
    check(expected_players(9, 1, 0, D) == 4, "lease beyond 4 is clamped to 4");
    check(expected_players(1, 0, 0, D) == 1, "solo lease -> 1");
}

static void test_window() {
    using expected::wait_window;
    const uint32_t D = expected::kRound1WaitMs;
    {
        wait_window w;
        check(w.on_call(10000) == 0, "first poll opens the window");
        check(w.on_call(10050) == 50, "next poll counts from the first");
        check(w.on_call(10000 + D) == D, "poll at +90 s reads 90 s");
        w.on_round_started();
        check(w.on_call(10000 + D + 16) == D + 1, "after round 1 started -> past the deadline");
    }
    {
        // Warm instance: polling with nobody expected, then a lease arrives.
        wait_window w;
        w.on_call(0);
        w.on_call(60000);
        w.on_lease(60010);
        check(w.on_call(60050) == 40, "a lease re-anchors the window");
        check(w.on_call(60010 + D) == D, "and its 90 s count from the lease");
    }
    {
        // A lease after round 1 started changes nothing.
        wait_window w;
        w.on_call(0);
        w.on_round_started();
        w.on_lease(500);
        check(w.on_call(516) == D + 1, "a lease after round 1 does not reopen the wait");
    }
    {
        // map_restart: _load.gsc polls again after a quiet gap -> a new window.
        wait_window w;
        w.on_call(0);
        w.on_call(16);
        w.on_round_started();
        check(w.on_call(20000) == 0, "a poll after a >5 s quiet gap, post round 1, opens a new window");
        check(w.on_call(20100) == 100, "the new window counts from the restart");
    }
    {
        // Wrap-around of the millisecond clock.
        wait_window w;
        w.on_call(0xFFFFFF00u);
        check(w.on_call(0x00000100u) == 0x200, "the window survives a GetTickCount wrap");
    }
}

static void test_rescue() {
    using namespace rescue;
    // --- needs_rescue --------------------------------------------------------------------
    {
        spawn_watch w;
        w.start({0, 0, -4}, 1000, /*after_round1=*/true, /*on_nothing=*/true);
        check(needs_rescue(w, {0, 0, -4}, true, 1016) == why::origin, "Hijacked: (0,0,-4) after round 1 -> origin");
    }
    {
        spawn_watch w;
        w.start({0, 0, -4}, 1000, /*after_round1=*/false, true);
        check(needs_rescue(w, {0, 0, -4}, true, 1016) == why::none, "a round-1 spawn is never rescued");
    }
    {
        spawn_watch w;
        w.start({100, 200, 50}, 1000, true, true);
        check(needs_rescue(w, {100, 200, 40}, true, 1100) == why::none, "on nothing inside the grace -> wait");
        check(needs_rescue(w, {100, 200, 20}, true, 1000 + kOnNothingGraceMs) == why::on_nothing,
              "still on nothing after the grace -> rescue");
        check(needs_rescue(w, {100, 200, 20}, false, 1000 + kOnNothingGraceMs) == why::none,
              "landed on something by the grace -> no rescue");
    }
    {
        spawn_watch w;
        w.start({100, 200, 50}, 1000, true, false);
        check(needs_rescue(w, {100, 200, 50 - 128}, false, 2000) == why::none, "exactly 128 below -> not yet");
        check(needs_rescue(w, {100, 200, 50 - 129}, false, 2000) == why::fell, "129 below within 3 s -> fell");
        check(needs_rescue(w, {100, 200, -400}, false, 1000 + kWatchMs + 1) == why::none, "after 3 s -> not ours");
        w.rescued = true;
        check(needs_rescue(w, {100, 200, -400}, false, 2000) == why::none, "rescued once only");
    }
    {
        spawn_watch w;   // inactive
        check(needs_rescue(w, {0, 0, 0}, true, 0) == why::none, "no watch -> none");
    }
    // --- crumbs ---------------------------------------------------------------------------
    {
        crumb_ring r;
        r.offer({1, 1, 1}, 0, true, true);
        r.offer({2, 2, 2}, 100, true, true);   // too soon
        r.offer({3, 3, 3}, 250, false, true);  // dead
        r.offer({4, 4, 4}, 260, true, false);  // not on the world
        r.offer({5, 5, 5}, 300, true, true);
        int used = 0;
        for (const auto& c : r.c) used += c.used;
        check(used == 2, "a crumb every 250 ms, only alive and on the world");
        for (uint32_t t = 600; t < 600 + 250 * 100; t += 250) r.offer({float(t), 0, 0}, t, true, true);
        used = 0;
        for (const auto& c : r.c) used += c.used;
        check(used == static_cast<int>(kCrumbs), "the ring holds kCrumbs");
    }
    // --- pick_spot ------------------------------------------------------------------------
    {
        crumb_ring rings[4];
        bool alive[4] = {true, true, false, false};
        bool present[4] = {true, true, false, false};
        vec3 now_at[4] = {{500, 500, 0}, {0, 0, -272}, {}, {}};
        // Teammate 0 walked from (100,0,0) to (500,500,0) over 4 s.
        for (uint32_t t = 0; t <= 4000; t += 250) {
            const float f = t / 4000.f;
            rings[0].offer({100 + 400 * f, 500 * f, 0}, t, true, true);
        }
        vec3 out;
        check(pick_spot(rings, alive, 4, 1, now_at, present, 4000, &out), "a spot is found");
        const float d0 = dist2(out, now_at[0]);
        check(d0 >= kClearance * kClearance, "the spot is 40+ from the teammate now");
        bool old_enough = false;
        for (const auto& c : rings[0].c)
            if (c.used && c.at.x == out.x && c.at.y == out.y && 4000 - c.ms >= kCrumbMinAgeMs) old_enough = true;
        check(old_enough, "the spot was stood on at least 1 s ago");
        // Newest valid: at t <= 3000 the teammate was 25% from its end; the crumb at 3000 is
        // (400,375), 156 from (500,500) -> clear and newest.
        check(out.x == 400.f && out.y == 375.f, "the newest crumb that is old enough and clear");
    }
    {
        // The only teammate is dead -> nothing.
        crumb_ring rings[2];
        for (uint32_t t = 0; t <= 4000; t += 250) rings[0].offer({float(t), 0, 0}, t, true, true);
        bool alive[2] = {false, true};
        bool present[2] = {true, true};
        vec3 now_at[2] = {{4000, 0, 0}, {0, 0, -272}};
        vec3 out;
        check(!pick_spot(rings, alive, 2, 1, now_at, present, 4000, &out), "no living teammate -> no spot");
    }
    {
        // Every crumb is within 40 of somebody now -> nothing.
        crumb_ring rings[2];
        for (uint32_t t = 0; t <= 4000; t += 250) rings[0].offer({float(t) / 1000.f, 0, 0}, t, true, true);
        bool alive[2] = {true, true};
        bool present[2] = {true, true};
        vec3 now_at[2] = {{0, 0, 0}, {0, 0, -272}};
        vec3 out;
        check(!pick_spot(rings, alive, 2, 1, now_at, present, 4000, &out), "every crumb crowded -> no spot");
    }
    {
        // Our own crumbs are never used.
        crumb_ring rings[2];
        for (uint32_t t = 0; t <= 4000; t += 250) rings[1].offer({float(t), 0, 0}, t, true, true);
        bool alive[2] = {true, true};
        bool present[2] = {true, true};
        vec3 now_at[2] = {{9999, 9999, 0}, {0, 0, -272}};
        vec3 out;
        check(!pick_spot(rings, alive, 2, 1, now_at, present, 4000, &out), "own crumbs are not a spot");
    }
}

int main() {
    test_expected();
    test_window();
    test_rescue();
    std::printf("expected_players_test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
