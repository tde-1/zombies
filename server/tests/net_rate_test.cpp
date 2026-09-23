// Unit test for server/components/net/net_rate.hpp -- the snapshot pacing arithmetic.
//
// Not under server/components/: CMake globs that directory into the DLL. Build and run:
//
//     cl /nologo /EHsc /std:c++17 server\tests\net_rate_test.cpp /Fe:build\net_rate_test.exe
//     build\net_rate_test.exe
//
//     g++ -std=c++17 server/tests/net_rate_test.cpp -o /tmp/nrt && /tmp/nrt
//
// The "measured" cases are box net_probe windows (dedi.md §22.3, §24.2): the formula must
// give what the engine did before it is trusted to say what the patch will do.
#include "../components/net/net_rate.hpp"

#include <cmath>
#include <cstdio>

using namespace enw::net_rate;

static int g_pass = 0, g_fail = 0;
static void check(bool c, const char* what) {
    if (c) { ++g_pass; return; }
    ++g_fail;
    std::printf("FAIL: %s\n", what);
}
static bool near(double a, double b) { return std::fabs(a - b) < 0.05; }

int main() {
    // --- the patch operand ---
    check(imul_for_scale(1) == 1000, "scale 1 = stock 1000");
    check(imul_for_scale(4) == 250, "scale 4 = 250");
    check(imul_for_scale(8) == 125, "scale 8 = 125");
    check(imul_for_scale(0) == 1000 && imul_for_scale(-3) == 1000, "scale < 1 clamps to stock");
    check(imul_for_scale(99) == 125, "scale > 8 clamps to 8");
    check(kImulStock[2] == 0xE8 && kImulStock[3] == 0x03, "stock imm32 is 0x3E8 little-endian");

    // --- the engine as measured, scale 1 (stock) ---
    // m_ee07e7e8 02:42:44-02:43:14: ~2,100-byte messages as two fragments, rate 25000:
    // 10.0 msgs/s, delay avg 85-91 ms.
    {
        const int d = next_delay_msec(2100, 25000, 1, 33, true);
        check(d >= 85 && d <= 91, "2,100 B fragmented at 25000 -> ~87 ms (measured 85-91)");
        check(near(snapshots_per_second(d), 10.0), "... -> 10 snapshots/s (measured 10.0)");
    }
    // net_fear_7000 (§22.3): 640-byte snapshots at 7000 -> 10.0/s.
    check(near(snapshots_per_second(next_delay_msec(640, 7000, 1, 33, false)), 10.0),
          "640 B at 7000 -> 10/s (measured 10.0)");
    // box_fear_rate7000 (§22.3): fragmented ~2,100 B messages at 7000 -> 3.0/s, delay 310-325.
    {
        const int d = next_delay_msec(2100, 7000, 1, 33, true);
        check(d >= 300 && d <= 330, "2,100 B fragmented at 7000 -> ~309 ms (measured 310-325)");
        check(std::fabs(snapshots_per_second(d) - 3.0) < 0.2, "... -> ~3/s (measured 3.0)");
    }
    // B's 13:42 game: 640 B at 25000, snaps 30 (snapshotMsec 33) -> 20/s, 0 delayed.
    check(next_delay_msec(640, 25000, 1, 33, false) == 33, "640 B at 25000 -> snapshotMsec 33 wins");
    check(near(snapshots_per_second(33), 20.0), "33 ms -> every server frame = 20/s (measured 20.0)");
    // §23 game, round 4: ~1,025 B -> 43 ms > 33 (rateDelayed set) but still one frame.
    check(next_delay_msec(1025, 25000, 1, 33, false) == 43, "1,025 B at 25000 -> 43 ms (rate-delayed)");
    check(near(snapshots_per_second(43), 20.0), "... still 20/s");
    check(max_bytes_at_20hz(25000, 1) == 1186, "stock: 1,186 B is the most that goes at 20 Hz");

    // --- with the patch, scale 4 ---
    check(next_delay_msec(2100, 25000, 4, 33, true) == 21, "2,100 B fragmented, scale 4 -> 21 ms");
    check(near(snapshots_per_second(next_delay_msec(2100, 25000, 4, 33, true)), 20.0),
          "... -> 20/s (was 10)");
    check(max_bytes_at_20hz(25000, 4) == 4936, "scale 4: 4,936 B still goes at 20 Hz");
    check(near(snapshots_per_second(next_delay_msec(4936, 25000, 4, 33, true)), 20.0), "4,936 B -> 20/s");
    check(near(snapshots_per_second(next_delay_msec(4937 + 100, 25000, 4, 33, true)), 10.0),
          "just over the bound -> 10/s (the bound is real)");
    // A player whose own config says rate 7000 is still helped: 28,000 effective.
    check(near(snapshots_per_second(next_delay_msec(640, 7000, 4, 33, false)), 20.0),
          "640 B at a client rate of 7000, scale 4 -> 20/s (was 10)");
    // Small messages are unchanged: snapshotMsec still wins.
    check(next_delay_msec(120, 25000, 4, 50, false) == 50, "Nacht-sized, snaps 20 -> 50 ms as before");

    // --- the one-fragment clamp only applies to the whole-message path ---
    check(rate_msec(5000, 25000, 1, false) == rate_msec(1164, 25000, 1, false), "SV_RateMsec clamps");
    check(rate_msec(5000, 25000, 1, true) > rate_msec(1164, 25000, 1, true), "0x639360 does not");
    check(rate_msec(100, 0, 1, false) > 0, "rate 0 does not divide by zero");

    std::printf("net_rate_test: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
