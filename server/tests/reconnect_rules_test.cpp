// Unit test for server/components/referee/reconnect_rules.hpp -- the disconnect/pause/reconnect
// rules with no engine in them (referee.md, "2026-09-24 cloud: disconnect pause + reconnect").
//
// Not under server/components/: CMake globs that directory into the DLL, and a main() there would
// be linked into binkw32.dll. Build and run (VS BuildTools x86 prompt, or any C++17 compiler):
//
//     cl /nologo /EHsc /std:c++17 server\tests\reconnect_rules_test.cpp /Fe:build\reconnect_rules_test.exe
//     build\reconnect_rules_test.exe
//
//     g++ -std=c++17 -O1 server/tests/reconnect_rules_test.cpp -o /tmp/rrt && /tmp/rrt
#include "../components/referee/reconnect_rules.hpp"

#include <cstdio>

using namespace enw::reconnect;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}

// A client that sends a new command every poll: serverTime moves by 16 ms a frame.
static uint64_t sig_at(int t) { return cmd_signature(t, 0, 0, 0, 0, 0); }

static void test_signature() {
    const uint64_t a = cmd_signature(1000, 0, 10, 20, 0, 0);
    check(a == cmd_signature(1000, 0, 10, 20, 0, 0), "signature is a pure function");
    check(a != cmd_signature(1016, 0, 10, 20, 0, 0), "serverTime moves the signature");
    check(a != cmd_signature(1000, 1, 10, 20, 0, 0), "buttons move it");
    check(a != cmd_signature(1000, 0, 11, 20, 0, 0), "pitch moves it");
    check(a != cmd_signature(1000, 0, 10, 21, 0, 0), "yaw moves it");
    check(a != cmd_signature(1000, 0, 10, 20, 127, 0), "forward moves it");
    check(a != cmd_signature(1000, 0, 10, 20, 0, -127), "right moves it");
}

static void test_link_watch() {
    link_cfg c;   // 5000 ms, 2 changes
    link_slot s;
    // Not connected: nothing, ever.
    check(step(s, false, true, sig_at(1), 0, false, c) == link_edge::none, "no client, no edge");
    check(s.phase == link_phase::none, "free slot stays none");

    // Connect: loading. The stale command left in the slot is the baseline, not a change.
    check(step(s, true, true, sig_at(1), 100, false, c) == link_edge::none, "connect edge is silent");
    check(s.phase == link_phase::loading, "connect -> loading");
    // Loading screen: nothing moves for a minute. Never lost while loading.
    check(step(s, true, true, sig_at(1), 60100, false, c) == link_edge::none, "a long load is not a loss");
    check(s.phase == link_phase::loading, "still loading");
    // In the world: two changes -> ready.
    check(step(s, true, true, sig_at(2), 60200, false, c) == link_edge::none, "one change is not ready yet");
    check(step(s, true, true, sig_at(3), 60300, false, c) == link_edge::ready, "second change -> ready");
    check(s.phase == link_phase::playing, "ready -> playing");

    // Playing: a steady stream never trips.
    int t = 4;
    uint32_t now = 60300;
    for (int i = 0; i < 1000; ++i) {
        now += 16;
        if (step(s, true, true, sig_at(t++), now, false, c) != link_edge::none) {
            check(false, "a steady stream produced an edge");
            break;
        }
    }
    // Silence: 4.9 s is not lost, 5 s is.
    const uint32_t quiet_from = now;
    const uint64_t frozen_sig = sig_at(t - 1);
    check(step(s, true, true, frozen_sig, quiet_from + 4900, false, c) == link_edge::none, "4.9 s silence is not lost");
    check(step(s, true, true, frozen_sig, quiet_from + 5000, false, c) == link_edge::lost, "5 s silence is lost");
    check(s.phase == link_phase::lost && s.lost_at_ms == quiet_from + 5000, "lost, with its time");
    // Still silent: no repeated edge.
    check(step(s, true, true, frozen_sig, quiet_from + 9000, false, c) == link_edge::none, "lost fires once");
    // The world freezes (the host held the pause): the lost slot stays lost.
    check(step(s, true, true, frozen_sig, quiet_from + 60000, true, c) == link_edge::none, "frozen: still lost, no edge");
    check(s.phase == link_phase::lost, "frozen keeps lost");
    // The network came back: input moves -> back.
    check(step(s, true, true, sig_at(t++), quiet_from + 61000, true, c) == link_edge::back, "input moves -> back");
    check(s.phase == link_phase::playing, "back -> playing");

    // While frozen, a playing client whose clock stands still is NOT called lost...
    now = quiet_from + 61000;
    const uint64_t still = sig_at(t - 1);
    for (int i = 1; i <= 20; ++i) {
        if (step(s, true, true, still, now + i * 1000, true, c) != link_edge::none) {
            check(false, "a frozen world called a live client lost");
            break;
        }
    }
    // ...and after the resume the silence clock starts from the resume, not from the freeze.
    now += 20000;
    check(step(s, true, true, still, now + 4000, false, c) == link_edge::none, "4 s after resume is not lost");
    check(step(s, true, true, still, now + 5000, false, c) == link_edge::lost, "5 s after resume is lost");

    // Disconnect resets the slot for whoever lands in it next.
    check(step(s, false, true, still, now + 6000, false, c) == link_edge::none, "disconnect is silent here");
    check(s.phase == link_phase::none && !s.have_sig, "disconnect resets");

    // An unreadable command (a soak bot, an unbound array) is never judged.
    link_slot b;
    step(b, true, false, 0, 0, false, c);
    for (uint32_t ms = 0; ms < 120000; ms += 1000)
        if (step(b, true, false, 0, ms, false, c) != link_edge::none) { check(false, "a bot was judged"); break; }
    check(b.phase == link_phase::loading, "a bot never leaves loading");
}

static void test_sampling() {
    link_slot s;
    s.phase = link_phase::loading;
    check(!should_sample(s, false, 0, 0), "never while loading");
    s.phase = link_phase::playing;
    check(should_sample(s, false, 0, 100), "first sample once playing");
    s.changed_now = false;
    check(!should_sample(s, true, 100, 1000), "no input change, no resample (keeps the last-input state)");
    s.changed_now = true;
    check(!should_sample(s, true, 100, 200), "throttled to 250 ms");
    check(should_sample(s, true, 100, 350), "input moved and 250 ms passed");
    s.phase = link_phase::lost;
    check(!should_sample(s, true, 100, 5000), "never while lost: the ghost's numbers are the zombies'");
}

static void test_counters_reset() {
    counters a{true, 2500, 40, 1, 2, 3, 10};
    counters b = a;
    check(!counters_reset(a, b), "same counters: same connection");
    b.kills = 41; b.score = 100;
    check(!counters_reset(a, b), "score may go down (spending); kills up is fine");
    b = a; b.kills = 0;
    check(counters_reset(a, b), "kills going down = re-seated");
    b = a; b.downs = 0;
    check(counters_reset(a, b), "downs going down = re-seated");
    counters none;
    check(!counters_reset(none, a) && !counters_reset(a, none), "no baseline, no verdict");
}

static void test_seat() {
    check(seat_conflict(-1, link_phase::none, true) == seat_action::admit, "nobody else holds it");
    check(seat_conflict(2, link_phase::lost, true) == seat_action::evict_ghost, "the old body is a lost link: evict it");
    check(seat_conflict(2, link_phase::playing, true) == seat_action::refuse, "a live second client is refused");
    check(seat_conflict(2, link_phase::loading, true) == seat_action::refuse, "a loading second client is refused");
    check(seat_conflict(2, link_phase::lost, false) == seat_action::refuse, "kill switch: the old refusal");
}

static void test_merge() {
    counters cur{true, 500, 0, 0, 0, 0, 0};          // a rejoiner's fresh 500
    counters old{true, 12340, 210, 4, 3, 5, 61};
    counters m = merge_restore(cur, old);
    check(m.have && m.score == 12340, "score put back exactly");
    check(m.kills == 210 && m.assists == 4 && m.downs == 3 && m.revives == 5 && m.headshots == 61, "counters put back");
    counters earned{true, 800, 212, 0, 0, 0, 0};    // killed two before the settle ended
    m = merge_restore(earned, old);
    check(m.kills == 212, "a counter already above the old value is kept");
    check(m.score == 12340, "score is the old score (the rejoin's 500 is what we undo)");
    counters nothing;
    m = merge_restore(cur, nothing);
    check(m.score == 500, "no restore values, nothing changes");
    check(plausible_counter(0) && plausible_counter(kCounterMax), "bounds inclusive");
    check(!plausible_counter(-1) && !plausible_counter(kCounterMax + 1LL), "outside the bounds");
}

static void test_restore_plan() {
    restore_cfg c;   // 1500 ms settle, 15 min expiry
    pending_restore p;
    check(step_restore(p, true, true, false, 0, c) == restore_step::idle, "nothing queued");
    p.active = true;
    p.queued_ms = 1000;
    p.values = counters{true, 9000, 1, 0, 0, 0, 0};
    // Queued while the player is still loading (not alive).
    check(step_restore(p, true, false, true, 2000, c) == restore_step::wait, "loading: wait");
    // Frozen world, entity alive (it cannot be -- but if it were): settling does not advance.
    check(step_restore(p, true, true, true, 3000, c) == restore_step::wait, "first alive frame starts the settle");
    check(step_restore(p, true, true, true, 60000, c) == restore_step::wait, "frozen: the spawn scripts have not run, keep waiting");
    // World runs.
    check(step_restore(p, true, true, false, 60500, c) == restore_step::wait, "500 ms running");
    check(step_restore(p, true, true, false, 61000, c) == restore_step::wait, "1000 ms running");
    check(step_restore(p, true, true, false, 61500, c) == restore_step::apply, "1500 ms running -> apply");
    check(!p.active, "applied once");
    check(step_restore(p, true, true, false, 62000, c) == restore_step::idle, "and never again");

    // Died during the settle (down -> not alive): the settle starts over at the next spawn.
    pending_restore q;
    q.active = true; q.queued_ms = 0; q.values.have = true;
    step_restore(q, true, true, false, 100, c);
    step_restore(q, true, true, false, 1000, c);
    check(step_restore(q, true, false, false, 1100, c) == restore_step::wait, "not alive resets");
    step_restore(q, true, true, false, 2000, c);
    check(step_restore(q, true, true, false, 3000, c) == restore_step::wait, "1000 ms into the new settle");
    check(step_restore(q, true, true, false, 3500, c) == restore_step::apply, "1500 ms into the new settle");

    // Never spawned: dropped after the expiry.
    pending_restore r;
    r.active = true; r.queued_ms = 0;
    check(step_restore(r, true, false, false, c.expire_ms - 1, c) == restore_step::wait, "just before expiry");
    check(step_restore(r, true, false, false, c.expire_ms, c) == restore_step::expire, "expired");
    check(!r.active, "expired is inactive");
}

int main() {
    test_signature();
    test_link_watch();
    test_sampling();
    test_counters_reset();
    test_seat();
    test_merge();
    test_restore_plan();
    std::printf("reconnect_rules: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
