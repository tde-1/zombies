// The proof-of-life component, and the worked example other agents copy.
//
// It exercises one piece of the core per phase:
//   post_load()   register host->game handlers (no game memory touched)
//   post_unpack() report what verify() made of the vault addresses -- LOG ONLY,
//                 because at this point the engine has not started and anything
//                 sent to Com_Printf is silently discarded
//   post_init()   print the banner to the real in-game console (milestone E1)
#include "../component.hpp"

#include "../game.hpp"
#include "../game_link.hpp"
#include "../logger.hpp"
#include "../memory.hpp"
#include "../steamstub.hpp"

namespace enw {
namespace {

class hello final : public component {
public:
    const char* name() const override { return "hello"; }

    void post_load() override {
        auto& link = game_link::get();

        // `say` is a host->game command in game-link v0. Until somebody hooks a
        // frame function nothing drains the game-thread queue, so take this one
        // off-thread: it only writes to our own log and the console.
        link.on(
            "say",
            [](const json::value& msg) {
                const std::string from = msg.str_or("from", "host");
                const std::string text = msg.str_or("text");
                ENW_INFO("host says (%s): %s", from.c_str(), text.c_str());
                game::console_print("^3[%s]^7 %s\n", from.c_str(), text.c_str());
            },
            /*want_game_thread=*/false);

        // Proves the command/reply round trip without needing any game hooks.
        link.on(
            "exec",
            [](const json::value& msg) {
                const std::string id = msg.str_or("id");
                const std::string cmd = msg.str_or("cmd");
                ENW_WARN("host asked us to exec '%s' but no command buffer is wired up yet",
                         cmd.c_str());
                if (!id.empty()) {
                    game_link::get().send_reply(id, false,
                                                "exec not implemented in the foundation build");
                }
            },
            /*want_game_thread=*/false);
    }

    void post_unpack() override {
        const auto stub = steamstub::last_report();
        const auto ver = game::last_verification();

        // Log only. The raw bytes are here so `re` can confirm the vault's
        // addresses without re-running the game.
        ENW_INFO("hello: Com_Printf   %08X bytes %s", static_cast<unsigned>(ver.com_printf_addr),
                 ver.com_printf_bytes.c_str());
        ENW_INFO("hello: Dvar_FindVar %08X bytes %s", static_cast<unsigned>(ver.dvar_findvar_addr),
                 ver.dvar_findvar_bytes.c_str());

        const auto text = memory::text_section();
        ENW_INFO("hello: .text %08X + %08X", static_cast<unsigned>(text.start),
                 static_cast<unsigned>(text.size));

        game_link::get().send_log("info", "enw_t4 post_unpack: com_printf=%s waited=%ums",
                                  ver.com_printf_ok ? "ok" : "suspect", stub.waited_ms);
    }

    // The engine is up: this is the first moment anything reaches the console.
    void post_init() override {
        const auto stub = steamstub::last_report();
        const auto ver = game::last_verification();

        game::console_print("^2==============================================\n");
        game::console_print("^2[ENW]^7 enw_t4 online - %u components\n",
                            static_cast<unsigned>(components::count()));
        game::console_print("^7      steamstub    : %s after %u ms\n",
                            stub.decrypted ? "^2decrypted^7" : "^1STILL ENCRYPTED^7", stub.waited_ms);
        game::console_print("^7      Com_Printf   : %08X %s\n",
                            static_cast<unsigned>(ver.com_printf_addr),
                            ver.com_printf_ok ? "^2verified^7" : "^1suspect^7");
        game::console_print("^7      Dvar_FindVar : %08X %s\n",
                            static_cast<unsigned>(ver.dvar_findvar_addr),
                            ver.dvar_findvar_ok ? "^2verified^7" : "^1suspect^7");
        game::console_print("^7      game-link    : %s\n",
                            game_link::get().connected() ? "^2connected^7" : "^3not connected^7");
        game::console_print("^2==============================================\n");

        ENW_INFO("hello: post_init printed the banner to the game console");
        game_link::get().send_log("info", "enw_t4 banner printed to the game console");
    }
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::hello)
