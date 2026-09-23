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
//   * four players instead of one (actors.js), each with a nameplate, and any of them
//     selectable as the first-person eye;
//   * players and zombies drawn as the game's own models (models.js, replay.md §9: the
//     Marines / the four heroes, the stock zombies, a procedural gait), falling back to
//     coloured capsules and one instanced capsule mesh when the models are not there;
//   * the scoreboard (points, health), the round counter, the body count, the event
//     feed, and round markers on the scrubber.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createScene, isWebGL2Available, installWorldFov, toThree, forwardOf } from './scene.js'
import { createActors, installSkyDome, SLOT_COLORS } from './actors.js'
// Lane R3 (replay.md §12): weapons in hands, muzzle flash, hit markers, blood, Pack-a-Punch,
// power-ups and sound, from the R1 events. fx.js is the pure reducer; gear.js draws; sound.js plays.
import {
  buildFx, weaponAt, fireAge, hitMarkerAt, bloodAt, powerupsAt, chipsAt, displayName, POWERUP_LABEL,
} from './fx.js'
import { createGear, loadAssets } from './gear.js'
import { ReplaySound } from './sound.js'
import {
  CG_FOV, VIEW_HEIGHT, HULL, HUD, BTN, stanceOf, WEAPONS, DEFAULT_WEAPON, weaponRow,
  simulateSpread, reticleGeom, cookAt, roundGlyphs, trackClock,
} from './waw.js'
import { fetchAsset, fetchJson } from './assets.js'
import { loadModelSet } from './models.js'
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

// The first-person crosshair is WaW's own now (replay.md §8.11): the four reticle_side_small
// ticks, their gap from each weapon file's hip spread, the spread driven by the engine's
// aimSpreadScale model over the recorded inputs -- all in waw.js, with sources.

// Viewer settings (B's ask 3): each overlay can be switched off; all start ON. Per-viewer
// convenience, so localStorage, wrapped: a private window has none and that is fine.
const SETTINGS_KEY = 'enw.replay3d.settings'
const DEFAULT_SETTINGS = { hud: true, xh: true, dmg: true, sb: true, fx: true }
// How many timed power-up chips the HUD can show at once (one per kind; fx.js CHIP_ORDER).
const CHIP_SLOTS = 5
function IconSound({ on }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z" />
      {on
        ? <path d="M14.5 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7.6 7.6 0 0 1 0 10.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        : <path d="M15 9.5l4.5 5M19.5 9.5l-4.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />}
    </svg>
  )
}
const DEBUG = (() => { try { return new URLSearchParams(window.location.search).has('r3ddebug') } catch { return false } })()
const loadSettings = () => {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') } } catch { return { ...DEFAULT_SETTINGS } }
}
const saveSettings = (v) => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(v)) } catch { /* no storage: still works */ } }

// Heights per stance (WaW, bg_pmove): the eye camera and the capsules both use them.
const BODY = {
  stand: { eye: VIEW_HEIGHT.stand, height: HULL.stand, radius: HULL.radius },
  crouch: { eye: VIEW_HEIGHT.crouch, height: HULL.crouch, radius: HULL.radius },
  prone: { eye: VIEW_HEIGHT.prone, height: HULL.prone, radius: HULL.radius },
}

// The chalk tally (hud_chalk_1..5, [I]): up to four near-vertical strokes and a diagonal,
// hand-wobbled, in a 64 x 64 box. Procedural SVG -- the game's texture is never shipped.
const TALLY = [
  'M13 9 C 11 24, 15 40, 12 57', 'M24 7 C 26 25, 22 41, 25 58', 'M35 9 C 33 26, 37 42, 34 57',
  'M46 8 C 48 24, 44 40, 47 58', 'M4 44 C 20 34, 38 26, 60 16',
]
function Chalk({ n }) {
  return (
    <svg className="r3d-waw-chalk" viewBox="0 0 64 64" aria-hidden="true">
      {TALLY.slice(0, n).map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
}

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
  const [settings, setSettings] = useState(loadSettings)
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings; saveSettings(settings); dirtyRef.current = true }, [settings])
  const toggle = (k) => setSettings((v) => ({ ...v, [k]: !v[k] }))
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
  const cookRef = useRef(null)
  const flashRef = useRef(null)
  const lowRef = useRef(null)
  const dmgRefs = useRef([])
  const gunRef = useRef(null)
  // Lane R3.
  const gearRef = useRef(null)
  const soundRef = useRef(null)
  const hitRef = useRef(null)
  const bloodRef = useRef(null)
  const chipRefs = useRef([])
  const [assets, setAssets] = useState(null)
  const [snd, setSnd] = useState({ available: false, enabled: false, muted: false })
  // The Tab scoreboard (B's ask, §8.12): held, like the game's.
  const [board, setBoard] = useState(false)
  // ?r3ddebug: the alignment numbers (§8.12), computed once the map is in.
  const [debugInfo, setDebugInfo] = useState(null)

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
  // Time <-> tick through the snaps' own clock (§8.11), not t0 + k * tick_ms.
  const clk = useMemo(() => (track ? trackClock(track) : null), [track])

  useEffect(() => { timeRef.current = clk ? (clk.at(firstLive) - t0) / 1000 : 0; dirtyRef.current = true }, [track, firstLive, clk, t0])
  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { focusRef.current = focus; dirtyRef.current = true }, [focus])
  useEffect(() => { camRef.current = camMode; dirtyRef.current = true }, [camMode])

  // Weapon per player per tick, as a NAME from the weapon table (or null: none / unproven).
  // An index the recording has not proven falls back to DEFAULT_WEAPON's row, flagged.
  const weaponNameAt = useCallback((p, k) => {
    if (!track || !p.wpn || !track.weapons) return DEFAULT_WEAPON
    const w = track.weapons[p.wpn[k]]
    if (!w) return null
    if (w.name) return w.name
    if (!w.raw || w.raw === '#0') return null
    return DEFAULT_WEAPON
  }, [track])

  // ---- lane R3: the FX index (fx.js), and the per-frame scratch it writes into ----------
  // The asset manifest (lane R2). Missing is normal until R2 lands: then every weapon is a
  // placeholder of its class, every power-up a stand-in, and the replay is silent.
  useEffect(() => {
    let dead = false
    loadAssets().then((a) => { if (!dead) setAssets(a) })
    return () => { dead = true }
  }, [])
  const F = useMemo(() => buildFx(track, assets), [track, assets])
  // The snapshot column's weapon NAME (never the unproven-index fallback row): the fallback for
  // "what is in his hands" on a file with no `weapon` events.
  const colWeapon = useCallback((p, k) => {
    if (!track || !p || !p.wpn || !track.weapons) return null
    const w = track.weapons[p.wpn[k]]
    return (w && w.name) || null
  }, [track])
  const tickRef = useRef(0)
  // Per-slot weapon state, reused every frame: { name, pap, source, fireAge, fireMs }.
  const gearState = useMemo(() => {
    const m = new Map()
    // `col` is the snapshot fallback for weaponAt, bound once per player (no closure per frame).
    if (track) for (const p of track.players) m.set(p.slot, { name: null, pap: false, source: 'none', fireAge: Infinity, fireMs: 0, plate: '', col: () => colWeapon(p, tickRef.current) })
    return m
  }, [track, colWeapon])
  const fxScratch = useMemo(() => ({ hit: {}, blood: {}, pups: [], chips: [], w: {} }), [])

  // aimSpreadScale per tick for every player, integrated once (scrub-exact). waw.js.
  const spread = useMemo(() => {
    const out = new Map()
    if (!track) return out
    for (const p of track.players) out.set(p.slot, simulateSpread(track, p, weaponNameAt))
    return out
  }, [track, weaponNameAt])

  // Zombie facing: the recorded yaw if the file has it, else the direction of travel over
  // +-1 tick, held while standing still (§8.11: both replays predate the yaw field).
  const zombieYaw = useMemo(() => {
    if (!track) return []
    return track.zombies.map((z) => {
      const n = z.pos.length / 3
      const out = new Float32Array(n)
      let last = NaN
      for (let k = 0; k < n; k++) {
        const rec = z.yaw ? z.yaw[k] : null
        if (rec != null) { out[k] = rec; last = rec; continue }
        const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1)
        const dx = z.pos[b * 3] - z.pos[a * 3], dy = z.pos[b * 3 + 1] - z.pos[a * 3 + 1]
        if (dx * dx + dy * dy > 4) last = Math.atan2(dy, dx) * 180 / Math.PI
        out[k] = last
      }
      return out
    })
  }, [track])
  const yawRecorded = !!(track && track.zombies.some((z) => z.yaw))

  // Distance walked, per tick, for every player and zombie (replay.md §9): the procedural
  // gait's phase is this distance, so a scrubbed or paused frame is posed exactly as a played
  // one. Horizontal only; a jump of 400 u in one tick is a teleport and walks nobody.
  const walked = useMemo(() => {
    const cum = (pos, n) => {
      const out = new Float32Array(n)
      for (let k = 1; k < n; k++) {
        const dx = pos[k * 3] - pos[k * 3 - 3], dy = pos[k * 3 + 1] - pos[k * 3 - 2]
        const d = Math.hypot(dx, dy)
        out[k] = out[k - 1] + (d < 400 ? d : 0)
      }
      return out
    }
    if (!track) return { players: new Map(), zombies: [] }
    const players = new Map()
    for (const p of track.players) players.set(p.slot, cum(p.pos, track.ticks))
    return { players, zombies: track.zombies.map((z) => cum(z.pos, z.pos.length / 3)) }
  }, [track])
  // Which zombie tracks end in a death: a `kill` event for that entity within 1.5 s of its
  // last sample. Those fall; a track that ends any other way (cleanup, end of file) just goes.
  const zombieDeathMs = useMemo(() => {
    if (!track || !clk) return []
    const kills = track.events.filter((e) => e.t === 'kill' && e.id != null)
    return track.zombies.map((z) => {
      const n = z.pos.length / 3
      const endMs = clk.at(z.t0 + n - 1)
      const k = kills.find((e) => e.id === z.id && Math.abs(e.ms - endMs) < 1500)
      return k ? endMs : null
    })
  }, [track, clk])

  // Downs. A `down` event when the referee sends one; otherwise INFERRED from the weapon
  // index going to #0 (none) while the player was holding a real one -- last stand takes
  // the weapon away (§8.11: both replays have no down event and both show this).
  const downs = useMemo(() => {
    const out = []
    if (!track) return out
    const real = track.events.filter((e) => e.t === 'down')
    if (real.length) return real.map((e) => ({ slot: e.slot, ms: e.ms, inferred: false }))
    const end = track.end_ms || Infinity
    for (const p of track.players) {
      if (!p.wpn || !track.weapons) continue
      let had = false
      for (let k = 0; k < track.ticks; k++) {
        const w = track.weapons[p.wpn[k]]
        const none = !w || !w.raw || w.raw === '#0'
        const ms = clk.at(k)
        if (!none && p.alive[k]) had = true
        else if (none && had && ms < end) { out.push({ slot: p.slot, ms, inferred: true }); had = false }
      }
    }
    return out
  }, [track, clk])

  // Index the event feed by tick once, so the per-frame lookup is a slice and not a
  // scan of 1500 events.
  const feedByTick = useMemo(() => {
    const out = new Map()
    if (!track) return out
    const add = (e) => {
      const k = Math.floor(clk.index(e.ms))
      if (!out.has(k)) out.set(k, [])
      out.get(k).push(e)
    }
    for (const e of track.events) {
      if (e.t === 'round' || e.t === 'auth_decision' || e.t === 'player_connect' || e.t === 'down') continue
      add(e)
    }
    for (const d of downs) add({ t: 'down', ms: d.ms, slot: d.slot, inferred: d.inferred })
    // Lane R3: power-up pickups and Pack-a-Punch (fx.js builds the lines).
    for (const l of F.feed) add(l)
    for (const h of track.hits || []) add({ t: 'hit', ms: h.ms, slot: h.slot, delta: h.to - h.from })
    // Frags from the +frag press, when the file has no grenade entities to show the real one.
    if (!(track.nades && track.nades.length)) {
      const row = WEAPONS.stielhandgranate
      for (const p of track.players) {
        for (const [d] of (p.presses && p.presses.frag) || []) {
          const c = cookAt(p.presses, d, row)
          if (c) add({ t: 'frag', ms: c.explodeAt, slot: p.slot, cooked: ((c.releasedAt - c.armedAt) / 1000) })
        }
      }
    }
    return out
  }, [track, clk, downs, F])

  const roundAt = useMemo(() => {
    // A flat array of round number per tick. `round` is an event, never a snap field
    // (replay.cpp emits no round), so it has to be carried forward.
    if (!track) return new Int16Array(0)
    const a = new Int16Array(track.ticks)
    let r = 0
    let i = 0
    for (let k = 0; k < track.ticks; k++) {
      while (i < track.rounds.length && track.rounds[i].ms <= clk.at(k)) { r = track.rounds[i].n; i++ }
      a[k] = r
    }
    return a
  }, [track, clk])

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
    // First person at WaW's own field of view (cg_fov 65, 4:3 horizontal), not Movement's
    // CS:GO 90: the crosshair's spread-to-pixels projection assumes it (waw.js reticleGeom).
    installWorldFov(api)
    api.setWorldFov(CG_FOV)
    sceneRef.current = api
    // `?r3ddebug` exposes the scene to the console, for the screenshots in replay.md §8.11
    // (placing the free camera exactly). Nothing reads it; off unless asked for.
    try {
      if (new URLSearchParams(window.location.search).has('r3ddebug')) {
        window.__r3d = {
          api, redraw: () => { dirtyRef.current = true },
          // Seek to replay seconds (screenshots, replay.md §9); the same as dragging the scrubber.
          seek: (s) => { timeRef.current = Math.max(0, s); dirtyRef.current = true },
        }
      }
    } catch { /* no window.location: not a browser */ }
    const actors = createActors(api)
    actorsRef.current = actors
    // The game's player and zombie models (replay.md §9). Loaded beside the map, never in
    // its way: until they arrive -- and for good if they are not there -- the capsules stay.
    // `?models=off` keeps the capsules, for comparison.
    let modelsOff = false
    try { modelsOff = new URLSearchParams(window.location.search).get('models') === 'off' } catch { /* not a browser */ }
    if (!modelsOff) {
      loadModelSet(track.map, {
        slots: track.players.map((p) => p.slot),
        dogs: track.zombies.some((z) => z.kind === 'dog'),
      }).then((ms) => {
        if (dead || !ms) return
        actors.setModels(ms)
        if (window.__r3d) window.__r3d.models = () => actors.modelInfo()
        dirtyRef.current = true
      })
    }
    // Lane R3: gear.js owns the held weapons, the flashes, the power-ups and the first-person
    // weapon (the §8.7 placeholder gun, now one per weapon class, or R2's glb when served).
    const gear = createGear(api, actors, null)
    gearRef.current = gear
    gunRef.current = gear
    api.setViewmodel(gear.viewmodel)
    if (window.__r3d) window.__r3d.fx = () => ({ gear: gear.info(), sound: soundRef.current ? soundRef.current.info() : null })
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
          actorsOnly(`No world model for ${track.map} yet. Players and zombies only.`)
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
        if (DEBUG && meta) {
          // Engine coordinates of three-space: (x, y, z)_engine = (x, -z, y)_three.
          const T = api.THREE
          const eng = (v) => [v.x, -v.z, v.y]
          let world = null
          api.scene.updateMatrixWorld(true)
          api.scene.traverse((o) => { if (!world && o.name === '__world') world = o })
          let ext = null
          if (world) {
            const b = new T.Box3().setFromObject(world)
            ext = { lo: [b.min.x, -b.max.z, b.min.y].map(Math.round), hi: [b.max.x, -b.min.z, b.max.y].map(Math.round) }
          }
          const anchors = []
          for (const a of (meta.anchors || []).filter((x) => /opel_blitz|treasure|couch/.test(x.model))) {
            let best = Infinity
            // GLTFLoader de-duplicates node names ("x", "x_1", "x_2", ...).
            const same = (n) => n === a.model || (n.startsWith(a.model + '_') && /^\d+$/.test(n.slice(a.model.length + 1)))
            api.scene.traverse((o) => {
              if (!same(o.name)) return
              const w = eng(o.getWorldPosition(new T.Vector3()))
              best = Math.min(best, Math.hypot(w[0] - a.origin[0], w[1] - a.origin[1], w[2] - a.origin[2]))
            })
            anchors.push(`${a.model} @ ${a.origin.map(Math.round).join(',')}: node ${Number.isFinite(best) ? best.toFixed(2) + ' u off' : 'missing'}`)
          }
          // A meshopt-served export (export_all.py) quantizes each mesh and folds the undo into
          // its node, so a node's position is no longer the prop's origin and the numbers above
          // read "off" by the dequantization offset. The real check ran on the float file at
          // export time and is in the sidecar; show that instead of a misleading number.
          if (String(meta.encoding || '').includes('meshopt') && meta.align) {
            anchors.length = 0
            anchors.push(`meshopt file: node positions include the dequantize offset; export-time align ${meta.align.ok ? 'OK' : 'FAILED'}: ${meta.align.anchors_checked} anchors, spawns on floor ${meta.align.spawns_on_floor}${meta.align.windows ? `, window goals median ${meta.align.windows.median} u` : ''}`)
          }
          const p0 = track.players[0]
          let first = null
          if (p0) {
            const k = Math.max(0, p0.alive.indexOf(1))
            const at = [p0.pos[k * 3], p0.pos[k * 3 + 1], p0.pos[k * 3 + 2]]
            let d = Infinity
            for (const sp of meta.spawns || []) d = Math.min(d, Math.hypot(at[0] - sp[0], at[1] - sp[1], at[2] - sp[2]))
            first = { at, d }
          }
          setDebugInfo({ ext, scale: meta.world_obj_scale || null, built: meta.built_at, anchors, first, spawns: (meta.spawns || []).length })
        }
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
          setNote('Props and sky only.')
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
          try { actorsOnly(`No world model for ${track.map} (${String(e.message || e)}). Players and zombies only.`) } catch { setErr(String(e.message || e)) }
        }
      } finally {
        if (!dead) { setBoot('out'); setTimeout(() => !dead && setBoot('off'), 220) }
      }
    })()

    return () => {
      dead = true
      gear.dispose()
      actors.dispose()
      api.dispose()
      canvas.remove()
      sceneRef.current = null
      actorsRef.current = null
      gunRef.current = null
      gearRef.current = null
    }
  }, [track, mapUrl, metaUrl])

  // Lane R3: the manifest reaches the gear when it lands (glbs from then on).
  useEffect(() => { if (gearRef.current) { gearRef.current.setAssets(assets); dirtyRef.current = true } }, [assets, track, mapUrl, metaUrl])

  // Lane R3: the sound. Built per (track, manifest); silent until a gesture enables it.
  useEffect(() => {
    const api = sceneRef.current
    if (!api || !track) return
    const s = new ReplaySound(api, assets, F)
    soundRef.current = s
    setSnd({ available: s.available, enabled: false, muted: s.muted })
    return () => { s.dispose(); if (soundRef.current === s) soundRef.current = null }
  }, [track, assets, F, mapUrl, metaUrl])
  // A gesture (Play, Space, the speaker button) is the only moment audio may start.
  const enableSound = useCallback(() => {
    const s = soundRef.current
    if (!s || !s.available) return
    if (!s.enabled) s.enable()
    s.seek(t0 + timeRef.current * 1000)
    setSnd({ available: true, enabled: s.enabled, muted: s.muted })
  }, [t0])
  const toggleMute = useCallback(() => {
    const s = soundRef.current
    if (!s || !s.available) return
    if (!s.enabled) { s.enable(); s.setMuted(false) } else s.setMuted(!s.muted)
    s.seek(t0 + timeRef.current * 1000)
    setSnd({ available: true, enabled: s.enabled, muted: s.muted })
  }, [t0])
  const togglePlay = useCallback(() => {
    enableSound()
    setPlaying((p) => !p)
  }, [enableSound])
  const togglePlayRef = useRef(togglePlay)
  const toggleMuteRef = useRef(toggleMute)
  useEffect(() => { togglePlayRef.current = togglePlay; toggleMuteRef.current = toggleMute }, [togglePlay, toggleMute])
  // Paused: whatever is queued stops now (Movement's rule: a pause may not leave a shot to fire later).
  useEffect(() => { if (!playing && soundRef.current) soundRef.current.stopAll() }, [playing])

  // ---- sampling ---------------------------------------------------------------
  // Movement's sampler, with the one change a 20 Hz server track needs: the track is
  // already dense, so there is no run window and no lead-in, and `ticks` is the whole
  // file rather than a start/end pair.
  const sample = useCallback(() => {
    const api = sceneRef.current
    const actors = actorsRef.current
    if (!api || !actors || !track) return null

    const tf = clk.index(t0 + timeRef.current * 1000)
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
      // Pitch: the entity's recorded pitch is always 0 (§8.11), so it is used only when the
      // file carries the usercmd-derived `pitch` column.
      const pa = p.pitch ? (p.pitch[i] ?? 0) : p.ang[i * 2]
      const pb = p.pitch ? (p.pitch[j] ?? pa) : p.ang[j * 2]
      const stance = stanceOf(p.btn ? p.btn[i] : 0)
      const wk = walked.players.get(p.slot)
      const dtS = j > i ? (clk.at(j) - clk.at(i)) / 1000 : 0
      const rec = {
        slot: p.slot, name: p.name, x, y, z,
        phase: wk ? wk[i] + (wk[j] - wk[i]) * ff : 0,
        speed: wk && dtS > 0 ? (wk[j] - wk[i]) / dtS : 0,
        t: timeRef.current,
        pitch: lerpAngle(pa, pb, ff),
        yaw: lerpAngle(p.ang[i * 2 + 1], p.ang[j * 2 + 1], ff),
        health: p.health[i], score: p.score[i], alive: p.alive[i] === 1,
        stance, height: BODY[stance].height,
      }
      list.push(rec)
      if (rec.slot === focusRef.current) focusP = rec
    }
    if (!focusP) focusP = list[0]

    actors.setPlayers(list, focusP ? focusP.slot : -1)
    if (focusP) api.setPose(focusP.x, focusP.y, focusP.z, focusP.pitch, focusP.yaw, focusP.stance !== 'stand', BODY[focusP.stance])

    // Zombies, interpolated between samples exactly as the players are (they used to snap
    // from sample to sample at 10 Hz, §8.11), facing their recorded or travelled yaw.
    const zs = []
    const nowMs = t0 + timeRef.current * 1000
    let zDying = 0
    for (let zi = 0; zi < track.zombies.length; zi++) {
      const z = track.zombies[zi]
      let k = i - z.t0
      const n = z.pos.length / 3
      if (k < 0) continue
      // A zombie killed in the track stays for 2 s after its last sample, falling (models.js).
      let death = null
      if (k >= n) {
        const dm = zombieDeathMs[zi]
        if (dm == null || nowMs - dm >= 2000 || nowMs < dm) continue
        death = (nowMs - dm) / 1000
        k = n - 1
      }
      const k2 = Math.min(n - 1, k + 1)
      const zf = k2 > k ? f : 0
      const yw = zombieYaw[zi]
      const wk = walked.zombies[zi]
      const dtS = k2 > k ? (clk.at(z.t0 + k2) - clk.at(z.t0 + k)) / 1000 : 0
      if (death != null) zDying++
      zs.push({
        key: `${z.id}:${z.t0}`,
        x: z.pos[k * 3] + (z.pos[k2 * 3] - z.pos[k * 3]) * zf,
        y: z.pos[k * 3 + 1] + (z.pos[k2 * 3 + 1] - z.pos[k * 3 + 1]) * zf,
        z: z.pos[k * 3 + 2] + (z.pos[k2 * 3 + 2] - z.pos[k * 3 + 2]) * zf,
        yaw: Number.isFinite(yw[k]) ? (Number.isFinite(yw[k2]) ? lerpAngle(yw[k], yw[k2], zf) : yw[k]) : null,
        phase: wk[k] + (wk[k2] - wk[k]) * zf,
        speed: death == null && dtS > 0 ? (wk[k2] - wk[k]) / dtS : 0,
        death, t: timeRef.current + zi * 0.37, kind: z.kind || null,
      })
    }
    actors.setZombies(zs)

    // Grenades in flight, and a fireball where each grenade track ends (§8.6).
    const ns = []
    const booms = []
    for (const n of track.nades || []) {
      const k = i - n.t0
      const len = n.pos.length / 3
      if (k >= 0 && k < len) ns.push({ x: n.pos[k * 3], y: n.pos[k * 3 + 1], z: n.pos[k * 3 + 2] })
      const age = (t0 + timeRef.current * 1000 - clk.at(n.t0 + len)) / 1000
      if (age >= 0 && age < 0.8 && len) booms.push({ x: n.pos[len * 3 - 3], y: n.pos[len * 3 - 2], z: n.pos[len * 3 - 1], age })
    }
    actors.setNades(ns)
    actors.setExplosions(booms)

    // What the HUD overlays need about the focused player.
    let fire = false
    let xh = null
    const fp = focusP && track.players.find((p) => p.slot === focusP.slot)
    if (fp) {
      fire = !!(fp.fire && fp.fire[i]) && focusP.alive
      const wname = weaponNameAt(fp, i)
      const sc = spread.get(fp.slot)
      const a = sc ? sc[i] : 0
      const b = sc ? sc[j] : 0
      xh = {
        row: weaponRow(wname), name: wname, scale: a + (b - a) * f,
        stance: focusP.stance, ads: !!(fp.btn && (fp.btn[i] & BTN.ADS)), alive: focusP.alive,
        presses: fp.presses, x: focusP.x, y: focusP.y, z: focusP.z, yaw: focusP.yaw, health: focusP.health,
        raw: track.weapons && fp.wpn ? (track.weapons[fp.wpn[i]] || {}) : {},
      }
    }

    // Zombies left: computed by the track from the round's stock total (lib/wawRules.js).
    const zl = track.zombies_left ? track.zombies_left[i] : null
    return { fire, xh, zs, i, list, alive: zs.length - zDying, left: zl == null ? null : zl, round: roundAt[i] || 0 }
  }, [track, clk, t0, roundAt, weaponNameAt, spread, zombieYaw, walked, zombieDeathMs])

  // ---- lane R3: weapons in hands, flashes, the viewmodel's weapon, power-ups, name tags ----
  // A pure function of replay time (fx.js), so a scrubbed or paused frame is what a played one
  // would be. Writes into gearState / fxScratch; nothing is allocated here per frame.
  const applyFx = useCallback((s, step) => {
    const gear = gearRef.current
    const actors = actorsRef.current
    if (!gear || !track) return
    const on = settingsRef.current.fx !== false
    const nowMs = t0 + timeRef.current * 1000
    const focus = focusRef.current
    const eyes = camRef.current === 'eyes'
    tickRef.current = s.i
    for (const p of track.players) {
      const g = gearState.get(p.slot)
      if (!g) continue
      weaponAt(F, p.slot, nowMs, g.col, fxScratch.w)
      g.name = fxScratch.w.name
      g.pap = fxScratch.w.pap
      g.source = fxScratch.w.source
      const fa = fireAge(F, p.slot, nowMs)
      g.fireAge = fa
      g.fireMs = nowMs - fa
      // The name tag's weapon line, rebuilt only when the weapon changes (actors.js).
      const key = `${g.name}|${g.pap}`
      if (actors && actors.setPlateWeapon && g.plate !== key) {
        g.plate = key
        actors.setPlateWeapon(p.slot, p.name, on && g.name ? displayName(g.name, g.pap, assets) : null)
      }
    }
    gear.root.visible = on
    gear.update(s.list, (slot) => gearState.get(slot), focus, eyes)
    powerupsAt(on ? F : null, nowMs, fxScratch.pups)
    gear.setPowerups(fxScratch.pups, timeRef.current)
    // First person: the watched player's weapon, kicked and flashed by his recorded shots; a
    // file with no fire events for him kicks on the attack button, as §8.7 always did.
    const fg = gearState.get(focus)
    gear.setViewmodelWeapon(fg && fg.name, fg && fg.pap)
    const recorded = F.fires.has(focus)
    gear.updateViewmodel(recorded ? fg.fireAge : null, fg ? fg.fireMs : 0, playingRef.current && s.fire, step)
  }, [track, t0, F, gearState, fxScratch, assets])

  // What the sound needs from the viewer, one object for the life of the track: where a player
  // was at a cue's time (a fire, the jingle), and whether his gun was upgraded then.
  const sndCtx = useMemo(() => {
    const w = {}
    return {
      focus: 0, mode: 'follow',
      posOf: (pid, ms, out) => {
        const p = track && track.players.find((q) => q.slot === pid)
        if (!p || !clk) return false
        const k = Math.max(0, Math.min(track.ticks - 1, Math.round(clk.index(ms))))
        toThree(p.pos[k * 3], p.pos[k * 3 + 1], p.pos[k * 3 + 2] + 48, out)
        return true
      },
      papAt: (pid, ms) => weaponAt(F, pid, ms, null, w).pap,
    }
  }, [track, clk, F])

  // Where the crosshair (and the hit marker on it) sits: the middle of the screen in first
  // person; in third person, the point the watched player aims at, projected. Called after the
  // render, so the camera it projects with is this frame's.
  const aimV = useMemo(() => ({ a: null, b: null }), [])
  const placeAim = useCallback(() => {
    const api = sceneRef.current
    const wrap = wrapRef.current
    if (!api || !wrap) return
    const mode = camRef.current
    let x = '50%'
    let y = '50%'
    let hide = mode === 'free'
    if (mode === 'follow') {
      const T = api.THREE
      if (!aimV.a) { aimV.a = new T.Vector3(); aimV.b = new T.Vector3() }
      const st = api.state
      const eye = st.body ? st.body.eye : 60
      toThree(st.origin.x, st.origin.y, st.origin.z + eye, aimV.a)
      forwardOf(st.pitch, st.yaw, aimV.b)
      aimV.a.addScaledVector(aimV.b, 2000).project(api.camera)
      if (aimV.a.z > 1 || Math.abs(aimV.a.x) > 1.2 || Math.abs(aimV.a.y) > 1.2) hide = true
      x = `${((aimV.a.x + 1) / 2 * wrap.clientWidth).toFixed(1)}px`
      y = `${((1 - aimV.a.y) / 2 * wrap.clientHeight).toFixed(1)}px`
    }
    for (const el of [xhRef.current, hitRef.current]) {
      if (!el) continue
      el.style.left = x
      el.style.top = y
      if (hide) el.style.visibility = 'hidden'
      else el.style.visibility = ''
    }
  }, [aimV])

  // ---- WaW overlays: crosshair, cook reticle, damage flash + direction, low health -----
  // All of it is a pure function of replay time and the track, so a paused or scrubbed
  // frame shows exactly what the player saw at that instant. Sources in waw.js.
  const drawOverlays = useCallback((s) => {
    const cfg = settingsRef.current
    const wrap = wrapRef.current
    const h = wrap ? wrap.clientHeight : 480
    const v = h / 480
    if (wrap) wrap.style.setProperty('--waw-v', v.toFixed(3))
    const tMs = t0 + timeRef.current * 1000
    const eyes = camRef.current === 'eyes'
    const x = s.xh

    // Grenade in hand (B's ask 5). Stock WaW has no cook meter: the reticle becomes the
    // grenade's reticle_center_cross, which grows by (grenadeTimeLeft % 1000)/100 px -- one
    // tick a second -- until the throw; it goes off holdFireTime + fuseTime after the press.
    const cook = x ? cookAt(x.presses, tMs, WEAPONS.stielhandgranate) : null
    const ck = cookRef.current
    if (ck) {
      const on = cfg.xh && eyes && cook && cook.holding && x.alive
      ck.style.display = on ? '' : 'none'
      if (on) {
        ck.style.setProperty('--ck-size', `${(cook.reticleSize * v).toFixed(1)}px`)
        ck.dataset.left = (cook.timeLeftMs / 1000).toFixed(1)
      }
    }

    // Hip crosshair (B's ask 4): CG_DrawReticleSides with this weapon's numbers.
    const el = xhRef.current
    if (el) {
      // Lane R3: also in third person, over the point he aims at (placeAim), so a hit marker has
      // somewhere to be. ADS still hides it, as in the game.
      const follow = camRef.current === 'follow'
      const on = cfg.xh && (eyes || follow) && x && x.row && x.row.side && x.alive && !x.ads && !(cook && cook.holding)
      el.style.display = on ? '' : 'none'
      if (on) {
        const g = reticleGeom(x.row, x.scale, x.stance, h)
        el.style.setProperty('--xh-gap', `${g.spread.toFixed(1)}px`)
        el.style.setProperty('--xh-size', `${g.size.toFixed(1)}px`)
        el.style.setProperty('--xh-alpha', g.alpha.toFixed(3))
        // crosshairColorChange (red over an enemy within enemyCrosshairRange) is NOT drawn:
        // the engine decides it with a trace along the view, and the files carry neither the
        // view pitch nor anything to trace against occlusion with. A horizontal-only guess
        // lit the crosshair red through walls, so it is left white (replay.md §8.11).
      }
    }

    // Damage (B's ask 6): the red flash and the direction smear, from RECORDED health drops;
    // a down with no recorded drop (the file's last-stand inference) flashes too.
    const hits = (track && track.hits) || []
    let flash = 0
    const icons = []
    const slot = focusRef.current
    for (const hit of hits) {
      if (hit.slot !== slot) continue
      const age = tMs - hit.ms
      if (age < 0 || age > HUD.damageIcon.timeMs) continue
      const dmg = hit.from - hit.to
      const kick = Math.min(HUD.viewKick.max, Math.max(HUD.viewKick.min, dmg * HUD.viewKick.scale))
      let pitchKick = -kick
      let dirYaw = null
      if (hit.src && x) {
        // Direction of the damage = attacker -> victim; forwardFrac = its dot with the view.
        dirYaw = Math.atan2(x.y - hit.src[1], x.x - hit.src[0]) * 180 / Math.PI
        pitchKick = kick * Math.cos((dirYaw - x.yaw) * Math.PI / 180)
      }
      if (age < HUD.flashMs) flash = Math.max(flash, Math.min(5, Math.abs((HUD.flashMs - age) * pitchKick / 500)) / 5 * 0.7)
      if (dirYaw !== null && x) {
        const t = age / HUD.damageIcon.timeMs
        icons.push({ angle: x.yaw - dirYaw, alpha: Math.min(1, 2 - 2 * t) })
      }
    }
    for (const d of downs) {
      if (d.slot !== slot) continue
      const age = tMs - d.ms
      if (age >= 0 && age < HUD.flashMs) flash = Math.max(flash, (1 - age / HUD.flashMs) * 0.7)
    }
    const fl = flashRef.current
    if (fl) fl.style.opacity = cfg.dmg && eyes ? flash.toFixed(3) : '0'
    for (let k = 0; k < dmgRefs.current.length; k++) {
      const e = dmgRefs.current[k]
      if (!e) continue
      const ic = icons[k]
      if (!ic || !cfg.dmg || !eyes) { e.style.opacity = '0'; continue }
      e.style.opacity = ic.alpha.toFixed(3)
      e.style.transform = `rotate(${ic.angle.toFixed(1)}deg)`
      e.style.setProperty('--dmg-w', `${HUD.damageIcon.w * v}px`)
      e.style.setProperty('--dmg-h', `${HUD.damageIcon.h * v}px`)
      e.style.setProperty('--dmg-r', `${HUD.damageIcon.offset * v}px`)
    }
    // The low-health overlay (_gameskill.gsc healthOverlay/fadeFunc): at or under the
    // cutoff it pulses every 0.8 s, full then 0.9 then 0.8 of full.
    const lo = lowRef.current
    if (lo) {
      let a = 0
      if (cfg.dmg && eyes && x && x.alive && x.health > 0 && x.health / 100 <= HUD.lowHealthCutoff) {
        const ph = ((tMs / 1000) % HUD.lowHealthPulse) / HUD.lowHealthPulse
        a = ph < 0.1 ? ph / 0.1 : ph < 0.4 ? 1 : ph < 0.6 ? 1 - (ph - 0.4) / 0.2 * 0.1 : 0.9 - (ph - 0.6) / 0.4 * 0.1
      }
      lo.style.opacity = a.toFixed(3)
    }

    // Lane R3. The hit marker (his shot landed: `hit`), the blood (he was swiped: `damage`) and
    // the timed power-up chips. Marker and blood are the watched player's own, so they show
    // while following him (first or third person), never in free cam.
    const following = camRef.current !== 'free'
    const fxOn = cfg.fx !== false
    const hm = hitRef.current
    if (hm) {
      const m = hitMarkerAt(F, slot, tMs, fxScratch.hit)
      const a = fxOn && following ? m.alpha : 0
      hm.style.opacity = a.toFixed(3)
      hm.classList.toggle('head', m.part === 'head')
      hm.style.setProperty('--hm-s', (v * (m.part === 'head' ? 1.25 : 1)).toFixed(3))
    }
    const bl = bloodRef.current
    if (bl) {
      const b = bloodAt(F, slot, tMs, fxScratch.blood)
      bl.style.opacity = (fxOn && cfg.dmg && following ? b.alpha : 0).toFixed(3)
    }
    const chips = chipsAt(fxOn && cfg.hud ? F : null, tMs, fxScratch.chips)
    for (let k = 0; k < CHIP_SLOTS; k++) {
      const el = chipRefs.current[k]
      if (!el) continue
      const c = chips[k]
      if (!c) { if (el.style.display !== 'none') el.style.display = 'none'; continue }
      el.style.display = ''
      if (el.dataset.kind !== c.kind) {
        el.dataset.kind = c.kind
        el.firstChild.textContent = c.label
      }
      el.lastChild.textContent = c.text
      el.classList.toggle('low', c.leftMs < 5000)
    }
  }, [track, t0, downs, F, fxScratch])

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
        applyFx(s, step)
        drawOverlays(s)
      }
      api.render()
      placeAim()
      // Lane R3: the sound scheduler rides the same clock (fx.js CueScheduler, sound.js).
      const snd = soundRef.current
      if (snd) {
        sndCtx.focus = focusRef.current
        sndCtx.mode = camRef.current
        snd.update(t0 + timeRef.current * 1000, playingRef.current, speedRef.current, sndCtx)
      }

      if (s && now - hudAt > 66) {
        hudAt = now
        setHud({
          t: timeRef.current, round: s.round, alive: s.alive, left: s.left, players: s.list, tick: s.i,
          weapon: s.xh ? { name: s.xh.name, raw: s.xh.raw.raw, source: s.xh.raw.source } : null,
        })
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [track, total, sample, drawOverlays, applyFx, placeAim, sndCtx, t0])

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
      if (e.code === 'Tab') {
        // Hold to show, like the game's scoreboard. Tab would otherwise move focus.
        e.preventDefault()
        if (settingsRef.current.sb) setBoard(e.type === 'keydown')
        return
      }
      if (e.type === 'keyup') { api && api.state.keys.delete(e.code); return }
      api && api.state.keys.add(e.code)
      if (e.code === 'Space') { e.preventDefault(); togglePlayRef.current() }
      else if (e.code === 'KeyM') toggleMuteRef.current()
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
    // Lane R3: a seek or a scrub drops every queued sound; nothing skipped is played late.
    if (soundRef.current) soundRef.current.seek(t0 + timeRef.current * 1000)
    setHud((h) => ({ ...h, t: timeRef.current }))
  }, [total, t0])

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

  // Points only where the recording has them (§8.12).
  const scoreOf = (p) => {
    const tp = track && track.players.find((x) => x.slot === p.slot)
    return tp && tp.has_score === false ? '—' : p.score
  }
  const sbRows = () => {
    const tMs = t0 + hud.t * 1000
    const solo = track.players.length === 1
    const kills = track.events.filter((e) => e.t === 'kill' && e.ms <= tMs)
    // Lane R3: what each is holding at the playhead, by its display name (fx.js).
    const withWeapon = (row) => {
      const tp = track.players.find((x) => x.slot === row.slot)
      const k = hud.tick == null ? 0 : hud.tick
      const w = weaponAt(F, row.slot, tMs, () => colWeapon(tp, k), {})
      return { ...row, weapon: w.name ? displayName(w.name, w.pap, assets) : null, pap: w.pap }
    }
    return hud.players.map((p) => withWeapon((() => {
      const tp = track.players.find((x) => x.slot === p.slot)
      // §16 (bug 7): the game's own counters, when the file has them — the same numbers
      // the in-game Tab scoreboard shows, kills attributed per player even with company.
      if (tp && Array.isArray(tp.counters) && tp.counters.length) {
        let c = null
        for (const row of tp.counters) { if (row[0] <= tMs) c = row; else break }
        return {
          slot: p.slot,
          name: p.name,
          points: tp.has_score === false ? '—' : p.score,
          kills: c ? c[1] : 0,
          downs: c ? c[2] : 0,
          revives: c ? c[3] : 0,
          _pts: tp.has_score === false ? -1 : p.score,
        }
      }
      const own = kills.filter((e) => e.slot === p.slot).length
      const unattributed = kills.filter((e) => e.slot === undefined).length
      return {
        slot: p.slot,
        name: p.name,
        points: tp && tp.has_score === false ? '—' : p.score,
        // Solo: every kill is the one player's. With company, unattributed kills are not
        // guessed at: attributed ones count, and none at all reads "—".
        kills: solo ? own + unattributed : (own || (unattributed ? '—' : 0)),
        downs: downs.filter((d) => d.slot === p.slot && d.ms <= tMs).length,
        // WaW's Revives column is revives GIVEN: `revive.by` is the reviver (`slot` is the
        // one who got up). Older sims sent only `slot`, so that stays the fallback.
        revives: track.events.filter((e) => e.t === 'revive' && (e.by !== undefined ? e.by === p.slot : e.slot === p.slot) && e.ms <= tMs).length,
        _pts: tp && tp.has_score === false ? -1 : p.score,
      }
    })())).sort((a, b) => b._pts - a._pts || a.slot - b.slot)
  }

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

      {/* WaW overlays, drawn under the chrome. Every one is driven from drawOverlays(). */}
      <div className="r3d-waw-low" ref={lowRef} aria-hidden="true" />
      <div className="r3d-waw-flash" ref={flashRef} aria-hidden="true" />
      <div className="r3d-waw-dmg" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((k) => (
          <div key={k} className="r3d-waw-dmg-arm" ref={(e) => { dmgRefs.current[k] = e }}><i /></div>
        ))}
      </div>
      <div className="r3d-zm-xh" ref={xhRef} aria-hidden="true" style={{ display: 'none' }}>
        <i className="u" /><i className="d" /><i className="l" /><i className="r" />
      </div>
      <div className="r3d-waw-cook" ref={cookRef} aria-hidden="true" style={{ display: 'none' }}>
        <i className="u" /><i className="d" /><i className="l" /><i className="r" />
      </div>
      {/* Lane R3: the hit marker (on the crosshair), the blood on a swipe, the power-up timers. */}
      <div className="r3d-fx-blood" ref={bloodRef} aria-hidden="true" />
      <div className="r3d-fx-hit" ref={hitRef} aria-hidden="true">
        <i className="a" /><i className="b" /><i className="c" /><i className="d" />
      </div>
      <div className="r3d-fx-chips" aria-live="off">
        {Array.from({ length: CHIP_SLOTS }, (_, k) => (
          <div key={k} className="r3d-fx-chip" ref={(e) => { chipRefs.current[k] = e }} style={{ display: 'none' }}>
            <span className="r3d-fx-chip-l" /><b className="r3d-fx-chip-t" />
          </div>
        ))}
      </div>

      {settings.hud && (
        <div className="r3d-waw-hud" title="Round and zombies left">
          <div className="r3d-waw-round">
            {(() => {
              const g = roundGlyphs(hud.round)
              if (g.number) return <span className="r3d-waw-num">{g.number}</span>
              return g.tallies.map((n, k) => <Chalk key={k} n={n} />)
            })()}
          </div>
          {hud.left != null && hud.round > 0 && (
            <div className="r3d-waw-left"><b>{hud.left}</b><span>left</span></div>
          )}
        </div>
      )}

      <div className="r3d-zm-score">
        {hud.players.map((p) => (
          <div key={p.slot} className={'r3d-zm-row' + (p.slot === focus ? ' on' : '') + (p.alive ? '' : ' down')}
            onClick={() => setFocus(p.slot)} title="Watch from this player">
            <span className="r3d-zm-dot" style={{ background: SLOT_COLORS[p.slot % SLOT_COLORS.length] }} />
            <span className="r3d-zm-name">{p.name}</span>
            <span className={'r3d-zm-hp' + (p.health < 50 ? ' hurt' : '')}>
              <i style={{ width: `${Math.max(0, Math.min(100, p.health))}%` }} />
            </span>
            <span className="r3d-zm-pts">{scoreOf(p)}</span>
          </div>
        ))}
      </div>

      <div className="r3d-zm-feed">
        {feed.map((e, n) => (
          <div key={n} className={'r3d-zm-ev' + (e.t === 'points' ? ' pts' : (e.t === 'down' || e.t === 'bleedout' || e.t === 'hit') ? ' bad' : '')}>
            {/* The same clock the scrubber shows, so a line in the feed and the time
                under the playhead are the same number: both are measured from the first
                snapshot, not from the moment the server process started. */}
            <span className="r3d-zm-ev-t">{clock((e.ms - t0) / 1000)}</span>
            {e.t === 'points' && <span>slot {e.slot} <b>+{e.delta}</b> {e.why}</span>}
            {/* A kill is its own record now, not an inference off a points line. `how`
                is the referee's word for why the zombie stopped existing. */}
            {e.t === 'kill' && <span><b>kill</b>{e.slot === undefined ? '' : ` · slot ${e.slot}`}{e.how ? ` · ${e.how}` : ''}</span>}
            {e.t === 'down' && <span>slot {e.slot} <b>down</b>{e.inferred ? ' (inferred)' : ''}</span>}
            {e.t === 'hit' && <span>slot {e.slot} <b>hit {e.delta}</b></span>}
            {e.t === 'frag' && <span>frag <b>{e.cooked > 0 ? `cooked ${e.cooked.toFixed(1)}s` : 'thrown'}</b> · went off (inferred)</span>}
            {e.t === 'revive' && <span>slot {e.slot} <b>revived</b></span>}
            {e.t === 'powerup' && <span>{e.slot == null ? 'power-up' : `slot ${e.slot}`} <b>{POWERUP_LABEL[e.kind] || 'Power-up'}</b></span>}
            {e.t === 'pap' && <span>slot {e.slot} <b>{e.state === 'done' ? 'Pack-a-Punched' : 'Pack-a-Punch'}</b>{e.name ? ` · ${displayName(e.name, e.state === 'done', assets)}` : ''}</span>}
            {e.t === 'bleedout' && <span>slot {e.slot} <b>bled out</b></span>}
            {e.t === 'chat' && <span>slot {e.slot}: {e.text}</span>}
            {e.t === 'referee' && <span>{e.label || e.id}</span>}
            {e.t === 'notify' && <span>{e.name}</span>}
          </div>
        ))}
      </div>

      <div className="r3d-bar">
        <button className="r3d-play r3d-icon" onClick={togglePlay} title="Play/pause (space)">
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

        {/* Lane R3: sound. Off until Play is pressed (browsers allow audio only after a gesture);
            this button mutes/unmutes (M). No manifest: no sounds, and the button says so. */}
        <button className={'r3d-x r3d-icon r3d-snd' + (snd.available ? '' : ' off')} onClick={toggleMute}
          disabled={!snd.available} aria-pressed={snd.enabled && !snd.muted}
          title={!snd.available ? 'No sounds for this replay' : !snd.enabled ? 'Sound (starts with Play)' : snd.muted ? 'Unmute (M)' : 'Mute (M)'}>
          <IconSound on={snd.available && snd.enabled && !snd.muted} />
        </button>

        <button className="r3d-x r3d-icon r3d-speed-btn" onClick={() => setSpeedOpen((v) => !v)} title={`Replay settings · speed ${speed}x`}><IconCog /></button>
        {speedOpen && (
          <div className="r3d-menu r3d-menu-speed r3d-menu-settings">
            <div className="r3d-set-lab">Speed</div>
            <div className="r3d-seg r3d-seg-row">
              {SPEEDS.map((s) => (
                <button key={s} className={'mono' + (s === speed ? ' on' : '')}
                  onClick={() => setSpeed(s)}>{s}x</button>
              ))}
            </div>
            <div className="r3d-set-lab">WaW overlays</div>
            {[['hud', 'Round + zombies left'], ['xh', 'Crosshair + grenade'], ['dmg', 'Damage effects'], ['fx', 'Weapons, hits + power-ups'], ['sb', 'Scoreboard (hold Tab)']].map(([k, label]) => (
              <button key={k} className={'r3d-set-tog' + (settings[k] ? ' on' : '')} onClick={() => toggle(k)} aria-pressed={settings[k]}>
                <span className="r3d-set-box" />{label}
              </button>
            ))}
            {hud.weapon && (
              <div className="r3d-set-note">
                Weapon {hud.weapon.raw || '—'}: {hud.weapon.source === 'index-proven' ? hud.weapon.name
                  : hud.weapon.name == null && (hud.weapon.raw === '#0' || !hud.weapon.raw) ? 'none'
                    : `unknown index, ${DEFAULT_WEAPON} numbers`}
              </div>
            )}
            <div className="r3d-set-note">
              Zombies left: {track.zombies_left_source === 'stock-formula' ? 'stock round formula − recorded deaths' : track.zombies_left_source ? 'assumed formula (custom map)' : 'n/a'}.
              Facing: {yawRecorded ? 'recorded' : 'direction of travel'}.
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

      {board && settings.sb && (() => {
        // WaW's scoreboard columns are the game's own strings (code_post_gfx.ff CGAME_SB_*:
        // Points, Kills, Downs, Revives). Only what the recording supports is filled in:
        // points are NOT recorded by the real DLL yet (player_int("score") is unbound), so
        // they read "—"; kills are the referee's unattributed `kill` events, credited to the
        // player only when there is one; downs are inferred; revives only from `revive` events.
        const rows = sbRows()
        return (
          <div className="r3d-waw-sb" role="dialog" aria-label="Scoreboard">
            <div className="r3d-waw-sb-head">
              <span>{track.map_name}</span>
              <span>Round {hud.round || '—'}</span>
            </div>
            <table>
              <thead><tr><th>Player</th><th>Weapon</th><th>Points</th><th>Kills</th><th>Downs</th><th>Revives</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.slot} className={r.slot === focus ? 'on' : ''}>
                    <td><i style={{ background: SLOT_COLORS[r.slot % SLOT_COLORS.length] }} />{r.name}</td>
                    <td className={'r3d-waw-sb-wpn' + (r.pap ? ' pap' : '')}>{r.weapon || '—'}</td>
                    <td>{r.points}</td><td>{r.kills}</td><td>{r.downs}</td><td>{r.revives}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="r3d-waw-sb-foot">{rows.some((r) => r.points === '—') ? 'No points in this recording.' : ''}{rows.length > 1 && rows.some((r) => r.kills === '—') ? ' Kills are not per player in multiplayer.' : ''}</div>
          </div>
        )
      })()}

      {DEBUG && debugInfo && (
        <pre className="r3d-waw-debug">{[
          `export ${debugInfo.built}  obj scale 1/${debugInfo.scale || 1}`,
          debugInfo.ext ? `world extent x ${debugInfo.ext.lo[0]}..${debugInfo.ext.hi[0]}  y ${debugInfo.ext.lo[1]}..${debugInfo.ext.hi[1]}  z ${debugInfo.ext.lo[2]}..${debugInfo.ext.hi[2]}  (span ${debugInfo.ext.hi[0] - debugInfo.ext.lo[0]} x ${debugInfo.ext.hi[1] - debugInfo.ext.lo[1]})` : 'no world shell',
          debugInfo.first ? `first live tick ${debugInfo.first.at.join(',')}  -> nearest of ${debugInfo.spawns} spawns ${debugInfo.first.d.toFixed(1)} u ${debugInfo.first.d <= 20 ? 'OK' : 'FAIL'}` : '',
          ...debugInfo.anchors,
        ].join('\n')}</pre>
      )}

      {err && <div className="r3d-state r3d-err">{err}</div>}
      <Boot state={boot} progress={progress} />
    </div>
  )
}
