// Numeric alignment checks for an exported map .glb against engine-unit anchors
// (replay.md §8.12). Written after a shell that was 2.54x too big passed every "does the
// player stand on the floor" test -- because the start-room floor is at z = 0 and 0 x 2.54
// is still 0. These checks use things that are NOT at the origin: spawn points, the map's
// own window goals, script_model placements, and the recording's first live tick.
//
// Pure Node, no three.js: the .glb is read directly (JSON chunk + BIN chunk), and only the
// `__world` mesh's triangles and the node translations are used.
'use strict'
const fs = require('node:fs')

function readGlb(file) {
  const d = fs.readFileSync(file)
  if (d.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb')
  const jl = d.readUInt32LE(12)
  const j = JSON.parse(d.subarray(20, 20 + jl).toString('utf8'))
  const binStart = 20 + jl + 8
  const bin = d.subarray(binStart)
  const acc = (i) => {
    const a = j.accessors[i]
    const bv = j.bufferViews[a.bufferView]
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0)
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type] * a.count
    const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[a.componentType]
    const buf = bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + n * T.BYTES_PER_ELEMENT)
    return new T(buf)
  }
  return { j, acc }
}

/** Every world triangle as a Float64Array of 9 numbers per triangle (engine units). */
function worldTriangles(glb) {
  const { j, acc } = glb
  const node = j.nodes.find((n) => n.name === '__world')
  if (!node) return null
  const out = []
  for (const pr of j.meshes[node.mesh].primitives) {
    const P = acc(pr.attributes.POSITION)
    const I = acc(pr.indices)
    for (let t = 0; t < I.length; t += 3) {
      for (let k = 0; k < 3; k++) { const v = I[t + k] * 3; out.push(P[v], P[v + 1], P[v + 2]) }
    }
  }
  return Float64Array.from(out)
}

function extents(T) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < T.length; i += 3) {
    for (let k = 0; k < 3; k++) { if (T[i + k] < lo[k]) lo[k] = T[i + k]; if (T[i + k] > hi[k]) hi[k] = T[i + k] }
  }
  return { lo, hi }
}

/** Highest upward-ish surface under (x, y) at or below z + up. null if none. */
function floorUnder(T, x, y, z, up = 18) {
  let best = null
  for (let i = 0; i < T.length; i += 9) {
    const ax = T[i], ay = T[i + 1], az = T[i + 2], bx = T[i + 3], by = T[i + 4], bz = T[i + 5], cx = T[i + 6], cy = T[i + 7], cz = T[i + 8]
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(d) < 1e-9) continue
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
    if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue
    const zz = u * az + v * bz + (1 - u - v) * cz
    if (zz <= z + up && (best === null || zz > best)) best = zz
  }
  return best
}

/** Horizontal distance from (x, y) to the nearest near-vertical triangle spanning [z0, z1]. */
function wallDistance(T, x, y, z0, z1) {
  let best = Infinity
  const seg = (px, py, qx, qy) => {
    const dx = qx - px, dy = qy - py
    const L = dx * dx + dy * dy
    let t = L > 0 ? ((x - px) * dx + (y - py) * dy) / L : 0
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(x - (px + dx * t), y - (py + dy * t))
  }
  for (let i = 0; i < T.length; i += 9) {
    const zmin = Math.min(T[i + 2], T[i + 5], T[i + 8]), zmax = Math.max(T[i + 2], T[i + 5], T[i + 8])
    if (zmax < z0 || zmin > z1) continue
    // normal z small = wall
    const ux = T[i + 3] - T[i], uy = T[i + 4] - T[i + 1], uz = T[i + 5] - T[i + 2]
    const vx = T[i + 6] - T[i], vy = T[i + 7] - T[i + 1], vz = T[i + 8] - T[i + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz)
    if (!nl || Math.abs(nz / nl) > 0.3) continue
    best = Math.min(best,
      seg(T[i], T[i + 1], T[i + 3], T[i + 4]), seg(T[i + 3], T[i + 4], T[i + 6], T[i + 7]), seg(T[i + 6], T[i + 7], T[i], T[i + 1]))
  }
  return best
}

/**
 * Run the §8.12 checks. `meta` is the export's sidecar (spawns, window_goals, anchors);
 * `firstTick` is [x, y, z] of a recording's first live player tick, or null.
 */
function check(glbFile, meta, firstTick) {
  const glb = readGlb(glbFile)
  const T = worldTriangles(glb)
  const out = { world: null, spawns: [], windows: null, anchors: [], firstTick: null }
  if (T) {
    const e = extents(T)
    out.world = { lo: e.lo.map(Math.round), hi: e.hi.map(Math.round), triangles: T.length / 9 }
  }
  for (const s of meta.spawns || []) {
    const f = T ? floorUnder(T, s[0], s[1], s[2]) : null
    out.spawns.push({ at: s, floorBelow: f === null ? null : +(s[2] - f).toFixed(1) })
  }
  if (T && meta.window_goals && meta.window_goals.length) {
    const ds = meta.window_goals.map((g) => wallDistance(T, g[0], g[1], g[2] + 10, g[2] + 40))
    ds.sort((a, b) => a - b)
    out.windows = { n: ds.length, median: +ds[ds.length >> 1].toFixed(1), max: +ds[ds.length - 1].toFixed(1) }
  }
  // Every script_model anchor must be a node at exactly its map_ents origin.
  const nodes = glb.j.nodes.filter((n) => n.translation)
  for (const a of meta.anchors || []) {
    let best = Infinity
    for (const n of nodes) {
      if (n.name !== a.model) continue
      const d = Math.hypot(n.translation[0] - a.origin[0], n.translation[1] - a.origin[1], n.translation[2] - a.origin[2])
      if (d < best) best = d
    }
    out.anchors.push({ model: a.model, origin: a.origin, nodeOffset: Number.isFinite(best) ? +best.toFixed(2) : null })
  }
  if (firstTick) {
    let best = Infinity, which = null
    for (const s of meta.spawns || []) {
      const d = Math.hypot(firstTick[0] - s[0], firstTick[1] - s[1], firstTick[2] - s[2])
      if (d < best) { best = d; which = s }
    }
    const f = T ? floorUnder(T, firstTick[0], firstTick[1], firstTick[2]) : null
    out.firstTick = { at: firstTick, nearestSpawn: which, distance: +best.toFixed(1), floorBelow: f === null ? null : +(firstTick[2] - f).toFixed(1) }
  }
  return out
}

module.exports = { readGlb, worldTriangles, extents, floorUnder, wallDistance, check }
