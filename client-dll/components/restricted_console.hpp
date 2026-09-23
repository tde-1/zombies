// The ENW console: World at War's stock console never opens; this one does, and it can only
// change settings the in-game catalogue allows (esc-menu.md §10). restricted_console.cpp is
// all of it. Like the Settings tab it has no hook of its own: pause_menu.cpp (which borrows
// the chat overlay's draw hook and input filter) calls it first, lines marked [console].
// Main thread only.
#pragma once

#include <windows.h>

#include "settings_tab.hpp"

namespace enw::client::restricted_console {

// Once, from pause_menu's post_init, with the menu's own stock-font drawing calls.
void init(const settings_tab::draw_api& api);

// Called first in pause_menu::filter. The console key (scan code 0x29, the key under Esc) is
// ALWAYS consumed, so the engine never sees it; it opens ours when `can_open` (in a map, no
// menu, no chat). While ours is open every key and character is ours. True = consumed.
bool filter(UINT msg, WPARAM wp, LPARAM lp, LRESULT* result, bool can_open);

bool is_open();

// Draw it (the 640x480 virtual space of the menu's placement; `vw` its width there).
void draw(float vw);

}  // namespace enw::client::restricted_console
