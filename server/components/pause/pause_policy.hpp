// The pause rule, with no engine in it, so it can be tested on its own
// (server/tests/pause_policy_test.cpp) and read in one sitting.
//
// B's spec, 2026-09-22: "If you are playing solo on a Verified game, the game actually pauses
// when you pause (Esc menu), and also when you type in chat -- with a setting 'pause when using
// global chat' you can toggle on/off for single-player. In multiplayer, multiple people typing
// should never pause the game; the game pauses when everyone has paused."
//
// What each client reports reaches us as two userinfo keys (the contract is in
// docs/kickstart/chat-overlay.md, "Client -> server: the pause contract"):
//
//     enw_ui     paused | typing | clear       (absent, empty or anything else = clear)
//     enw_pchat  1 | 0                          (absent = 1: "pause when using global chat")
//
// The rule:
//   * nobody connected                    -> not paused (a disconnect counts as unpaused)
//   * exactly one client connected        -> paused if `paused`, or `typing` with enw_pchat 1
//   * two or more                         -> paused only if EVERY connected client is `paused`;
//                                            `typing` never counts, in any number
//   * the host can hold the game paused on its own (crash grace, everyone-AFK, an operator) and
//     that hold is OR-ed on top; the UI can never release a host hold.
//
// There is deliberately NO ceiling on how long a multiplayer pause may last (B, 2026-09-22).
// pause.cpp logs the length of every pause instead.
#pragma once

#include <cstring>
#include <string>

namespace enw::pause_rule {

enum class ui_state { clear, paused, typing };

enum class reason { none, host, solo_menu, solo_chat, all_menu, operator_file };

inline const char* to_string(ui_state s) {
    switch (s) {
        case ui_state::paused: return "paused";
        case ui_state::typing: return "typing";
        default: return "clear";
    }
}

inline const char* to_string(reason r) {
    switch (r) {
        case reason::host: return "host";
        case reason::solo_menu: return "solo_menu";
        case reason::solo_chat: return "solo_chat";
        case reason::all_menu: return "all_menu";
        case reason::operator_file: return "operator";
        default: return "none";
    }
}

inline ui_state parse_ui(const std::string& v) {
    if (v == "paused") return ui_state::paused;
    if (v == "typing") return ui_state::typing;
    return ui_state::clear;
}

// `\key\value\key\value` (the leading backslash is optional). Returns "" when absent.
constexpr char kSep = 0x5C;  // the info-string separator (a backslash)

inline std::string info_value(const std::string& info, const char* key) {
    const size_t klen = std::strlen(key);
    size_t i = (!info.empty() && info[0] == kSep) ? 1 : 0;
    while (i < info.size()) {
        const size_t kend = info.find(kSep, i);
        if (kend == std::string::npos) return "";
        const size_t vstart = kend + 1;
        size_t vend = info.find(kSep, vstart);
        if (vend == std::string::npos) vend = info.size();
        if (kend - i == klen && info.compare(i, klen, key) == 0)
            return info.substr(vstart, vend - vstart);
        i = vend + 1;
    }
    return "";
}

struct client_report {
    bool connected = false;
    ui_state ui = ui_state::clear;
    bool pause_on_chat = true;   // enw_pchat; only ever consulted when the client is alone
};

inline client_report from_userinfo(bool connected, const std::string& userinfo) {
    client_report r;
    r.connected = connected;
    if (!connected) return r;
    r.ui = parse_ui(info_value(userinfo, "enw_ui"));
    r.pause_on_chat = info_value(userinfo, "enw_pchat") != "0";
    return r;
}

// What the players want, host hold not included.
inline reason ui_wants(const client_report* clients, int n) {
    int connected = 0, in_menu = 0;
    const client_report* only = nullptr;
    for (int i = 0; i < n; ++i) {
        if (!clients[i].connected) continue;
        ++connected;
        only = &clients[i];
        if (clients[i].ui == ui_state::paused) ++in_menu;
    }
    if (connected == 0) return reason::none;
    if (connected == 1) {
        if (only->ui == ui_state::paused) return reason::solo_menu;
        if (only->ui == ui_state::typing && only->pause_on_chat) return reason::solo_chat;
        return reason::none;
    }
    return in_menu == connected ? reason::all_menu : reason::none;
}

// The effective decision. A host hold wins and is reported as such.
//
// `ui_enabled` false is ENW_PAUSE_HOST_ONLY=1 (2026-09-24, disconnect pause): the gate is armed,
// the HOST's hold (a player lost their connection, everyone AFK) freezes the world, and the
// players' Esc/typing pause does not. It exists so the box can take the disconnect pause back
// without also taking back the Esc pause that was switched off with ENW_NO_PAUSE (dedi.md §18.6).
inline reason decide(bool host_hold, const client_report* clients, int n, bool ui_enabled = true) {
    if (host_hold) return reason::host;
    if (!ui_enabled) return reason::none;
    return ui_wants(clients, n);
}


// ---------------------------------------------------------------- write guards --
// The freeze writes engine memory in exactly two places each frozen frame: svs.time, and each
// active client's nextSnapshotTime. Both are only ever written when the value already there is a
// plausible TIME near the frozen one -- a pointer, a string id or a wild count fails this, so a
// wrong address can never be scribbled on (2026-09-23, referee.md §15.4).
//
// svs.time: SV_Frame adds frameMsec (1000/sv_fps, at most 1000) before we see it.
inline bool plausible_svs_time(int prior, int frozen) {
    return frozen > 0 && prior >= frozen && prior - frozen <= 1000;
}
// nextSnapshotTime: svs.time + rateMsec (+ 50 * delay), or svs.time - 1, or svs.time + 1000 for a
// client that is not active -- all within a few seconds of the frozen time. Only ever pulled DOWN.
inline bool plausible_next_snapshot(int prior, int frozen) {
    return frozen > 0 && prior > frozen && prior - frozen <= 5000;
}
// How many client slots the gate may touch: sv_maxclients, clamped to the array (4 on T4).
inline int client_slots(int sv_maxclients, int array_len) {
    if (sv_maxclients < 1) return 0;
    return sv_maxclients < array_len ? sv_maxclients : array_len;
}

}  // namespace enw::pause_rule
