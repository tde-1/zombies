// raw_mouse_model.hpp -- the pure decisions behind mouse_polling's compensations
// (client.md §1g, 2026-09-23, lane 17b).
//
// B played 0.2.24, frame time is fine, and asked for every downside of the raw-input
// mouse and of NOLEGACY to be listed and, where code can, paid for. Each piece here is
// one of those payments, kept free of engine addresses and of global state so
// tools/dev/mouse_tests.cpp can drive it without a game. mouse_polling.cpp owns the
// Win32 calls; this file owns the arithmetic and the rules.
//
// Reuse, not invention, where there is prior art:
//   * the per-block RAWMOUSE offset and the WOW64 header: MSDN GetRawInputBuffer
//     remarks and SDL3 WIN_PollRawInput (raw_buffer.hpp has the full note);
//   * GetRawInputBuffer returning -1 with ERROR_INSUFFICIENT_BUFFER being a buffer
//     problem, not a dead API: SDL3 WIN_PollRawInput grows its buffer on exactly that
//     error and keeps going (libsdl-org/SDL, src/video/windows/SDL_windowsevents.c);
//   * absolute (MOUSE_MOVE_ABSOLUTE) reports mapped onto the (virtual) desktop in
//     pixels: SDL3 WIN_HandleRawMouseInput, MOUSE_VIRTUAL_DESKTOP / SM_CXVIRTUALSCREEN;
//   * the Windows pointer-speed table (SPI_GETMOUSESPEED 1..20 -> multiplier, the
//     "6/11 notch" = 10 = 1.0): the table every raw-input sensitivity converter uses
//     (e.g. the Quake/Source community's m_rawinput calculators); we only log it and
//     apply it on an explicit opt-in.
#pragma once

#include <windows.h>

namespace enw::rawmodel {

// ---------------------------------------------------------------- block offset
// The RAWMOUSE offset inside one GetRawInputBuffer block, derived from THE BLOCK
// ITSELF: dwSize is header + RAWMOUSE, so 16 + 24 = 40 on the 32-bit layout and
// 24 + 24 = 48 on the WOW64 (64-bit header) layout. This is a second, independent
// signal next to IsWow64Process (raw_buffer.hpp): if a future Windows, an emulator
// or an injected module ever hands us the other layout, we read it correctly
// instead of turning a click into a yaw. Anything else is not a mouse block we
// understand and is skipped (0), never guessed at.
constexpr unsigned kRawMouseSize = 24;  // sizeof(RAWMOUSE), both bitnesses
constexpr unsigned offset_from_block_size(unsigned dwSize) {
    return dwSize == 16 + kRawMouseSize   ? 16u
           : dwSize == 24 + kRawMouseSize ? 24u
                                          : 0u;
}

// The step to the next block. NEXTRAWINPUTBLOCK in 32-bit code rounds dwSize up to
// 4; the WOW64 buffer is laid out by the 64-bit side, which rounds to 8 (MSDN's
// remark: "align the RAWINPUT structure by 8 bytes"). A mouse block is 48 either
// way, so this only matters if a block of another size (a HID report) is ever in
// the queue -- and then the 4-byte step would misparse every block after it.
constexpr unsigned block_stride(unsigned dwSize, bool wow64_layout) {
    return wow64_layout ? ((dwSize + 7u) & ~7u) : ((dwSize + 3u) & ~3u);
}

// ------------------------------------------------------- impossible deltas
// A relative HID mouse axis is at most 16 bits signed per report. A relative delta
// outside +-32767 cannot have come from a device; it is a misread (exactly what the
// 0.2.3-0.2.20 WOW64 bug produced: a wheel notch read as lLastX = 0x00780400, a
// ~7.8 million-count spin). Discard it, count it, never hand it to the engine.
constexpr long kMaxRelative = 32767;
constexpr bool plausible_relative(long dx, long dy) {
    return dx >= -kMaxRelative && dx <= kMaxRelative && dy >= -kMaxRelative &&
           dy <= kMaxRelative;
}

// ------------------------------------------------------- GetRawInputBuffer -1
// Should a (UINT)-1 from GetRawInputBuffer turn the bulk read off for the session?
// ERROR_INSUFFICIENT_BUFFER means the NEXT block is bigger than what we offered
// (SDL3 grows and retries); the report stays queued and its own WM_INPUT still
// delivers it, so this frame simply skips the bulk read. Anything else (Special K's
// ERROR_PROC_NOT_FOUND, SpecialKO/SpecialK#354) is a broken API: after
// kBulkFailLimit consecutive failures we stop calling it.
constexpr int kBulkFailLimit = 3;
constexpr bool bulk_error_is_transient(unsigned long err) {
    return err == ERROR_INSUFFICIENT_BUFFER;
}

// ------------------------------------------------------------ button tracker
// The two rules of mouse_polling's button state machine (its file header has the
// argument; client.md §6c the proof), lifted out unchanged so the "exactly one
// engine edge per physical transition" claim can be driven by a test against a
// model of the engine's differ (IN_MouseEvent 0x5FA5F0 XORs the 5-bit mask).
//
// Rule 1, a raw transition: update the tracked mask and mark the button known.
inline void apply_transition(WPARAM* mask, WPARAM* known, WPARAM mk, bool down) {
    if (down) *mask |= mk; else *mask &= ~mk;
    *known |= mk;
}
// Rule 2, any legacy mouse message: the known bits of its LOW word are replaced by
// the tracked mask; unknown bits and the high word (wheel delta, XBUTTON number)
// pass through untouched.
inline WPARAM rewrite_low_word(WPARAM wp, WPARAM mask, WPARAM known) {
    if (!known) return wp;
    const WPARAM lo = wp & 0xFFFF;
    const WPARAM fixed = (lo & ~known) | (mask & known);
    return (wp & ~static_cast<WPARAM>(0xFFFF)) | fixed;
}
// RAWMOUSE.usButtonFlags -> transitions, in the order they are emitted: per
// button, DOWN before UP (a click shorter than one report carries both).
struct raw_transition { int idx; WPARAM mk; bool down; };
inline int decode_button_flags(USHORT flags, raw_transition out[10]) {
    static const struct { USHORT dn, up; int idx; WPARAM mk; } k[5] = {
        {RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_LEFT_BUTTON_UP, 0, MK_LBUTTON},
        {RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_UP, 1, MK_RBUTTON},
        {RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_UP, 2, MK_MBUTTON},
        {RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_4_UP, 3, MK_XBUTTON1},
        {RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_BUTTON_5_UP, 4, MK_XBUTTON2},
    };
    int n = 0;
    for (const auto& b : k) {
        if (flags & b.dn) out[n++] = {b.idx, b.mk, true};
        if (flags & b.up) out[n++] = {b.idx, b.mk, false};
    }
    return n;
}

// -------------------------------------------------------------- wheel ledger
// THE DOUBLE-WHEEL BUG this fixes (found 2026-09-23, lane 17b). The engine's
// WM_MOUSEWHEEL handler (0x60706B) queues one K_MWHEELUP (0xCE) or K_MWHEELDOWN
// (0xCD) down+up PER MESSAGE -- it is an event, not a state, so the mask-differ
// argument that makes duplicate BUTTON messages harmless does not apply. Raw input
// is registered in every mode, so a wheel notch arrives as a raw RI_MOUSE_WHEEL
// AND, whenever legacy messages are on (the menu, the console, the frame of a flip,
// ENW_RAW_MOUSE_NOLEGACY=0), as a legacy WM_MOUSEWHEEL too. 0.2.3-0.2.24 synthesised
// the raw one AND forwarded the legacy one: two notches per notch.
//
// The ledger pairs twins instead of guessing which side of a flip a report was on
// (the same trap as button defect 2). Whichever twin is consumed first is delivered
// and leaves a credit; the other twin, if it comes within kTtlFrames, is swallowed
// against it. A legacy wheel with no raw twin (a precision touchpad, a PostMessage)
// is delivered; a raw wheel with no legacy twin (NOLEGACY) is delivered. Credits
// expire so a missing twin can never eat a later, genuine notch for long.
class wheel_ledger {
public:
    static constexpr unsigned long long kTtlFrames = 3;

    // `delta` is the signed wheel delta; 0 is ignored (it is not a notch -- and the
    // engine would read a 0-delta message as MWHEELDOWN). Returns true when the
    // caller must deliver this notch to the engine.
    bool on_raw(int delta, unsigned long long frame) { return take(delta, frame, raw_, leg_); }
    bool on_legacy(int delta, unsigned long long frame) { return take(delta, frame, leg_, raw_); }

    int raw_pending(int delta) const { return raw_[idx(delta)].n; }
    int legacy_pending(int delta) const { return leg_[idx(delta)].n; }
    long swallowed() const { return swallowed_; }

private:
    struct side { int n = 0; unsigned long long frame = 0; };
    static int idx(int delta) { return delta > 0 ? 0 : 1; }
    static void expire(side& s, unsigned long long frame) {
        if (s.n && frame - s.frame > kTtlFrames) s.n = 0;
    }
    bool take(int delta, unsigned long long frame, side* mine, side* other) {
        if (delta == 0) return false;
        const int i = idx(delta);
        expire(mine[i], frame);
        expire(other[i], frame);
        if (other[i].n > 0) {  // this is the twin of one already delivered
            --other[i].n;
            ++swallowed_;
            return false;
        }
        ++mine[i].n;
        mine[i].frame = frame;
        return true;
    }
    side raw_[2], leg_[2];
    long swallowed_ = 0;
};

// ------------------------------------------------------ the registration
// Raw input registration is ONE entry per (usage page, usage) per PROCESS, and the
// last RegisterRawInputDevices wins, silently. Anything else loaded into the game
// (an overlay, a macro tool's DLL, a future component) can therefore replace ours
// -- different window, legacy messages back on -- or remove it. With NOLEGACY the
// engine's motion comes ONLY from our WM_INPUT, so a removed registration is a dead
// mouse, not a degraded one. And GetRawInputBuffer drains the calling THREAD's whole
// raw queue, every usage: a foreign keyboard/HID registration delivered to our
// thread would have its reports eaten by our bulk read. mouse_polling snapshots
// GetRegisteredRawInputDevices once a second and this decides what it means.
struct reg_entry {
    unsigned short page, usage;
    unsigned long flags;
    bool target_is_ours;        // hwndTarget == the game window
    bool target_on_our_thread;  // hwndTarget NULL (focus window) or a window of our thread
};
struct reg_verdict {
    bool mouse_present = false;  // a generic-mouse (1/2) entry exists
    bool mouse_ours = false;     // ...and it is still exactly what we registered
    bool foreign_on_thread = false;  // another usage whose reports land in our queue
};
inline reg_verdict classify_registrations(const reg_entry* e, unsigned n, bool want_nolegacy) {
    reg_verdict v;
    for (unsigned i = 0; i < n; ++i) {
        if (e[i].page == 0x01 && e[i].usage == 0x02) {
            v.mouse_present = true;
            v.mouse_ours = e[i].target_is_ours &&
                           (((e[i].flags & RIDEV_NOLEGACY) != 0) == want_nolegacy);
        } else if (e[i].target_on_our_thread) {
            v.foreign_on_thread = true;
        }
    }
    return v;
}

// ---------------------------------------------------------------- the clip
// `tol` pixels of slack per edge: a DPI-unaware process on a scaled display gets
// its ClipCursor rect scaled and GetClipCursor's answer scaled back, and the round
// trip can be a pixel off -- which must not read as "the clip was lost" every frame.
constexpr long iabs(long v) { return v < 0 ? -v : v; }
constexpr bool rect_same(const RECT& a, const RECT& b, long tol = 0) {
    return iabs(a.left - b.left) <= tol && iabs(a.top - b.top) <= tol &&
           iabs(a.right - b.right) <= tol && iabs(a.bottom - b.bottom) <= tol;
}

// Is the cursor outside the central box that leaves `margin_pct` % of the width
// and height free on every side? With the recentre skipped (NOLEGACY), the OS
// cursor -- if Windows still moves it -- walks to the edge of the clip and sits
// there; if the clip is ever lost (UAC, Ctrl+Alt+Del, another program's
// ClipCursor(NULL)), an edge-parked cursor is one flick from the second monitor.
// An occasional recentre when it leaves the middle keeps it far from every edge at
// a cost of one SetCursorPos every few hundred pixels of pointer travel, instead of
// the stock one per frame.
constexpr bool outside_inner(POINT p, RECT r, int margin_pct) {
    const long w = r.right - r.left, h = r.bottom - r.top;
    if (w <= 0 || h <= 0) return false;
    const long mx = w * margin_pct / 100, my = h * margin_pct / 100;
    return p.x < r.left + mx || p.x >= r.right - mx || p.y < r.top + my || p.y >= r.bottom - my;
}

// ------------------------------------------------ Windows pointer speed / EPP
// SPI_GETMOUSESPEED (1..20, default 10 = the "6/11" notch) -> the factor Windows
// applies to a relative count before it becomes cursor pixels, with "Enhance
// pointer precision" OFF. The stock T4 path (GetCursorPos differences) inherited
// this factor -- and, with EPP on, Windows' acceleration curve. Raw input sees
// neither. So raw and stock are the same sensitivity ONLY at speed 10, EPP off.
inline double windows_speed_multiplier(int speed) {
    static const double k[21] = {1.0,   0.03125, 0.0625, 0.125, 0.25, 0.375, 0.5,
                                 0.625, 0.75,    0.875,  1.0,   1.25, 1.5,   1.75,
                                 2.0,   2.25,    2.5,    2.75,  3.0,  3.25,  3.5};
    return (speed >= 1 && speed <= 20) ? k[speed] : 1.0;
}

// Opt-in (ENW_RAW_MOUSE_WINSPEED=1): scale raw counts by the Windows speed factor
// so a player who tuned sensitivity with a non-default slider keeps the same feel.
// Whole counts go to the engine (CL_MouseEvent takes ints); the remainder carries
// to the next frame so nothing is lost to rounding, in either direction.
class scaler {
public:
    void set(double m) { m_ = m; cx_ = cy_ = 0.0; }
    double factor() const { return m_; }
    void apply(int* dx, int* dy) {
        if (m_ == 1.0) return;
        *dx = step(*dx, cx_);
        *dy = step(*dy, cy_);
    }
private:
    int step(int v, double& carry) const {
        const double want = static_cast<double>(v) * m_ + carry;
        const int out = static_cast<int>(want);  // truncates toward zero
        carry = want - static_cast<double>(out);
        return out;
    }
    double m_ = 1.0, cx_ = 0.0, cy_ = 0.0;
};

// ----------------------------------------------------------- absolute devices
// MOUSE_MOVE_ABSOLUTE reports (RDP, VMs, pen tablets, some remote-play tools) carry
// a 0..65535 coordinate, not a delta. Upstream's Update() took it as-is, so an
// absolute device turned the view in 1/65536ths-of-the-screen units: ~25x the
// sensitivity of the same hand movement as pixels on a 2560-wide desktop. SDL3
// maps it onto the virtual desktop (MOUSE_VIRTUAL_DESKTOP) or the primary screen
// first; so do we, and then it is a pixel position like the stock path's.
constexpr long absolute_to_pixels(long v, long origin, long span) {
    return origin + static_cast<long>((static_cast<long long>(v) * span) / 65536);
}

// rawMouseValue_t, iw4x-client RawMouse (see mouse_polling.cpp for the attribution),
// moved here so it can be tested, with one change: switching between an absolute
// and a relative device no longer produces a one-frame jump (upstream zeroed
// `current` for an absolute report, so the delta from the last relative position
// to the first absolute one was the whole coordinate). And a second: a relative
// accumulator is rebased to 0 on every ResetDelta, because upstream's `current`
// only ever grew -- a net turn in one direction overflows a signed int after 2^31
// counts (undefined behaviour; ~45 min of steady one-way turning at 8 kHz x 100
// counts). An absolute one keeps its position, which the next delta needs.
struct rawMouseValue_t {
    int current = 0;
    int previous = 0;
    bool last_absolute = false;

    void ResetDelta() {
        if (last_absolute) previous = current;
        else current = previous = 0;
    }
    int GetDelta() const { return current - previous; }

    void Update(int value, bool absolute) {
        if (absolute) {
            if (!last_absolute) {
                // First absolute report after relative ones: it is a position with
                // nothing to difference against yet. Start there, move by zero.
                current = previous = value;
            } else {
                current = value;
            }
        } else {
            current += value;
        }
        last_absolute = absolute;
    }
};

}  // namespace enw::rawmodel
