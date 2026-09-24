// What the rest of the DLL may ask the pause component. Read-only, main thread only.
#pragma once

namespace enw::pause_state {

// True while the G_RunFrame gate is holding the world (a frozen frame has been applied): no
// script runs, no timer moves, the engine's client timeout cannot advance. False when pause is
// not armed (listen server, ENW_NO_PAUSE=1, the gate failed its byte check).
bool world_frozen();

}  // namespace enw::pause_state
