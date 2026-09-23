// The map's pre-game choice menu, answered by the server (docs/kickstart/game-modes.md).
//
// PURE: no engine, no Windows. Unit-tested in server/tests/menu_answer_test.cpp; the engine
// half is game_mode.cpp.
//
// A custom map like Battlestar Galactica (UGX Mod 1.0.x) opens a vote menu at
// all_players_connected and its script WAITS on the host player's `menuresponse` notify:
//
//     maps/ugxm_init.gsc  handle_vote():         players[0] waittill("voting_complete")
//                         handle_vote_watcher(): self waittill("menuresponse", menu, response)
//                                                "gg" gungame, "ss" sharpshooter, "cl" classic,
//                                                "ar" arcademode, "bh" bountyhunter, "start"
//
// The party leader picks the mode on the site instead. The host puts three dvars on the
// dedicated server's command line (host-owned: a party can never set them,
// infra/host-agent/lib/instances.js HOST_OWNED_DVARS):
//
//     enw_menu_hide    ugxm_vote_host,ugxm_vote_players   menus the server never sends
//     enw_menu_answer  ugxm_vote_host:gg,start            the responses, in order, sent as
//                                                          the player the menu was opened for
//     enw_menu_done    ugxm_voting_complete               the level notify that proves it took
//
// Every name and response is one plain token of [A-Za-z0-9_], at most 63 characters, at most
// 8 of each. Anything else is refused as a whole: a half-parsed answer could hide a menu the
// script then waits on forever, which is worse than showing it.
#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace enw::game_mode {

inline constexpr size_t kMaxToken = 63;
inline constexpr size_t kMaxItems = 8;

inline bool plain_token(const std::string& s) {
    if (s.empty() || s.size() > kMaxToken) return false;
    for (char c : s) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
        if (!ok) return false;
    }
    return true;
}

// Split on `sep`; false if any piece is not a plain token or there are too many.
inline bool split_tokens(const std::string& s, char sep, std::vector<std::string>& out) {
    out.clear();
    if (s.empty()) return true;
    size_t start = 0;
    while (true) {
        const size_t at = s.find(sep, start);
        const std::string piece = s.substr(start, at == std::string::npos ? std::string::npos : at - start);
        if (!plain_token(piece)) return false;
        out.push_back(piece);
        if (out.size() > kMaxItems) return false;
        if (at == std::string::npos) break;
        start = at + 1;
    }
    return true;
}

// Case-insensitive, as the engine's own menu lookup is.
inline bool same_name(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        char x = a[i], y = b[i];
        if (x >= 'A' && x <= 'Z') x = static_cast<char>(x - 'A' + 'a');
        if (y >= 'A' && y <= 'Z') y = static_cast<char>(y - 'A' + 'a');
        if (x != y) return false;
    }
    return true;
}

struct spec {
    std::vector<std::string> hide;       // menus never sent to a client
    std::string answer_menu;             // the menu whose responses we send
    std::vector<std::string> responses;  // in order
    std::string done_notify;             // optional level notify that proves the answer took
    std::string error;                   // why parse() refused, empty when ok

    bool active() const { return !hide.empty() && !answer_menu.empty() && !responses.empty(); }

    bool hides(const std::string& menu) const {
        for (const auto& h : hide) if (same_name(h, menu)) return true;
        return false;
    }
    bool answers(const std::string& menu) const { return !answer_menu.empty() && same_name(answer_menu, menu); }
};

// All-or-nothing. An empty `hide` and `answer` is a valid "off" (no error). A hide list with no
// answer, or an answer menu that is not also hidden, is refused: either would leave a script
// waiting on a menu that nobody will ever answer, or answer a menu the player can also see.
inline spec parse(const std::string& hide, const std::string& answer, const std::string& done) {
    spec s;
    if (hide.empty() && answer.empty()) return s;
    std::vector<std::string> h;
    if (!split_tokens(hide, ',', h) || h.empty()) { s.error = "enw_menu_hide is not a list of plain tokens"; return s; }
    const size_t colon = answer.find(':');
    if (colon == std::string::npos) { s.error = "enw_menu_answer has no ':'"; return s; }
    const std::string menu = answer.substr(0, colon);
    std::vector<std::string> r;
    if (!plain_token(menu)) { s.error = "enw_menu_answer menu is not a plain token"; return s; }
    if (!split_tokens(answer.substr(colon + 1), ',', r) || r.empty()) { s.error = "enw_menu_answer responses are not plain tokens"; return s; }
    if (!done.empty() && !plain_token(done)) { s.error = "enw_menu_done is not a plain token"; return s; }
    s.hide = h;
    bool hidden = false;
    for (const auto& x : h) if (same_name(x, menu)) hidden = true;
    if (!hidden) { s.hide.clear(); s.error = "the answered menu is not in enw_menu_hide"; return s; }
    s.answer_menu = menu;
    s.responses = r;
    s.done_notify = done;
    return s;
}

// The schedule: the first response goes kFirstMs after the menu was (not) opened, then one
// every kStepMs. UGX's watcher re-arms its waittill one server frame (50 ms) after each
// response (`wait 0.01` for entity 0), so 600 ms is twelve frames of margin. If `done` is
// configured and has not been seen kDoneWaitMs after the last response, the whole sequence is
// sent once more (the responses are idempotent: a mode pick sets a value, `start` ends a vote
// that is already over harmlessly), at most kMaxRounds times in all.
inline constexpr unsigned kFirstMs = 600;
inline constexpr unsigned kStepMs = 600;
inline constexpr unsigned kDoneWaitMs = 4000;
inline constexpr int kMaxRounds = 3;

}  // namespace enw::game_mode
