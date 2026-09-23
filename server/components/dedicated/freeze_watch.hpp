// The dedicated server's freeze rule, with no engine in it (dedi.md §23).
//
// A frozen dedicated server is not a dead process and not a busy one. The outer
// loop in WinMain keeps running at com_maxfps, every frame ENTERS the body
// (`frame-body-entered` [0x1F552D4] keeps counting), and none of them get as far
// as writing `com_frameTime` [0x1F9648C], because each one faults and the engine's
// own abortframe unwinds it back to Com_Frame's setjmp (§12.1). The server sends no
// snapshots, the player times out, and until 2026-09-23 nothing told the host.
//
// This file decides, from four numbers read once per outer frame, two things:
//
//   * ESCAPED: a frame entered the body and did not come back through the straight
//     path ([0x1F964BC] did not move with [0x1F552D4]). A healthy game has none;
//     §23's game had one, five seconds before it died, and that one corrupted the
//     script VM.
//   * FROZEN: com_frameTime has not moved for `stall_ms` while at least
//     `min_frames` frames were entered. "Frames were entered" is what separates a
//     freeze from one long frame (a map load blocks the outer loop too, and when it
//     returns com_frameTime moves on the next frame).
//
// And one more thing, from the script VM's own bookkeeping: whether the VM is AT
// REST between frames. IW asserts on entry to VM_Resume that function_count is 0
// and localVars is localVarsStack - 1; between two outer frames nothing of the VM
// is running, so anything else means an escaped frame left a thread half-executed.
//
// Pure: no Windows, no engine, unit-tested in server/tests/freeze_watch_test.cpp.
// Clean room: our own code; the layout numbers are cited where they are used.
#pragma once

#include <cstdint>

namespace enw::freeze_watch {

// scrVmPub[0] (0x3BD4700, stride 0x4320) and scrVmGlob[0] (0x3BDDDF8), T4SP
// clientscript_public.hpp, each field checked against an instruction in dedi.md §23:
//   +0x0 localVars   0x697B86 `add [ecx],4`       rest = &localVarsStack[-1] = 0x3BDDE10
//   +0x8 function_count  0x697BD0 `add [esi+0x3BD4708],1`                rest = 0
//   +0xC function_frame  0x697BC8 `mov ecx,[esi+0x3BD470C]`   rest = &function_frame_start[0]
//   +0x10 top        join_probe reads 0x03BD4A20 at every boundary   rest = &stack[0]
constexpr uint32_t kLocalVarsRest     = 0x3BDDE10;
constexpr uint32_t kLocalVarsStackEnd = 0x3BDFE14;   // 2048 slots after 0x3BDDE14
constexpr uint32_t kFunctionFrameRest = 0x3BD4720;
constexpr uint32_t kTopRest           = 0x3BD4A20;

struct vm_state {
    uint32_t local_vars = kLocalVarsRest;
    int32_t  function_count = 0;
    uint32_t function_frame = kFunctionFrameRest;
    uint32_t top = kTopRest;
};

inline bool vm_at_rest(const vm_state& v) {
    return v.local_vars == kLocalVarsRest && v.function_count == 0 &&
           v.function_frame == kFunctionFrameRest && v.top == kTopRest;
}

// Slots above rest; negative if something popped past the bottom.
inline int32_t local_depth(const vm_state& v) {
    return static_cast<int32_t>(v.local_vars - kLocalVarsRest) / 4;
}

// Past the end of localVarsStack: .bss is already overwritten (the §23 overrun).
inline bool vm_overran(const vm_state& v) {
    return v.local_vars >= kLocalVarsStackEnd || v.local_vars < kLocalVarsRest;
}

struct sample {
    uint32_t now_ms = 0;       // a monotonic millisecond clock (timeGetTime)
    uint32_t frame_time = 0;   // com_frameTime [0x1F9648C]
    uint32_t entered = 0;      // frame-body-entered [0x1F552D4]
    uint32_t body = 0;         // Com_Frame-body [0x1F964BC]
};

struct result {
    uint32_t escaped_now = 0;   // frames that escaped since the previous sample
    bool frozen_now = false;    // true exactly once, on the sample that crosses the line
    uint32_t stalled_ms = 0;    // how long com_frameTime has not moved
    uint32_t stalled_frames = 0;
};

class watch {
public:
    explicit watch(uint32_t stall_ms = 5000, uint32_t min_frames = 30, uint32_t arm_advances = 3)
        : stall_ms_(stall_ms), min_frames_(min_frames), arm_advances_(arm_advances) {}

    result feed(const sample& s) {
        result r{};
        if (!have_last_) {
            last_ = s;
            have_last_ = true;
            advanced_at_ms_ = s.now_ms;
            entered_at_advance_ = s.entered;
            return r;
        }

        // Unsigned deltas, so a counter that wraps is still a small forward step.
        const uint32_t d_entered = s.entered - last_.entered;
        const uint32_t d_body = s.body - last_.body;
        if (d_entered > d_body) {
            r.escaped_now = d_entered - d_body;
            escaped_total_ += r.escaped_now;
        }

        if (s.frame_time != last_.frame_time) {
            if (advances_ < arm_advances_) ++advances_;
            advanced_at_ms_ = s.now_ms;
            entered_at_advance_ = s.entered;
            if (fired_) resumed_ = true;
        } else {
            r.stalled_ms = s.now_ms - advanced_at_ms_;
            r.stalled_frames = s.entered - entered_at_advance_;
            if (!fired_ && armed() && r.stalled_ms > stall_ms_ && r.stalled_frames >= min_frames_) {
                fired_ = true;
                r.frozen_now = true;
            }
        }
        last_ = s;
        return r;
    }

    // Not until com_frameTime has moved a few times: a server still booting has not
    // started simulating, and that is not a freeze.
    bool armed() const { return advances_ >= arm_advances_; }
    bool fired() const { return fired_; }
    bool resumed_after_firing() const { return resumed_; }
    uint64_t escaped_total() const { return escaped_total_; }
    uint32_t last_advance_frame_time() const { return last_.frame_time; }

private:
    uint32_t stall_ms_, min_frames_, arm_advances_;
    sample last_{};
    bool have_last_ = false;
    uint32_t advances_ = 0;
    uint32_t advanced_at_ms_ = 0;
    uint32_t entered_at_advance_ = 0;
    uint64_t escaped_total_ = 0;
    bool fired_ = false;
    bool resumed_ = false;
};

}  // namespace enw::freeze_watch
