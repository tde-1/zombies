// The zombies 3D replay viewer.
//
// This is ENW Movement's ReplayViewer.jsx rewritten around a zombies track. What was
// copied and what was not is written up in docs/kickstart/replay.md §2; the short
// version is that the *renderer* (scene.js, skywall.js) and the *asset fetcher*
// (assets.js) are Movement's files unchanged, the chrome is Movement's markup and
// Movement's CSS class-for-class (r3d.css), and this file is new because Movement's
// original is 1554 lines of which about 1100 are KZ jumpstats, a CS:GO viewmodel, a
// crosshair parser and footstep audio -- none of which a zombies game has.
//
// WHAT IS THE SAME, ON PURPOSE:
//   * the playback sampler: floor the tick, lerp to the next, shortest-arc on angles,
//     and NO interpolation across a discontinuity;
//   * the render loop is change-driven, not free-running -- it returns immediately
//     when paused, clean and not in free-cam, and bails while the tab is hidden;
//   * camera modes 'eyes' | 'follow' | 'free' on keys 1/2/3, drag to look, wheel to
//     zoom the orbit, WASD in free cam;
//   * the control bar: play/pause, -5s/+5s, a native range scrubber, the clock, the
//     speed cog, fullscreen.
//
// WHAT IS NEW:
//   * four players instead of one (actors.js), each a coloured capsule with a
//     nameplate, and any of them selectable as the first-person eye;
//   * zombies as one instanced capsule mesh;
//   * the scoreboard (points, health), the round counter, the body count, the event
//     feed, and round markers on the scrubber.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createScene, isWebGL2Available } from './scene.js'
import { createActors, installSkyDome, createPlaceholderGun, SLOT_COLORS } from './actors.js'
import { fetchAsset, fetchJson } from './assets.js'
import Boot from './Boot.jsx'
import './r3d.css'

const CAMS = [['eyes', 'First person'], ['follow', 'Third person'], ['free', 'Free cam']]
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8]
// A zombies game is 40 minutes, not 40 seconds. Movement's +-5 s is a KZ run's
// granularity; here the same two buttons move a round's worth of time.
const SKIP_S = 15

const clock = (s) => {
  if (!Number.isFinite(s)) return '0:00'
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const ss = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// The first-person crosshair (replay.md §8.7). WaW's hip crosshair is four ticks round a
// gap that opens with movement and with each shot and closes again; these are per-class
// numbers in screen pixels, eyeballed against the game, not read out of the weapon files.
// The weapon is `#<index>` until the DLL resolves names (§3 gap 5), so every weapon is a
// rifle today and the table is the seam for the day it is not.
const XH_CLASS = {
  pistol: { base: 10, move: 16, shot: 7, max: 46, recover: 60 },
  rifle: { base: 14, move: 24, shot: 9, max: 60, recover: 45 },
  smg: { base: 12, move: 18, shot: 5, max: 50, recover: 70 },
  mg: { base: 20, move: 30, shot: 4, max: 70, recover: 35 },
  shotgun: { base: 26, move: 20, shot: 12, max: 70, recover: 40 },
}
const xhClass = (weapon) => {
  const w = String(weapon || '')
  if (/colt|walther|nambu|tokarev|357|m1911|pistol/i.test(w)) return XH_CLASS.pistol
  if (/thompson|mp40|ppsh|type100|mp44|stg/i.test(w)) return XH_CLASS.smg
  if (/30cal|mg42|dp28|fg42|bar|type99/i.test(w)) return XH_CLASS.mg
  if (/shotgun|trench|doublebarrel/i.test(w)) return XH_CLASS.shotgun
  return XH_CLASS.rifle
}
const WAW_RUN = 190   // units a second; the engine's sprint is a little over this

const lerpAngle = (a, b, f) => {
  let d = ((b - a + 540) % 360) - 180
  return a + d * f
}

function IconPlay() { return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg> }
function IconPause() { return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg> }
function IconBack() { return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V2L7 7l5 5V9a5 5 0 1 1-5 5H5a7 7 0 1 0 7-9z" /></svg> }
function IconFwd() { return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V2l5 5-5 5V9a5 5 0 1 0 5 5h2a7 7 0 1 1-7-9z" /></svg> }
function IconCog() { return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4c0-.6-.05-1.2-.15-1.75l2.05-1.6-2-3.46-2.4 1a7.9 7.9 0 0 0-3-1.75L15.1 1.5h-4l-.4 2.94a7.9 7.9 0 0 0-3 1.75l-2.4-1-2 3.46 2.05 1.6a8.3 8.3 0 0 0 0 3.5L3.3 15.35l2 3.46 2.4-1a7.9 7.9 0 0 0 3 1.75l.4 2.94h4l.4-2.94a7.9 7.9 0 0 0 3-1.75l2.4 1 2-3.46-2.05-1.6c.1-.55.15-1.15.15-1.75z" /></svg> }
function IconFull() { return <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zM4 15h2v3h3v2H4zm14 3v-3h2v5h-5v-2z" /></svg> }

/**
 * @param track  the decoded track from GET /api/replay/<match>/track
 * @param mapUrl the map .glb
 * @param metaUrl the map .meta.json (sun, spawn, the honest note about the shell)
 */
export default function ReplayViewer({ track, mapUrl, metaUrl, title, onClose }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const sceneRef = useRef(null)
  const actorsRef = useRef(null)
  const skyRef = useRef(null)

  const [boot, setBoot] = useState('on')
  const [progress, setProgress] = useState(null)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)
  const [camMode, setCamMode] = useState('follow')
  const [focus, setFocus] = useState(track?.players?.[0]?.slot ?? 0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [speedOpen, setSpeedOpen] = useState(false)
  // `hud` is the only state the frame loop is allowed to set, and it is set at most
  // ~15 times a second. Every other per-frame value lives in a ref: a setState per
  // frame is a React render per frame, and the viewer's whole frame budget is the
  // scene's.
  const [hud, setHud] = useState({ t: 0, round: 0, alive: 0, left: null, kills: null, players: [] })

  const timeRef = useRef(0)
  const playingRef = useRef(false)
  const speedRef = useRef(1)
  const focusRef = useRef(focus)
  const dirtyRef = useRef(true)
  const camRef = useRef('follow')
  const xhRef = useRef(null)
  const gunRef = useRef(null)
  const bloomRef = useRef(0)

  // THE TIMELINE'S ZERO IS THE FIRST SNAPSHOT, NOT THE FIRST EVENT.
  //
  // A replay starts recording when the game process starts, and a real dedicated server
  // spends minutes booting, loading the map and waiting for a player before there is a
  // single snapshot to record. Game 2's first snap is at ms 311_355 -- five and a quarter
  // minutes of `hello`, `log` and `map_loaded` before tick 0. Tick k is therefore at
  // `t0_ms + k * tick_ms`, and an event's tick is `(e.ms - t0_ms) / tick_ms`.
  //
  // Without that subtraction every event lands 3_113 ticks past the end of an 880-tick
  // track: the round counter stays on "—" for a game that reached round 1, the feed is
  // empty for its whole length, and the round marks sit off the right-hand end of the
  // scrubber. It never showed up before because every replay this was built against came
  // from the simulator, whose first snap is at ms 0 -- so `t0_ms` was 0 and the bug was
  // exactly zero ticks wide. Found 2026-09-23 against the first real game.
  const t0 = track ? (track.t0_ms || 0) : 0
  // The END is game over (or the intermission), not the last byte (replay.md §8.5). The
  // sampler kept writing through the intermission on m_0afb449b and the camera then
  // "flew" with the intermission path; Movement's scrubber ends where the run does.
  const endMs = track ? (track.end_ms && track.end_ms > t0 ? Math.min(track.end_ms, track.duration_ms) : track.duration_ms) : 0
  const total = track ? Math.max(0, (endMs - t0) / 1000) : 0
  // The START is the first tick anybody is alive: on a real game tick 0 is a dead player
  // at [0,0,0] for the seven seconds before the spawn.
  const firstLive = useMemo(() => {
    if (!track) return 0
    let k = Infinity
    for (const p of track.players) { const a = p.alive.indexOf(1); if (a >= 0 && a < k) k = a }
    return Number.isFinite(k) ? k : 0
  }, [track])
  const tickMs = track ? track.tick_ms : 50

  useEffect(() => { timeRef.current = (firstLive * (track ? track.tick_ms : 50)) / 1000; dirtyRef.current = true }, [track, firstLive])
  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { focusRef.current = focus; dirtyRef.current = true }, [focus])
  useEffect(() => { camRef.current = camMode; dirtyRef.current = true }, [camMode])

  // Index the event feed by tick once, so the per-frame lookup is a slice and not a
  // scan of 1500 events.
  const feedByTick = useMemo(() => {
    const out = new Map()
    if (!track) return out
    for (const e of track.events) {
      if (e.t === 'round' || e.t === 'auth_decision' || e.t === 'player_connect') continue
      const k = Math.floor((e.ms - t0) / tickMs)
      if (!out.has(k)) out.set(k, [])
      out.get(k).push(e)
    }
    return out
  }, [track, tickMs, t0])

  const roundAt = useMemo(() => {
    // A flat array of round number per tick. `round` is an event, never a snap field
    // (replay.cpp emits no round), so it has to be carried forward.
    if (!track) return new Int16Array(0)
    const a = new Int16Array(track.ticks)
    let r = 0
    let i = 0
    for (let k = 0; k < track.ticks; k++) {
      while (i < track.rounds.length && track.rounds[i].ms - t0 <= k * tickMs) { r = track.rounds[i].n; i++ }
      a[k] = r
    }
    return a
  }, [track, tickMs, t0])

  // ---- scene ------------------------------------------------------------------
  useEffect(() => {
    if (!track) return
    let dead = false
    if (!isWebGL2Available()) { setErr('This browser has no WebGL 2.'); setBoot('off'); return }

    // The canvas is created here rather than rendered by React, and it has to be.
    // StrictMode runs this effect twice in development: mount, clean up, mount again.
    // The cleanup calls renderer.dispose(), which loses the WebGL context on that
    // canvas element FOR GOOD -- a second createScene over the same element gets a
    // dead context and throws on `capabilities.precision`. Owning the element means
    // the second mount gets a second canvas, which is also what a real remount wants.
    const canvas = document.createElement('canvas')
    canvas.className = 'r3d-canvas'
    wrapRef.current.insertBefore(canvas, wrapRef.current.firstChild)
    canvasRef.current = canvas

    const api = createScene(canvas, {})
    sceneRef.current = api
    const actors = createActors(api)
    actorsRef.current = actors
    const gun = createPlaceholderGun()
    gunRef.current = gun
    api.setViewmodel(gun.object)
    api.resize()

    // The floor to stand a gridded, model-less replay on: the lowest thing anybody or
    // anything is recorded at. T4 puts a player's origin at the feet, so the lowest
    // recorded z IS the floor of the lowest room they reached, to within a step.
    const floorFromTrack = () => {
      let lo = Infinity
      for (const p of track.players) for (let i = 2; i < p.pos.length; i += 3) if (p.pos[i] < lo) lo = p.pos[i]
      for (const z of track.zombies) for (let i = 2; i < z.pos.length; i += 3) if (z.pos[i] < lo) lo = z.pos[i]
      const first = track.players[0]
      return {
        z: Number.isFinite(lo) ? lo : 0,
        cx: first && first.pos.length ? first.pos[0] : 0,
        cy: first && first.pos.length ? first.pos[1] : 0,
      }
    }

    // Everything the actors need is already in hand; only the world is in question. So a
    // map that is missing, refused or broken ends here — a grid at the real floor height,
    // a plain sentence saying so, and a replay that plays. It is NEVER an error overlay
    // over a black page: the commonest case by far is a map nobody has exported yet, and
    // a custom map with no export is the normal state of the archive.
    const actorsOnly = (why) => {
      setNote(why)
      const f = floorFromTrack()
      api.setGrid(f.cx, f.cy, f.z, true)
    }

    ;(async () => {
      try {
        if (!mapUrl) {
          actorsOnly(`No world model for ${track.map} yet — showing players and zombies over a grid at the floor they walked on.`)
          await api.precompile()
          dirtyRef.current = true
          return
        }
        const got = await fetchAsset([mapUrl], {
          onProgress: (loaded, size) => !dead && setProgress(size ? loaded / size : null),
        })
        if (dead) return
        if (!got.ok) throw new Error('the map geometry could not be fetched')
        const r = await api.loadMap(got.buffer)
        if (!r || !r.ok) throw new Error((r && r.error) || 'the map failed to load')
        skyRef.current = installSkyDome(api)

        const meta = await fetchJson([metaUrl]).catch(() => null)
        if (meta && meta.sun) {
          // The map author's own sun, straight out of worldspawn. Nacht's is a cold
          // blue moon (0.64 0.85 1) at 0.75 with 0.1 ambient, and using it is the
          // difference between "a night map" and "a grey room".
          //
          // scene.js's setLighting takes Source's shape -- a THREE.Color, a VRAD
          // `_light` brightness where 200 is a normal outdoor sun, and a unit
          // direction the light travels ALONG. WaW's worldspawn gives a 0..1 colour,
          // a 0..1 `sunlight` scale, and `sundirection` as Quake angles. This is the
          // conversion between them, and it is the only place the two engines' light
          // vocabularies meet.
          const T = api.THREE
          const D = Math.PI / 180
          const [sp, sy] = meta.sun.direction
          const p = sp * D
          const y = sy * D
          api.setLighting({
            color: new T.Color().setRGB(...meta.sun.color.map((v) => Math.min(1, Math.max(0, v))), T.SRGBColorSpace),
            brightness: Math.max(40, meta.sun.light * 260),
            dir: [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)],
            ambient: new T.Color().setRGB(meta.sun.ambient * 2.2, meta.sun.ambient * 2.2, meta.sun.ambient * 3, T.SRGBColorSpace),
          })
        }
        if (meta && meta.world_shell === false) {
          setNote('Props and sky only — the world shell needs a memory-side export (replay.md §4).')
          // Until the shell lands there is no floor, and a capsule floating in black
          // reads as a bug rather than as a missing export. scene.js's own grid, put
          // at the real floor height, is the cheapest honest stand-in: it is visibly
          // a grid, it is at the height the recorded positions stand on, and it goes
          // away the moment `--world` is used.
          const ns = meta.pathnodes || []
          let floor = meta.spawn ? meta.spawn[2] : 0
          for (const n of ns) if (n[2] < floor) floor = n[2]
          const cx = meta.spawn ? meta.spawn[0] : 0
          const cy = meta.spawn ? meta.spawn[1] : 0
          api.setGrid(cx, cy, floor, true)
        }
        await api.precompile()
        // The map arrives long after the first frames, and the render loop is
        // change-driven: paused and clean, it returns without drawing. Nothing in
        // loading is an input event, so without this the map, the sky and the grid
        // all sit in the scene graph un-drawn until the viewer happens to be
        // resized or dragged -- which is exactly what a headless screenshot never
        // does, and how this was found.
        dirtyRef.current = true
      } catch (e) {
        // Same landing as "never exported". The cause is printed, because a network
        // failure and a missing export want different actions from whoever reads it,
        // but the outcome is a watchable replay either way.
        if (!dead) {
          try { actorsOnly(`No world model for ${track.map} — ${String(e.message || e)}. Players and zombies only.`) } catch { setErr(String(e.message || e)) }
        }
      } finally {
        if (!dead) { setBoot('out'); setTimeout(() => !dead && setBoot('off'), 220) }
      }
    })()

    return () => {
      dead = true
      actors.dispose()
      api.dispose()
      canvas.remove()
      sceneRef.current = null
      actorsRef.current = null
      gunRef.current = null
    }
  }, [track, mapUrl, metaUrl])

  // ---- sampling ---------------------------------------------------------------
  // Movement's sampler, with the one change a 20 Hz server track needs: the track is
  // already dense, so there is no run window and no lead-in, and `ticks` is the whole
  // file rather than a start/end pair.
  const sample = useCallback(() => {
    const api = sceneRef.current
    const actors = actorsRef.current
    if (!api || !actors || !track) return null

    const tf = (timeRef.current * 1000) / tickMs
    let i = Math.floor(tf)
    if (i < 0) i = 0
    if (i > track.ticks - 1) i = track.ticks - 1
    const j = Math.min(track.ticks - 1, i + 1)
    let f = tf - i
    if (f < 0) f = 0
    if (f > 1) f = 1

    const list = []
    let focusP = null
    for (const p of track.players) {
      const ax = p.pos[i * 3], ay = p.pos[i * 3 + 1], az = p.pos[i * 3 + 2]
      const bx = p.pos[j * 3], by = p.pos[j * 3 + 1], bz = p.pos[j * 3 + 2]
      // A teleport -- a respawn, or the round-change move -- must not be smeared
      // across a frame. 400 units in one tick is 8000 u/s; the engine caps a sprint
      // at about 190.
      const dx = bx - ax, dy = by - ay, dz = bz - az
      const ff = (dx * dx + dy * dy + dz * dz > 400 * 400) ? 0 : f
      const x = ax + dx * ff, y = ay + dy * ff, z = az + dz * ff
      const rec = {
        slot: p.slot, name: p.name, x, y, z,
        pitch: lerpAngle(p.ang[i * 2], p.ang[j * 2], ff),
        yaw: lerpAngle(p.ang[i * 2 + 1], p.ang[j * 2 + 1], ff),
        health: p.health[i], score: p.score[i], alive: p.alive[i] === 1,
      }
      list.push(rec)
      if (rec.slot === focusRef.current) focusP = rec
    }
    if (!focusP) focusP = list[0]

    actors.setPlayers(list, focusP ? focusP.slot : -1)
    if (focusP) api.setPose(focusP.x, focusP.y, focusP.z, focusP.pitch, focusP.yaw, false)

    const zs = []
    for (const z of track.zombies) {
      const k = i - z.t0
      if (k < 0 || k * 3 >= z.pos.length) continue
      zs.push({ x: z.pos[k * 3], y: z.pos[k * 3 + 1], z: z.pos[k * 3 + 2] })
    }
    actors.setZombies(zs)

    // Grenades in flight, and a fireball where each grenade track ends (§8.6).
    const ns = []
    const booms = []
    for (const n of track.nades || []) {
      const k = i - n.t0
      const len = n.pos.length / 3
      if (k >= 0 && k < len) ns.push({ x: n.pos[k * 3], y: n.pos[k * 3 + 1], z: n.pos[k * 3 + 2] })
      const age = ((tf - (n.t0 + len)) * tickMs) / 1000
      if (age >= 0 && age < 0.8 && len) booms.push({ x: n.pos[len * 3 - 3], y: n.pos[len * 3 - 2], z: n.pos[len * 3 - 1], age })
    }
    actors.setNades(ns)
    actors.setExplosions(booms)

    // What the crosshair and the gun need: the focused player's ground speed and trigger.
    let speed = 0
    let fire = false
    const fp = focusP && track.players.find((p) => p.slot === focusP.slot)
    if (fp) {
      const dx = fp.pos[j * 3] - fp.pos[i * 3], dy = fp.pos[j * 3 + 1] - fp.pos[i * 3 + 1]
      if (j > i) speed = Math.min(400, Math.hypot(dx, dy) / (tickMs / 1000))
      fire = !!(fp.fire && fp.fire[i]) && focusP.alive
    }

    const zl = track.zombies_alive ? track.zombies_alive[i] : null
    const kr = track.kills_round ? track.kills_round[i] : null
    return { speed, fire, i, list, alive: zs.length, left: zl === undefined ? null : zl, kills: kr === undefined ? null : kr, round: roundAt[i] || 0 }
  }, [track, tickMs, roundAt])

  // ---- frame loop -------------------------------------------------------------
  useEffect(() => {
    if (!track) return
    let raf = 0
    let last = performance.now()
    let hudAt = 0
    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      const api = sceneRef.current
      if (!api) return
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (document.hidden) return

      const freeMoving = camRef.current === 'free' && api.state.keys.size > 0
      if (playingRef.current) {
        timeRef.current += dt * speedRef.current
        if (timeRef.current >= total) { timeRef.current = total; playingRef.current = false; setPlaying(false) }
      } else if (!dirtyRef.current && !freeMoving) {
        return
      }
      dirtyRef.current = false
      if (freeMoving) api.tickFree(dt, api.state.keys.has('ShiftLeft') || api.state.keys.has('ShiftRight'))

      const s = sample()
      if (skyRef.current) skyRef.current()
      // Crosshair and gun: only animated while time moves -- a paused frame is a still,
      // the same as Movement's.
      if (s) {
        const moving = playingRef.current
        const step = moving ? dt * speedRef.current : 0
        const g = gunRef.current
        if (g) g.update(moving && s.fire, step)
        const el = xhRef.current
        if (el) {
          const c = xhClass(null)
          if (moving && s.fire) bloomRef.current = Math.min(c.max, bloomRef.current + c.shot * step * 10)
          bloomRef.current = Math.max(0, bloomRef.current - c.recover * step)
          const gap = Math.min(c.max, c.base + c.move * Math.min(1, s.speed / WAW_RUN) + bloomRef.current)
          el.style.setProperty('--xh-gap', `${gap.toFixed(1)}px`)
        }
      }
      api.render()

      if (s && now - hudAt > 66) {
        hudAt = now
        setHud({ t: timeRef.current, round: s.round, alive: s.alive, left: s.left, kills: s.kills, players: s.list, tick: s.i })
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [track, total, sample])

  // ---- input ------------------------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onResize = () => { sceneRef.current && sceneRef.current.resize(); dirtyRef.current = true }
    const ro = new ResizeObserver(onResize)
    ro.observe(el)

    let dragging = false
    let px = 0
    let py = 0
    // THE PLAY / FIRST-PERSON BUG (replay.md §8.1). This handler used to take every press
    // on the wrapper and capture the pointer to it -- and the wrapper holds the top rail and
    // the control bar. With the pointer captured, `click` fires on the wrapper, never on the
    // button: Play and the camera rail were dead to the mouse while Space and 1/2/3 worked.
    // Movement puts the drag on the canvas; so does this, now.
    const down = (e) => {
      if (e.button !== 0 || e.target !== canvasRef.current) return
      dragging = true; px = e.clientX; py = e.clientY
      e.target.setPointerCapture?.(e.pointerId)
    }
    const move = (e) => {
      if (!dragging || !sceneRef.current) return
      sceneRef.current.drag(e.clientX - px, e.clientY - py)
      px = e.clientX; py = e.clientY
      dirtyRef.current = true
    }
    const up = () => { dragging = false }
    const wheel = (e) => { if (sceneRef.current) { e.preventDefault(); sceneRef.current.wheel(e.deltaY); dirtyRef.current = true } }
    // On the wrapper, not the canvas: the canvas is created and destroyed by the
    // scene effect, and the canvas fills the wrapper, so every pointer that would
    // have reached it reaches this instead.
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })

    const key = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
      const api = sceneRef.current
      if (e.type === 'keyup') { api && api.state.keys.delete(e.code); return }
      api && api.state.keys.add(e.code)
      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p) }
      else if (e.code === 'Digit1') setCamMode('eyes')
      else if (e.code === 'Digit2') setCamMode('follow')
      else if (e.code === 'Digit3') setCamMode('free')
      else if (e.code === 'ArrowLeft') seek(timeRef.current - SKIP_S)
      else if (e.code === 'ArrowRight') seek(timeRef.current + SKIP_S)
    }
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
    return () => {
      ro.disconnect()
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
    }
  }, [])

  useEffect(() => { sceneRef.current && sceneRef.current.setMode(camMode) }, [camMode])

  const seek = useCallback((t) => {
    timeRef.current = Math.max(0, Math.min(total, t))
    dirtyRef.current = true
    setHud((h) => ({ ...h, t: timeRef.current }))
  }, [total])

  // The event feed: whatever happened in the last four seconds before the playhead.
  const feed = useMemo(() => {
    if (!track || hud.tick == null) return []
    const span = Math.ceil(4000 / tickMs)
    const out = []
    for (let k = Math.max(0, hud.tick - span); k <= hud.tick; k++) {
      const got = feedByTick.get(k)
      if (got) for (const e of got) out.push(e)
    }
    return out.slice(-5)
  }, [track, hud.tick, feedByTick, tickMs])

  if (!track) return <div className="r3d"><Boot /></div>

  const pct = (ms) => `${Math.max(0, Math.min(100, ((ms - t0) / 1000 / (total || 1)) * 100))}%`

  return (
    <div className="r3d" ref={wrapRef}>
      <div className="r3d-top">
        <div className="r3d-title">
          <span className="r3d-alias">{title || track.map_name}</span>
          <span className="r3d-sep" />
          <span className="r3d-title-more">{track.map}</span>
          <span className="r3d-sep r3d-title-more" />
          <span className="r3d-title-more">{track.mode} · {track.hz} Hz · {track.match_id}</span>
        </div>
        <div className="r3d-tools">
          <div className="r3d-seg r3d-cams">
            {CAMS.map(([k, label]) => (
              <button key={k} className={camMode === k ? 'on' : ''} onClick={() => setCamMode(k)}
                title={`${label} (${k === 'eyes' ? 1 : k === 'follow' ? 2 : 3})`}>{label}</button>
            ))}
          </div>
          {onClose && <button className="r3d-x r3d-icon" onClick={onClose} title="Close">✕</button>}
        </div>
      </div>

      {note && <div className="r3d-note">{note}</div>}

      {camMode === 'eyes' && (
        <div className="r3d-zm-xh" ref={xhRef} aria-hidden="true">
          <i className="u" /><i className="d" /><i className="l" /><i className="r" />
        </div>
      )}

      <div className="r3d-zm-round">
        <span className="r3d-zm-round-lab">Round</span>
        <span className="r3d-zm-round-n">{hud.round || '—'}</span>
        {/* "Zombies up" is the number of zombies the VIEWER has, which is what it can
            honestly claim from positions alone. When the referee sends the round's own
            counters (2026-09-22 DLL builds onward) they are the better number and they
            are labelled as what they are: `zombies_alive` is the round's remaining pool,
            not what is on screen. */}
        {hud.left == null
          ? <span className="r3d-zm-alive">Zombies up <b>{hud.alive}</b></span>
          : <span className="r3d-zm-alive">Zombies left <b>{hud.left}</b>{hud.kills == null ? null : <> · killed <b>{hud.kills}</b></>}</span>}
      </div>

      <div className="r3d-zm-score">
        {hud.players.map((p) => (
          <div key={p.slot} className={'r3d-zm-row' + (p.slot === focus ? ' on' : '') + (p.alive ? '' : ' down')}
            onClick={() => setFocus(p.slot)} title="Watch from this player">
            <span className="r3d-zm-dot" style={{ background: SLOT_COLORS[p.slot % SLOT_COLORS.length] }} />
            <span className="r3d-zm-name">{p.name}</span>
            <span className={'r3d-zm-hp' + (p.health < 50 ? ' hurt' : '')}>
              <i style={{ width: `${Math.max(0, Math.min(100, p.health))}%` }} />
            </span>
            <span className="r3d-zm-pts">{p.score}</span>
          </div>
        ))}
      </div>

      <div className="r3d-zm-feed">
        {feed.map((e, n) => (
          <div key={n} className={'r3d-zm-ev' + (e.t === 'points' ? ' pts' : (e.t === 'down' || e.t === 'bleedout') ? ' bad' : '')}>
            {/* The same clock the scrubber shows, so a line in the feed and the time
                under the playhead are the same number: both are measured from the first
                snapshot, not from the moment the server process started. */}
            <span className="r3d-zm-ev-t">{clock((e.ms - t0) / 1000)}</span>
            {e.t === 'points' && <span>slot {e.slot} <b>+{e.delta}</b> {e.why}</span>}
            {/* A kill is its own record now, not an inference off a points line. `how`
                is the referee's word for why the zombie stopped existing. */}
            {e.t === 'kill' && <span><b>kill</b>{e.slot === undefined ? '' : ` · slot ${e.slot}`}{e.how ? ` · ${e.how}` : ''}</span>}
            {e.t === 'down' && <span>slot {e.slot} <b>down</b></span>}
            {e.t === 'revive' && <span>slot {e.slot} <b>revived</b></span>}
            {e.t === 'bleedout' && <span>slot {e.slot} <b>bled out</b></span>}
            {e.t === 'chat' && <span>slot {e.slot}: {e.text}</span>}
            {e.t === 'referee' && <span>{e.label || e.id}</span>}
            {e.t === 'notify' && <span>{e.name}</span>}
          </div>
        ))}
      </div>

      <div className="r3d-bar">
        <button className="r3d-play r3d-icon" onClick={() => setPlaying((p) => !p)} title="Play/pause (space)">
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="r3d-skip r3d-icon" onClick={() => seek(timeRef.current - SKIP_S)} title={`-${SKIP_S}s`}><IconBack /></button>
        <button className="r3d-skip r3d-icon" onClick={() => seek(timeRef.current + SKIP_S)} title={`+${SKIP_S}s`}><IconFwd /></button>

        <div className="r3d-scrub-wrap">
          <div className="r3d-stagesegs">
            {track.rounds.map((r) => (
              <span key={r.n}>
                <span className="r3d-zm-rtick" style={{ left: pct(r.ms) }} />
                {(r.n % 5 === 0 || r.n === 1) && <span className="r3d-zm-rnum" style={{ left: pct(r.ms) }}>{r.n}</span>}
              </span>
            ))}
          </div>
          <input type="range" className="r3d-range r3d-scrub" min={0} max={total || 1} step={0.01}
            value={Math.max(0, Math.min(hud.t, total || 1))}
            onChange={(e) => seek(Number(e.target.value))} aria-label="Position" />
        </div>

        <span className="r3d-clock">{clock(hud.t)} / {clock(total)}</span>

        <button className="r3d-x r3d-icon r3d-speed-btn" onClick={() => setSpeedOpen((v) => !v)} title={`Speed ${speed}x`}><IconCog /></button>
        {speedOpen && (
          <div className="r3d-menu r3d-menu-speed">
            <div className="r3d-seg">
              {SPEEDS.map((s) => (
                <button key={s} className={'mono' + (s === speed ? ' on' : '')}
                  onClick={() => { setSpeed(s); setSpeedOpen(false) }}>{s}x</button>
              ))}
            </div>
          </div>
        )}
        <button className="r3d-x r3d-icon" title="Fullscreen"
          onClick={() => {
            const el = wrapRef.current
            if (document.fullscreenElement) document.exitFullscreen()
            else el && el.requestFullscreen && el.requestFullscreen()
          }}><IconFull /></button>
      </div>

      {err && <div className="r3d-state r3d-err">{err}</div>}
      <Boot state={boot} progress={progress} />
    </div>
  )
}
