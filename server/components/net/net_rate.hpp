// The dedicated server's snapshot pacing, as arithmetic (dedi.md §22.1, §24.2).
//
// After every snapshot the server picks the next send time (SV_SendMessageToClient
// 0x6393F0) for an internet client:
//
//   * a message that went out whole:   msec = max(SV_RateMsec(size), snapshotMsec)
//         SV_RateMsec 0x6392D0: size clamped to 1164, (size + 64) * 1000 / rate
//   * a message that was fragmented and flushed at once (the path taken when a snapshot is
//     bigger than one packet):          msec = 0x639360(size), NO clamp:
//                                              (size + 64) * 1000 / rate
//
// with rate = min(client `rate`, sv_maxRate), both at most 25000 (the dvars' own domains).
// The next send then waits for the first 50 ms server frame (sv_fps 20) at or after that
// time. So a message of more than 25000 / 20 - 64 = 1186 bytes cannot go at 20 Hz on any
// stock setting, and one of ~2,100 bytes goes at 10 Hz: box game m_ee07e7e8 (2026-09-23
// 02:42-02:43 UTC) sent 10.0 snapshots a second, delay avg 85-91 ms, every packet a
// fragment, for as long as its player was in.
//
// The fix is the `imul eax, eax, 1000` in both functions (0x639323, 0x6393A6): make the
// 1000 smaller by a factor `scale` and every client is paced as if its rate were `scale`
// times higher. scale 4 = 100,000 bytes/s at rate 25000: a 4,936-byte message still goes
// at 20 Hz. The per-client bound stays (a bad connection is not flooded without limit);
// scale 1 is stock.
//
// Pure: no Windows, no engine. Unit-tested in server/tests/net_rate_test.cpp.
#pragma once

#include <cstdint>

namespace enw::net_rate {

// `imul eax, eax, 0x3E8` -- the operand we change is the imm32 at +2.
constexpr uintptr_t kImulSites[2] = {0x639323, 0x6393A6};
constexpr uint8_t kImulStock[6] = {0x69, 0xC0, 0xE8, 0x03, 0x00, 0x00};
constexpr int kImmOffset = 2;

constexpr int kFragmentClamp = 1164;   // 0x48C, SV_RateMsec only
constexpr int kHeaderBytes = 64;       // the +0x40 both functions add
constexpr int kServerFrameMsec = 50;   // sv_fps 20
constexpr int kDefaultScale = 4;
constexpr int kMaxScale = 8;

inline int clamp_scale(int s) { return s < 1 ? 1 : (s > kMaxScale ? kMaxScale : s); }

// The imm32 to write for a scale: 1000 / scale (1000, 500, 333, 250, 200, 166, 142, 125).
inline uint32_t imul_for_scale(int scale) { return 1000u / static_cast<uint32_t>(clamp_scale(scale)); }

// The engine's own result, integer division as the idiv does it.
//   whole_message = false: SV_RateMsec (the size is clamped to one fragment)
//   whole_message = true:  0x639360 (the fragmented message, no clamp)
inline int rate_msec(int bytes, int rate, int scale, bool whole_message) {
    if (rate <= 0) rate = 1;
    int size = bytes;
    if (!whole_message && size > kFragmentClamp) size = kFragmentClamp;
    return static_cast<int>((static_cast<int64_t>(size) + kHeaderBytes) *
                            static_cast<int64_t>(imul_for_scale(scale)) / rate);
}

// The delay the engine sets after a message of `bytes` (fragmented = one that is bigger
// than a packet and was flushed at once).
inline int next_delay_msec(int bytes, int rate, int scale, int snapshot_msec, bool fragmented) {
    const int m = rate_msec(bytes, rate, scale, fragmented);
    if (fragmented) return m;
    return m < snapshot_msec ? snapshot_msec : m;
}

// What the player gets: sends happen only on 50 ms server frames, so a delay of 51-100 ms
// is two frames.
inline double snapshots_per_second(int delay_msec) {
    int frames = (delay_msec + kServerFrameMsec - 1) / kServerFrameMsec;
    if (frames < 1) frames = 1;
    return 1000.0 / (frames * kServerFrameMsec);
}

// The biggest message that still goes every server frame at this rate and scale.
inline int max_bytes_at_20hz(int rate, int scale) {
    return static_cast<int>(static_cast<int64_t>(kServerFrameMsec) * rate /
                            imul_for_scale(scale)) - kHeaderBytes;
}

}  // namespace enw::net_rate
