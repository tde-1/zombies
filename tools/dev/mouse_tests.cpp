// mouse_tests: unit tests for the two pure pieces behind client.md §1f.
//   * raw_buffer.hpp  -- the RAWMOUSE offset inside a GetRawInputBuffer block
//   * mouse_jitter.hpp -- the view-turn meter
// Built by CMake next to loadtest; run it, exit code 0 = pass.
#include <windows.h>

#include <cstdio>
#include <cstring>

#include "../../client-dll/components/mouse_jitter.hpp"
#include "../../client-dll/components/raw_buffer.hpp"

namespace {
int g_fail = 0;
#define CHECK(c)                                                              \
    do {                                                                      \
        if (!(c)) {                                                           \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #c);          \
            ++g_fail;                                                         \
        }                                                                     \
    } while (0)

void test_offsets() {
    CHECK(enw::rawbuf::mouse_offset_for(true, 4) == 24);   // WOW64: 64-bit header
    CHECK(enw::rawbuf::mouse_offset_for(false, 4) == sizeof(RAWINPUTHEADER));
    CHECK(sizeof(RAWINPUTHEADER) == 16);                    // this test is built x86
    BOOL wow = FALSE;
    ::IsWow64Process(::GetCurrentProcess(), &wow);
    CHECK(enw::rawbuf::mouse_offset() == (wow ? 24u : 16u));
}

// A block exactly as rawprobe dumped it from GetRawInputBuffer on this box
// (2026-09-23, WOW64): dwType 0, dwSize 48, 8-byte hDevice 0, 8-byte wParam 1,
// then RAWMOUSE {usFlags 0, ulButtons 0, ulRawButtons 0, lLastX 1, lLastY 0,
// ulExtraInformation 0xE17E0000}.
void test_block_parse() {
    alignas(8) unsigned char blk[48] = {};
    const unsigned dw[] = {0, 48, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0xE17E0000u};
    std::memcpy(blk, dw, sizeof dw);
    const auto* ri = reinterpret_cast<const RAWINPUT*>(blk);
    CHECK(ri->header.dwType == RIM_TYPEMOUSE);
    CHECK(ri->header.dwSize == 48);
    // The old read: 8 bytes early, motion gone, marker gone.
    CHECK(ri->data.mouse.lLastX == 0);
    CHECK(ri->data.mouse.ulExtraInformation != 0xE17E0000u);
    // The fixed read.
    const RAWMOUSE* m = enw::rawbuf::mouse_of(ri, enw::rawbuf::mouse_offset_for(true, 4));
    CHECK(m->lLastX == 1);
    CHECK(m->lLastY == 0);
    CHECK(m->ulExtraInformation == 0xE17E0000u);
    // A click in a buffered report: the old read turned it into a yaw.
    unsigned dw2[12];
    std::memcpy(dw2, dw, sizeof dw2);
    dw2[7] = RI_MOUSE_LEFT_BUTTON_DOWN;  // ulButtons at RAWMOUSE+4 = block+28
    dw2[9] = 0;
    std::memcpy(blk, dw2, sizeof dw2);
    CHECK(ri->data.mouse.lLastX == RI_MOUSE_LEFT_BUTTON_DOWN);  // bug: click -> dx
    CHECK(ri->data.mouse.usButtonFlags == 0);                    // bug: click lost
    m = enw::rawbuf::mouse_of(ri, 24);
    CHECK(m->usButtonFlags == RI_MOUSE_LEFT_BUTTON_DOWN);
    CHECK(m->lLastX == 0);
}

void test_jitter_even() {
    enw::mousejitter::meter j;
    j.reset();
    for (int i = 0; i < 1000; ++i) j.add(4.0, 4.0);
    CHECK(j.moving_frames() == 998);
    CHECK(j.dropouts() == 0);
    CHECK(j.jitter_pct() < 0.01);
    CHECK(j.pct_error_percentile(0.99) == 1);
}

void test_jitter_dropouts() {
    // 1 report/ms, 4 ms frames, every 4th frame's reports "lost" (the bug).
    enw::mousejitter::meter j;
    j.reset();
    for (int i = 0; i < 1000; ++i) j.add((i % 4 == 3) ? 0.0 : 4.0, 4.0);
    CHECK(j.dropouts() >= 240);
    CHECK(j.jitter_pct() > 20.0);
    CHECK(j.pct_error_percentile(0.99) >= 100);
    CHECK(j.delivered() == 750 * 4.0);
}

void test_jitter_uneven_frames_even_rate() {
    // Frames of 3,4,5 ms carrying exactly rate*dt: an even turn at uneven fps.
    enw::mousejitter::meter j;
    j.reset();
    const double dts[3] = {3.0, 4.0, 5.0};
    for (int i = 0; i < 999; ++i) j.add(dts[i % 3] * 1.0, dts[i % 3]);
    CHECK(j.jitter_pct() < 0.01);
    CHECK(j.dropouts() == 0);
}

// T4 calls IN_MouseMove twice per engine frame; the second call finds ~nothing.
// Fed per call that is a "dropout" every other sample; summed per frame (what
// probe_frame_flush does) it is the even turn it really is.
void test_jitter_double_call_per_frame() {
    enw::mousejitter::meter per_call, per_frame;
    per_call.reset();
    per_frame.reset();
    for (int i = 0; i < 1000; ++i) {
        per_call.add(4.0, 3.7);
        per_call.add(0.0, 0.3);
        per_frame.add(4.0 + 0.0, 4.0);
    }
    CHECK(per_call.dropouts() >= 990);
    CHECK(per_call.jitter_pct() > 80.0);
    CHECK(per_frame.dropouts() == 0);
    CHECK(per_frame.jitter_pct() < 0.01);
}

void test_jitter_stationary_ignored() {
    enw::mousejitter::meter j;
    j.reset();
    for (int i = 0; i < 100; ++i) j.add(0.0, 4.0);
    CHECK(j.moving_frames() == 0);
    CHECK(j.jitter_pct() == 0.0);
}
}  // namespace

int main() {
    test_offsets();
    test_block_parse();
    test_jitter_even();
    test_jitter_dropouts();
    test_jitter_uneven_frames_even_rate();
    test_jitter_double_call_per_frame();
    test_jitter_stationary_ignored();
    if (g_fail) std::printf("mouse_tests: %d FAILED\n", g_fail);
    else std::printf("mouse_tests: all passed\n");
    return g_fail ? 1 : 0;
}
