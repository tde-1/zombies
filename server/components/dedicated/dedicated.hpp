// Stage C: headless dedicated server mode.
//
// Unlike IW4 and MWR, T4's single-player executable SHIPPED WITH a dedicated code
// path still in it (T4 SP is the co-op executable, and co-op needs a server).
// Observed on the stock Steam build 1.7.1263, 2026-09-20 -- see
// docs/kickstart/dedi.md:
//
//   +set dedicated 1  ->  dvar reads "dedicated LAN server"
//                         no Direct3D interface is ever requested
//                         no game window; a "Call of Duty WinConsole" instead
//                         the 'ui' fastfile is not loaded
//                         r_loadForRenderer is already 0
//                         "Opening IP socket: localhost:28960"
//                         "--- Common Initialization Complete ---"
//
// So this component is NOT "build a dedicated server out of a client" the way
// iw4x-client/Dedicated.cpp and h1-mod/dedicated.cpp are. Its job is narrower:
//
//   1. stop the engine falling back into client/renderer init after Com_Init
//      (with no map loaded it re-creates D3D9 + a window, reloads code_post_gfx
//      and dies on "Exceeded limit of 1 'snddriverglobals' assets");
//   2. force and hold the server dvars (some are latched or read-only);
//   3. pace the frame loop with a sleep instead of whatever the renderer used to
//      pace it with, and prove the idle cost;
//   4. keep local client 0 out of the game so the host does not occupy a slot and
//      inflate the zombie count (_zombiemode.gsc sizes rounds off get_players()).
#pragma once
#include "component.hpp"

namespace enw::dedi {

// True once post_unpack() has run and the engine really is in dedicated mode.
// Other components use this to skip client-only work
// (component::is_supported() is the usual place).
bool is_dedicated();

// Raw value of the engine's `dedicated` dvar: 0 listen, 1 LAN, 2 internet.
int dedicated_value();

}  // namespace enw::dedi
