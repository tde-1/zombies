// Unit test for server/components/dedicated/freeze_watch.hpp -- the freeze rule, no engine.
//
// Not under server/components/: CMake globs that directory into the DLL. Build and run:
//
//     cl /nologo /EHsc /std:c++17 server\tests\freeze_watch_test.cpp /Fe:build\freeze_watch_test.exe
//     build\freeze_watch_test.exe
//
//     g++ -std=c++17 server/tests/freeze_watch_test.cpp -o /tmp/fwt && /tmp/fwt
//
// The numbers in the §23 replay are the ones in enw-4520.log (dedi.md §23.1).
#include "../components/dedicated/freeze_watch.hpp"

#include <cstdio>

using namespace enw::freeze_watch;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}

// One outer frame of a healthy server: the body is entered and comes back, and
// com_frameTime moves by the frame's length.
struct sim {
    sample s{1000, 9660, 0, 0};
    void healthy(uint32_t ms = 23) { s.now_ms += ms; s.frame_time += ms; ++s.entered; ++s.body; }
    void escaped(uint32_t ms = 16) { s.now_ms += ms; ++s.entered; }          // faulted before the write
    void escaped_after_write(uint32_t ms = 23) { s.now_ms += ms; s.frame_time += ms; ++s.entered; }
    void long_frame(uint32_t ms) { s.now_ms += ms; s.frame_time += ms; ++s.entered; ++s.body; }
};

static void test_healthy_never_fires() {
    watch w;
    sim m;
    w.feed(m.s);
    bool fired = false, escaped = false;
    for (int i = 0; i < 43 * 285; ++i) {   // 285 s at 43 Hz, the §23 game before the freeze
        m.healthy();
        const auto r = w.feed(m.s);
        fired |= r.frozen_now;
        escaped |= r.escaped_now != 0;
    }
    check(!fired, "a healthy 285 s game never fires");
    check(!escaped, "a healthy game has no escaped frames");
    check(w.armed(), "a healthy game arms the watch");
    check(w.escaped_total() == 0, "escaped_total stays 0");
}

static void test_section23_replay() {
    watch w;
    sim m;
    w.feed(m.s);
    for (int i = 0; i < 43 * 280; ++i) { m.healthy(); w.feed(m.s); }
    // 12:32:59.9 - 12:33:04.97: one frame escaped (body 40.2 vs entered 40.4 Hz).
    m.escaped_after_write();
    auto r = w.feed(m.s);
    check(r.escaped_now == 1, "the single escaped frame is counted");
    check(!r.frozen_now, "one escaped frame is not a freeze");
    for (int i = 0; i < 43 * 5; ++i) { m.healthy(); w.feed(m.s); }
    // 12:33:05.2: the overrun; from here every frame faults at 0x5FFE23 before the write.
    uint32_t fired_at = 0, frames = 0, escapes = 0;
    for (int i = 0; i < 62 * 60; ++i) {   // a minute at 61.8 Hz
        m.escaped();
        const auto x = w.feed(m.s);
        ++frames;
        escapes += x.escaped_now;
        if (x.frozen_now) {
            check(fired_at == 0, "fires only once");
            fired_at = frames;
            check(x.stalled_ms > 5000 && x.stalled_ms < 5100, "fires just past 5 s of stall");
            check(x.stalled_frames >= 300, "and after ~5 s worth of entered frames");
        }
    }
    check(fired_at != 0, "the §23 freeze fires");
    check(fired_at > 300 && fired_at < 330, "within one second of the 5 s line at 62 Hz");
    check(escapes == frames, "every frozen frame is an escaped frame");
    check(w.fired(), "fired() latches");
    check(!w.resumed_after_firing(), "a frozen server does not resume");
}

static void test_long_frame_is_not_a_freeze() {
    // A map_restart or a slow load blocks the outer loop: our subscriber is simply
    // not called, and when it is, com_frameTime has moved.
    watch w;
    sim m;
    w.feed(m.s);
    for (int i = 0; i < 500; ++i) { m.healthy(); w.feed(m.s); }
    m.long_frame(9000);
    auto r = w.feed(m.s);
    check(!r.frozen_now, "one 9 s frame that advanced com_frameTime is not a freeze");
    // Even a long frame whose com_frameTime did NOT move is not enough on its own:
    // it is one frame, not a loop spinning past a dead body.
    m.s.now_ms += 9000; ++m.s.entered; ++m.s.body;
    r = w.feed(m.s);
    check(!r.frozen_now, "one long frame with a still clock does not fire (min_frames)");
    for (int i = 0; i < 100; ++i) { m.healthy(); r = w.feed(m.s); check(!r.frozen_now, "recovers"); }
}

static void test_boot_does_not_fire() {
    // Before the map runs, com_frameTime can sit still while frames are entered.
    watch w;
    sim m;
    w.feed(m.s);
    bool fired = false;
    for (int i = 0; i < 60 * 20; ++i) {
        m.s.now_ms += 16; ++m.s.entered; ++m.s.body;   // clock not moving
        fired |= w.feed(m.s).frozen_now;
    }
    check(!fired, "a server whose clock has never moved is not armed");
    check(!w.armed(), "not armed during boot");
    for (int i = 0; i < 3; ++i) { m.healthy(); w.feed(m.s); }
    check(w.armed(), "armed after three advances");
}

static void test_counter_wrap() {
    watch w;
    sim m;
    m.s.entered = 0xFFFFFFF0u; m.s.body = 0xFFFFFFF0u; m.s.frame_time = 0xFFFFFF00u;
    w.feed(m.s);
    bool escaped = false;
    for (int i = 0; i < 64; ++i) { m.healthy(); escaped |= w.feed(m.s).escaped_now != 0; }
    check(!escaped, "wrapping counters are not escapes");
}

static void test_resume_after_fire_is_reported() {
    watch w(5000, 30, 3);
    sim m;
    w.feed(m.s);
    for (int i = 0; i < 100; ++i) { m.healthy(); w.feed(m.s); }
    for (int i = 0; i < 400; ++i) { m.escaped(); w.feed(m.s); }
    check(w.fired(), "fired");
    m.healthy();
    w.feed(m.s);
    check(w.resumed_after_firing(), "a clock that moves again after firing is reported");
}

static void test_vm_rest() {
    vm_state rest;
    check(vm_at_rest(rest), "default is rest");
    check(local_depth(rest) == 0, "rest depth 0");
    check(!vm_overran(rest), "rest is not an overrun");

    vm_state live = rest;   // the §23 varpool line at 12:33:29
    live.local_vars = 0x03BFE2DC;
    check(!vm_at_rest(live), "03BFE2DC is not rest");
    check(local_depth(live) == 33075, "03BFE2DC is 33,075 slots up");
    check(vm_overran(live), "03BFE2DC is past localVarsStack");

    vm_state half = rest;   // an escaped frame five functions deep
    half.function_count = 5;
    half.function_frame = kFunctionFrameRest + 5 * 0x18;
    half.local_vars = kLocalVarsRest + 4 * 37;
    check(!vm_at_rest(half), "a half-executed thread is not rest");
    check(!vm_overran(half), "but it has not overrun yet");
    check(local_depth(half) == 37, "depth 37");

    vm_state top = rest;
    top.top = kTopRest + 8;
    check(!vm_at_rest(top), "an operand left on the stack is not rest");

    vm_state last = rest;
    last.local_vars = kLocalVarsStackEnd - 4;
    check(!vm_overran(last), "the last slot is still inside the stack");
    last.local_vars = kLocalVarsStackEnd;
    check(vm_overran(last), "one past the end is an overrun");
}

int main() {
    test_healthy_never_fires();
    test_section23_replay();
    test_long_frame_is_not_a_freeze();
    test_boot_does_not_fire();
    test_counter_wrap();
    test_resume_after_fire_is_reported();
    test_vm_rest();
    std::printf("freeze_watch_test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
