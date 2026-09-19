// See logprint_mirror.hpp for what this is and why it exists.
#include "logprint_mirror.hpp"

#include "../../../shared/core/game.hpp"
#include "../../../shared/core/logger.hpp"
#include "t4_bind.hpp"

#include <atomic>

namespace enw::referee {
namespace {

std::atomic<bool> g_enabled{false};

// IW4MAdmin splits on ';', so a field containing one would silently shift every
// field after it. Their GSC never has to care because it only ever emits engine
// identifiers; ours can carry a custom map's flag name, which is author-supplied
// and could be anything. Replace rather than escape: their parser has no unescape
// step, so an escape sequence would arrive as literal backslashes.
std::string sanitise(std::string s) {
    for (char& c : s) {
        if (c == ';' || c == '\n' || c == '\r') c = '_';
    }
    if (s.size() > 128) s.resize(128);
    return s;
}

}  // namespace

bool logprint_enabled() { return g_enabled.load(std::memory_order_relaxed); }

void set_logprint_enabled(bool on) {
    const bool was = g_enabled.exchange(on, std::memory_order_relaxed);
    if (was != on) {
        ENW_INFO("logprint mirror %s (IW4MAdmin GSE lines into the game log)",
                 on ? "ENABLED" : "disabled");
    }
}

void logprint_event(const std::string& payload) {
    if (!logprint_enabled()) return;
    // LogPrint() is the GSC builtin; from C++ the equivalent is a console print on
    // the logfile channel, which is what ends up in the same game log a log-tailing
    // admin tool reads. Channel 0 is CON_CHANNEL_DONT_FILTER.
    game::console_print("GSE;%s\n", payload.c_str());
}

void lp_round_complete(int round) {
    logprint_event("RC;" + std::to_string(round));
}

void lp_easter_egg_step(const std::string& step_key) {
    logprint_event("ZW;easter_egg;step;" + sanitise(step_key));
}

void lp_easter_egg_complete(const std::string& map_name) {
    logprint_event("ZW;easter_egg;complete;" + sanitise(map_name));
}

// ENW extension. Their 34 EventLogType values have no buyable ending because
// Treyarch maps do not have one; an unknown ZW kind makes their parser log a
// warning and drop the line, so this is safe to emit at a stock IW4MAdmin.
void lp_buyable_ending(int round, const std::string& map_name) {
    logprint_event("ZW;buyable_ending;" + std::to_string(round) + ";" + sanitise(map_name));
}

void lp_power(bool on, int slot, int round) {
    logprint_event("ZW;power;" + std::string(on ? "on" : "off") + ";" +
                   (slot >= 0 ? "player;" + std::to_string(slot) : std::string("world")) + ";" +
                   std::to_string(round));
}

void lp_zombies(int round, int remaining, int alive) {
    logprint_event("ZW;zombies;" + std::to_string(round) + ";" + std::to_string(remaining) + ";" +
                   std::to_string(alive));
}

void lp_player_event(int slot, const std::string& category, const std::string& args) {
    // Their ZP block carries a full player descriptor (guid, name, team, ...) before
    // the category. We do not have those fields bound yet, so we emit the slot and
    // let the host correlate; a real deployment fills the block from client_s once
    // svs.clients is mapped.
    logprint_event("ZP;" + std::to_string(slot) + ";;;;" + sanitise(category) +
                   (args.empty() ? "" : ";" + args));
}

}  // namespace enw::referee
