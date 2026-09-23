// First-person hands and aim-down-sights, the pure half (lane RV, replay.md §14). No three.js, no
// DOM: the ADS fraction at a replay time, and the viewmodel pose between the gun's idle and ADS
// frames. fphands.js turns this into bones; web/test/replay-fp.js tests it.
//
// ADS, recorded two ways:
//   * replay_events >= 2: the DLL writes ps.fWeaponPosFrac (the engine's own 0..1 "how far into
//     the sights") on every snap; the track carries it per tick in tenths (`players[].ads`).
//   * every older file: the ADS BUTTON (usercmd bit 0x800, `presses.ads` = [[down, up|null]]),
//     eased with the weapon file's adsTransInTime / adsTransOutTime -- the rate the engine moves
//     fWeaponPosFrac at. It is intent, not state: the game refuses ADS while sprinting or
//     reloading, and this does not know that ([H], stated in §14).

export const DEFAULT_ADS_IN_MS = 300
export const DEFAULT_ADS_OUT_MS = 300

// Binary search: last index with arr[i][0] <= v, or -1.
function lastDownLE(edges, v) {
  let lo = 0
  let hi = edges.length - 1
  let out = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (edges[mid][0] <= v) { out = mid; lo = mid + 1 } else hi = mid - 1
  }
  return out
}

/**
 * The ADS fraction at `tMs` from the button's press/release edges, eased in and out at the
 * weapon's rates. Exact whatever the order the frames are asked in (scrub-safe): it starts from
 * the last edge far enough back that the fraction had fallen to 0 before it.
 */
export function adsFracFromPresses(edges, tMs, inMs = DEFAULT_ADS_IN_MS, outMs = DEFAULT_ADS_OUT_MS) {
  if (!edges || !edges.length) return 0
  const inR = Math.max(1, inMs)
  const outR = Math.max(1, outMs)
  let i = lastDownLE(edges, tMs)
  if (i < 0) return 0
  // Walk back while the previous press still overlaps what this one inherits.
  while (i > 0) {
    const up = edges[i - 1][1]
    if (up === null || up === undefined || edges[i][0] - up < outR) i--
    else break
  }
  let f = 0
  let t = null
  for (let k = i; k < edges.length; k++) {
    const d = edges[k][0]
    if (d > tMs) break
    if (t !== null) f = Math.max(0, f - (d - t) / outR)
    const u = edges[k][1]
    const end = u === null || u === undefined || u > tMs ? tMs : u
    f = Math.min(1, f + (end - d) / inR)
    t = end
    if (end === tMs) return f
  }
  return t === null ? 0 : Math.max(0, f - (tMs - t) / outR)
}

/** The recorded fraction (tenths per tick) at a fractional tick, or null when not recorded. */
export function adsFracFromColumn(col, kf) {
  if (!col || !col.length) return null
  const k = Math.max(0, Math.min(col.length - 1, kf))
  const a = Math.floor(k)
  const b = Math.min(col.length - 1, a + 1)
  const va = col[a]
  const vb = col[b]
  if (va === null || va === undefined) return null
  if (vb === null || vb === undefined) return va / 10
  return (va + (vb - va) * (k - a)) / 10
}

// -------------------------------------------------------------------- the pose --

function nlerpQ(a, b, t, out) {
  // Shortest arc; nlerp is indistinguishable from slerp at viewmodel angles and cheaper.
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const s = d < 0 ? -1 : 1
  let n = 0
  for (let i = 0; i < 4; i++) { out[i] = a[i] + (s * b[i] - a[i]) * t; n += out[i] * out[i] }
  n = Math.sqrt(n) || 1
  for (let i = 0; i < 4; i++) out[i] /= n
  return out
}

/**
 * One bone's local transform at ADS fraction `frac`: bind <- idle <- ads, each layer only where
 * it has a value (a bone the ADS anim does not move keeps the idle pose, as the engine's blend
 * does). `bind` is { q:[4], t:[3] }; idle/ads are [q|null, t|null] from fp_poses.json or undefined.
 * Writes into out = { q:[4], t:[3] }.
 */
export function blendBone(bind, idle, ads, frac, out) {
  const qi = (idle && idle[0]) || bind.q
  const ti = (idle && idle[1]) || bind.t
  const qa = (ads && ads[0]) || qi
  const ta = (ads && ads[1]) || ti
  if (frac <= 0) { for (let i = 0; i < 4; i++) out.q[i] = qi[i]; for (let i = 0; i < 3; i++) out.t[i] = ti[i]; return out }
  if (frac >= 1) { for (let i = 0; i < 4; i++) out.q[i] = qa[i]; for (let i = 0; i < 3; i++) out.t[i] = ta[i]; return out }
  nlerpQ(qi, qa, frac, out.q)
  for (let i = 0; i < 3; i++) out.t[i] = ti[i] + (ta[i] - ti[i]) * frac
  return out
}

/**
 * Where in the ADS anim a fraction is. The engine SCRUBS the weapon's adsUpAnim by the aim
 * fraction: frame 0 is the hip pose (tag_torso low and right), the last frame the sights. With
 * `n` frames (0..n-1) -> { a, b, t }: blend frame a to frame b by t. Writes into `out`.
 */
export function adsSeqSample(n, frac, out) {
  const o = out || {}
  if (!(n > 1)) { o.a = 0; o.b = 0; o.t = 0; return o }
  const f = Math.max(0, Math.min(1, frac || 0)) * (n - 1)
  o.a = Math.min(n - 2, Math.floor(f))
  o.b = o.a + 1
  o.t = f - o.a
  return o
}

/** The world FOV at ADS fraction `frac`: the game eases cg_fov to the weapon's adsZoomFov. */
export function adsFov(hipFov, zoomFov, frac) {
  if (!zoomFov || !(zoomFov > 0) || frac <= 0) return hipFov
  const f = Math.min(1, frac)
  return hipFov + (zoomFov - hipFov) * f
}
