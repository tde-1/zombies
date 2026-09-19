// Degraded-mode event transport: IW4MAdmin's `LogPrint("GSE;…")` convention.
//
// WHY. Our contract is NDJSON over TCP (docs/protocol/game-link-v0.md) and that
// stays the contract. But a socket is not always there -- the host agent may be
// down, the DLL may be running in a game somebody launched by hand, or an
// operator may simply want to point an existing tool at an ENW server. On T4 the
// only other outbound channel that exists is a line in the game log: `libcod`
// (the usual "GSC talks to MySQL/HTTP" escape hatch) does not support WaW.
//
// So we mirror the *event* subset -- never `snap`, never `input`, which are far
// too big and too frequent for a text log -- as IW4MAdmin's own semicolon format.
// That makes an ENW server readable by IW4MAdmin (MIT, maintained, ships a
// "Plutonium T4 CO-OP/Zombies" parser) at the cost of about fifty lines.
//
// FORMAT, read from the real source at
// C:\Users\b\ZombiesDev\thirdparty\iw4m-admin-zombiestats
// (RaidMax/IW4M-Admin, branch feature/zombie-stats, MIT):
//   Plugins/ZombieStats/Events/ZombieEventParser.cs
//
//   GSE;RC;<round>                          round complete
//   GSE;ZP;<player block>;<category>;...    player-scoped: down revive perk powerup
//                                           weapon box door trap build
//   GSE;ZW;<kind>;<args...>                 world-scoped:
//        round_special;<round>;<type>
//        zombies;<round>;<remaining>;<alive>
//        power;<state>;<source>;[player]
//        easter_egg;step;<key>
//        easter_egg;complete;<map>
//
// WHERE WE EXTEND IT. Their 34 EventLogType values have no slot for a buyable
// ending, because Treyarch maps do not have one -- it is a custom-map and ZWR
// convention, and it is the middle tier of our badge model. We add one kind
// rather than bend theirs:
//
//   GSE;ZW;buyable_ending;<round>;<map>     ENW extension, ignored by their parser
//
// Their parser throws ArgumentException on an unknown ZW kind and drops the line
// with a warning, so the extension degrades safely on a stock IW4MAdmin.
//
// OFF BY DEFAULT: dvar `enw_logprint_events` (0/1). Costs nothing when off.
#pragma once
#include "../../../shared/core/enw.hpp"

namespace enw::referee {

// Is the mirror switched on? Reads the dvar once per map load, not per event.
bool logprint_enabled();
void set_logprint_enabled(bool on);

// Emit one already-formatted GSE payload (without the "GSE;" prefix or newline).
// No-op when disabled or when Com_Printf is not available.
void logprint_event(const std::string& payload);

// The shapes we actually emit. Each is a thin wrapper so call sites stay readable
// and the separator/escaping rule lives in one place.
void lp_round_complete(int round);
void lp_easter_egg_step(const std::string& step_key);
void lp_easter_egg_complete(const std::string& map_name);
void lp_buyable_ending(int round, const std::string& map_name);   // ENW extension
void lp_power(bool on, int slot_or_negative_for_world, int round);
void lp_zombies(int round, int remaining, int alive);
void lp_player_event(int slot, const std::string& category, const std::string& args);

}  // namespace enw::referee
