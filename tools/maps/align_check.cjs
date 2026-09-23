#!/usr/bin/env node
// The §8.12 alignment check (web/server/lib/mapAlign.js, the same code web/test/map-align.js
// runs) against ONE export, anywhere on disk -- export_all.py runs it on every staged map
// before anyone promotes it to the served dir.
//   node tools/maps/align_check.cjs <bsp.glb> <bsp.meta.json>
// Prints one JSON line: mapAlign.check()'s numbers plus {ok, problems[]}. Reads the served
// (meshopt / quantized) file as well as the float twin.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const align = require(path.join(__dirname, '..', '..', 'web', 'server', 'lib', 'mapAlign.js'))

const [glb, metaFile] = process.argv.slice(2)
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
;(async () => {
const r = await align.check(glb, meta, null)
const problems = []
if (!r.world) problems.push('no __world mesh')
else {
  const span = [0, 1, 2].map((i) => r.world.hi[i] - r.world.lo[i])
  // Coordinates are culled to +-65536 at export, so a span may reach 131072 (terrain).
  if (span.some((v) => !Number.isFinite(v)) || Math.max(...span) > 131072) problems.push(`extent ${span} is not engine units`)
}
const sp = r.spawns.filter((s) => s.floorBelow !== null || s.propBelow !== undefined)
// T4 origins are at the feet; script_struct spawns float up to ~60 u (Nacht's sit 16 u up).
const within = (v) => v !== null && v !== undefined && v >= -2 && v <= 64
const onShell = sp.filter((s) => within(s.floorBelow))
// ...or on a prop's top (a map floored with xmodels, mapAlign `propBelow`).
const onFloor = sp.filter((s) => within(s.floorBelow) || within(s.propBelow))
// Path nodes are set on the ground by the mapper; spawns (script_structs) may float. Either
// standing is evidence the shell is in the right place; neither is a problem.
const pn = r.pathnodes
const nodesStand = pn && pn.sampled >= 5 && pn.onFloor / pn.sampled >= 0.75
if (r.spawns.length && !onFloor.length && !nodesStand) problems.push(`no spawn of ${r.spawns.length} stands on a floor (${sp.map((s) => s.floorBelow).slice(0, 5)}) and path nodes ${pn ? pn.onFloor + '/' + pn.sampled : 'none'}`)
// Exterior goals stand ~55-60 u outside their window; a wrong-scale shell puts them 100s off.
if (r.windows && r.windows.median > 120) problems.push(`window goals median ${r.windows.median} u from a wall`)
// Box mode (quantized served bytes) is a sanity check against a gross misplacement: a model's
// origin can sit outside its own geometry (bcast's mod_cappy_attach 2.4 u; Der Riese's
// teleporter door, hinged 39 u off its panel). Allowed: its own size, at least 16 u.
const tol = (a) => (a.mode === 'box' ? Math.max(16, a.boxSize || 0) : 1)
const off = r.anchors.filter((a) => a.nodeOffset !== null && a.nodeOffset > tol(a))
if (off.length) problems.push(`${off.length} script_model anchors are off their map_ents origin`)
if (r.farNodes.length) problems.push(`${r.farNodes.length} nodes lie past +-65536 u (${r.farNodes.slice(0, 3).map((n) => n.name)})`)
console.log(JSON.stringify({
  ok: !problems.length, problems, world: r.world, windows: r.windows,
  spawns_on_floor: `${onFloor.length}/${r.spawns.length}`,
  spawns_on_shell: `${onShell.length}/${r.spawns.length}`,
  pathnodes_on_floor: pn ? `${pn.onFloor}/${pn.sampled}` : null,
  anchors_checked: r.anchors.filter((a) => a.nodeOffset !== null).length,
  anchors_on: r.anchors.filter((a) => a.nodeOffset !== null && a.nodeOffset <= tol(a)).length,
  anchor_mode: [...new Set(r.anchors.map((a) => a.mode))].join(','),
  far_nodes: r.farNodes.length,
}))
})().catch((e) => { console.log(JSON.stringify({ ok: false, problems: [`align_check: ${e.message}`] })); process.exitCode = 1 })
