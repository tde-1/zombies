'use strict'
// Map alignment against engine-unit truth (replay.md §8.12).
//
//   node test/map-align.js [<maps dir>]
//
// Checks the exported .glb for every map that has one on THIS machine (it is game-derived
// and never in git, so on a machine without an export this prints "skipped" and passes).
// It is part of `npm test` because a shell exported in the wrong unit passed every earlier
// check: the start-room floor is at z = 0, where a 2.54x scale changes nothing.
const fs = require('node:fs')
const path = require('node:path')
const align = require('../server/lib/mapAlign')

const MAPS = process.argv[2] || process.env.ZM_MAPS_DIR
  || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'maps')
const REPLAYS = path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'replays')

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ', name, detail || '') } else { fail++; console.log('FAIL', name, detail || '') }
}

// Known first live ticks (engine units) of real replays, for the maps they were played on.
// Read from the .enwr when the file is on this machine; otherwise the recorded value.
const FIRST_TICK = { nazi_zombie_prototype: { match: 'm_0afb449b', pos: [0, 424, 18] } }

// The reader itself, on a synthetic glb, so it runs on every machine. export_all.py's optimiser
// (gltf-transform) INTERLEAVES vertex attributes: POSITION and NORMAL share one bufferView with
// byteStride 24. A reader that ignored byteStride read normal bytes as positions and reported
// a world 1e34 units across (2026-09-23 04:13, the Nacht staging export) -- the file was fine.
function syntheticGlb(interleaved) {
  const tri = [[0, 0, 0], [100, 0, 0], [0, 200, 50]]
  const nrm = [[0, 0, 1], [0, 0, 1], [0, 0, 1]]
  const vb = Buffer.alloc(interleaved ? 3 * 24 : 3 * 12 * 2)
  tri.forEach((p, i) => p.forEach((v, k) => vb.writeFloatLE(v, interleaved ? i * 24 + k * 4 : i * 12 + k * 4)))
  nrm.forEach((p, i) => p.forEach((v, k) => vb.writeFloatLE(v, interleaved ? i * 24 + 12 + k * 4 : 36 + i * 12 + k * 4)))
  const ib = Buffer.alloc(8)
  ;[0, 1, 2].forEach((v, i) => ib.writeUInt16LE(v, i * 2))
  const bin = Buffer.concat([vb, ib])
  const j = {
    asset: { version: '2.0' },
    nodes: [{ name: '__world', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    bufferViews: interleaved
      ? [{ buffer: 0, byteOffset: 0, byteLength: 72, byteStride: 24 }, { buffer: 0, byteOffset: 72, byteLength: 6 }]
      : [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }, { buffer: 0, byteOffset: 72, byteLength: 6 }],
    accessors: interleaved
      ? [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
         { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC3' },
         { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }]
      : [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
         { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
         { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }],
    buffers: [{ byteLength: bin.length }],
  }
  let js = Buffer.from(JSON.stringify(j))
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)])
  const binp = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)])
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + binp.length, 8)
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.writeUInt32LE(0x4e4f534a, 4)
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(binp.length, 0); c2.writeUInt32LE(0x004e4942, 4)
  const f = path.join(require('node:os').tmpdir(), `zm-align-${interleaved ? 'i' : 'p'}-${process.pid}.glb`)
  fs.writeFileSync(f, Buffer.concat([head, c1, js, c2, binp]))
  return f
}
for (const inter of [false, true]) {
  const f = syntheticGlb(inter)
  const T = Array.from(align.worldTriangles(align.readGlb(f)))
  fs.unlinkSync(f)
  ok(`reader: ${inter ? 'interleaved (byteStride 24)' : 'packed'} POSITION reads back exactly`,
    JSON.stringify(T) === JSON.stringify([0, 0, 0, 100, 0, 0, 0, 200, 50]), JSON.stringify(T))
}

;(async () => {
  const bsp = 'nazi_zombie_prototype'
  const glb = path.join(MAPS, bsp, `${bsp}.glb`)
  const metaFile = path.join(MAPS, bsp, `${bsp}.meta.json`)
  if (!fs.existsSync(glb) || !fs.existsSync(metaFile)) {
    console.log(`skipped: no ${bsp} export under ${MAPS}`)
    console.log('\n0 passed, 0 failed')
    return
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  if (!meta.spawns) {
    console.log(`skipped: ${bsp} was exported before the §8.12 anchors existed (re-export it)`)
    console.log('\n0 passed, 0 failed')
    return
  }
  let first = FIRST_TICK[bsp].pos
  try {
    const lib = await import(require('node:url').pathToFileURL(path.join(__dirname, '..', '..', 'infra', 'host-agent', 'lib', 'replay.js')).href)
    const f = path.join(REPLAYS, `${FIRST_TICK[bsp].match}.enwr`)
    if (fs.existsSync(f)) {
      let alive = false
      for (const e of lib.readEvents(f)) {
        if (e.t !== 'snap') continue
        const p = (e.players || [])[0]
        if (!p) continue
        if (p.alive !== undefined) alive = p.alive
        if (alive && p.pos && (p.pos[0] || p.pos[1])) { first = p.pos; break }
      }
    }
  } catch { /* the recorded value above */ }

  const r = align.check(glb, meta, first)
  console.log(JSON.stringify(r.world), 'windows', JSON.stringify(r.windows))
  const span = [r.world.hi[0] - r.world.lo[0], r.world.hi[1] - r.world.lo[1]]
  // Nacht with its terrain and sky is ~12 000 u across at the true scale; 2.54x is ~31 000.
  ok('world extent is in engine units, not centimetres', span[0] < 20000 && span[1] < 20000, `span ${span.map(Math.round)}`)
  for (const s of r.spawns) ok(`spawn ${s.at} stands on a floor`, s.floorBelow !== null && s.floorBelow >= -2 && s.floorBelow <= 60, `origin - floor = ${s.floorBelow}`)
  ok('window goals sit at the walls (exterior goals are ~55-60 u outside the window)', r.windows.median < 70 && r.windows.max < 90, JSON.stringify(r.windows))
  const truck = r.anchors.filter((a) => /opel_blitz/.test(a.model))
  ok('the trucks are at their map_ents origins', truck.length > 0 && truck.every((a) => a.nodeOffset !== null && a.nodeOffset < 0.5), JSON.stringify(truck.map((a) => a.nodeOffset)))
  ok('the first live player tick is within 20 u of a spawn', r.firstTick.distance <= 20, JSON.stringify(r.firstTick))
  ok('and stands on the floor there', r.firstTick.floorBelow !== null && Math.abs(r.firstTick.floorBelow) < 20, `origin - floor = ${r.firstTick.floorBelow}`)
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
})()
