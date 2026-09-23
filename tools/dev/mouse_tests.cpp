// mouse_tests: unit tests for the two pure pieces behind client.md §1f.
//   * raw_buffer.hpp  -- the RAWMOUSE offset inside a GetRawInputBuffer block
//   * mouse_jitter.hpp -- the view-turn meter
// Built by CMake next to loadtest; run it, exit code 0 = pass.
#include <windows.h>

#include <cstdio>
#include <cstring>

#include "../../client-dll/components/mouse_jitter.hpp"
#include "../../client-dll/components/raw_buffer.hpp"
#include "../../client-dll/components/raw_mouse_model.hpp"

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

// ===========================================================================
// Lane 17b (client.md §1g): the compensations in raw_mouse_model.hpp.
// ===========================================================================
namespace rm = enw::rawmodel;

// The engine, as far as mouse input goes, read off the dump (client.md §6a):
// every WM_MOUSEMOVE / WM_?BUTTON? goes to 0x6070F7, which turns the MK_ bits into a
// 5-bit mask and IN_MouseEvent XORs it against oldButtonState -> one key event per
// changed bit. WM_MOUSEWHEEL goes to 0x60706B: one MWHEELUP (delta > 0) or
// MWHEELDOWN (delta <= 0) per MESSAGE.
struct engine_model {
    int old = 0;
    int downs[5] = {}, ups[5] = {};
    int wheel_up = 0, wheel_down = 0;
    void mouse_msg(WPARAM wp) {
        int m = 0;
        if (wp & MK_LBUTTON) m |= 1;
        if (wp & MK_RBUTTON) m |= 2;
        if (wp & MK_MBUTTON) m |= 4;
        if (wp & MK_XBUTTON1) m |= 8;
        if (wp & MK_XBUTTON2) m |= 16;
        const int ch = m ^ old;
        for (int i = 0; i < 5; ++i)
            if (ch & (1 << i)) ++((m & (1 << i)) ? downs : ups)[i];
        old = m;
    }
    void wheel_msg(int delta) { ++(delta > 0 ? wheel_up : wheel_down); }
};

// mouse_polling's message path with the engine behind it: raw reports (dispatched
// or buffered -- the same consume path since 17b) and legacy messages, in whatever
// order a test feeds them. `ledger=false` is 0.2.3-0.2.24's wheel handling.
struct pipeline {
    WPARAM mask = 0, known = 0;
    rm::wheel_ledger L;
    engine_model E;
    unsigned long long frame = 0;
    bool ledger = true;
    void raw(USHORT flags, short wheel = 0) {
        rm::raw_transition t[10];
        const int n = rm::decode_button_flags(flags, t);
        for (int i = 0; i < n; ++i) {
            rm::apply_transition(&mask, &known, t[i].mk, t[i].down);
            E.mouse_msg(mask);  // emit_button: the post-transition mask
        }
        if (flags & RI_MOUSE_WHEEL) {
            if (!ledger) { E.wheel_msg(wheel); return; }
            if (L.on_raw(wheel, frame)) E.wheel_msg(wheel);
        }
    }
    void legacy_mouse(WPARAM wp) { E.mouse_msg(rm::rewrite_low_word(wp, mask, known)); }
    void legacy_wheel(int delta) {
        if (!ledger || delta == 0 || L.on_legacy(delta, frame)) E.wheel_msg(delta);
    }
};

void test_click_nolegacy_buffered_exactly_once() {
    // NOLEGACY: no legacy messages at all; the click is only in (buffered) raw.
    pipeline p;
    p.raw(RI_MOUSE_LEFT_BUTTON_DOWN);
    p.raw(0);  // plain motion reports in between carry no transition
    p.raw(RI_MOUSE_LEFT_BUTTON_UP);
    CHECK(p.E.downs[0] == 1 && p.E.ups[0] == 1);
}

void test_click_legacy_mode_twins_either_order() {
    pipeline p;
    // Legacy twin dispatched in the pump BEFORE the raw report is drained.
    p.raw(RI_MOUSE_LEFT_BUTTON_DOWN);       // an earlier click makes MOUSE1 "known"
    p.legacy_mouse(MK_LBUTTON);
    p.raw(RI_MOUSE_LEFT_BUTTON_UP);
    p.legacy_mouse(0);
    CHECK(p.E.downs[0] == 1 && p.E.ups[0] == 1);
    p.legacy_mouse(MK_LBUTTON);             // twin first (mask not yet down -> no edge)
    CHECK(p.E.downs[0] == 1);
    p.raw(RI_MOUSE_LEFT_BUTTON_DOWN);       // then the buffered raw report: THE edge
    CHECK(p.E.downs[0] == 2);
    p.legacy_mouse(0);                      // up twin first: rewritten to "still down"
    CHECK(p.E.ups[0] == 1);
    p.raw(RI_MOUSE_LEFT_BUTTON_UP);
    CHECK(p.E.downs[0] == 2 && p.E.ups[0] == 2);
}

void test_click_first_ever_legacy_first() {
    // MOUSE1 never seen in raw yet: the legacy message passes and makes the edge,
    // the raw report that follows carries the same mask -> no second edge.
    pipeline p;
    p.legacy_mouse(MK_LBUTTON);
    p.raw(RI_MOUSE_LEFT_BUTTON_DOWN);
    p.legacy_mouse(0);
    p.raw(RI_MOUSE_LEFT_BUTTON_UP);
    CHECK(p.E.downs[0] == 1 && p.E.ups[0] == 1);
}

void test_click_within_one_report_and_stale_moves() {
    pipeline p;
    p.raw(RI_MOUSE_RIGHT_BUTTON_DOWN | RI_MOUSE_RIGHT_BUTTON_UP);  // a click shorter than 1 report
    CHECK(p.E.downs[1] == 1 && p.E.ups[1] == 1);
    // client.md §6b arm C: moves carrying a stale MK_RBUTTON invent nothing once known.
    for (int i = 0; i < 3; ++i) p.legacy_mouse(MK_RBUTTON);
    CHECK(p.E.downs[1] == 1 && p.E.ups[1] == 1);
    // the wheel's high word survives a rewrite
    const WPARAM w = MAKEWPARAM(MK_RBUTTON, static_cast<WORD>(-120));
    CHECK(HIWORD(rm::rewrite_low_word(w, 0, MK_RBUTTON)) == static_cast<WORD>(-120));
    CHECK(LOWORD(rm::rewrite_low_word(w, 0, MK_RBUTTON)) == 0);
    // XBUTTON order: a report with 4 and 5 both down emits two transitions
    rm::raw_transition t[10];
    CHECK(rm::decode_button_flags(RI_MOUSE_BUTTON_4_DOWN | RI_MOUSE_BUTTON_5_DOWN, t) == 2);
    CHECK(t[0].mk == MK_XBUTTON1 && t[1].mk == MK_XBUTTON2);
    CHECK(rm::decode_button_flags(RI_MOUSE_WHEEL, t) == 0);  // a wheel is not a button
}

void test_wheel_double_old_and_fixed() {
    // Legacy mode (menu / NOLEGACY=0): every notch is raw AND legacy.
    pipeline old_way;
    old_way.ledger = false;
    for (int i = 0; i < 5; ++i) { old_way.raw(RI_MOUSE_WHEEL, 120); old_way.legacy_wheel(120); }
    CHECK(old_way.E.wheel_up == 10);  // the 0.2.3-0.2.24 double
    pipeline p;
    for (int i = 0; i < 5; ++i) { p.raw(RI_MOUSE_WHEEL, 120); p.legacy_wheel(120); }
    CHECK(p.E.wheel_up == 5);
    for (int i = 0; i < 4; ++i) { p.legacy_wheel(-120); p.raw(RI_MOUSE_WHEEL, -120); }  // twin first
    CHECK(p.E.wheel_down == 4);
    // A burst: three raw, then three legacy twins in the next frame.
    ++p.frame;
    for (int i = 0; i < 3; ++i) p.raw(RI_MOUSE_WHEEL, 120);
    ++p.frame;
    for (int i = 0; i < 3; ++i) p.legacy_wheel(120);
    CHECK(p.E.wheel_up == 8);
    CHECK(p.L.swallowed() == 12);
}

void test_wheel_nolegacy_touchpad_and_expiry() {
    pipeline p;
    for (int i = 0; i < 7; ++i) p.raw(RI_MOUSE_WHEEL, -120);  // NOLEGACY: raw only
    CHECK(p.E.wheel_down == 7);
    p.frame += 10;  // the unpaired credits expire...
    p.legacy_wheel(-120);  // ...so a touchpad notch later is NOT eaten
    CHECK(p.E.wheel_down == 8);
    p.frame += 10;
    p.legacy_wheel(120);  // touchpad, no raw twin ever
    CHECK(p.E.wheel_up == 1);
    p.raw(RI_MOUSE_WHEEL, -120);  // opposite direction never pairs
    CHECK(p.E.wheel_down == 9);
    // zero delta: not a notch (the engine would read it as MWHEELDOWN)
    rm::wheel_ledger L;
    CHECK(!L.on_raw(0, 0));
    // within the TTL a missing twin can eat at most what it was owed
    CHECK(L.on_raw(120, 100));
    CHECK(!L.on_legacy(120, 100 + rm::wheel_ledger::kTtlFrames));
    CHECK(L.on_legacy(120, 100 + rm::wheel_ledger::kTtlFrames));
}

// A real WOW64 block (rawprobe's layout) carrying a click and a wheel notch.
void test_block_offset_from_size_and_misread_guard() {
    CHECK(rm::offset_from_block_size(40) == 16);
    CHECK(rm::offset_from_block_size(48) == 24);
    CHECK(rm::offset_from_block_size(0) == 0);
    CHECK(rm::offset_from_block_size(44) == 0);
    CHECK(rm::block_stride(48, true) == 48);
    CHECK(rm::block_stride(41, true) == 48);   // a HID block on the 64-bit side
    CHECK(rm::block_stride(41, false) == 44);  // what NEXTRAWINPUTBLOCK would have done
    alignas(8) unsigned char blk[48] = {};
    // dwType 0, dwSize 48, hDevice(8) 0, wParam(8) 0 (foreground: RIM_INPUT),
    // RAWMOUSE: usFlags 0, usButtonFlags WHEEL | usButtonData 120, raw 0, x 0, y 0.
    const unsigned dw[] = {0, 48, 0, 0, 0, 0, 0,
                           RI_MOUSE_WHEEL | (120u << 16), 0, 0, 0, 0};
    std::memcpy(blk, dw, sizeof dw);
    const auto* ri = reinterpret_cast<const RAWINPUT*>(blk);
    const RAWMOUSE* m = enw::rawbuf::mouse_of(ri, rm::offset_from_block_size(ri->header.dwSize));
    CHECK(m->usButtonFlags == RI_MOUSE_WHEEL);
    CHECK(static_cast<SHORT>(m->usButtonData) == 120);
    CHECK(m->lLastX == 0 && m->lLastY == 0);                     // a wheel is not motion
    CHECK(rm::plausible_relative(m->lLastX, m->lLastY));
    // The old +16 read: the wheel becomes a 7.8 M-count yaw -- now refused outright.
    const RAWMOUSE* bad = enw::rawbuf::mouse_of(ri, 16);
    CHECK(bad->lLastX == 0x00780400);
    CHECK(!rm::plausible_relative(bad->lLastX, bad->lLastY));
    CHECK(rm::plausible_relative(32767, -32767));
    CHECK(!rm::plausible_relative(0, -32768));
    // A click in the same slot, fixed read: exactly one LEFT DOWN transition, no motion.
    unsigned dw2[12];
    std::memcpy(dw2, dw, sizeof dw2);
    dw2[7] = RI_MOUSE_LEFT_BUTTON_DOWN;
    std::memcpy(blk, dw2, sizeof dw2);
    m = enw::rawbuf::mouse_of(ri, 24);
    rm::raw_transition t[10];
    CHECK(rm::decode_button_flags(m->usButtonFlags, t) == 1 && t[0].down && t[0].mk == MK_LBUTTON);
    CHECK(m->lLastX == 0);
}

void test_bulk_error_policy() {
    CHECK(rm::bulk_error_is_transient(ERROR_INSUFFICIENT_BUFFER));
    CHECK(!rm::bulk_error_is_transient(ERROR_PROC_NOT_FOUND));  // Special K
    CHECK(!rm::bulk_error_is_transient(ERROR_NOACCESS));
    CHECK(rm::kBulkFailLimit > 1);
}

void test_raw_value_rebase_and_absolute() {
    rm::rawMouseValue_t v;
    // relative: two frames, deltas exact, accumulator rebased (cannot overflow)
    for (int f = 0; f < 100000; ++f) {
        for (int r = 0; r < 8; ++r) v.Update(30000, false);  // 240k counts a frame
        CHECK(v.GetDelta() == 240000);
        v.ResetDelta();
        if (v.current != 0) { CHECK(v.current == 0); break; }
    }
    // relative -> absolute: no jump on the first absolute report
    v.Update(5, false);
    v.Update(1000, true);
    CHECK(v.GetDelta() == 0);
    v.ResetDelta();
    v.Update(1010, true);
    v.Update(1030, true);
    CHECK(v.GetDelta() == 30);
    v.ResetDelta();
    // absolute -> relative: continues from the position, no jump
    v.Update(-4, false);
    CHECK(v.GetDelta() == -4);
    // pixel mapping (SDL3's rule)
    CHECK(rm::absolute_to_pixels(0, 0, 2560) == 0);
    CHECK(rm::absolute_to_pixels(65535, 0, 2560) == 2559);
    CHECK(rm::absolute_to_pixels(32768, -1920, 4480) == 320);  // second monitor on the left
}

void test_speed_and_scaler() {
    CHECK(rm::windows_speed_multiplier(10) == 1.0);
    CHECK(rm::windows_speed_multiplier(6) == 0.5);
    CHECK(rm::windows_speed_multiplier(20) == 3.5);
    CHECK(rm::windows_speed_multiplier(0) == 1.0);
    rm::scaler s;
    int dx = 7, dy = -7;
    s.apply(&dx, &dy);  // default 1.0: untouched
    CHECK(dx == 7 && dy == -7);
    s.set(0.5);
    int tx = 0, ty = 0;
    for (int i = 0; i < 11; ++i) { int x = 1, y = -1; s.apply(&x, &y); tx += x; ty += y; }
    CHECK(tx == 5 && ty == -5);  // 5.5 -> 5 delivered, 0.5 carried, nothing lost
    int x = 1, y = -1;
    s.apply(&x, &y);
    CHECK(x == 1 && y == -1);    // ...and the carry comes out
}

void test_clip_geometry() {
    const RECT r = {0, 0, 2560, 1440};
    CHECK(!rm::outside_inner({1280, 720}, r, 25));
    CHECK(rm::outside_inner({2559, 720}, r, 25));      // parked at the right edge
    CHECK(rm::outside_inner({1280, 0}, r, 25));
    CHECK(!rm::outside_inner({640, 360}, r, 25));      // exactly on the inner box
    CHECK(!rm::outside_inner({5, 5}, RECT{0, 0, 0, 0}, 25));
    const RECT a = {0, 0, 2560, 1440}, b = {1, 0, 2561, 1439}, c = {0, 0, 1280, 720};
    CHECK(rm::rect_same(a, a));
    CHECK(!rm::rect_same(a, b));
    CHECK(rm::rect_same(a, b, 2));   // DPI round trip
    CHECK(!rm::rect_same(a, c, 2));  // borderless resized the window: stale clip
}

void test_registration_verdicts() {
    using E = rm::reg_entry;
    const E ours[] = {{1, 2, RIDEV_NOLEGACY, true, true}};
    auto v = rm::classify_registrations(ours, 1, true);
    CHECK(v.mouse_present && v.mouse_ours && !v.foreign_on_thread);
    v = rm::classify_registrations(ours, 1, false);  // flags no longer what we set
    CHECK(v.mouse_present && !v.mouse_ours);
    const E stolen[] = {{1, 2, 0, false, false}};
    v = rm::classify_registrations(stolen, 1, false);
    CHECK(v.mouse_present && !v.mouse_ours);
    v = rm::classify_registrations(nullptr, 0, true);  // removed
    CHECK(!v.mouse_present && !v.mouse_ours);
    const E kb[] = {{1, 2, 0, true, true}, {1, 6, 0, false, true}, {1, 5, 0, false, false}};
    v = rm::classify_registrations(kb, 3, false);
    CHECK(v.mouse_ours && v.foreign_on_thread);
    const E kb_elsewhere[] = {{1, 2, 0, true, true}, {1, 6, 0, false, false}};
    v = rm::classify_registrations(kb_elsewhere, 2, false);
    CHECK(v.mouse_ours && !v.foreign_on_thread);
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
    test_click_nolegacy_buffered_exactly_once();
    test_click_legacy_mode_twins_either_order();
    test_click_first_ever_legacy_first();
    test_click_within_one_report_and_stale_moves();
    test_wheel_double_old_and_fixed();
    test_wheel_nolegacy_touchpad_and_expiry();
    test_block_offset_from_size_and_misread_guard();
    test_bulk_error_policy();
    test_raw_value_rebase_and_absolute();
    test_speed_and_scaler();
    test_clip_geometry();
    test_registration_verdicts();
    if (g_fail) std::printf("mouse_tests: %d FAILED\n", g_fail);
    else std::printf("mouse_tests: all passed\n");
    return g_fail ? 1 : 0;
}
