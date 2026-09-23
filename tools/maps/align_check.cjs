#!/usr/bin/env node
// The §8.12 alignment check (web/server/lib/mapAlign.js, the same code web/test/map-align.js
// runs) against ONE export, anywhere on disk -- export_all.py runs it on every staged map
// before anyone promotes it to the served dir.
//   node tools/maps/align_check.cjs <bsp.glb> <bsp.meta.json>
// Prints one JSON line: mapAlign.check()'s numbers plus {ok, problems[]}.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const align = require(path.join(__dirname, '..', '..', 'web', 'server', 'lib', 'mapAlign.js'))

const [glb, metaFile] = process.argv.slice(2)
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
const r = align.check(glb, meta, null)
const problems = []
if (!r.world) problems.push('no __world mesh')
else {
  const span = [0, 1, 2].map((i) => r.world.hi[i] - r.world.lo[i])
  if (span.some((v) => !Number.isFinite(v)) || Math.max(...span) > 65536) problems.push(`extent ${span} is not engine units`)
}
const sp = r.spawns.filter((s) => s.floorBelow !== null)
// T4 origins are at the feet; script_struct spawns float up to ~60 u (Nacht's sit 16 u up).
const onFloor = sp.filter((s) => s.floorBelow >= -2 && s.floorBelow <= 64)
if (r.spawns.length && !onFloor.length) problems.push(`no spawn of ${r.spawns.length} stands on a floor (${sp.map((s) => s.floorBelow).slice(0, 5)})`)
// Exterior goals stand ~55-60 u outside their window; a wrong-scale shell puts them 100s off.
if (r.windows && r.windows.median > 120) problems.push(`window goals median ${r.windows.median} u from a wall`)
const off = r.anchors.filter((a) => a.nodeOffset !== null && a.nodeOffset > 1)
if (off.length) problems.push(`${off.length} script_model anchors are off their map_ents origin`)
console.log(JSON.stringify({
  ok: !problems.length, problems, world: r.world, windows: r.windows,
  spawns_on_floor: `${onFloor.length}/${r.spawns.length}`,
  anchors_checked: r.anchors.filter((a) => a.nodeOffset !== null).length,
}))
