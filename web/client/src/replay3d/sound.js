// Replay sound (lane R3, replay.md §12): gunfire, hit markers, the swipe, the Pack-a-Punch
// jingle, power-up pickups and the announcer.
//
// SHAPE. Movement's replay3d/audio.js (CSGO-Matchmaker) is the pattern: a manifest, samples
// decoded only after a gesture, a LOOKAHEAD scheduler run off the viewer's own clock, and every
// queued sound thrown away on a pause, a seek or a speed change. The scheduler is fx.js's
// CueScheduler (pure, unit-tested); this file is the noise. Positional audio is three.js's own:
// an AudioListener on the camera (the viewer camera is the listener, in every mode) and a pool
// of PositionalAudio objects placed where each sound happened; 2D sounds (the hit marker, the
// swipe, the announcer) are a pool of plain THREE.Audio.
//
// AUTOPLAY. Browsers refuse audio before a user gesture, so nothing here exists until the viewer
// calls enable() from the Play click (or Space, or the speaker button). Until then the replay is
// silent by design, and a missing manifest keeps it silent for good -- never broken.
import { AudioListener, PositionalAudio, Audio as ThreeAudio, Group, Vector3 } from 'three'
import { toThree } from './scene.js'
import { CueScheduler, soundsFor, soundUrl } from './fx.js'

const MUTED_KEY = 'enw.replay3d.muted'
const loadMuted = () => { try { return localStorage.getItem(MUTED_KEY) === '1' } catch { return false } }
const saveMuted = (m) => { try { localStorage.setItem(MUTED_KEY, m ? '1' : '0') } catch { /* no storage */ } }

const POOL_3D = 24
const POOL_2D = 8
const MASTER = 0.8
const tmpV = new Vector3()

// Per-cue loudness. The shot of the player being watched is not louder than anyone else's --
// it is nearer, and the panner does that.
const GAIN = { fire: 0.7, hit: 0.55, damage: 0.8, pap: 0.9, pap_done: 0.8, powerup_spawn: 0.6, powerup_pickup: 0.85, announce: 1 }

export class ReplaySound {
  /**
   * @param api     createScene()'s object (camera, scene)
   * @param assets  /mapdata/_assets.json, or null (then: silent)
   * @param fx      fx.js buildFx()'s index
   */
  constructor(api, assets, fx) {
    this.api = api
    this.assets = assets
    this.fx = fx
    this.sched = new CueScheduler(fx)
    this.sched.onDrop = () => this.stopAll()
    this.listener = null
    this.pool3 = []
    this.pool2 = []
    this.next3 = 0
    this.next2 = 0
    this.group = null
    this.buffers = new Map()      // url -> AudioBuffer | 'loading' | 'failed'
    this.muted = loadMuted()
    this.enabled = false
    this.played = 0
    // Wanted samples: only what this replay's cues can play.
    this.urls = new Set()
    if (assets && fx) {
      for (const c of fx.cues) {
        for (const pap of c.kind === 'fire' ? [false, true] : [false]) {
          for (const v of soundsFor(c, assets, pap) || []) { const u = soundUrl(v); if (u) this.urls.add(u) }
        }
      }
    }
  }

  /** Whether this replay can make any sound at all. */
  get available() { return this.urls.size > 0 }

  /** Call from a user gesture. Creates the listener and starts fetching samples. */
  enable() {
    if (!this.available) return false
    if (!this.listener) {
      try {
        this.listener = new AudioListener()
      } catch { return false }
      this.api.camera.add(this.listener)
      this.group = new Group()
      this.group.name = 'r3-sound'
      this.api.scene.add(this.group)
      for (let i = 0; i < POOL_3D; i++) {
        const a = new PositionalAudio(this.listener)
        // Inches: full volume inside ~12 ft, a gunshot across Nacht still audible.
        a.setRefDistance(150)
        a.setRolloffFactor(1.1)
        a.setDistanceModel('inverse')
        a.setMaxDistance(6000)
        this.group.add(a)
        this.pool3.push(a)
      }
      for (let i = 0; i < POOL_2D; i++) this.pool2.push(new ThreeAudio(this.listener))
      for (const u of this.urls) this.load(u)
    }
    const ctx = this.listener.context
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    this.enabled = true
    this.applyGain()
    return true
  }

  applyGain() { if (this.listener) this.listener.setMasterVolume(this.muted ? 0 : MASTER) }
  setMuted(m) {
    this.muted = !!m
    saveMuted(this.muted)
    if (this.muted) this.stopAll()
    this.applyGain()
  }

  load(u) {
    if (this.buffers.has(u)) return
    this.buffers.set(u, 'loading')
    const ctx = this.listener.context
    fetch(u).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer() })
      .then((b) => ctx.decodeAudioData(b))
      .then((buf) => { this.buffers.set(u, buf) })
      .catch(() => { this.buffers.set(u, 'failed') })
  }

  stopAll() {
    for (const a of this.pool3) if (a.isPlaying) { try { a.stop() } catch { /* ended */ } }
    for (const a of this.pool2) if (a.isPlaying) { try { a.stop() } catch { /* ended */ } }
  }

  /** A seek or a scrub: nothing queued survives, nothing skipped is played late. */
  seek(ms) { this.sched.seek(ms) }

  /**
   * Every frame.
   * @param ms       the replay clock (the events' own ms)
   * @param playing  whether time is moving
   * @param rate     playback speed
   * @param ctx      { focus, mode, posOf(pid, ms, outVec3) -> bool, papAt(pid, ms) -> bool }
   */
  update(ms, playing, rate, ctx) {
    if (!this.enabled || this.muted || !this.listener || (typeof document !== 'undefined' && document.hidden)) {
      // Keep the cursor on the clock so turning the sound on does not replay the past.
      this.sched.update(ms, false, rate, null)
      return
    }
    this.sched.update(ms, playing, rate, (c, delay) => this.cue(c, delay, ctx))
  }

  cue(c, delay, ctx) {
    const following = ctx.mode !== 'free'
    switch (c.kind) {
      case 'hit':
      case 'damage':
        // Only for the player being watched, as the game only plays them to that player.
        if (!following || c.pid !== ctx.focus) return
        return this.play2(soundsFor(c, this.assets)?.[0], delay, GAIN[c.kind])
      case 'fire': {
        const pap = ctx.papAt ? ctx.papAt(c.pid, c.ms) : false
        const s = soundsFor(c, this.assets, pap)
        if (!s || !ctx.posOf(c.pid, c.ms, tmpV)) return
        return this.play3(s[0], delay, tmpV, GAIN.fire)
      }
      case 'pap':
      case 'pap_done': {
        const s = soundsFor(c, this.assets)
        if (!s || !ctx.posOf(c.pid, c.ms, tmpV)) return
        return this.play3(s[0], delay, tmpV, GAIN[c.kind])
      }
      case 'powerup_spawn':
      case 'powerup_pickup': {
        const s = soundsFor(c, this.assets)
        if (!s) return
        if (Number.isFinite(c.x)) {
          toThree(c.x, c.y, c.z + 24, tmpV)
          this.play3(s[0], delay, tmpV, GAIN[c.kind])
        } else this.play2(s[0], delay, GAIN[c.kind])
        // The announcer is heard by everyone, everywhere.
        if (s[1]) this.play2(s[1], delay + 0.15, GAIN.announce)
        return
      }
      default:
    }
  }

  buffer(v) {
    const u = soundUrl(v)
    if (!u) return null
    const b = this.buffers.get(u)
    if (b === undefined) { this.urls.add(u); this.load(u); return null }
    return typeof b === 'string' ? null : b
  }

  play3(v, delay, three, gain) {
    const buf = this.buffer(v)
    if (!buf) return
    const a = this.pool3[this.next3]
    this.next3 = (this.next3 + 1) % this.pool3.length
    if (a.isPlaying) { try { a.stop() } catch { /* ended */ } }
    a.position.copy(three)
    a.updateMatrixWorld(true)
    a.setBuffer(buf)
    a.setVolume(gain)
    a.play(delay)
    this.played++
  }

  play2(v, delay, gain) {
    const buf = this.buffer(v)
    if (!buf) return
    const a = this.pool2[this.next2]
    this.next2 = (this.next2 + 1) % this.pool2.length
    if (a.isPlaying) { try { a.stop() } catch { /* ended */ } }
    a.setBuffer(buf)
    a.setVolume(gain)
    a.play(delay)
    this.played++
  }

  info() {
    return {
      available: this.available, enabled: this.enabled, muted: this.muted, played: this.played,
      buffers: [...this.buffers.entries()].map(([u, b]) => [u, typeof b === 'string' ? b : 'ready']),
      context: this.listener ? this.listener.context.state : null,
    }
  }

  dispose() {
    this.stopAll()
    if (this.group) this.api.scene.remove(this.group)
    if (this.listener) {
      this.api.camera.remove(this.listener)
      try { this.listener.gain.disconnect() } catch { /* gone */ }
    }
    this.pool3.length = 0
    this.pool2.length = 0
  }
}
