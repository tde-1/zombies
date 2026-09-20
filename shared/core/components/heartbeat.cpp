// "Still ticking at Ns."
//
// WHY THIS EXISTS. The referee lost two 420-second captures to a game that
// stopped ticking 65 seconds in (see components/focus_guard.cpp). Nothing
// errored, nothing crashed, the process stayed alive and the logs simply
// stopped. It was only caught because two independent runs produced *identical*
// durations, which is a thin thread to hang a measurement on.
//
// One line every 15 seconds makes that failure obvious in one run instead of
// two, and gives `launch.ps1` something to assert on. It costs a log line per
// 900 frames.
#include "../component.hpp"

#include "../frame.hpp"
#include "../game_link.hpp"
#include "../json.hpp"
#include "../logger.hpp"

namespace enw {
namespace {

constexpr uint32_t kIntervalMs = 15000;

DWORD g_started = 0;
DWORD g_last = 0;
uint64_t g_last_frames = 0;

class heartbeat final : public component {
public:
    const char* name() const override { return "heartbeat"; }

    void post_unpack() override {
        g_started = ::GetTickCount();
        g_last = g_started;
        frame::subscribe("heartbeat", [](uint64_t n) {
            const DWORD now = ::GetTickCount();
            if (now - g_last < kIntervalMs) return;

            const uint32_t since = now - g_last;
            const uint64_t frames = n - g_last_frames;
            const double fps = since ? (static_cast<double>(frames) * 1000.0 / since) : 0.0;

            ENW_INFO("heartbeat: still ticking at %.0f s - %llu frames total, %.1f fps over the "
                     "last %.0f s",
                     (now - g_started) / 1000.0, static_cast<unsigned long long>(n), fps,
                     since / 1000.0);

            // `perf` in game-link v0. Droppable: it is resampleable by
            // definition, and the next one is 15 s away.
            const double mean_ms = frames ? (static_cast<double>(since) / frames) : 0.0;
            json::writer w;
            w.str("t", "perf")
                .integer("ms", game_link::now_ms())
                .num("frame_ms_p50", mean_ms)
                .num("frame_ms_p99", mean_ms)
                .integer("frames", static_cast<long long>(n));
            game_link::get().send_sample(w);

            g_last = now;
            g_last_frames = n;
        });
        ENW_INFO("heartbeat: armed (every %u s)", kIntervalMs / 1000);
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::heartbeat)
