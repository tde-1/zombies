// Getting work onto the game's main thread.
//
// WHY: almost nothing in an IW engine is safe to call from an arbitrary thread,
// and at least one thing we need -- Com_Printf reaching the console -- appears
// not to work off-thread at all (see docs/kickstart/foundation.md). Our loader
// and game-link both run on their own threads, so they need a way to hand work
// over.
//
// HOW: DllMain runs on the process's initial thread, which is the game's main
// thread, so we record its id there for free. Something called frequently from
// that thread then drains the queue. Until a real frame hook exists, the pump is
// driven from a detour on Dvar_FindVar (see components/main_thread.cpp) -- the
// engine calls it constantly and its signature is simple and verified.
#pragma once
#include "enw.hpp"

#include <functional>

namespace enw::scheduler {

// Called from DllMain.
void set_main_thread(unsigned long thread_id);
unsigned long main_thread_id();
bool on_main_thread();

// Queue work for the main thread. Returns false if the queue is full (bounded;
// oldest is dropped, and the drop is counted).
bool run_on_main(std::function<void()> fn);

// Run queued work. Safe to call from anywhere but only actually does anything on
// the main thread. Re-entrant-safe: a pump inside a pump is a no-op.
size_t pump(size_t max_items = 16);

struct stats {
    uint64_t queued = 0;
    uint64_t ran = 0;
    uint64_t dropped = 0;
    uint64_t pumps = 0;
    size_t pending = 0;
};
stats snapshot();

}  // namespace enw::scheduler
