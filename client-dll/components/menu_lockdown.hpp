// The main-menu lockdown (menu_lockdown.cpp, esc-menu.md §10.1): an ENW game never shows
// World at War's main menu. Main thread only.
#pragma once

#include <windows.h>

namespace enw::client::menu_lockdown {

// join_retry.cpp owns the SCR_DrawScreenField seam (README hard rule 9: one owner per call
// site) and calls this after the engine has drawn the screen -- the main menu included -- so
// what we draw covers it.
void draw_over();

// pause_menu::filter calls this first: while our end screen is up, the main menu under it
// gets no keys and no clicks. True = consumed.
bool swallow_input(UINT msg);

}  // namespace enw::client::menu_lockdown
