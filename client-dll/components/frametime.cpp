// A frame-time histogram, because "it stutters" is not a number.
//
// ===========================================================================
// WHY
// ===========================================================================
// B's report is "when I'm in the game there's stuttery performance". The
// heartbeat component already prints an average FPS every 15 s, and an average
// is exactly the statistic that cannot see a stutter: 175 fps average is what
// you get from 2600 frames at 5.5 ms and forty frames at 120 ms, and it is also
// what you get from a perfectly smooth 175. The eye sees the forty.
//
// So this records the DISTRIBUTION. Per 10-second window it logs p50, p95, p99,
// the worst single frame, and counts of frames over 16.7 / 33.3 / 50 ms -- i.e.
// "dropped a frame at 60 Hz", "visible hitch", "unmistakable freeze". Those are
// the numbers an A/B between two launches can actually be run on.
//
// ===========================================================================
// HOW IT MEASURES
// ===========================================================================
// One QueryPerformanceCounter per frame from the shared frame tick
// (`enw::frame::subscribe`, foundation.md §3 -- we do NOT hook Com_Frame, that
// hook is owned). The callback runs on the game's main thread at a frame
// boundary AFTER the engine's own frame work, so consecutive deltas are true
// wall-clock frame periods including present and any stall inside the engine.
//
// The histogram is 0.25 ms buckets from 0 to 128 ms plus one overflow bucket:
// 512 ints, fixed, no allocation, no locking, no I/O on the frame path. A
// percentile is read out of the buckets when the window closes, so the only
// per-frame cost is one QPC and one array increment. Sub-quarter-millisecond
// quantisation is irrelevant for a p99 we care about at all.
//
// The FIRST frame of a session and the first frame after a map load are not
// stutters we can do anything about, and they are large enough to dominate a
// max. They are still counted -- an honest max is the point -- but the log line
// names the window index so a reader can tell the load window from a steady one.
//
// ===========================================================================
// OFF BY DEFAULT
// ===========================================================================
// ENW_FRAMETIME=1 turns it on. Anything else, or unset, and the component says
// so once at post_init and never subscribes -- so a player's game pays nothing,
// not even the QPC. ENW_FRAMETIME_WINDOW=<seconds> changes the 10 s window.
//
// Clean room: our own code.

#include "component.hpp"
#include "frame.hpp"
#include "logger.hpp"

#include <cstdlib>
#include <cstring>

namespace enw::client {
namespace {

// 0.25 ms buckets, 0 .. 128 ms, plus an overflow bucket at the top.
constexpr int kBuckets = 513;
constexpr double kBucketMs = 0.25;
constexpr int kOverflow = kBuckets - 1;

struct window {
    int hist[kBuckets];
    long frames;
    double sum_ms;
    double max_ms;
    long over16;  // missed a 60 Hz frame
    long over33;  // a visible hitch
    long over50;  // unmistakable

    void reset() {
        std::memset(hist, 0, sizeof hist);
        frames = 0;
        sum_ms = 0.0;
        max_ms = 0.0;
        over16 = over33 = over50 = 0;
    }

    void add(double ms) {
        int b = static_cast<int>(ms / kBucketMs);
        if (b < 0) b = 0;
        if (b > kOverflow) b = kOverflow;
        ++hist[b];
        ++frames;
        sum_ms += ms;
        if (ms > max_ms) max_ms = ms;
        if (ms > 16.7) ++over16;
        if (ms > 33.3) ++over33;
        if (ms > 50.0) ++over50;
    }

    // The bucket's UPPER edge, which is the honest way to report a quantised
    // percentile: "p99 is at most this".
    double percentile(double p) const {
        if (frames <= 0) return 0.0;
        long want = static_cast<long>(p * static_cast<double>(frames));
        if (want < 1) want = 1;
        long seen = 0;
        for (int i = 0; i < kBuckets; ++i) {
            seen += hist[i];
            if (seen >= want) {
                if (i == kOverflow) return max_ms;
                return (i + 1) * kBucketMs;
            }
        }
        return max_ms;
    }
};

window g_win;      // the current 10 s window
window g_session;  // everything since the first frame

bool g_enabled = false;
double g_window_s = 10.0;
long long g_qpf = 0;
long long g_last = 0;
long long g_window_start = 0;
long g_window_index = 0;

long long qpc() {
    LARGE_INTEGER v;
    ::QueryPerformanceCounter(&v);
    return v.QuadPart;
}

void report(const window& w, const char* what, long index) {
    if (w.frames <= 0) {
        ENW_INFO("frametime: %s %ld -- no frames", what, index);
        return;
    }
    const double avg = w.sum_ms / static_cast<double>(w.frames);
    ENW_INFO("frametime: %s %ld -- %ld frames, %.1f fps avg | "
             "p50 %.2f ms  p95 %.2f ms  p99 %.2f ms  max %.2f ms | "
             "over 16.7ms: %ld (%.2f%%)  over 33.3ms: %ld (%.2f%%)  over 50ms: %ld",
             what, index, w.frames, avg > 0.0 ? 1000.0 / avg : 0.0, w.percentile(0.50),
             w.percentile(0.95), w.percentile(0.99), w.max_ms, w.over16,
             100.0 * w.over16 / w.frames, w.over33, 100.0 * w.over33 / w.frames, w.over50);
}

class frametime final : public component {
public:
    const char* name() const override { return "frametime"; }

    void post_init() override {
        const char* v = std::getenv("ENW_FRAMETIME");
        if (!v || v[0] != '1' || v[1] != '\0') {
            ENW_DEBUG("frametime: off (set ENW_FRAMETIME=1 for a per-window frame-time "
                      "histogram: p50/p95/p99/max and the count of frames over 16.7/33.3/50 ms)");
            return;
        }

        LARGE_INTEGER f;
        if (!::QueryPerformanceFrequency(&f) || f.QuadPart == 0) {
            ENW_WARN("frametime: QueryPerformanceFrequency failed; not measuring.");
            return;
        }
        g_qpf = f.QuadPart;

        if (const char* w = std::getenv("ENW_FRAMETIME_WINDOW")) {
            const double s = std::atof(w);
            if (s >= 1.0 && s <= 600.0) g_window_s = s;
        }

        g_win.reset();
        g_session.reset();
        g_enabled = true;
        ENW_INFO("frametime: ON. Per-frame QueryPerformanceCounter off the shared frame tick, "
                 "0.25 ms buckets, a line every %.0f s. An average cannot see a stutter; this "
                 "is the distribution.",
                 g_window_s);

        frame::subscribe("frametime", [](uint64_t) {
            if (!g_enabled) return;
            const long long now = qpc();

            if (g_last == 0) {
                // First frame: there is no previous frame to difference against.
                g_last = now;
                g_window_start = now;
                return;
            }

            const double ms = 1000.0 * static_cast<double>(now - g_last) / static_cast<double>(g_qpf);
            g_last = now;
            g_win.add(ms);
            g_session.add(ms);

            const double elapsed =
                static_cast<double>(now - g_window_start) / static_cast<double>(g_qpf);
            if (elapsed >= g_window_s) {
                report(g_win, "window", ++g_window_index);
                g_win.reset();
                g_window_start = now;
            }
        });
    }

    void pre_destroy() override {
        if (!g_enabled) return;
        report(g_session, "SESSION TOTAL, windows:", g_window_index);
    }
};

ENW_REGISTER_COMPONENT(frametime)

}  // namespace
}  // namespace enw::client
