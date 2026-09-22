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
  nazi_zombie_derberg: ENGINE_LIMIT,     // dedi.md §13.2: scrVmPub.localVars overrun
  nazi_zombie_octogonal: ENGINE_LIMIT,   // dedi.md §16.4: snddriverglobals singleton
  water: ENGINE_LIMIT,                   // dedi.md §16.4: memory reserve
  nazi_zombie_orbit: MEMORY,             // stalls the 32-bit client (lib/maps.js)
  ugx_artemovsk: MEMORY,                 // UGX Requiem, same
}

const UNTESTED = 'Not tested on our servers yet'
const LOCAL_ONLY = 'Play Local only'
const BROKEN = 'Does not run'

/** The reason for a map row that is NOT on the server list. Null for one that is. */
function noteFor (row, onServer) {
  if (!row || onServer) return null
  if (row.health === 'broken') return BROKEN
  if (KNOWN[row.key]) return KNOWN[row.key]
  if (row.health === 'custom-only') return LOCAL_ONLY
  return UNTESTED
}

module.exports = { noteFor, KNOWN }
