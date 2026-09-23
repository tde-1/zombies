// The main-menu lockdown's model: when has an ENW game fallen back to World at War's main
// menu, and what does the player read before the game closes. Pure, unit-tested
// (tools/tests/lockdown_test.cpp). menu_lockdown.cpp is the engine half; esc-menu.md §10.
//
// B, 2026-09-23: players must never reach World at War's stock main menu. The launcher is
// our menu. So when a game session ends -- the server went away, a kick, an error, Exit, the
// stock pause menu's Quit in Play Local -- the engine's fall-back to its main menu is covered
// by our own screen that says why, and the game closes; the launcher is back in front.
#pragma once

#include <cstdint>
#include <string>

namespace enw::lockdown {

// clc.state on this build (t4-sp-map.md, boot_direct.cpp's log): 1 CA_CINEMATIC, 2 the main
// menu (disconnected; also the first boot frames), 4 challenging, 5 connecting, 6..9
// loading, 10 in a map. 0 is before the client is up.
inline bool at_menu_state(int s) { return s == 0 || s == 2; }
inline bool session_state(int s) { return s >= 4; }

enum class step { none, show, quit };

struct tracker {
    uint32_t debounce_ms = 1500;   // a map change passes through low states for a frame or two
    uint32_t show_ms = 4000;       // how long the player reads our screen before the game closes

    bool session = false;          // this process has been connecting / in a map
    bool reached_map = false;      // ...and got all the way in (clc.state 10)
    bool shown = false;
    bool quit = false;
    uint64_t low_since = 0;        // at the menu since (0 = not)
    uint64_t shown_at = 0;
    // MEASURED (l12b): a server killed after a game over sends no disconnect, and this engine
    // never times the client out (60 s at clc.state 10, cl_timeout 10). So a map (state 10)
    // with no in-band datagram from the server for this long is a session that has ended.
    uint32_t silence_ms = 20000;
    bool lost = false;             // ended by that silence, not by a fall to the menu

    // Once a frame. `now` in ms; `quiet_ms` how long the server has sent nothing in-band
    // (0 = unknown / not measured). Returns what to do NOW (show: start drawing our screen;
    // quit: send `quit`), each exactly once.
    step feed(uint64_t now, int clc_state, uint64_t quiet_ms = 0) {
        if (quit) return step::none;
        if (shown) {
            if (now - shown_at >= show_ms) { quit = true; return step::quit; }
            return step::none;
        }
        if (clc_state >= 10 && reached_map && silence_ms && quiet_ms >= silence_ms) {
            lost = true;
            shown = true;
            shown_at = now;
            return step::show;
        }
        if (session_state(clc_state)) {
            session = true;
            if (clc_state >= 10) reached_map = true;
            low_since = 0;
            return step::none;
        }
        if (!session || !at_menu_state(clc_state)) { low_since = 0; return step::none; }
        if (!low_since) { low_since = now ? now : 1; return step::none; }
        if (now - low_since < debounce_ms) return step::none;
        shown = true;
        shown_at = now;
        return step::show;
    }
};

// The engine's error text (com_errorMessage, usually a localisation key) as a line a player
// can read. Anything we do not recognise is shown as the engine wrote it, minus the key's
// EXE_ prefix and underscores, so nothing is hidden.
inline std::string describe(const std::string& err, bool reached_map) {
    std::string e;
    for (char c : err) e.push_back(static_cast<char>(c >= 'a' && c <= 'z' ? c - 32 : c));
    auto has = [&](const char* k) { return e.find(k) != std::string::npos; };
    if (e.empty()) return reached_map ? "The game has ended." : "Could not join the game.";
    if (has("SERVERDISCONNECT") || has("SERVER_DISCONNECT") || has("DISCONNECTED")) return "The server closed the game.";
    if (has("TIMEDOUT") || has("TIMED OUT") || has("CONNECTIONINTERRUPTED")) return "Lost the connection to the server.";
    if (has("KICKED") || has("DROPPED")) return "You were removed from the game.";
    if (has("SERVERISFULL") || has("SERVER_IS_FULL")) return "The game is full.";
    if (has("CANNOTJOININPROGRESS")) return "The game could not be joined.";
    if (has("BAD_CHALLENGE") || has("BADCHALLENGE")) return "Could not join the game.";
    if (has("DID NOT LET YOU IN")) return "Could not join the game.";
    if (has("SCRIPT RUNTIME ERROR") || has("SCRIPT COMPILE ERROR")) return "The map hit a script error.";
    std::string out = err;
    if (out.rfind("EXE_", 0) == 0) {
        out = out.substr(4);
        for (auto& c : out) if (c == '_') c = ' ';
    }
    if (out.size() > 90) out = out.substr(0, 87) + "...";
    return out;
}

}  // namespace enw::lockdown
