// Ending the match from outside the referee.
//
// The referee decides game over from what the scripts do (end_game, intermission).
// A server whose frame has stopped (dedi.md §23) will never run another script, so
// the freeze watchdog has to be able to say "this match is over" itself, and it
// must say it the same way: one `game_over` with the result, the replay sampler
// stopped, one `match_end`. Everything that goes to the host goes through the same
// function the scripts' ending uses, so the host cannot tell the two apart except
// by `reason` and `flags`.
#pragma once

namespace enw::referee {

// Sends game_over (reason, flags:[flag] if flag is non-null) and match_end with
// server_alive as given. Must be called on the game thread (a frame subscriber).
// Returns false if the referee is not armed or the match has already ended.
bool end_game_now(const char* reason, const char* flag, bool server_alive);

}  // namespace enw::referee
