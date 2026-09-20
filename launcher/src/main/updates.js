// Updates, in the two lanes B asked for (spec 13 §2).
//
//   Web changes: the wrapped site refreshes itself, BUT NEVER MID-SOMETHING. Not while
//   the player is in game, not mid-action (typing, setting up a party, filling a form),
//   not during an install. It waits for an idle moment.
//
//   App / client DLL: silent background download, applied ON THE NEXT LAUNCH. Never
//   mid-game. Verified play requires the current client.
//
// There is no update server in this build and there will not be one tonight (no cloud,
// no publishing). `updateFeed` may point at a local folder or a local http endpoint; if
// it is null this module checks nothing and says so.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { P, assertWritable, ensureDirs } from './paths.js'

const PENDING = () => path.join(P.updates, 'pending.json')

export class Updater extends EventEmitter {
  constructor({ feed = null, intervalMs = 15 * 60 * 1000, currentVersion = '0.0.0' } = {}) {
    super()
    this.feed = feed
    this.intervalMs = intervalMs
    this.currentVersion = currentVersion
    this.timer = null
    this.busy = false
  }

  start() {
    if (!this.feed) { this.emit('status', { checking: false, reason: 'no update feed configured (local build)' }); return }
    const tick = () => { this.check().catch(() => {}) }
    this.timer = setInterval(tick, this.intervalMs)
    setTimeout(tick, 5000)
  }

  stop() { clearInterval(this.timer) }

  async check() {
    if (!this.feed || this.busy) return null
    this.busy = true
    try {
      const manifest = await this.readFeed()
      if (!manifest || manifest.version === this.currentVersion) {
        this.emit('status', { checking: false, upToDate: true })
        return null
      }
      const staged = await this.download(manifest)
      fs.writeFileSync(assertWritable(PENDING()), JSON.stringify({ ...manifest, staged, at: new Date().toISOString() }, null, 2))
      // The player is told once, quietly, and nothing happens to their running game.
      this.emit('staged', { version: manifest.version, appliesWhen: 'the next time you start the launcher' })
      return manifest
    } finally { this.busy = false }
  }

  async readFeed() {
    if (this.feed.startsWith('http')) {
      const res = await fetch(this.feed, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      return res.json()
    }
    try { return JSON.parse(fs.readFileSync(path.join(this.feed, 'latest.json'), 'utf8')) } catch { return null }
  }

  async download(manifest) {
    ensureDirs()
    const out = []
    for (const f of manifest.files || []) {
      const dest = assertWritable(path.join(P.updates, path.basename(f.name)))
      if (f.url?.startsWith('http')) {
        const res = await fetch(f.url, { signal: AbortSignal.timeout(120000) })
        if (!res.ok) throw new Error(`download failed: ${f.name}`)
        fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
      } else {
        fs.copyFileSync(path.join(this.feed, f.name), dest)
      }
      const got = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
      if (f.sha256 && got !== f.sha256) { fs.unlinkSync(dest); throw new Error(`${f.name} did not match its hash; discarded`) }
      out.push({ name: f.name, path: dest, sha256: got })
    }
    return out
  }
}

export function pending() {
  try { return JSON.parse(fs.readFileSync(PENDING(), 'utf8')) } catch { return null }
}

// Called at startup, before anything else opens — the only moment it is safe.
export function applyPending({ gameDir = P.game } = {}) {
  const p = pending()
  if (!p) return { applied: false }
  const done = []
  for (const f of p.staged || []) {
    if (/enw_t4\.dll$/i.test(f.name)) {
      const dest = assertWritable(path.join(gameDir, 'binkw32.dll'))
      fs.copyFileSync(f.path, dest)
      done.push(`updated the ENW client in ${dest}`)
    }
  }
  fs.unlinkSync(PENDING())
  return { applied: true, version: p.version, done }
}

// ------------------------------------------------- the "never mid-something" rule --

// The site refresh gate. `reasons` are the things that must all be false.
export class IdleGate {
  constructor() { this.blockers = new Map() }
  block(key, why) { this.blockers.set(key, why) }
  unblock(key) { this.blockers.delete(key) }
  get blocked() { return this.blockers.size > 0 }
  get why() { return [...this.blockers.values()] }
  // Run `fn` at the next idle moment, checking every `everyMs`.
  when(fn, { everyMs = 2000, giveUpMs = 30 * 60 * 1000 } = {}) {
    const until = Date.now() + giveUpMs
    const tick = () => {
      if (!this.blocked) return fn()
      if (Date.now() > until) return
      setTimeout(tick, everyMs)
    }
    tick()
  }
}
