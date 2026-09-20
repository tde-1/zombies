// The per-frame tick, owned by the core.
//
// THE RULE (docs/dev-box.md): components SUBSCRIBE here. No component hooks
// `Com_Frame` itself. MinHook allows exactly one hook per target address and the
// loser only finds out from a log line -- we already lost four minutes of
// `referee`'s frame binding that way.
//
//     #include "frame.hpp"
//     enw::frame::subscribe("my_thing", [](uint64_t n) { ... });
//
// HOW IT IS TAKEN: we do NOT detour Com_Frame. We retarget the `call Com_Frame`
// instruction in WinMain's loop (0x5FF7BD, verified by `re`) to our own stub,
// which calls the real Com_Frame and then runs the subscribers. That leaves
// Com_Frame's own bytes untouched, so a component that still MinHooks it --
// `dedicated` does, for its frame-rate counter -- keeps working. Rewriting one
// rel32 is also strictly safer than relocating a prologue.
//
// WHEN IT ACTUALLY FIRES: not yet, on a stock launch. `re` established (board
// 01:35) that WinMain never reaches its loop, because 0x5FF4E0 -- called at
// WinMain+0x199, before the loop -- runs renderer/D3D bring-up unconditionally.
// Until that is bypassed there is no per-frame tick in any mode. Subscribing is
// still the right thing to do: the moment the loop runs, every subscriber starts
// ticking with no further change.
//
// Callbacks run ON THE GAME'S MAIN THREAD, at a frame boundary, after the
// engine's own frame work. Keep them short. A callback that faults is caught,
// logged once and unsubscribed rather than allowed to kill the game every frame.
#pragma once
#include "enw.hpp"

#include <functional>

namespace enw::frame {

// `n` is our own frame counter, starting at 1.
using callback = std::function<void(uint64_t n)>;

// Returns a token for unsubscribe(), or 0 if the name is empty.
int subscribe(const char* name, callback fn);
void unsubscribe(int token);

// Is the tick installed (i.e. did we get the call site)? Note this can be true
// while count() stays 0 -- see "WHEN IT ACTUALLY FIRES" above.
bool installed();

// Frames dispatched since the hook went in.
uint64_t count();

// Subscribers currently registered.
size_t subscriber_count();

// Core-internal: called once from components/frame_dispatch.cpp at post_unpack,
// and at shutdown. Components do not call these.
bool install();
void uninstall();

}  // namespace enw::frame
