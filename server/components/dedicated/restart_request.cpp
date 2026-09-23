// A player's "Restart game", server side: the Esc menu's button (client-dll/components/
// pause_menu.cpp) reaches the dedicated server and the run is restarted WITHOUT breaking
// records. docs/kickstart/esc-menu.md §3 is the contract; this header is the short form.
//
// THE CHANNEL: userinfo, like the pause contract (chat-overlay.md §8). The client sets
//     enw_req  restart.<n>
// with the engine's own `setu`; the engine re-sends userinfo on the change and
// SV_UpdateUserinfo_f keeps svs.clients[i].userinfo current, which referee::client() reads.
// No client command: the stock game prints "Unknown cmd" on the player's HUD for one.
// We act on a CHANGE of the value per slot, and the value a client connects with is only a
// baseline -- so a key left over from an earlier game can never restart anything.
//
// WHO MAY: a verified player, or anybody when they are alone. The DLL cannot know
// "verified" on its own -- identity is the host's decision (`auth`, referee.md §13) -- so:
//   * host link UP   -> we send `restart_request` and the HOST decides and acts. It ends
//                       the current run as ABANDONED (end_reason `player_restart`, replay
//                       signed, result posted) and answers with the referee's own `end`
//                       (referee.cpp do_end: game_over + match_end + map_restart + reset +
//                       a fresh map_loaded), and the next run is a NEW run with its own id.
//                       Nothing here restarts the map in that case: a map_restart the host
//                       did not order would carry one run's clock into the next.
//   * host link DOWN -> there is no referee, no replay and no record to protect. Solo:
//                       `map_restart` here, once the pause gate has let go. Co-op: refused
//                       (nobody can vouch for who asked).
//
// Off switch: ENW_RESTART_REQUESTS=0.
#include "../../../shared/core/component.hpp"

#include "../../../shared/core/frame.hpp"
#include "../../../shared/core/game_link.hpp"
#include "../../../shared/core/logger.hpp"
#include "../../../shared/core/memory.hpp"
#include "../referee/t4_bind.hpp"
#include "dedicated.hpp"

#include <cstdlib>
#include <cstring>
#include <string>

namespace enw {
namespace {

constexpr uintptr_t kLevelTime = 0x18F6DC8;      // level.time (pause.cpp)
constexpr uintptr_t kSvPausedDvar = 0x1F9645C;   // dvar_s* sv_paused; pause.cpp sets it 1 while frozen
constexpr size_t kDvarCurrent = 0x10;
constexpr int kSlots = 4;
constexpr uint32_t kPollMs = 100;
constexpr uint32_t kDebounceMs = 15000;          // one restart per 15 s, whoever asks
constexpr uint32_t kHostAnswerMs = 15000;
constexpr uint32_t kLocalWaitMs = 5000;          // for the pause gate to let go

std::string userinfo_value(const std::string& info, const char* key) {
    // "\k\v\k\v": keys at odd positions after splitting on '\'.
    const std::string k = key;
    size_t i = 0;
    while (i < info.size()) {
        if (info[i] == '\\') ++i;
        const size_t ke = info.find('\\', i);
        if (ke == std::string::npos) return {};
        const size_t ve = info.find('\\', ke + 1);
        const std::string name = info.substr(i, ke - i);
        const std::string val = info.substr(ke + 1, ve == std::string::npos ? std::string::npos : ve - ke - 1);
        if (name == k) return val;
        if (ve == std::string::npos) return {};
        i = ve;
    }
    return {};
}

int read_int(uintptr_t a) {
    int v = 0;
    memory::read(a, &v);
    return v;
}

int sv_paused() {
    uintptr_t dvar = 0;
    if (!memory::read(at(kSvPausedDvar), &dvar) || !dvar) return -1;
    int v = -1;
    memory::read(dvar + kDvarCurrent, &v);
    return v;
}

class restart_request final : public component {
public:
    const char* name() const override { return "restart_request"; }

    void post_unpack() override { referee::bind(); }

    void post_init() override {
        if (!dedi::is_dedicated()) return;
        if (const char* e = std::getenv("ENW_RESTART_REQUESTS"); e && !std::strcmp(e, "0")) {
            ENW_INFO("restart_request: OFF (ENW_RESTART_REQUESTS=0)");
            return;
        }
        frame::subscribe("restart_request", [this](uint64_t) { tick(); });
        ENW_INFO("restart_request: armed -- userinfo enw_req restart.<n> from a client asks for a "
                 "restart; with a host link the host decides (verified or solo) and ends the run "
                 "through `end`, without one a solo player's request is a plain map_restart");
    }

private:
    struct seen { bool connected = false; std::string last; };

    void tick() {
        const uint32_t now = game_link::now_ms();
        if (now - last_poll_ < kPollMs) return;
        last_poll_ = now;
        int active = 0;
        for (int i = 0; i < kSlots; ++i) {
            auto c = referee::client(i);
            if (c && c->active) ++active;
        }
        players_ = active;
        for (int i = 0; i < kSlots; ++i) {
            auto c = referee::client(i);
            auto& s = seen_[i];
            if (!c || !c->active) {
                // A map_restart sends every client back through the connect handshake: this
                // edge, not level.time, is how a restart shows (level.time keeps counting
                // across map_restart on this engine -- measured, escmenu1).
                if (s.connected) last_drop_ = now;
                s.connected = false;
                s.last.clear();
                continue;
            }
            const std::string v = userinfo_value(c->userinfo, "enw_req");
            if (!s.connected) { s.connected = true; s.last = v; continue; }   // baseline only
            if (v == s.last) continue;
            s.last = v;
            if (v.rfind("restart.", 0) == 0) on_request(i, c->name, v);
        }
        pending_tick(now);
    }

    void on_request(int slot, const std::string& who, const std::string& value) {
        const uint32_t now = game_link::now_ms();
        ++requests_;
        if (last_restart_ && now - last_restart_ < kDebounceMs) {
            ENW_INFO("restart_request: slot %d ('%s') asked again (%s) %u ms after the last restart: "
                     "ignored (one per %u s)", slot, who.c_str(), value.c_str(), now - last_restart_,
                     kDebounceMs / 1000);
            return;
        }
        auto& link = game_link::get();
        if (link.connected()) {
            json::writer w;
            w.str("t", "restart_request")
                .integer("ms", now)
                .integer("slot", slot)
                .str("name", who)
                .str("req", value)
                .integer("players", players_)
                .integer("level_time", read_int(at(kLevelTime)));
            link.send(w);
            last_restart_ = now;
            mode_ = pending::host;
            since_ = now;
            level_at_request_ = read_int(at(kLevelTime));
            ENW_INFO("restart_request: slot %d ('%s') asked to restart (%s, %d player(s)) -> sent "
                     "to the host, which decides (verified or solo) and ends the run with `end`",
                     slot, who.c_str(), value.c_str(), players_);
            return;
        }
        if (players_ != 1) {
            ENW_WARN("restart_request: slot %d ('%s') asked to restart a %d-player game and there is "
                     "no host link to say who they are: REFUSED", slot, who.c_str(), players_);
            return;
        }
        last_restart_ = now;
        mode_ = pending::local;
        since_ = now;
        level_at_request_ = read_int(at(kLevelTime));
        ENW_INFO("restart_request: slot %d ('%s') is alone and there is no host link (no referee, "
                 "no record): map_restart once the pause gate lets go (sv_paused %d)",
                 slot, who.c_str(), sv_paused());
    }

    void pending_tick(uint32_t now) {
        if (mode_ == pending::none) return;
        const int lt = read_int(at(kLevelTime));
        if (mode_ == pending::local) {
            const bool frozen = sv_paused() == 1;
            if (frozen && now - since_ < kLocalWaitMs) return;
            if (frozen) {
                ENW_WARN("restart_request: the game is still frozen %u ms after the request (a host "
                         "hold, or another reason): not restarting under a freeze", now - since_);
                mode_ = pending::none;
                return;
            }
            const bool ok = referee::console_command("map_restart");
            ENW_INFO("restart_request: map_restart %s (level.time %d, %u ms after the request)",
                     ok ? "queued" : "REFUSED: the command buffer is not bound", lt, now - since_);
            mode_ = ok ? pending::watch : pending::none;
            since_ = now;
            return;
        }
        // host / watch: the evidence is the connected clients dropping back into the connect
        // handshake, which a map_restart does to every one of them.
        if (last_drop_ && last_drop_ >= since_) {
            ENW_INFO("restart_request: the map restarted %u ms after the %s (clients re-entered the "
                     "connect handshake; level.time %d at the request, %d now)",
                     last_drop_ - since_, mode_ == pending::host ? "request went to the host" : "map_restart",
                     level_at_request_, lt);
            ++restarts_;
            mode_ = pending::none;
            return;
        }
        if (now - since_ > kHostAnswerMs) {
            ENW_WARN("restart_request: no restart %u ms after the %s (level.time %d). %s",
                     now - since_, mode_ == pending::host ? "request went to the host" : "map_restart",
                     lt, mode_ == pending::host ? "The host refused it, or is an agent that does not "
                                                  "know `restart_request` (unknown types are ignored)."
                                                : "");
            mode_ = pending::none;
        }
    }

    void pre_destroy() override {
        if (requests_)
            ENW_INFO("restart_request: %d request(s), %d restart(s) seen", requests_, restarts_);
    }

    enum class pending { none, host, local, watch };
    seen seen_[kSlots];
    uint32_t last_poll_ = 0;
    uint32_t last_restart_ = 0;
    uint32_t last_drop_ = 0;         // the last time an active slot left the active state
    uint32_t since_ = 0;
    int level_at_request_ = 0;
    int players_ = 0;
    int requests_ = 0;
    int restarts_ = 0;
    pending mode_ = pending::none;
};

}  // namespace
}  // namespace enw

ENW_REGISTER_COMPONENT(enw::restart_request)
