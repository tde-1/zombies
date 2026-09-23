// The boot queue: real games boot one at a time, a player's before an agent's, and a boot
// whose lease has gone never starts.
//
// ONE GAME BOOTS AT A TIME (vps.md §15): `--boot 4` in one tick got one instance to a loaded
// map; started one after another, each waited on, they came up. Until 2026-09-23 that rule
// was a promise chain in `host.js boot()`, and it had three faults, all of which showed in
// the 12:12-12:15 UTC incident (host.md §15):
//
//   1. A queued boot could not be cancelled. Retiring its lease removed the instance from
//      the manager, but the link in the chain still ran `inst.start()` when its turn came:
//      B's lease m_3a672469 was retired at 12:12:46 and its game started at 12:13:36 anyway,
//      an orphan the host then called "unknown" and ignored.
//   2. It was first come, first served. B's lease queued behind an agent's boot that never
//      loaded its map, for the whole 90 s gate.
//   3. The 90 s gate timer started when a boot was QUEUED, not when it started, so a boot
//      that waited 85 s in line gave the next one 5 s.
//
// This is that rule as an object: `add`, `cancel`, `settle`. Real entries go ahead of every
// queued agent entry (FIFO among each). `admit(entry)` is asked just before a boot starts —
// the RAM guard lives there — and may say go, wait (retry later), or drop.
import { EventEmitter } from 'node:events'

export class BootQueue extends EventEmitter {
  /**
   * @param {object}   o
   * @param {number}  [o.gateMs=90000]   how long one boot may hold the next back
   * @param {number}  [o.retryMs=5000]   how soon to ask `admit` again after a `wait`
   * @param {Function}[o.admit]          async (entry) => { go: true } | { wait: why } | { drop: why }
   * @param {object}  [o.log]
   */
  constructor({ gateMs = 90_000, retryMs = 5_000, admit = null, log = null } = {}) {
    super()
    this.gateMs = gateMs
    this.retryMs = retryMs
    this.admit = admit || (async () => ({ go: true }))
    this.log = log || { info() {}, warn() {}, error() {}, debug() {} }
    this.queue = []          // entries waiting their turn, in boot order
    this.active = null       // the entry whose game is booting now
    this.pumping = false
    this.retryTimer = null
    this.gateTimer = null
  }

  /** Waiting + booting. `mapCache.busy` and the heartbeat read it. */
  get size() { return this.queue.length + (this.active ? 1 : 0) }

  has(id) { return (this.active && this.active.id === id) || this.queue.some((e) => e.id === id) }

  /** 0 = booting now, 1 = next, ...; -1 = not here. */
  position(id) {
    if (this.active && this.active.id === id) return 0
    const i = this.queue.findIndex((e) => e.id === id)
    return i < 0 ? -1 : i + 1
  }

  /**
   * Queue a boot. `entry`: { id, real, start: () => boolean, label? }.
   * `start()` spawns the process and returns false if it could not.
   * @returns {number} how many boots are ahead of it (0: it is next or booting)
   */
  add(entry) {
    const e = { real: false, label: entry.id, ...entry, queuedAt: Date.now() }
    if (e.real) {
      // Ahead of every queued agent boot, behind real ones queued before it.
      let i = 0
      while (i < this.queue.length && this.queue[i].real) i++
      this.queue.splice(i, 0, e)
    } else this.queue.push(e)
    const ahead = this.position(e.id) - (this.active ? 0 : 1)
    this.pump()
    return Math.max(0, ahead)
  }

  /**
   * The lease went away. A queued entry is removed and will never start; the active one
   * releases the gate (its process is the caller's to stop). Returns where it was.
   */
  cancel(id, why = 'cancelled') {
    const i = this.queue.findIndex((e) => e.id === id)
    if (i >= 0) {
      const [e] = this.queue.splice(i, 1)
      e.cancelled = true
      this.log.info(`boot of ${id} cancelled while queued (${why}) - it will not start`)
      this.emit('cancelled', e, why)
      return 'queued'
    }
    if (this.active && this.active.id === id) {
      this.active.cancelled = true
      this.release(id, `cancelled: ${why}`)
      return 'active'
    }
    return null
  }

  /** The active boot has finished (map_loaded, exit, failure): the next may go. */
  settle(id, why = 'settled') {
    if (!this.active || this.active.id !== id) return false
    this.release(id, why)
    return true
  }

  release(id, why) {
    clearTimeout(this.gateTimer); this.gateTimer = null
    const e = this.active
    this.active = null
    this.log.debug?.(`boot gate released by ${id}: ${why}`)
    this.emit('released', e, why)
    this.pump()
  }

  /** Start the next boot if nothing is booting. Re-entrant calls are no-ops. */
  async pump() {
    if (this.active || this.pumping || !this.queue.length) return
    this.pumping = true
    clearTimeout(this.retryTimer); this.retryTimer = null
    try {
      while (!this.active && this.queue.length) {
        const e = this.queue[0]
        let verdict
        try { verdict = (await this.admit(e)) || { go: true } } catch (err) { verdict = { go: true, why: `admit threw: ${err.message}` } }
        // Cancelled, or jumped by a real entry, while admit was deciding: look again.
        if (e.cancelled || this.queue[0] !== e) continue
        if (verdict.drop) {
          this.queue.shift()
          this.log.warn(`boot of ${e.id} dropped: ${verdict.drop}`)
          this.emit('dropped', e, verdict.drop)
          continue
        }
        if (verdict.wait) {
          e.waitingSince = e.waitingSince || Date.now()
          e.waitWhy = verdict.wait
          this.emit('waiting', e, verdict.wait)
          this.retryTimer = setTimeout(() => this.pump(), this.retryMs)
          this.retryTimer.unref?.()
          break
        }
        this.queue.shift()
        let started = false
        try { started = !!e.start() } catch (err) { this.log.error(`boot of ${e.id} threw: ${err.message}`) }
        if (!started) { this.emit('not_started', e); continue }
        this.active = e
        e.startedAt = Date.now()
        // The gate counts from the START of this boot, not from when it was queued.
        this.gateTimer = setTimeout(() => {
          if (this.active !== e) return
          this.log.warn(`${e.id} has not loaded its map ${Math.round(this.gateMs / 1000)} s after its boot started - letting the next boot go`)
          this.release(e.id, 'gate timeout')
        }, this.gateMs)
        this.gateTimer.unref?.()
        this.emit('started', e)
      }
    } finally {
      this.pumping = false
    }
    // Something was added or cancelled while admit was awaited and nothing is booting.
    if (!this.active && this.queue.length && !this.retryTimer) this.pump()
  }

  clear() {
    clearTimeout(this.gateTimer); clearTimeout(this.retryTimer)
    for (const e of this.queue) e.cancelled = true
    this.queue = []; this.active = null
  }
}
