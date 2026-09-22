// The input gate: how a second consumer of the game window's messages gets them
// WITHOUT a second WndProc subclass.
//
// chat-overlay.md §3 and README hard rule 9 in different clothes: `mouse_polling`
// owns the one subclass of the "CoD-WaW" window (its guard refuses to install when
// the proc is not 0x606BE0, so a second subclass makes one of the two refuse
// depending on load order). Everything else that needs the window's messages asks
// mouse_polling through this header.
//
//   * A FILTER is called first, for every message, before mouse_polling does
//     anything. Returning true means "consumed": mouse_polling returns *result and
//     neither it nor the engine sees the message.
//   * CAPTURED means the mouse belongs to an overlay, not the game: mouse_polling
//     feeds the engine no motion and no buttons (raw or legacy), puts the legacy
//     messages back (NOLEGACY off) so the OS cursor moves, and does not recentre.
//     Entering capture forces every tracked button up in the engine's differ;
//     leaving it resyncs from the OS, so nothing is held down across the overlay.
//   * send_to_engine() hands a message to the ENGINE's own WndProc directly, past
//     the filter -- used to release keys the engine believes are held when the
//     overlay opens.
//
// All of it runs on the game's main thread (the message pump and the frame are the
// same thread in T4). Defined in mouse_polling.cpp, which owns the subclass.
#pragma once

#include <windows.h>

namespace enw::client::input_gate {

using filter_fn = bool (*)(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam, LRESULT* result);

void set_filter(filter_fn fn);

void set_captured(bool on);
bool captured();

// True once the subclass is on the window (either mode: raw input, or the
// passthrough one installed only so a filter has somewhere to run).
bool installed();

// The game window we subclassed, or nullptr.
HWND window();

// Straight to the engine's WndProc (0x606BE0), bypassing the filter and
// mouse_polling's own rewriting. No-op before install.
LRESULT send_to_engine(UINT msg, WPARAM wparam, LPARAM lparam);

}  // namespace enw::client::input_gate
