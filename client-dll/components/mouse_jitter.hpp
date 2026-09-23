// mouse_jitter.hpp -- "is the view turning smoothly?" as a number (client.md §1f).
//
// A frame-time histogram cannot see the stutter B describes if the frames are on
// time and the VIEW is not: a frame that applies 0 counts between two frames
// that applied 4 each is a visible hitch in the turn at a perfect 250 fps. So
// this measures the mouse delta the engine was actually handed per frame
// (what our IN_MouseMove passes to CL_MouseEvent) against the frame's length.
//
// For each frame i with both neighbours moving, the expected delta is the
// neighbours' rate times this frame's length:
//     expected_i = dt_i * (d_{i-1} + d_{i+1}) / (dt_{i-1} + dt_{i+1})
// and the error is |d_i - expected_i|. Reported per window:
//   * jitter %   = sum |error| / sum expected         (0 = perfectly even turn)
//   * p99 error  = the 99th percentile of |error| / expected, in %
//   * dropouts   = frames that applied NOTHING between two frames that moved.
//                  The WOW64 GetRawInputBuffer bug (raw_buffer.hpp) shows up as
//                  exactly this: a frame whose reports all came through the
//                  buffered read turned by zero.
//
// Integer report counts alone give a floor: at 1000 Hz and ~4 ms frames a frame
// carries 3, 4 or 5 reports, so an ideal pipeline still reads ~10-15 %. The
// number is for A/B between builds on the same input, not an absolute grade.
//
// Pure (no Windows, no globals) so tools/dev/mouse_tests.cpp can drive it.
#pragma once

#include <cmath>
#include <cstring>

namespace enw::mousejitter {

class meter {
public:
    void reset() {
        std::memset(hist_, 0, sizeof hist_);
        moving_ = dropouts_ = 0;
        err_sum_ = exp_sum_ = delivered_ = 0.0;
        have_ = 0;
    }

    // One frame: d = magnitude of the delta handed to the engine, dt in ms.
    void add(double d, double dt_ms) {
        delivered_ += d;
        if (dt_ms <= 0.0) return;
        // Shift the window: [0] = i-1, [1] = i, [2] = i+1 (the newest).
        d_[0] = d_[1]; dt_[0] = dt_[1];
        d_[1] = d_[2]; dt_[1] = dt_[2];
        d_[2] = d;     dt_[2] = dt_ms;
        if (have_ < 3) ++have_;
        if (have_ < 3) return;
        if (d_[0] <= 0.0 || d_[2] <= 0.0) return;  // not moving through frame i
        const double rate = (d_[0] + d_[2]) / (dt_[0] + dt_[2]);
        const double expected = rate * dt_[1];
        if (expected <= 0.0) return;
        const double err = std::fabs(d_[1] - expected);
        ++moving_;
        if (d_[1] <= 0.0) ++dropouts_;
        err_sum_ += err;
        exp_sum_ += expected;
        int b = static_cast<int>(100.0 * err / expected);
        if (b > kMaxPct) b = kMaxPct;
        ++hist_[b];
    }

    long moving_frames() const { return moving_; }
    long dropouts() const { return dropouts_; }
    double delivered() const { return delivered_; }
    double jitter_pct() const { return exp_sum_ > 0.0 ? 100.0 * err_sum_ / exp_sum_ : 0.0; }
    // Upper edge of the 1 % bucket holding the p-th percentile.
    int pct_error_percentile(double p) const {
        if (moving_ <= 0) return 0;
        long want = static_cast<long>(p * static_cast<double>(moving_));
        if (want < 1) want = 1;
        long seen = 0;
        for (int i = 0; i <= kMaxPct; ++i) {
            seen += hist_[i];
            if (seen >= want) return i + 1;
        }
        return kMaxPct;
    }

private:
    static constexpr int kMaxPct = 200;
    long hist_[kMaxPct + 1] = {};
    double d_[3] = {}, dt_[3] = {};
    int have_ = 0;
    long moving_ = 0, dropouts_ = 0;
    double err_sum_ = 0.0, exp_sum_ = 0.0, delivered_ = 0.0;
};

}  // namespace enw::mousejitter
