// The ENW Esc menu: replaces World at War's stock pause menu in a box (dedicated) game.
//
// docs/kickstart/esc-menu.md is the write-up. This header is the seam between the menu
// (pause_menu.cpp, all of its code) and the chat overlay (chat_overlay.cpp), which owns
// the three things the menu needs and must not duplicate:
//   * the draw hook (CG_Draw2D's call site) -- the overlay calls pause_menu::draw() first;
//   * the input gate filter (input_gate.hpp allows ONE) -- the overlay calls
//     pause_menu::filter() first;
//   * the chat panel itself -- the menu embeds it through chat_embed below.
// Everything runs on the game's main thread.
#pragma once

#include <windows.h>

namespace enw::client {

namespace pause_menu {

// True while our menu is up. The pause contract (chat-overlay.md §8) reports
// `enw_ui paused` whenever this is true: menu wins over typing.
bool is_open();

// Called by the overlay's input filter before anything else it does. True = consumed.
bool filter(UINT msg, WPARAM wp, LPARAM lp, LRESULT* result);

// Called by the overlay's draw hook (inside CG_Draw2D's window, after the HUD). True =
// the menu drew this frame, and the overlay must not draw its own panel or notify lines.
bool draw(int local_client);

// [C1] The engine menu now up (keyCatchers 0x10) is the one the map STARTED under, not one
// the player opened: the pause contract must not report it as `paused` (esc-menu.md §11.4).
bool map_start_menu();

// [C1] The ENW console's `quit` / `disconnect` / `restart`: the same paths as the menu's
// Exit game (the site is told it was on purpose, then disconnect, then quit unless
// `then_quit` is false) and Restart game (`setu enw_req restart.<n>`). True = started.
bool request_exit(bool then_quit);
bool request_restart_game();

}  // namespace pause_menu

// Implemented in chat_overlay.cpp (it needs the overlay's own state). The menu calls these
// and nothing else of the overlay's.
namespace chat_embed {

// Open the chat panel as part of the menu: the overlay takes the keyboard and mouse
// (input_gate captured, engine keys released, pointer kept on the monitor) exactly as if
// T had been pressed, but Esc, Enter and the close box no longer close it.
void open();
// Give it back. Closes the panel.
void close();
// Draw the open panel with its WaW chat anchor moved to (x, y) in the 640x480 virtual
// space (the anchor is the baseline of the newest history row; the panel is 340 wide and
// reaches 180 above and 26 below it). The overlay does not draw the pointer while
// embedded: the menu draws it last, above everything.
void draw_at(float x, float y);
// CG has drawn in the last 500 ms: we are in a map.
bool in_game();
// The overlay is open on its own (T), not as part of the menu. Esc is then the chat's:
// it closes the chat and does not open the menu.
bool chat_open_alone();

}  // namespace chat_embed

}  // namespace enw::client
