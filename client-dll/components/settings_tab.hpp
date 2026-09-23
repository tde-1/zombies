// The Settings tab of the ENW Esc menu (esc-menu.md §9). pause_menu.cpp owns the menu,
// the draw hook and the input filter (both borrowed from the chat overlay); this is only
// the panel it draws on the right when Settings is chosen, and what a click there does.
// Main thread only, like everything the menu does.
#pragma once

#include <windows.h>

#include <string>
#include <vector>

namespace enw::client::settings_tab {

// pause_menu's own drawing calls (stock WaW font, engine-drawn), so the two read as one.
struct draw_api {
    void (*txt)(float x, float y, const std::string& s, const float* col, float scale);
    float (*tw)(const std::string& s, float scale);
    void (*box)(float x, float y, float w, float h, const float* col);
};

// Once, from pause_menu's post_init: loads the embedded schema and logs what it holds.
void init(const draw_api& api);
bool available();

// The tab was opened (or the menu opened on it): re-read the binds, the context.
void on_show();
// The menu is closing: end a capture or a drag, nothing else.
void on_hide();

// Draw the panel in the 640x480 virtual space; (mx, my) is the pointer there.
void draw(float x, float y, float w, float h, float mx, float my);

// Input, in virtual coordinates. True = ours (consumed).
bool mouse_down(float vx, float vy, int button);   // 0 left, 1 right, 2 middle, 3/4 X1/X2
bool mouse_up(float vx, float vy);
void mouse_move(float vx, float vy);
bool wheel(float vx, float vy, int notches);
// A key while the tab is up. True = consumed. Esc during a bind capture cancels it.
bool key_down(WPARAM vk, LPARAM lp);
bool capturing();

// Every frame (pause_menu's frame subscriber): write-through checks, the vid_restart
// wait, and whether the menu should stay open across a restart.
void frame_tick();
bool restart_in_progress();

// For the selftest (pause_menu's ENW_ESC_MENU_SELFTEST=5): set an item as a click would,
// by id; press Apply; switch tabs; the centre of an item's control in virtual space.
bool set_by_id(const std::string& id, const std::string& value);
bool apply_restart();
bool show_tab(const std::string& tab_id);
// Where to click, in virtual space: an item's control (`part` 0 = its centre, 1 = the
// "<" of a list, 2 = its ">", 3 = a slider at `frac`), a tab by id ("tab:<id>"), or the
// Apply button ("apply"). False when it is not on screen now.
bool control_point(const std::string& id, int part, float frac, float* vx, float* vy);
std::string value_of(const std::string& id);
void log_values(const char* why);
void set_restricted_override(int v);   // -1 real, 0 off, 1 on (selftest only)

// [console] The ENW console (restricted_console.cpp, esc-menu.md §10) sets settings through
// exactly the tab's path: the same catalogue, the same visibility rules (Verified, mod-owned,
// forbidden), the same `seta` + write-through. Each returns the one line the player reads.
std::string console_get(const std::string& name);
std::string console_set(const std::string& name, const std::string& value);
std::string console_reset(const std::string& name);
// "cg_fov 90 (field of view, 65 to 120)" per setting the console accepts now, filtered by a
// name prefix; and the bare names, for Tab completion.
std::vector<std::string> console_list(const std::string& prefix);
std::vector<std::string> console_names();

}  // namespace enw::client::settings_tab
