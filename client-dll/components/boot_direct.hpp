// boot_direct: launcher Play -> black/loading -> the zombies map. See boot_direct.cpp.
//
// The one seam into connect_local.cpp: its gate asks `fire_now()` first, and tells us
// when it actually called CL_ConnectLocal. Everything else lives in boot_direct.cpp.
#pragma once

#include <cstdint>

namespace enw::client::boot_direct {

// True when the direct boot is on for this process (armed join, ENW_DIRECT_BOOT != 0).
bool enabled();

// Asked by connect_local's gate every frame before its own menu-based gate. True means
// "connect now": the engine is far enough up that CL_ConnectLocal works, and waiting for
// the main menu would only show the menu (and play its music).
bool fire_now(uint64_t frame, unsigned long long ms_since_post_init, int clc_state,
              long file_videos_open);

// connect_local calls this right after CL_ConnectLocal returns.
void note_connect();

}  // namespace enw::client::boot_direct
