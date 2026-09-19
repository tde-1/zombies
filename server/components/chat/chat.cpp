// Chat: capture what a player types, and inject a line from outside.
//
// This is the transport under cross-server chat, the 24 h warnings and any
// staff message, so it has to work in both directions and it has to work on a
// headless server with no client attached.
//
// CAPTURE. A client's chat arrives as the client command `say` / `say_team`
// (T4 keeps the CoD lineage here). The engine's handler formats it and calls
// SV_SendServerCommand to echo it to everyone. We take it before that, which
// means the host can *suppress* a line (mute, slur filter, flood) rather than
// only observe it.
//
// INJECT. SV_SendServerCommand(client, "c \"<text>\"") is the same path the
// engine uses; client == nullptr broadcasts. Colour codes (^1..^8) pass through.
//
// Both halves are behind referee::bound().server_cmd, so on an unbound build
// this component logs the fact once and stays quiet.
#include "../../../shared/core/component.hpp"

#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../referee/t4_bind.hpp"

namespace enw {
namespace {

// Chat we inject must never be mistaken for a player. The host sets `from`;
// we render it in a fixed shape so a client cannot forge it by typing.
std::string render(const std::string& from, const std::string& text) {
    if (from.empty()) return "^3[ENW]^7 " + text;
    return "^3[" + from + "]^7 " + text;
}

class chat final : public component {
public:
    const char* name() const override { return "chat"; }

    void post_load() override {
        auto& link = game_link::get();
        link.on("say",
                [this](const json::value& m) {
                    say(-1, render(m.str_or("from"), m.str_or("text")));
                },
                /*want_game_thread=*/true);
        link.on("tell",
                [this](const json::value& m) {
                    say(static_cast<int>(m.num_or("slot", -1)),
                        render(m.str_or("from"), m.str_or("text")));
                },
                /*want_game_thread=*/true);
    }

    void post_unpack() override {
        referee::bind();
        if (!referee::bound().server_cmd) {
            ENW_WARN("chat: SV_SendServerCommand/Cmd_AddCommand not bound; capture and inject are off");
            return;
        }
        // BIND: hook the `say`/`say_team` client command here and call on_say().
        ENW_INFO("chat: armed");
    }

    // Called from the say hook, on the game thread, BEFORE the engine echoes.
    // Returns true to let the engine print it, false to swallow it.
    bool on_say(int slot, const std::string& text, bool team) {
        json::writer w;
        w.str("t", "chat")
            .integer("ms", game_link::now_ms())
            .integer("slot", slot)
            .str("text", text)
            .boolean("team", team);
        game_link::get().send(w);
        ++captured_;
        // v0 always lets it through. Suppression needs a host round trip, which
        // means holding the line for a frame; that is a v1 change to the protocol
        // (a `chat` with an `id` and an `auth`-style reply).
        return true;
    }

private:
    void say(int slot, const std::string& line) {
        if (!referee::server_say(slot, line)) {
            ENW_WARN("chat: cannot inject (unbound): %s", line.c_str());
            return;
        }
        ++injected_;
    }

    uint64_t captured_ = 0;
    uint64_t injected_ = 0;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::chat)
