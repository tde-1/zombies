// The site's notices to this player ("Your record has been uploaded.", esc-menu.md §10.3), as
// the chat overlay's poll thread receives them, for the one other place that shows them: the
// main-menu lockdown's end screen (menu_lockdown.cpp). A game over on a box usually ends in the
// server going away seconds later, and the HUD may not be drawn in between (the intermission
// scoreboard), so the end screen repeats the newest notice. Header-only; any thread.
#pragma once

#include <windows.h>

#include <mutex>
#include <string>

namespace enw::client::notice_board {

struct board {
    std::mutex mu;
    std::string text;
    ULONGLONG at = 0;
};

inline board& get() {
    static board b;
    return b;
}

inline void post(const std::string& text) {
    board& b = get();
    std::lock_guard<std::mutex> lk(b.mu);
    b.text = text;
    b.at = ::GetTickCount64();
}

// The newest notice if it is younger than `max_age_ms`, else empty.
inline std::string latest(ULONGLONG max_age_ms) {
    board& b = get();
    std::lock_guard<std::mutex> lk(b.mu);
    if (b.text.empty() || ::GetTickCount64() - b.at > max_age_ms) return {};
    return b.text;
}

}  // namespace enw::client::notice_board
