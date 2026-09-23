// Numeric alignment checks for an exported map .glb against engine-unit anchors
// (replay.md §8.12). Written after a shell that was 2.54x too big passed every "does the
// player stand on the floor" test -- because the start-room floor is at z = 0 and 0 x 2.54
// is still 0. These checks use things that are NOT at the origin: spawn points, the map's
// own window goals, script_model placements, and the recording's first live tick.
//
// Pure Node, no three.js: the .glb is read directly (JSON chunk + BIN chunk), and only the
// `__world` mesh's triangles and the node translations are used.
//
// It reads the SERVED file too (2026-09-23, lane GEO; replay.md §10 had to revert a 7 MB Nacht
// because this crashed on it): EXT_meshopt_compression buffer views are decoded with
// meshoptimizer's decoder (load() finds one -- see meshoptDecoder()), KHR_mesh_quantization
// int8/int16/uint8/uint16 attributes are read with their `normalized` flag, and the `__world`
// node's own transform (the one gltf-transform's quantize() writes to undo a 16-bit grid) is
// applied, so the triangles come back in engine units either way.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const COMP = {
  5126: [Float32Array, 'getFloat32', 1], 5125: [Uint32Array, 'getUint32', 4294967295],
  5123: [Uint16Array, 'getUint16', 65535], 5122: [Int16Array, 'getInt16', 32767],
  5121: [Uint8Array, 'getUint8', 255], 5120: [Int8Array, 'getInt8', 127],
}

/**
 * Parse a .glb. `views` (optional) maps bufferView index -> decoded bytes (Uint8Array) for
 * meshopt-compressed views, from load(); a compressed view without one throws.
 */
function readGlb(file, views) {
  const d = Buffer.isBuffer(file) ? file : fs.readFileSync(file)
  if (d.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb')
  const jl = d.readUInt32LE(12)
  const j = JSON.parse(d.subarray(20, 20 + jl).toString('utf8'))
  const binStart = 20 + jl + 8
  const bin = d.subarray(binStart)
  const viewBytes = (vi) => {
    const bv = j.bufferViews[vi]
    const mo = bv.extensions && bv.extensions.EXT_meshopt_compression
    if (mo) {
      if (!views || !views[vi]) throw new Error('meshopt-compressed glb: read it with mapAlign.load()')
      return { bytes: views[vi], base: 0, stride: mo.byteStride }
    }
    return { bytes: bin, base: bv.byteOffset || 0, stride: bv.byteStride }
  }
  // Floats out, always: a quantized accessor is dequantized (`normalized` -> [-1, 1] / [0, 1]).
  const acc = (i) => {
    const a = j.accessors[i]
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]
    const [T, get, max] = COMP[a.componentType]
    const item = comps * T.BYTES_PER_ELEMENT
    const { bytes, base, stride } = viewBytes(a.bufferView)
    const off = base + (a.byteOffset || 0)
    // export_all.py's optimiser (gltf-transform) INTERLEAVES vertex attributes: POSITION is
    // every `byteStride` bytes, not packed.
    const step = stride || item
    const dv = new DataView(bytes.buffer, bytes.byteOffset)
    const isIndex = a.componentType !== 5126 && !a.normalized
    const out = isIndex && comps === 1 ? new Uint32Array(a.count) : new Float64Array(comps * a.count)
    for (let e = 0; e < a.count; e++) {
      for (let c = 0; c < comps; c++) {
        let v = dv[get](off + e * step + c * T.BYTES_PER_ELEMENT, true)
        if (a.normalized) v = Math.max(v / max, -1)
        out[e * comps + c] = v
      }
    }
    return out
  }
  return { j, acc }
}

let decoderPromise = null
/** meshoptimizer's decoder: the `meshoptimizer` package if installed, else the copy inside
 *  three (web/client, which the viewer itself uses), else the r3dnode prefix optimize_glb.cjs
 *  uses. null when none is on this machine. */
function meshoptDecoder() {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      const { pathToFileURL } = require('node:url')
      const cands = [
        () => require('meshoptimizer/meshopt_decoder.cjs'),
        () => require(path.join(process.env.R3D_NODE_PREFIX || 'C:/Users/b/tools/r3dnode', 'node_modules', 'meshoptimizer', 'meshopt_decoder.cjs')),
        () => import(pathToFileURL(path.join(__dirname, '..', '..', 'client', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'meshopt_decoder.module.js')).href),
      ]
      for (const c of cands) {
        try {
          const m = await c()
          const dec = m.MeshoptDecoder || (m.default && m.default.MeshoptDecoder) || m.default || m
          if (dec && dec.decodeGltfBuffer) { await dec.ready; return dec }
        } catch { /* next */ }
      }
      return null
    })()
  }
  return decoderPromise
}

/** readGlb(), with any EXT_meshopt_compression views decoded first. */
async function load(file) {
  const d = fs.readFileSync(file)
  const glb = readGlb(d, {})
  const { j } = glb
  const packed = (j.bufferViews || []).map((bv, i) => [i, bv.extensions && bv.extensions.EXT_meshopt_compression]).filter((x) => x[1])
  if (!packed.length) return glb
  const dec = await meshoptDecoder()
  if (!dec) {
    const e = new Error('meshopt-compressed glb and no meshopt decoder on this machine')
    e.code = 'NO_MESHOPT'
    throw e
  }
  const jl = d.readUInt32LE(12)
  const bin = d.subarray(20 + jl + 8)
  const views = {}
  for (const [i, mo] of packed) {
    const sb = j.buffers[mo.buffer || 0] || {}
    if ((mo.buffer || 0) !== 0 || sb.uri) throw new Error('meshopt source is not the GLB binary chunk')
    const src = new Uint8Array(bin.buffer, bin.byteOffset + (mo.byteOffset || 0), mo.byteLength)
    const out = new Uint8Array(mo.count * mo.byteStride)
    dec.decodeGltfBuffer(out, mo.count, mo.byteStride, src, mo.mode, mo.filter || 'NONE')
    views[i] = out
  }
  return readGlb(d, views)
}

/** A node's local matrix (column-major 4x4), from `matrix` or T*R*S. */
function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice()
  const [tx, ty, tz] = n.translation || [0, 0, 0]
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1]
  const [sx, sy, sz] = n.scale || [1, 1, 1]
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]
}

function mul(a, b) {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}

/** World matrix of node index `ni` (parents applied). */
function worldMatrix(j, ni) {
  const parent = new Map()
  j.nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)))
  let m = nodeMatrix(j.nodes[ni])
  for (let p = parent.get(ni); p !== undefined; p = parent.get(p)) m = mul(nodeMatrix(j.nodes[p]), m)
  return m
}

const isIdentity = (m) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12)

/** Every world triangle as a Float64Array of 9 numbers per triangle (engine units). */
function worldTriangles(glb) {
  const { j, acc } = glb
  const ni = j.nodes.findIndex((n) => n.name === '__world')
  if (ni < 0) return null
  const node = j.nodes[ni]
  const M = worldMatrix(j, ni)
  const ident = isIdentity(M)
  const out = []
  for (const pr of j.meshes[node.mesh].primitives) {
    const P = acc(pr.attributes.POSITION)
    const I = acc(pr.indices)
    for (let t = 0; t < I.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const v = I[t + k] * 3
        const x = P[v], y = P[v + 1], z = P[v + 2]
        if (ident) out.push(x, y, z)
        else out.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14])
      }
    }
  }
  return Float64Array.from(out)
}

/** Node `ni`'s mesh as world-space triangles (9 numbers each). Cached on the glb. */
function nodeTriangles(glb, ni) {
  if (!glb.triCache) glb.triCache = new Map()
  if (!glb.triCache.has(ni)) glb.triCache.set(ni, nodeTrianglesRaw(glb, ni))
  return glb.triCache.get(ni)
}

function nodeTrianglesRaw(glb, ni) {
  const { j, acc } = glb
  const M = worldMatrix(j, ni)
  const out = []
  for (const pr of j.meshes[j.nodes[ni].mesh].primitives) {
    const P = acc(pr.attributes.POSITION)
    const I = pr.indices !== undefined ? acc(pr.indices) : Uint32Array.from({ length: P.length / 3 }, (_, k) => k)
    for (let t = 0; t < I.length; t++) {
      const v = I[t] * 3, x = P[v], y = P[v + 1], z = P[v + 2]
      out.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14])
    }
  }
  return Float64Array.from(out)
}

/** Is any POSITION of this mesh stored quantized (integer), i.e. did quantize() fold a
 *  dequantization into the node transform? Then the node's translation is no longer the
 *  model's origin, and anchors are checked against the node's world box instead. */
function meshQuantized(j, mi) {
  return j.meshes[mi].primitives.some((p) => j.accessors[p.attributes.POSITION].componentType !== 5126)
}

/** World-space box of node `ni`'s mesh. */
function nodeBox(glb, ni) {
  const { j, acc } = glb
  const M = worldMatrix(j, ni)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const pr of j.meshes[j.nodes[ni].mesh].primitives) {
    const a = j.accessors[pr.attributes.POSITION]
    let mn = a.min, mx = a.max
    if (!mn || !mx) {
      const P = acc(pr.attributes.POSITION)
      mn = [Infinity, Infinity, Infinity]; mx = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]) }
    } else if (a.normalized) {
      const max = COMP[a.componentType][2]
      mn = mn.map((v) => Math.max(v / max, -1)); mx = mx.map((v) => Math.max(v / max, -1))
    }
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? mx[0] : mn[0], y = c & 2 ? mx[1] : mn[1], z = c & 4 ? mx[2] : mn[2]
      const w = [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]]
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]) }
    }
  }
  return { lo, hi }
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
async function check(glbFile, meta, firstTick) {
  const glb = typeof glbFile === 'string' || Buffer.isBuffer(glbFile) ? await load(glbFile) : glbFile
  const T = worldTriangles(glb)
  const out = { world: null, spawns: [], windows: null, anchors: [], firstTick: null }
  if (T) {
    const e = extents(T)
    out.world = { lo: e.lo.map(Math.round), hi: e.hi.map(Math.round), triangles: T.length / 9 }
  }
  // Some custom maps floor their play space with xmodels (bridge_zombie spawns on the deck of
  // `vehicle_usa_ship_lst`, over water), so a spawn with no shell floor under it is also
  // tested against the triangles of every prop whose world box is under it: `propBelow`.
  let boxes = null
  for (const s of meta.spawns || []) {
    const f = T ? floorUnder(T, s[0], s[1], s[2]) : null
    const row = { at: s, floorBelow: f === null ? null : +(s[2] - f).toFixed(1) }
    if (row.floorBelow === null || row.floorBelow < -2 || row.floorBelow > 64) {
      if (!boxes) {
        boxes = []
        glb.j.nodes.forEach((n, i) => { if (n.mesh !== undefined && !String(n.name || '').startsWith('__')) boxes.push([i, nodeBox(glb, i)]) })
      }
      let top = null
      for (const [i, b] of boxes) {
        if (s[0] < b.lo[0] || s[0] > b.hi[0] || s[1] < b.lo[1] || s[1] > b.hi[1] || b.lo[2] > s[2] + 18) continue
        const P = nodeTriangles(glb, i)
        const z = floorUnder(P, s[0], s[1], s[2])
        if (z !== null && (top === null || z > top)) top = z
      }
      if (top !== null) row.propBelow = +(s[2] - top).toFixed(1)
    }
    out.spawns.push(row)
  }
  if (T && meta.window_goals && meta.window_goals.length) {
    // A window whose wall is a prop (bridge_zombie's ship hull) is measured against the props
    // within 300 u of it as well, and counted in `viaProps`.
    let viaProps = 0
    const ds = meta.window_goals.map((g) => {
      const d = wallDistance(T, g[0], g[1], g[2] + 10, g[2] + 40)
      if (d <= 70) return d
      if (!boxes) {
        boxes = []
        glb.j.nodes.forEach((n, i) => { if (n.mesh !== undefined && !String(n.name || '').startsWith('__')) boxes.push([i, nodeBox(glb, i)]) })
      }
      let best = d
      for (const [i, b] of boxes) {
        if (g[0] < b.lo[0] - 300 || g[0] > b.hi[0] + 300 || g[1] < b.lo[1] - 300 || g[1] > b.hi[1] + 300) continue
        if (b.hi[2] < g[2] + 10 || b.lo[2] > g[2] + 40) continue
        best = Math.min(best, wallDistance(nodeTriangles(glb, i), g[0], g[1], g[2] + 10, g[2] + 40))
      }
      if (best < d) viaProps++
      return best
    })
    ds.sort((a, b) => a - b)
    out.windows = { n: ds.length, median: +ds[ds.length >> 1].toFixed(1), max: +ds[ds.length - 1].toFixed(1), viaProps }
  }
  // The map's own AI path nodes, which a mapper sets on the ground (Nacht: 28 u over the
  // floor, v2beta 11-21 u). Spawn points are script_structs and can float -- dcv2's sit 85-130
  // u up while 58 of 59 sampled path nodes stand on the shell -- so a spawn that floats is not
  // a misplaced shell when the path nodes stand. Sampled (at most 60), shell first, then props.
  const nodes = meta.pathnodes || []
  if (nodes.length) {
    const step = Math.ceil(nodes.length / 60)
    let n = 0, on = 0, onProps = 0
    for (let k = 0; k < nodes.length; k += step) {
      const p = nodes[k]
      n++
      const f = T ? floorUnder(T, p[0], p[1], p[2]) : null
      if (f !== null && p[2] - f >= -2 && p[2] - f <= 48) { on++; continue }
      if (!boxes) {
        boxes = []
        glb.j.nodes.forEach((nd, i) => { if (nd.mesh !== undefined && !String(nd.name || '').startsWith('__')) boxes.push([i, nodeBox(glb, i)]) })
      }
      let top = null
      for (const [i, b] of boxes) {
        if (p[0] < b.lo[0] || p[0] > b.hi[0] || p[1] < b.lo[1] || p[1] > b.hi[1] || b.lo[2] > p[2] + 18) continue
        const z = floorUnder(nodeTriangles(glb, i), p[0], p[1], p[2])
        if (z !== null && (top === null || z > top)) top = z
      }
      if (top !== null && p[2] - top >= -2 && p[2] - top <= 48) { on++; onProps++ }
    }
    out.pathnodes = { sampled: n, onFloor: on, onProps }
  }
  // Every script_model anchor must be a node at exactly its map_ents origin. In a served
  // (meshopt) file whose prop positions are quantized, the node translation carries the
  // dequantization, so there the anchor must lie inside (or within 1 u of) the node's world
  // box instead -- `mode: 'box'`, a weaker check the float twin makes exact.
  const cand = glb.j.nodes.map((n, i) => [n, i]).filter(([n]) => n.mesh !== undefined && (n.translation || n.matrix))
  for (const a of meta.anchors || []) {
    let best = Infinity, mode = 'origin', size = null
    for (const [n, i] of cand) {
      if (n.name !== a.model) continue
      let d
      if (meshQuantized(glb.j, n.mesh) || n.matrix) {
        const b = nodeBox(glb, i)
        d = Math.hypot(...[0, 1, 2].map((k) => Math.max(b.lo[k] - a.origin[k], 0, a.origin[k] - b.hi[k])))
        mode = 'box'
        if (d < best) size = Math.max(...[0, 1, 2].map((k) => b.hi[k] - b.lo[k]))
      } else {
        d = Math.hypot(n.translation[0] - a.origin[0], n.translation[1] - a.origin[1], n.translation[2] - a.origin[2])
      }
      if (d < best) best = d
    }
    const row = { model: a.model, origin: a.origin, mode, nodeOffset: Number.isFinite(best) ? +best.toFixed(2) : null }
    if (size !== null) row.boxSize = +size.toFixed(1)
    out.anchors.push(row)
  }
  // Nothing may be PLACED past the engine's +-65536 (nazi_zombie_pd shipped a prop 200 490 u
  // out, which frames the camera on a void). A backdrop centred inside that merely overhangs
  // it (zm_nuked's desert mountain; projectx's jeepride terrain, centred 78 000 u out) is
  // scenery and is allowed: the limit on a box CENTRE is twice the world's, 131072.
  // The sky rides the camera and is exempt.
  out.farNodes = []
  glb.j.nodes.forEach((n, i) => {
    if (n.mesh === undefined || n.name === '__sky') return
    const b = nodeBox(glb, i)
    const c = [0, 1, 2].map((k) => (b.lo[k] + b.hi[k]) / 2)
    if ([...b.lo, ...b.hi].some((v) => !Number.isFinite(v)) || c.some((v) => Math.abs(v) > 131072)) out.farNodes.push({ name: n.name, lo: b.lo.map(Math.round), hi: b.hi.map(Math.round) })
  })
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

module.exports = { readGlb, load, meshoptDecoder, nodeBox, worldTriangles, extents, floorUnder, wallDistance, check }
