// Launcher telemetry (lane T1; docs/kickstart/telemetry.md §6, launcher.md 2026-09-23).
//
// B: "Any time the client crashes, any time a user has an issue with the launcher or the
// game, I want as much logging as possible ... Crash logs always automatically upload,
// including mine ... Don't sacrifice performance. Store more logs rather than less."
//
// WHAT, WHEN:
//   * every game exit (quit, crash, hang, kill)  -> a `client` bundle
//   * a launcher error / uncaught exception      -> a `launcher` bundle (one per message per 10 min)
//   * the first start after crash.js kept reports on disk -> one `backlog` launcher bundle
//   * Settings -> Send logs now                  -> a `manual` launcher bundle, sent at once
//
// PERFORMANCE RULES (the reason this file is shaped the way it is):
//   * NOTHING while a game is running: no bundle is built and nothing is uploaded until the
//     game has exited and 5 s have passed. The queue re-checks before every step, and an
//     upload in flight is aborted (and retried later, not counted) if a game starts.
//   * One bundle at a time, streamed from disk.
//   * Nothing here throws into a caller; every step is a `telemetry` line in launcher.log.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { newBundleId } from './bundle.cjs'
import { assertWritable } from '../paths.js'
import { Outbox, backoff } from './outbox.js'
import { collectGameBundle, collectLauncherBundle } from './collect.js'
import * as probe from './probe.js'
import { ensureWer } from './wer.js'

export { collectGameBundle, collectLauncherBundle, classifyGame } from './collect.js'
export { Outbox, backoff, BACKOFF_MS } from './outbox.js'

export const QUIET_MS = 5_000
export const SIGNIN_RETRY_MS = 30 * 60_000
export const SAME_ERROR_MS = 10 * 60_000
const NO_SITE_RETRY_MS = 5 * 60_000
const GAME_PAUSE_POLL_MS = 15_000
const POLL_MS = 60_000

export function defaultDirs(P) {
  const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return {
    root: P.root,
    logs: P.logs,
    state: P.state,
    game: P.game,
    maps: P.maps,
    crashes: P.crashes,
    settings: P.settings,
    config: P.config,
    detection: P.detection,
    crashDumps: path.join(LOCAL, 'CrashDumps'),
    ourDumps: path.join(P.crashes, 'dumps'),
    outbox: path.join(P.root, 'telemetry', 'outbox'),
    rejected: path.join(P.root, 'telemetry', 'rejected'),
    stateFile: path.join(P.state, 'telemetry.json'),
  }
}

// Retry-After: seconds or an HTTP date.
export function retryAfterMs(v, now = Date.now()) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (Number.isFinite(n)) return Math.max(0, n * 1000)
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.max(0, t - now) : null
}

export class Telemetry extends EventEmitter {
  // deps:
  //   dirs              defaultDirs(P) (tests pass their own)
  //   api()             the SiteApi or null (needs uploadBundle)
  //   isGameRunning()   true while any game this launcher started is alive
  //   log(line)         one launcher.log line, scope `telemetry`
  //   appVersion, secrets() -> string[] (async ok), steamId() -> string|null
  //   probes            { machine, events, wer, dllSha } (defaults: probe.js + ensureWer)
  //   now, setTimer, clearTimer, quietMs
  constructor(deps = {}) {
    super()
    this.dirs = deps.dirs
    this.api = deps.api || (() => null)
    this.isGameRunning = deps.isGameRunning || (() => false)
    this._log = deps.log || (() => {})
    this.appVersion = deps.appVersion || '0.0.0'
    this.secrets = deps.secrets || (() => [])
    this.steamId = deps.steamId || (() => null)
    this.now = deps.now || Date.now
    this.setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    this.clearTimer = deps.clearTimer || clearTimeout
    this.quietMs = deps.quietMs ?? QUIET_MS
    this.gamePollMs = deps.gamePollMs ?? GAME_PAUSE_POLL_MS
    this.abortPollMs = deps.abortPollMs ?? 2000
    this.werResult = null
    this.probes = deps.probes || {
      machine: () => probe.machine(),
      events: (o) => probe.events(o),
      wer: () => this.werResult || this.checkWer(),
      dllSha: (p) => probe.fileSha256(p),
    }
    this.outbox = new Outbox({ dir: this.dirs.outbox, rejectedDir: this.dirs.rejected, log: (l) => this.log(l), now: this.now })
    this.quietUntil = 0
    this.timer = null
    this.running = false
    this.rerun = false
    this.stopped = false
    this.recentErrors = new Map()
    this.pausedLogged = false
    this.chain = Promise.resolve()
  }

  log(line) { try { this._log(line) } catch {} }

  // ----------------------------------------------------------------- state file --
  readState() { try { return JSON.parse(fs.readFileSync(this.dirs.stateFile, 'utf8')) } catch { return {} } }
  writeState(patch) {
    try {
      const s = { ...this.readState(), ...patch }
      fs.mkdirSync(path.dirname(assertWritable(this.dirs.stateFile)), { recursive: true })
      fs.writeFileSync(assertWritable(this.dirs.stateFile), JSON.stringify(s, null, 2))
      return s
    } catch (e) { this.log(`could not write ${this.dirs.stateFile}: ${e.message}`); return null }
  }

  status() {
    const s = this.readState()
    let outbox = 0
    try { outbox = this.outbox.count() } catch {}
    return { last_upload_at: s.last_upload_at || null, outbox, first_sent: !!s.first_auto_sent, sending: !!this.manualBusy }
  }

  async checkWer() {
    if (!this.werPromise) {
      this.werPromise = ensureWer({ ourFolder: this.dirs.ourDumps, log: (l) => this.log(l) })
        .then((r) => { this.werResult = r; return r })
    }
    return this.werPromise
  }

  // --------------------------------------------------------------- enqueueing --

  // ctx: see collectGameBundle. Never throws.
  enqueueGame(ctx = {}) {
    try {
      const endedAt = Number(ctx.endedAt) || this.now()
      this.quietUntil = Math.max(this.quietUntil, endedAt + this.quietMs)
      const e = this.outbox.add({ bundle_id: newBundleId(), kind: 'client', reason: 'game', job: { ...ctx, pids: [...(ctx.pids || [])], endedAt } })
      this.log(`queued a game bundle ${e.id} (map ${ctx.map || '?'}, pid ${ctx.pid || '?'}, exit ${ctx.exitCode ?? ctx.signal ?? '?'}); built once the game has been gone ${this.quietMs / 1000} s`)
      this.kick(this.quietMs)
      return e.id
    } catch (err) { this.log(`could not queue a game bundle: ${err.message}`); return null }
  }

  // ctx: { reason, error, where, crashFiles }. One bundle per error message per 10 min.
  enqueueLauncher(ctx = {}) {
    try {
      const reason = ctx.reason || 'launcher_error'
      const err = ctx.error ? { message: String(ctx.error.message || ctx.error), stack: String(ctx.error.stack || '') } : null
      if (err && reason !== 'manual' && reason !== 'backlog') {
        const key = err.message.slice(0, 300)
        const last = this.recentErrors.get(key)
        if (last && this.now() - last < SAME_ERROR_MS) {
          this.log(`not bundling "${key.slice(0, 80)}" again: the same error was bundled ${Math.round((this.now() - last) / 1000)} s ago`)
          return null
        }
        this.recentErrors.set(key, this.now())
      }
      const e = this.outbox.add({ bundle_id: newBundleId(), kind: 'launcher', reason, job: { reason, error: err, where: ctx.where || null, crashFiles: ctx.crashFiles || [] } })
      this.log(`queued a launcher bundle ${e.id} (${reason}${err ? `: ${err.message.slice(0, 120)}` : ''})`)
      this.kick(0)
      return e.id
    } catch (e2) { this.log(`could not queue a launcher bundle: ${e2.message}`); return null }
  }

  // crash.js keeps every report it could not send in crashes\*.json. Each one is bundled
  // ONCE (the newest mtime bundled is remembered), then left where it is.
  enqueueBacklog() {
    try {
      const mark = Number(this.readState().backlog_mark) || 0
      let files = []
      try { files = fs.readdirSync(this.dirs.crashes).filter((f) => f.endsWith('.json')) } catch {}
      const fresh = files.map((f) => path.join(this.dirs.crashes, f))
        .map((p) => ({ p, at: (() => { try { return fs.statSync(p).mtimeMs } catch { return 0 } })() }))
        .filter((x) => x.at > mark).sort((a, b) => b.at - a.at)
      if (!fresh.length) return null
      const id = this.enqueueLauncher({ reason: 'backlog', crashFiles: fresh.slice(0, 100).map((x) => x.p) })
      if (id) this.writeState({ backlog_mark: fresh[0].at })
      return id
    } catch (e) { this.log(`backlog: ${e.message}`); return null }
  }

  // ------------------------------------------------------------------ running --

  start() {
    this.stopped = false
    try { this.outbox.ensure() } catch (e) { this.log(`outbox unavailable: ${e.message}`) }
    try { const n = this.outbox.count(); if (n) this.log(`${n} bundle(s) waiting in the outbox from an earlier run`) } catch {}
    this.enqueueBacklog()
    this.kick(0)
  }

  stop() { this.stopped = true; if (this.timer) this.clearTimer(this.timer); this.timer = null; try { this.abort?.abort(new Error('the launcher is closing')) } catch {} }

  // The next sign-in releases every bundle that was waiting for one.
  onSignedIn() {
    try {
      let n = 0
      for (const e of this.outbox.list()) {
        if (!e.meta.wait_signin) continue
        e.meta.wait_signin = false
        e.meta.next_at = this.now()
        this.outbox.save(e)
        n++
      }
      if (n) { this.log(`signed in: ${n} bundle(s) that were waiting for a sign-in go now`); this.kick(0) }
    } catch (e) { this.log(`onSignedIn: ${e.message}`) }
  }

  kick(ms = 0) {
    if (this.stopped) return
    if (this.timer) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => { this.timer = null; this.run().catch((e) => this.log(`queue: ${e.message}`)) }, Math.max(0, ms))
  }

  paused() {
    if (this.isGameRunning()) {
      if (!this.pausedLogged) { this.log('paused: a game is running (nothing is built or sent until it has exited)'); this.pausedLogged = true }
      return this.gamePollMs
    }
    if (this.pausedLogged) { this.pausedLogged = false; this.quietUntil = Math.max(this.quietUntil, this.now() + this.quietMs) }
    const q = this.quietUntil - this.now()
    return q > 0 ? q : 0
  }

  // One step at a time through the queue; returns when nothing is due.
  async run() {
    if (this.running) { this.rerun = true; return }
    this.running = true
    let wait = null
    try {
      for (let guard = 0; guard < 500 && !this.stopped; guard++) {
        const p = this.paused()
        if (p) { wait = p; break }
        try { this.outbox.prune() } catch (e) { this.log(`prune: ${e.message}`) }
        const now = this.now()
        const entries = this.outbox.list()
        const build = entries.find((e) => !e.meta.built && (e.meta.next_at || 0) <= now && !e.meta.manual_hold)
        if (build) { await this.exclusive(() => this.build(build)); continue }
        const due = entries.find((e) => e.meta.built && (e.meta.next_at || 0) <= now && !e.meta.manual_hold)
        if (!due) {
          const next = entries.filter((e) => !e.meta.manual_hold).map((e) => e.meta.next_at || 0).sort((a, b) => a - b)[0]
          wait = next ? Math.min(POLL_MS * 60, Math.max(1000, next - now)) : null
          break
        }
        await this.exclusive(() => this.upload(due))
      }
    } finally {
      this.running = false
      if (this.rerun) { this.rerun = false; this.kick(0) } else if (wait != null) this.kick(wait)
    }
  }

  // Uploads and builds never overlap, whoever asked (the queue or Send logs now).
  exclusive(fn) {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => {})
    return p
  }

  async secretList() {
    try { return ((await this.secrets()) || []).filter((s) => typeof s === 'string' && s.length >= 6) } catch { return [] }
  }

  async build(e, { noBinary = false } = {}) {
    const t0 = this.now()
    const opts = {
      outPath: e.bundlePath,
      dirs: this.dirs,
      appVersion: this.appVersion,
      secrets: await this.secretList(),
      probes: this.probes,
      bundleId: e.id,
      noBinary,
      now: this.now,
    }
    try {
      const job = { ...e.meta.job, steamId: e.meta.job?.steamId || this.steamId() || null }
      const r = e.meta.kind === 'client' ? await collectGameBundle(job, opts) : await collectLauncherBundle(job, opts)
      e.meta.built = true
      e.meta.reason = r.manifest?.reason || e.meta.reason
      e.meta.bytes = r.bytes
      e.meta.no_binary = noBinary || undefined
      e.meta.next_at = e.meta.next_at && e.meta.attempts ? e.meta.next_at : this.now()
      this.outbox.save(e)
      const bins = r.files.filter((f) => f.binary).length
      this.log(`built ${e.meta.kind}/${e.meta.reason} bundle ${e.id}: ${(r.bytes / 1e6).toFixed(2)} MB, ${r.files.length} file(s)${bins ? ` incl. ${bins} dump(s)` : ''}, ${Object.values(r.scrub_hits || {}).reduce((a, b) => a + b, 0)} redaction(s), ${this.now() - t0} ms`)
      return true
    } catch (err) {
      e.meta.build_failures = (e.meta.build_failures || 0) + 1
      e.meta.last_error = `build: ${err.message}`
      if (e.meta.build_failures >= 3) {
        this.log(`could not build bundle ${e.id} three times (${err.message}); dropped`)
        this.outbox.remove(e)
      } else {
        e.meta.next_at = this.now() + backoff(e.meta.build_failures)
        this.outbox.save(e)
        this.log(`could not build bundle ${e.id} (${err.message}); trying again in ${Math.round(backoff(e.meta.build_failures) / 1000)} s`)
      }
      return false
    }
  }

  // One upload and what its answer means (telemetry.md §3). Returns { ok, status, message }.
  async upload(e, { manual = false } = {}) {
    const api = this.api()
    if (!api || typeof api.uploadBundle !== 'function') {
      e.meta.next_at = this.now() + NO_SITE_RETRY_MS
      e.meta.last_error = 'no site connection'
      this.outbox.save(e)
      this.log(`bundle ${e.id}: no site connection; kept, next try in 5 min`)
      return { ok: false, status: 0, message: 'No connection to the site. Saved; sends later.' }
    }
    if (!fs.existsSync(e.bundlePath)) { e.meta.built = false; this.outbox.save(e); return { ok: false, status: 0, message: 'rebuilding' } }
    const ac = new AbortController()
    this.abort = ac
    let watch = null
    if (!manual) {
      watch = setInterval(() => { if (this.isGameRunning()) ac.abort(new Error('a game started')) }, this.abortPollMs)
      watch.unref?.()
    }
    const size = fs.statSync(e.bundlePath).size
    const t0 = this.now()
    let r
    try {
      r = await api.uploadBundle(e.bundlePath, { bundleId: e.id, kind: e.meta.kind, reason: e.meta.reason, signal: ac.signal })
    } catch (err) {
      clearInterval(watch); this.abort = null
      if (ac.signal.aborted) {
        this.log(`upload of ${e.id} stopped: ${ac.signal.reason?.message || 'aborted'}; it goes again after the game (not counted as a failure)`)
        return { ok: false, status: 0, message: 'Stopped.' }
      }
      return this.failed(e, `network: ${err.message}`)
    }
    clearInterval(watch); this.abort = null
    const st = r.status
    const took = this.now() - t0
    if (st >= 200 && st < 300) {
      this.outbox.remove(e)
      const prev = this.readState()
      const first = !manual && !prev.first_auto_sent
      this.writeState({ last_upload_at: new Date(this.now()).toISOString(), last_bundle_id: e.id, ...(first ? { first_auto_sent: true } : {}) })
      this.log(`sent ${e.meta.kind}/${e.meta.reason} bundle ${e.id} (${(size / 1e6).toFixed(2)} MB in ${took} ms)${r.data?.duplicate ? ', the site already had it' : ''}${r.data?.severity ? `, severity ${r.data.severity}` : ''}${r.data?.flags?.length ? `, flags ${r.data.flags.join(',')}` : ''}`)
      if (first) this.emit('first_sent', { id: e.id })
      this.emit('sent', { id: e.id, manual })
      return { ok: true, status: st, message: 'Logs sent' }
    }
    if (st === 401) {
      e.meta.wait_signin = true
      e.meta.next_at = this.now() + SIGNIN_RETRY_MS
      e.meta.last_error = 'signed out (401)'
      this.outbox.save(e)
      this.log(`bundle ${e.id}: the site wants a sign-in (401); kept until the next sign-in, or 30 min`)
      return { ok: false, status: st, message: 'Sign in to send logs. Saved; sends after sign-in.' }
    }
    if (st === 429) {
      const ms = Math.max(60_000, retryAfterMs(r.retryAfter, this.now()) ?? backoff(e.meta.attempts + 1))
      e.meta.next_at = this.now() + ms
      e.meta.last_error = `rate limited (429), retry after ${Math.round(ms / 1000)} s`
      this.outbox.save(e)
      this.log(`bundle ${e.id}: rate limited (429); next try in ${Math.round(ms / 1000)} s`)
      return { ok: false, status: st, message: 'Too many logs today. Saved; sends later.' }
    }
    if (st === 413) {
      if (!e.meta.no_binary) {
        this.log(`bundle ${e.id}: too large for the site (413, ${(size / 1e6).toFixed(1)} MB); rebuilding once without dumps`)
        e.meta.built = false
        this.outbox.save(e)
        const ok = await this.build(e, { noBinary: true })
        if (ok && manual) return this.upload(e, { manual })
        return { ok: false, status: st, message: 'Too large; rebuilt without dumps.' }
      }
      this.log(`bundle ${e.id}: too large even without dumps (413); dropped`)
      this.outbox.remove(e)
      return { ok: false, status: st, message: 'Logs too large to send.' }
    }
    if (st === 400) {
      const why = `rejected (400): ${String(r.data?.error || r.text || '').slice(0, 200)}`
      this.outbox.reject(e, why)
      this.log(`bundle ${e.id}: ${why}; moved to telemetry\\rejected, never retried`)
      return { ok: false, status: st, message: 'The site refused the logs.' }
    }
    return this.failed(e, `the site answered ${st}`)
  }

  failed(e, why) {
    e.meta.attempts = (e.meta.attempts || 0) + 1
    const ms = backoff(e.meta.attempts)
    e.meta.next_at = this.now() + ms
    e.meta.last_error = why
    this.outbox.save(e)
    this.log(`bundle ${e.id}: ${why}; attempt ${e.meta.attempts}, next try in ${Math.round(ms / 1000)} s`)
    return { ok: false, status: 0, message: 'Could not reach the site. Saved; sends later.' }
  }

  // Settings -> Send logs now. Builds a manual bundle and uploads it at once. Resolves
  // { ok, message } for the button; never rejects.
  async sendNow() {
    if (this.manualBusy) return { ok: false, message: 'Already sending.' }
    this.manualBusy = true
    try {
      const e = this.outbox.add({ bundle_id: newBundleId(), kind: 'launcher', reason: 'manual', manual_hold: true, job: { reason: 'manual' } })
      this.log(`Send logs now: bundle ${e.id}`)
      return await this.exclusive(async () => {
        const built = await this.build(e)
        if (!built) return { ok: false, message: 'Could not collect the logs.' }
        e.meta.manual_hold = false
        this.outbox.save(e)
        const r = await this.upload(e, { manual: true })
        this.kick(1000)
        return { ok: r.ok, message: r.message }
      })
    } catch (err) {
      this.log(`Send logs now failed: ${err.message}`)
      return { ok: false, message: 'Could not send the logs.' }
    } finally { this.manualBusy = false }
  }
}
