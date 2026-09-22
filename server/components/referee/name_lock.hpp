#pragma once

// The name lock. A slot whose invite token verified is called what the token says, and
// nothing the client sends can change it. See name_lock.cpp for the engine chain and why
// the lock has to be server-side.

#include <string>

namespace enw::referee::namelock {

// Arm the hook on SV_UpdateUserinfo_f. Safe to call more than once; returns false and
// says so in the log if the addresses do not check out, in which case every lock_slot()
// is advisory and warns.
bool bind();
bool bound();

// Bind a slot to a name. Applied immediately, and re-applied on every userinfo change.
// An empty name is ignored — that is "not locked", not "locked to nothing".
void lock_slot(int slot, const std::string& name);
void unlock_slot(int slot);

// Every slot, on disconnect-all / next match.
void reset();

// Once per server frame, from the referee's existing poll. The safety net for any writer
// of cl->name that is not the userinfo path.
void tick();

// One line for the log and the proof harness.
std::string report();

}  // namespace enw::referee::namelock
