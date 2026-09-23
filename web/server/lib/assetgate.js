'use strict'
// The asset gate, import side (archive.md 13, 2026-09-23). B: "every model, every map, every
// gun, everything should load flawlessly." `archive/asset_audit.py --write-manifest` records a
// map's verdict as `asset_audit.verdict` in its manifest:
//
//   clean | minor      nothing a player meets is missing       -> the manifest decides
//   hide               the release itself lacks a zombie model, a box/wall weapon, a script
//   fix | patch        a file we do not deliver (fix) / the release ships under a name nothing
//                      loads (patch) -- hidden until the fix is staged and the audit re-run
//   unproven           no console log yet                      -> the manifest decides
//
// A blocking verdict forces `maps.hidden = 1` on import, whatever `site_hidden` says, so no
// import (and no `popular.py --apply` setting site_hidden false) can put such a map back on the
// list. Unhiding one means re-running the audit after a fix, not editing a flag.
const BLOCKING = new Set(['hide', 'fix', 'patch'])

function blocked (m) {
  const v = m && m.asset_audit && m.asset_audit.verdict
  return BLOCKING.has(v) ? v : null
}

// -> { hidden: 0|1, hidden_set: 0|1 } for import-archive.js's upsert
function hiddenFor (m) {
  if (blocked(m)) return { hidden: 1, hidden_set: 1 }
  return {
    hidden: m && m.site_hidden === true ? 1 : 0,
    hidden_set: m && typeof m.site_hidden === 'boolean' ? 1 : 0,
  }
}

module.exports = { blocked, hiddenFor, BLOCKING }
