import { useEffect, useRef } from 'react'
import { PLAYER_COLOURS } from '../pages/Live'

// The top-down view. A canvas, not SVG: at four frames a second with up to sixty-four
// moving dots, SVG means sixty-four DOM mutations a frame and React reconciling them, and
// a canvas means one clear and sixty-four fills.
//
// ── The problem this solves, and how ────────────────────────────────────────────────
// We have no map geometry. The site knows a map's NAME, not its bounds — the archive has
// the .bsp but nothing has parsed it, and the referee's `snap` carries world coordinates
// with no frame of reference. So the view AUTOSCALES to what it has seen: it keeps a
// running bounding box of every position ever reported this session, pads it, and fits
// that to the canvas.
//
// That has one honest consequence and it is worth knowing: **the view zooms out when
// somebody opens a new area, and it never zooms back in.** A player who runs to a far
// corner shrinks everything for the rest of the game. The alternative — rescaling to the
// current frame — makes the whole map lurch every time somebody moves, which is worse.
// When map bounds exist (the archive's extraction step, or the DLL reporting them at
// map_loaded), pass them in and this becomes a fixed frame.
//
// The other thing it will not do is pretend. Zombies are drawn only where the box sent
// them; a map whose DLL does not report zombie entities yet shows players on an empty
// field, and the caption says so rather than scattering decorative dots.

const PAD = 220           // world units of margin around the bounding box
const TRAIL_LEN = 40      // frames of history per player (~10 s at 4 Hz)

export default function TopDown({ frame, trails = true, height = 420 }) {
  const ref = useRef(null)
  const box = useRef(null)          // { minx, maxx, miny, maxy } — grows, never shrinks
  const history = useRef(new Map()) // slot -> [[x,y], …]
  const lastMatch = useRef(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv || !frame) return
    const s = frame.state

    // A different game is a different world. Reset, or the first frame of the next game
    // is drawn inside the last one's bounding box.
    if (lastMatch.current !== frame.match_id) {
      lastMatch.current = frame.match_id
      box.current = null
      history.current = new Map()
    }

    const pts = []
    for (const p of s.players) if (p.pos) pts.push(p.pos)
    for (const z of s.zombies) if (z.pos) pts.push(z.pos)
    if (!pts.length) { clear(cv); return }

    let b = box.current
    for (const [x, y] of pts) {
      if (!b) b = { minx: x, maxx: x, miny: y, maxy: y }
      else {
        if (x < b.minx) b.minx = x
        if (x > b.maxx) b.maxx = x
        if (y < b.miny) b.miny = y
        if (y > b.maxy) b.maxy = y
      }
    }
    box.current = b

    for (const p of s.players) {
      if (!p.pos) continue
      const h = history.current.get(p.slot) || []
      h.push([p.pos[0], p.pos[1]])
      while (h.length > TRAIL_LEN) h.shift()
      history.current.set(p.slot, h)
    }

    draw(cv, s, b, trails ? history.current : null)
  }, [frame, trails])

  return (
    <div className="card" style={{ padding: 8 }}>
      <canvas ref={ref} style={{ width: '100%', height, display: 'block', borderRadius: 8 }} />
      <div className="row wrap tiny" style={{ gap: 12, marginTop: 6, paddingLeft: 4 }}>
        {(frame ? frame.state.players : []).map((p) => (
          <span key={p.slot} className="row" style={{ gap: 5 }}>
            <i style={{ width: 9, height: 9, borderRadius: 2, background: PLAYER_COLOURS[p.slot % 4], display: 'inline-block' }} />
            {p.name}
          </span>
        ))}
        {frame && frame.state.zombies.length === 0 && (
          <span className="tiny">No zombie positions in this frame — the box is not reporting them for this map.</span>
        )}
      </div>
    </div>
  )
}

function clear(cv) {
  const { ctx } = fit(cv)
  ctx.clearRect(0, 0, cv.width, cv.height)
}

// Size the backing store to the element's real pixels so nothing is blurry on a scaled
// display, and hand back the projection into it.
function fit(cv) {
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth
  const h = cv.clientHeight
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
  }
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, w, h }
}

function draw(cv, s, b, history) {
  const { ctx, w, h } = fit(cv)
  const css = getComputedStyle(document.documentElement)
  const panel = css.getPropertyValue('--panel-2').trim() || '#22241a'
  const line = css.getPropertyValue('--line').trim() || 'rgba(228,223,209,.10)'
  const hot = css.getPropertyValue('--hot').trim() || '#b0342c'
  const muted = css.getPropertyValue('--faint').trim() || '#6e6b5d'

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = panel
  ctx.fillRect(0, 0, w, h)

  const minx = b.minx - PAD
  const maxx = b.maxx + PAD
  const miny = b.miny - PAD
  const maxy = b.maxy + PAD
  const scale = Math.min(w / Math.max(1, maxx - minx), h / Math.max(1, maxy - miny))
  const ox = (w - (maxx - minx) * scale) / 2
  const oy = (h - (maxy - miny) * scale) / 2
  // World +Y is north in Call of Duty; screen +Y is down. Flip it, or everybody runs the
  // wrong way and nobody can tell you why the map feels mirrored.
  const X = (x) => ox + (x - minx) * scale
  const Y = (y) => h - (oy + (y - miny) * scale)

  // A grid at 512 world units — one Call of Duty "block", so the spacing means something
  // rather than being decorative.
  ctx.strokeStyle = line
  ctx.lineWidth = 1
  ctx.beginPath()
  const step = 512
  for (let x = Math.ceil(minx / step) * step; x < maxx; x += step) { ctx.moveTo(X(x), 0); ctx.lineTo(X(x), h) }
  for (let y = Math.ceil(miny / step) * step; y < maxy; y += step) { ctx.moveTo(0, Y(y)); ctx.lineTo(w, Y(y)) }
  ctx.stroke()

  // Zombies first, so a player is never hidden under one.
  for (const z of s.zombies) {
    if (!z.pos) continue
    ctx.fillStyle = hot
    ctx.globalAlpha = 0.72
    ctx.beginPath()
    ctx.arc(X(z.pos[0]), Y(z.pos[1]), 3, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  if (history) {
    for (const [slot, pts] of history) {
      if (pts.length < 2) continue
      ctx.strokeStyle = PLAYER_COLOURS[slot % 4]
      ctx.globalAlpha = 0.28
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(X(pts[0][0]), Y(pts[0][1]))
      for (const [x, y] of pts.slice(1)) ctx.lineTo(X(x), Y(y))
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  for (const p of s.players) {
    if (!p.pos) continue
    const x = X(p.pos[0])
    const y = Y(p.pos[1])
    const colour = PLAYER_COLOURS[p.slot % 4]
    // Where they are looking. The yaw is the second angle and is degrees counterclockwise
    // from world +X, which is why this is not just cos/sin of a screen angle.
    if (p.ang && p.ang.length >= 2 && p.alive) {
      const yaw = (p.ang[1] * Math.PI) / 180
      ctx.strokeStyle = colour
      ctx.globalAlpha = 0.5
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + Math.cos(yaw) * 16, y - Math.sin(yaw) * 16)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = p.connected ? colour : muted
    ctx.beginPath()
    ctx.arc(x, y, 6, 0, Math.PI * 2)
    ctx.fill()
    // A downed player is a ring, not a dot: at this size a colour change is invisible and
    // "who is down" is the single most important thing on the view.
    if (p.down || !p.alive) {
      ctx.strokeStyle = hot
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(x, y, 10, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}
