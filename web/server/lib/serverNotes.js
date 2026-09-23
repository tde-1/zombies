'use strict'

// WHY a map is not playable on our servers, in the few words the site shows on hover
// (B, 2026-09-22: "mark maps that aren't playable").
//
// The flag itself is `maps.onServer()` (lib/maps.js, SERVER_PROVEN): a map is playable on a
// box only once a dedicated server has run it to game over with a real client attached. This
// file only names the reason for the ones that are not, from the dedi lane's findings
// (docs/kickstart/dedi.md §13, §14, §16). Anything not named here has simply not been
// through that run yet.

const ENGINE_LIMIT = 'Hits a game engine limit on our servers'
const MEMORY = 'Too big for the game’s memory limit'

const KNOWN = {
  // nazi_zombie_derberg was ENGINE_LIMIT (dedi.md §13.2 localVars overrun). That was the
  // escaped-frame class dedi.md §23/§25/§26 fixed (box DLL fd3039d2): box-proven 2026-09-23,
  // 185 s + watchdog clean (archive.md §14), so it is on boxProven.json and needs no note.
  nazi_zombie_octogonal: ENGINE_LIMIT,   // dedi.md §16.4: snddriverglobals singleton
  water: ENGINE_LIMIT,                   // dedi.md §16.4: memory reserve
  nazi_zombie_orbit: MEMORY,             // stalls the 32-bit client (lib/maps.js)
  ugx_artemovsk: MEMORY,                 // UGX Requiem, same
}

const UNTESTED = 'Not tested on our servers yet'
const LOCAL_ONLY = 'Play Local only'
const BROKEN = 'Does not run'
// The "New" tag's hover: lib/maps.js BOX_PROVEN, server-side proof only.
const UNTESTED_CLIENT = 'New: loads on our servers, not yet played with a client'

let BOX = {}
try { BOX = require('./boxProven.json').maps || {} } catch { BOX = {} }

/** The reason for a map row that is NOT on the server list (null for one that is), or the
 *  caveat for one that is on it only at the 'box' level. */
function noteFor (row, onServer, level = null) {
  if (!row) return null
  if (onServer) return level === 'box' ? UNTESTED_CLIENT : null
  if (row.health === 'broken') {
    const b = BOX[row.key]
    return b && b.result === 'fail' && b.note ? `${BROKEN} on our servers: ${b.note}` : BROKEN
  }
  if (KNOWN[row.key]) return KNOWN[row.key]
  if (row.health === 'custom-only') return LOCAL_ONLY
  return UNTESTED
}

module.exports = { noteFor, KNOWN, UNTESTED_CLIENT }
