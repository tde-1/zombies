// Instance manager — start, watch, sample and stop game-server processes.
//
// Two kinds of instance speak the same protocol and are otherwise interchangeable:
//   kind 'sim'  — `node sim/sim-instance.js`, a fake game. Used for everything until the
//                 DLL lands, and afterwards as the reference the real thing is diffed against.
//   kind 'game' — a real `CoDWaW.exe` dev copy with our DLL, launched through
//                 `tools/dev/launch.ps1` (owned by the foundation agent). Only this kind
//                 takes the game lock.
//
// SAFETY (docs/dev-box.md rules 4 and 5)
//   * We keep the PID of every process WE started and only ever kill those, by PID.
//     There is no name-based kill anywhere in this file, on purpose: B or another agent
//     may have their own CoDWaW.exe running.
//   * A 'game' instance acquires ZombiesDev\locks\game.lock before launch and releases it
//     on stop. A lock older than 15 min whose PID is dead is stale and may be taken.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { makeLog, mkdirp, id as makeId } from './util.js'
import { ProcSampler } from './procstat.js'

export const LOCK_FILE = path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'locks', 'game.lock')
export const LOCK_STALE_MS = 15 * 60 * 1000

export function readLock(file = LOCK_FILE) {
  try {
    const txt = fs.readFileSync(file, 'utf8').trim()
    const [owner, pid, iso, ...what] = txt.split(/\s+/)
    return { owner, pid, iso, what: what.join(' '), ageMs: Date.now() - Date.parse(iso), raw: txt }
  } catch { return null }
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** Take the game lock, or explain why we cannot. Never steals a live lock. */
export function acquireGameLock(owner, what, file = LOCK_FILE) {
  const cur = readLock(file)
  if (cur) {
    const stale = (Number.isFinite(cur.ageMs) && cur.ageMs > LOCK_STALE_MS) || (cur.pid !== 'starting' && !pidAlive(cur.pid))
    if (!stale) return { ok: false, reason: `held by ${cur.owner} since ${cur.iso} (${cur.what})`, lock: cur }
  }
  mkdirp(path.dirname(file))
  fs.writeFileSync(file, `${owner} starting ${new Date().toISOString()} ${what}`)
  return { ok: true, stole: !!cur }
}

export function stampGameLock(owner, pid, what, file = LOCK_FILE) {
  try { fs.writeFileSync(file, `${owner} ${pid} ${new Date().toISOString()} ${what}`) } catch { /* best effort */ }
}

export function releaseGameLock(owner, file = LOCK_FILE) {
  const cur = readLock(file)
  if (!cur || cur.owner !== owner) return false
  try { fs.unlinkSync(file); return true } catch { return false }
}

export class Instance extends EventEmitter {
  constructor(mgr, opts) {
    super()
    this.mgr = mgr
    this.id = opts.id || makeId('i', 3)
    this.kind = opts.kind || 'sim'
    this.role = opts.role || 'server'
    this.port = opts.port
    this.matchId = opts.matchId || null
    this.assignment = opts.assignment || null
    this.args = opts.args || []
    this.env = opts.env || {}
    this.maxRestarts = opts.maxRestarts ?? 3
    this.restarts = 0
    this.state = 'new'        // new | starting | running | exiting | exited | failed
    this.pid = null
    this.startedAt = null
    this.exitedAt = null
    this.exitCode = null
    this.samples = []         // rolling CPU/RAM samples
    this.peakRss = 0
    this.cpuSum = 0
    this.cpuN = 0
    this.log = mgr.log.child(this.id)
    this.logFile = path.join(mgr.logDir, `${this.id}.log`)
    mkdirp(mgr.logDir)
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' })
    this.holdsGameLock = false
  }

  /** The game args a real launch needs, as PowerShell array elements. */
  gameArgs() {
    const out = []
    if (this.assignment?.fs_game) out.push(`+set fs_game ${this.assignment.fs_game}`)
    if (this.assignment?.map) out.push(`+map ${this.assignment.map}`)
    out.push(`+set net_port ${this.port}`)
    for (const [k, v] of Object.entries(this.assignment?.settings?.dvars || {})) out.push(`+set ${k} ${v}`)
    return out.concat(this.args)
  }

  spawnArgs() {
    if (this.kind === 'sim') {
      return { cmd: process.execPath, argv: [path.join(this.mgr.root, 'sim', 'sim-instance.js'), ...this.args] }
    }
    // A real CoDWaW.exe, through the foundation agent's tools/dev/launch.ps1. Its real
    // signature (read from the script, not assumed) is:
    //   launch.ps1 -Name <copy> -Role <role> -EnwHost <h:p> -Instance <id>
    //              -HomePath own|default -Why <text> -GameArgs '+a','+b' [-DryRun]
    // It takes the game lock ITSELF, hides the window, and prints the game's PID, then
    // returns — so the PowerShell wrapper exits while the game keeps running.
    //
    // `-Command` rather than `-File`: only -Command makes PowerShell parse `'a','b'` as a
    // real string[]. Under -File the whole thing arrives as one string and -GameArgs
    // silently becomes a one-element array with a comma in it.
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`
    const ga = this.gameArgs()
    const cmdline = [
      `& ${q(this.mgr.launchScript)}`,
      `-Name ${q(this.mgr.gameCopy)}`,
      `-Role ${q(this.role)}`,
      `-EnwHost ${q(`${this.mgr.linkHost}:${this.mgr.linkPort}`)}`,
      `-Instance ${q(this.id)}`,
      '-HomePath own',
      `-Why ${q(`host-agent ${this.id} ${this.matchId || ''}`)}`,
      ga.length ? `-GameArgs ${ga.map(q).join(',')}` : '',
      this.mgr.dryRun ? '-DryRun' : '',
    ].filter(Boolean).join(' ')
    return { cmd: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmdline], cmdline }
  }

  start() {
    if (this.kind === 'game') {
      // launch.ps1 owns the lock (dev-box.md rule 5). We must NOT take it as well — two
      // holders is worse than none — but we check it first so the refusal is ours and
      // legible, rather than a PowerShell throw in a log file.
      const cur = readLock()
      if (cur && !this.mgr.dryRun) {
        const stale = (Number.isFinite(cur.ageMs) && cur.ageMs > LOCK_STALE_MS) || (cur.pid !== 'starting' && !pidAlive(cur.pid))
        if (!stale) {
          this.state = 'failed'
          this.failReason = `game.lock is held by ${cur.owner} (${cur.what}) — not launching`
          this.log.warn(this.failReason); this.emit('failed', this.failReason); return false
        }
      }
      if (!fs.existsSync(this.mgr.launchScript)) {
        this.state = 'failed'
        this.failReason = `launch script not found: ${this.mgr.launchScript}`
        this.log.warn(this.failReason); this.emit('failed', this.failReason); return false
      }
      const copy = path.join(path.dirname(LOCK_FILE), '..', `waw-${this.mgr.gameCopy}`)
      if (!fs.existsSync(copy) && !this.mgr.dryRun) {
        this.state = 'failed'
        this.failReason = `no game copy at ${copy} — run tools\\dev\\new-copy.ps1 ${this.mgr.gameCopy} first`
        this.log.warn(this.failReason); this.emit('failed', this.failReason); return false
      }
    }
    const { cmd, argv } = this.spawnArgs()
    const env = {
      ...process.env,
      ENW_HOST: `${this.mgr.linkHost}:${this.mgr.linkPort}`,
      ENW_INSTANCE: this.id,
      ENW_ROLE: this.role,
      ENW_MATCH: this.matchId || '',
      ENW_PORT: String(this.port),
      ...this.env,
    }
    this.state = 'starting'
    this.startedAt = Date.now()
    this.log.info(`start ${this.kind} port ${this.port} -> ${path.basename(argv[0] || cmd)}`)
    this.logStream.write(`\n=== ${new Date().toISOString()} start ${this.kind} ${cmd} ${argv.join(' ')}\n`)
    const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.pid = child.pid
    this.mgr.ownedPids.add(child.pid)
    child.stdout.on('data', (d) => { this.logStream.write(d); this.scanForGamePid(d) })
    child.stderr.on('data', (d) => { this.logStream.write(d); this.scanForGamePid(d) })
    child.on('spawn', () => { this.state = 'running'; this.emit('running') })
    child.on('error', (e) => { this.log.error(`spawn failed: ${e.message}`); this.state = 'failed'; this.failReason = e.message; this.emit('failed', e.message) })
    child.on('exit', (code, sig) => {
      // For a real game the PowerShell wrapper exits as soon as it has printed the PID;
      // the game itself is still running and is what we actually track. Only treat the
      // wrapper's exit as the instance's exit if it never handed us a live PID.
      if (this.kind === 'game' && this.gamePid && pidAlive(this.gamePid)) {
        this.mgr.ownedPids.delete(child.pid)
        this.log.debug(`launcher exited (${code}); game PID ${this.gamePid} is up`)
        return
      }
      this.onExit(code, sig)
    })
    this.emit('started')
    return true
  }

  /** launch.ps1 prints "PID <n>" and then the bare id. Adopt it and watch THAT process. */
  scanForGamePid(d) {
    if (this.kind !== 'game' || this.gamePid) return
    const m = /^\s*PID\s+(\d+)\b/m.exec(String(d))
    if (!m) return
    const pid = Number(m[1])
    if (!pidAlive(pid)) return
    this.gamePid = pid
    this.pid = pid                       // this is the process we sample and kill
    this.mgr.ownedPids.add(pid)
    this.log.info(`game PID ${pid} adopted (launcher holds game.lock as "${this.mgr.gameCopy}")`)
    // No child 'exit' event exists for a process we did not spawn, so poll it.
    this.watch = setInterval(() => {
      if (pidAlive(this.gamePid)) return
      clearInterval(this.watch); this.watch = null
      this.onExit(null, 'gone')
    }, 2000)
    this.watch.unref?.()
  }

  onExit(code, sig) {
    if (this.watch) { clearInterval(this.watch); this.watch = null }
    this.mgr.ownedPids.delete(this.pid)
    if (this.child?.pid) this.mgr.ownedPids.delete(this.child.pid)
    this.exitCode = code
    this.exitSignal = sig
    this.exitedAt = Date.now()
    const wanted = this.state === 'exiting'
    this.state = 'exited'
    this.log.info(`exit code=${code} signal=${sig || '-'}${wanted ? '' : ' (unexpected)'}`)
    this.logStream.write(`=== ${new Date().toISOString()} exit ${code} ${sig || ''}\n`)
    // launch.ps1 took the lock in OUR game-copy's name and then returned, so releasing it
    // is our job. releaseGameLock only deletes a lock whose owner matches, so we can never
    // free another agent's.
    if (this.kind === 'game') releaseGameLock(this.mgr.gameCopy)
    this.emit('exit', { code, sig, wanted })
    if (!wanted && this.restartPolicy() ) {
      this.restarts++
      const delay = Math.min(30_000, 1000 * 2 ** (this.restarts - 1))
      this.log.warn(`restarting in ${delay}ms (${this.restarts}/${this.maxRestarts})`)
      setTimeout(() => { if (!this.mgr.stopping) this.start() }, delay).unref?.()
    } else if (!wanted && code !== 0) {
      this.state = 'failed'
      this.failReason = `exited ${code} and is out of restarts`
      this.emit('failed', this.failReason)
    }
    // A clean exit(0) we did not ask for is a game server that finished by itself — the
    // referee has already called the game. Not a failure.
  }

  restartPolicy() {
    // A crashed game server that had a live match is restarted (the referee decides
    // whether the match survives); one that exited cleanly with no match is not.
    if (this.mgr.stopping) return false
    if (this.restarts >= this.maxRestarts) return false
    return this.matchId != null || this.exitCode !== 0
  }

  /** Stop by PID — ours, and only ours. */
  stop(reason = 'stop', { graceMs = 4000 } = {}) {
    if (!this.child || this.state === 'exited') return Promise.resolve()
    this.state = 'exiting'
    this.log.info(`stopping: ${reason}`)
    // A real game was never our child, so there is no SIGTERM to send and no 'exit' to
    // wait for: kill the PID we adopted and release the lock launch.ps1 left behind.
    if (this.kind === 'game' && this.gamePid) {
      if (this.watch) { clearInterval(this.watch); this.watch = null }
      try { spawn('taskkill.exe', ['/PID', String(this.gamePid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* ignore */ }
      return new Promise((resolve) => setTimeout(() => { this.onExit(null, 'killed'); resolve() }, 1500))
    }
    return new Promise((resolve) => {
      const done = () => resolve()
      this.child.once('exit', done)
      // Ask nicely first (the sim handles SIGTERM; a real game gets taskkill /PID).
      try { this.child.kill('SIGTERM') } catch { /* already gone */ }
      setTimeout(() => {
        if (this.state === 'exited') return
        const pid = this.pid
        if (!this.mgr.ownedPids.has(pid)) return done()
        this.log.warn(`forcing PID ${pid}`)
        if (process.platform === 'win32') {
          // /T takes the tree we started (powershell -> the game). Still PID-scoped.
          try { spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* ignore */ }
        } else { try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ } }
      }, graceMs).unref?.()
    })
  }

  addSample(s) {
    if (!s) return
    this.samples.push({ at: Date.now(), ...s })
    if (this.samples.length > 720) this.samples.shift()   // ~1 h at 5 s
    if (s.rssBytes > this.peakRss) this.peakRss = s.rssBytes
    if (s.cores != null) { this.cpuSum += s.cores; this.cpuN++ }
  }

  usage() {
    const last = this.samples.at(-1) || {}
    return {
      cores_now: last.cores ?? null,
      cores_avg: this.cpuN ? this.cpuSum / this.cpuN : null,
      rss_bytes: last.rssBytes ?? null,
      rss_peak_bytes: this.peakRss || null,
      threads: last.threads ?? null,
      samples: this.cpuN,
    }
  }

  info() {
    return {
      id: this.id, kind: this.kind, role: this.role, port: this.port, pid: this.pid,
      state: this.state, match_id: this.matchId, restarts: this.restarts,
      uptime_ms: this.startedAt ? (this.exitedAt || Date.now()) - this.startedAt : 0,
      log: this.logFile, fail: this.failReason || null, usage: this.usage(),
      assignment: this.assignment ? { map: this.assignment.map, mode: this.assignment.mode, nonce: this.assignment.nonce } : null,
    }
  }
}

export class InstanceManager extends EventEmitter {
  constructor({ root, logDir, linkHost, linkPort, basePort = 28960, maxInstances = 8, launchScript, lockOwner = 'host', gameCopy = 'host', dryRun = false, sampleMs = 5000, log } = {}) {
    super()
    this.root = root
    this.logDir = logDir
    this.linkHost = linkHost
    this.linkPort = linkPort
    this.basePort = basePort
    this.maxInstances = maxInstances
    this.launchScript = launchScript
    this.lockOwner = lockOwner
    // The dev game copy (ZombiesDev\waw-<gameCopy>) AND the name launch.ps1 writes into
    // game.lock — they are the same string in launch.ps1, so they must be here too.
    this.gameCopy = gameCopy
    this.dryRun = dryRun
    this.sampleMs = sampleMs
    this.log = log || makeLog('instances')
    this.instances = new Map()
    this.ownedPids = new Set()
    this.usedPorts = new Set()
    this.stopping = false
    this.sampler = new ProcSampler({ log: this.log })
    this.seq = 0
  }

  startSampling() {
    if (this.sampleTimer) return
    const run = async () => {
      const live = [...this.instances.values()].filter((i) => i.pid && i.state === 'running')
      if (live.length) {
        const map = await this.sampler.sample(live.map((i) => i.pid))
        for (const i of live) i.addSample(map.get(i.pid))
        this.emit('samples')
      }
    }
    this.sampleTimer = setInterval(run, this.sampleMs)
    this.sampleTimer.unref?.()
    run()
  }

  allocPort() {
    for (let p = this.basePort; p < this.basePort + 200; p += 2) if (!this.usedPorts.has(p)) { this.usedPorts.add(p); return p }
    throw new Error('no free game port')
  }

  create(opts = {}) {
    if (this.instances.size >= this.maxInstances) throw new Error(`instance cap reached (${this.maxInstances})`)
    const inst = new Instance(this, { ...opts, id: opts.id || `inst-${String(++this.seq).padStart(2, '0')}`, port: opts.port || this.allocPort() })
    this.instances.set(inst.id, inst)
    inst.on('exit', () => this.emit('instance_exit', inst))
    this.emit('instance_created', inst)
    return inst
  }

  get(id) { return this.instances.get(id) }
  list() { return [...this.instances.values()] }

  async remove(id, reason = 'removed') {
    const inst = this.instances.get(id)
    if (!inst) return false
    inst.maxRestarts = 0
    await inst.stop(reason)
    this.usedPorts.delete(inst.port)
    this.instances.delete(id)
    try { inst.logStream.end() } catch { /* ignore */ }
    this.emit('instance_removed', inst)
    return true
  }

  /** Reap instances that finished and have had no connection for a while. */
  reap(idleMs = 60_000) {
    const now = Date.now()
    for (const i of this.list()) {
      if (i.state === 'exited' && i.exitedAt && now - i.exitedAt > idleMs) this.remove(i.id, 'reaped')
      if (i.state === 'failed' && i.startedAt && now - i.startedAt > idleMs) this.remove(i.id, 'reaped (failed)')
    }
  }

  async stopAll(reason = 'shutdown') {
    this.stopping = true
    clearInterval(this.sampleTimer)
    this.sampler.stop()
    await Promise.all(this.list().map((i) => i.stop(reason)))
    // Belt and braces: anything we started that is somehow still alive, by PID only.
    for (const pid of this.ownedPids) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    this.ownedPids.clear()
  }
}
