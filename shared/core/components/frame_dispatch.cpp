// Installs the core's per-frame tick and reports on it.
//
// The dispatcher itself lives in shared/core/frame.cpp; this is just the
// component that turns it on at the right moment and tells the log what
// happened. See frame.hpp for the ownership rule: components subscribe, nobody
// hooks Com_Frame.
#include "../component.hpp"

#include "../frame.hpp"
#include "../game_link.hpp"
#include "../logger.hpp"
#include "../scheduler.hpp"

namespace enw {
namespace {

class frame_dispatch final : public component {
public:
    const char* name() const override { return "frame_dispatch"; }

    void post_unpack() override {
        if (!frame::install()) {
            ENW_ERROR("frame_dispatch: no per-frame tick. Everything that subscribed will stay "
                      "silent, and steady-state scheduler::run_on_main() work will not run.");
            return;
        }

        // The core's own subscriber: this is what makes run_on_main() and the
        // game-link inbound queue work in steady state rather than only during
        // startup (see components/main_thread.cpp for the startup pump).
        frame::subscribe("core_pump", [](uint64_t) {
            scheduler::pump(8);
            game_link::get().pump(8);
        });
    }

    void post_init() override {
        if (!frame::installed()) return;
        ENW_INFO("frame_dispatch: %u subscriber(s), %llu frames so far",
                 static_cast<unsigned>(frame::subscriber_count()),
                 static_cast<unsigned long long>(frame::count()));
        if (frame::count() == 0) {
            // Expected today, and worth saying plainly every run so nobody
            // mistakes "subscribed" for "ticking".
            ENW_WARN("frame_dispatch: ZERO frames so far. WinMain has not reached its loop - "
                     "0x5FF4E0 (renderer/D3D bring-up, called before the loop and not gated by "
                     "com_dedicated) is still in the way. Nothing that needs a frame tick works "
                     "until that is bypassed.");
        }
    }

    void pre_destroy() override { frame::uninstall(); }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::frame_dispatch)
