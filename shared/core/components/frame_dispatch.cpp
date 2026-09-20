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
            // Normal at this point: post_init runs ~200 ms in, while the renderer
            // is still coming up, and WinMain only reaches its loop after that.
            // In a solo run the tick starts a few seconds later (measured: 301
            // frames by t+5.5 s). If it is STILL zero once the game is at the
            // menu, that is dedi's 0x5FF4E0 blocker -- renderer/D3D bring-up runs
            // before the loop and is not gated by com_dedicated, so a dedicated
            // server never gets there at all.
            ENW_INFO("frame_dispatch: no frames yet - WinMain has not reached its loop. Normal "
                     "this early in a solo run; permanent in dedicated mode until 0x5FF4E0 is "
                     "bypassed.");
        }
    }

    void pre_destroy() override { frame::uninstall(); }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::frame_dispatch)
