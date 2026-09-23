// IDLE-SERVER AUTO-CLOSE (B, 2026-09-23 19:10 UK; esc-menu.md §13).
//
// B's lease m_5a28dcbe (zm_nuked) went `ready` at 16:36 UTC, nobody ever joined, and it held
// the box's RAM for 95 minutes, blocking every other boot. Two rules end such a lease
// cleanly, with reason `no_players`:
//
//   NEVER JOINED  nobody was admitted within `readyMs` (default 5 min) of the map being ready
//                 (the timer starts at `map_loaded`, so booting and loading never count).
//                 Decided here, by the host: no game was played, so no result is posted; the
//                 site is told with a per-game status `no_players` and ends the lease.
//   ALL GONE      everybody who was in the game has been gone for `goneMs` (default 3 min).
//                 The referee's own empty / crash-grace close does this (lib/referee.js
//                 `tickGrace`: `emptyCloseMs` / `crashGraceMs`, both set to `goneMs` by
//                 host.js); the run is finished and posted as always, flagged `no_players`,
//                 and the site's result ingest ends the lease.
//
// Never while a player is connected, and never while the site says a join is in progress
// (`hold_idle` on the lease: a party member's launcher is downloading the map, or a Resume
// is on its way in). Pure: host.js applies it, test/idle.js checks it.

/**
 * @returns {null | {reason:'no_players', rule:'never_joined', detail:string}}
 */
export function neverJoined({ now, readyAt, admitted, connected, hold, readyMs, finished = false }) {
  if (finished || !readyAt || !(readyMs > 0)) return null
  if (admitted || connected > 0 || hold) return null
  const idle = now - readyAt
  if (idle < readyMs) return null
  return { reason: 'no_players', rule: 'never_joined', detail: `nobody joined within ${Math.round(readyMs / 1000)} s of the server being ready` }
}

/** The launcher's line and the site's note, terse (B's design direction). */
export const CLOSED_TEXT = {
  never_joined: 'Server closed: nobody joined.',
  all_gone: 'Server closed: everyone left.',
}
