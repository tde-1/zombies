// The host agent, running beside the game on the player's own PC.
//
// WHY THIS FILE EXISTS
// --------------------
// `localrun.js` has always talked to `http://127.0.0.1:8787` and thrown if nothing
// answered. On a developer's box something usually did, because somebody had started
// `node infra/host-agent/host.js` in a terminal. **A player who installs the launcher
// has no host agent, no Node and no repo**, so every local game they played reported
// nothing, recorded nothing and left no replay — and the failure looked like "the
// launcher is a bit quiet" rather than like a missing process.
//
// So the launcher starts it. Three decisions, each with a reason:
//
//  1. **It runs on Electron's own Node**, `process.execPath` with
//     `ELECTRON_RUN_AS_NODE=1`. The host agent has zero dependencies and needs exactly
//     one non-obvious API — `zlib.zstdCompressSync`, for the replay chunks — which
//     Electron 38's Node 22.22 has. Nothing to install on a friend's machine.
//  2. **It picks its own free ports** rather than hard-coding 8787/38700. Three agents
//     on this box have already collided on ports, and on a player's PC 8787 might be
//     anything. We probe, we bind what is free, and we tell `LocalRun` where we put it.
//     A host agent that is ALREADY running and already in local mode is reused instead.
//  3. **It dies with us.** A referee left running after the launcher quits is an
//     orphan that holds a port and writes replays for nobody. Killed on `will-quit`,
//     and the agent independently watches our pid (`--exit-with-pid`) so a launcher
//     that crashes rather than quits does not leave one behind either.
//
// dev-box.md rule 4 applies to the kill: we only ever kill the pid we spawned, and we
// never touch an agent we merely found.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { P, RESOURCES, dirOfModule, unpacked, ensureDirs } from './paths.js'

const FIRST_DASH_PORT = 8787
const FIRST_LINK_PORT = 38700
const PORT_TRIES = 12

// Where host.js is, packaged and unpackaged. Packaged it is an extraResource, so it is
// a real file on disk beside app.asar — it has to be, because it runs in its own
// process and nothing outside this one can read inside an archive.
export function findHostAgent() {
  const tried = []
  const consider = (p, via) => {
    const exists = !!p && fs.existsSync(p)
    tried.push({ path: p, via, exists })
    return exists ? p : null
  }
  const hits = [
    RESOURCES ? consider(path.join(RESOURCES, 'host-agent', 'host.js'), 'shipped with the launcher') : null,
    consider(unpacked(path.resolve(dirOfModule(import.meta.url), '..', '..', '..', 'infra', 'host-agent', 'host.js')), 'the repo checkout (development)'),
  ].filter(Boolean)
  return { file: hits[0] || null, tried }
}

function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, host)
  })
}

async function firstFreePort(from, tries = PORT_TRIES) {
  for (let p = from; p < from + tries; p++) if (await portFree(p)) return p
  return null
}

async function probe(dashUrl, timeoutMs = 1500) {
  try {
    const res = await fetch(`${dashUrl}/api/state`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

export class HostAgent extends EventEmitter {
  constructor({ logDir = P.logs, replayDir = path.join(P.root, 'replays'), keyDir = path.join(P.root, 'state', 'keys') } = {}) {
    super()
    this.child = null
    this.pid = null
    this.dashUrl = null
    this.linkHost = null
    this.adopted = false        // true when we reused one we did not start
    this.logDir = logDir
    this.replayDir = replayDir
    this.keyDir = keyDir
    this.logFile = path.join(logDir, 'host-agent.log')
    this.lastError = null
    this.tail = []              // the last few lines, for the failure message
  }

  /** Resolve an agent to talk to: reuse a suitable one, else start ours. Idempotent. */
  async ensure() {
    if (this.dashUrl && (this.adopted || (this.child && !this.child.killed))) {
      if (await probe(this.dashUrl)) return this.info()
      // It went away under us. Fall through and start a new one.
      this.dashUrl = null
      this.child = null
    }

    // 1. Is one already running and willing to referee a local game? A developer's
    //    box often has one; adopting it is both polite and what B is used to.
    for (let p = FIRST_DASH_PORT; p < FIRST_DASH_PORT + 4; p++) {
      const url = `http://127.0.0.1:${p}`
      const st = await probe(url)
      if (!st) continue
      if (st.local?.enabled && !st.local?.lease_held) {
        this.adopted = true
        this.dashUrl = url
        this.linkHost = st.link ? `${st.link.host}:${st.link.port}` : null
        this.emit('log', `reusing the host agent already running on ${url} (local mode is on, game link ${this.linkHost})`)
        return this.info()
      }
      this.emit('log', `a host agent answers on ${url} but ${st.local?.enabled ? 'it holds a lease' : 'it is not in local mode'} — starting our own on another port`)
    }

    // 2. Start our own.
    return this.start()
  }

  async start() {
    const found = findHostAgent()
    if (!found.file) {
      this.lastError =
        'The ENW referee (host-agent) is missing from this copy of the launcher, so a local game ' +
        'cannot be recorded.\n\nThis is a packaging fault, not something you did — please send this ' +
        'to us.\n\nLooked in:\n' + found.tried.map((t) => `  ${t.exists ? 'found' : 'not there'}  ${t.path}`).join('\n')
      throw new Error(this.lastError)
    }

    ensureDirs()
    for (const d of [this.logDir, this.replayDir, this.keyDir]) fs.mkdirSync(d, { recursive: true })

    const dashPort = await firstFreePort(FIRST_DASH_PORT)
    const linkPort = await firstFreePort(FIRST_LINK_PORT)
    if (!dashPort || !linkPort) {
      this.lastError = `No free port for the ENW referee (tried ${FIRST_DASH_PORT}-${FIRST_DASH_PORT + PORT_TRIES} and ${FIRST_LINK_PORT}-${FIRST_LINK_PORT + PORT_TRIES}).`
      throw new Error(this.lastError)
    }

    const args = [
      found.file,
      '--local',                       // adopt a game we were TOLD to expect, and only that
      '--box', 'this-pc',
      '--dash-port', String(dashPort),
      '--link-port', String(linkPort),
      '--link-host', '127.0.0.1',
      '--replay-dir', this.replayDir,
      '--log-dir', this.logDir,
      '--key-dir', this.keyDir,
      '--max-instances', '2',
      '--exit-with-pid', String(process.pid),
      // NOT `--site`: the launcher is the thing that talks to the site, and the agent
      // refuses local mode outright if a site is configured (host.md, "Never on a game
      // box"). Passing one here would silently disable the whole feature.
    ]

    const out = fs.createWriteStream(this.logFile, { flags: 'a' })
    out.write(`\n=== ${new Date().toISOString()} launcher starting the host agent ===\n${found.file}\n  dash ${dashPort}  link ${linkPort}\n`)

    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ENW_BOX: 'this-pc' },
      cwd: path.dirname(found.file),
      windowsHide: true,
      // NOT detached: a detached child survives us, and an orphaned referee holding a
      // port is exactly what this file exists to prevent.
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.pid = child.pid
    this.adopted = false
    this.dashUrl = `http://127.0.0.1:${dashPort}`
    this.linkHost = `127.0.0.1:${linkPort}`

    const keep = (d) => {
      const s = d.toString()
      out.write(s)
      for (const line of s.split('\n')) if (line.trim()) this.tail.push(line.trim())
      while (this.tail.length > 40) this.tail.shift()
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('exit', (code, signal) => {
      out.write(`\n=== host agent exited code=${code} signal=${signal} ===\n`)
      out.end()
      if (this.child === child) { this.child = null; this.pid = null }
      this.emit('exit', { code, signal })
    })
    child.on('error', (e) => { this.lastError = e.message; this.emit('log', `host agent failed to start: ${e.message}`) })

    // Ready when its dashboard answers, or 20 s. Starting is a few hundred ms in
    // practice; the long budget is for a cold disk on a friend's PC.
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      if (!this.child) break
      const st = await probe(this.dashUrl, 800)
      if (st) {
        this.emit('log', `host agent up on ${this.dashUrl} (game link ${this.linkHost}, pid ${this.pid})`)
        return this.info()
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    const why = this.tail.slice(-8).join('\n') || '(it printed nothing)'
    this.lastError = `The ENW referee did not start within 20 seconds.\n\nIts last output:\n${why}\n\nFull log: ${this.logFile}`
    this.stop()
    throw new Error(this.lastError)
  }

  info() {
    return {
      dashUrl: this.dashUrl,
      linkHost: this.linkHost,
      pid: this.pid,
      adopted: this.adopted,
      replayDir: this.replayDir,
      logFile: this.logFile,
    }
  }

  /** Read the link address back from the agent itself rather than assuming our flag took. */
  async link() {
    if (!this.dashUrl) return this.linkHost
    const st = await probe(this.dashUrl)
    if (st?.link) this.linkHost = `${st.link.host}:${st.link.port}`
    return this.linkHost
  }

  /**
   * Stop the agent we started. NEVER one we adopted — dev-box.md rule 4: kill only
   * processes you started, by pid.
   */
  stop() {
    const c = this.child
    this.child = null
    if (!c || c.killed) return false
    try { c.kill() } catch {}
    // Windows ignores SIGTERM for a Node process that is mid-write; give it a moment
    // and then be certain, by pid, because a referee holding the link port would stop
    // the next game from ever connecting.
    const pid = c.pid
    setTimeout(() => {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch {}
    }, 1500).unref?.()
    return true
  }
}

let singleton = null
export function hostAgent() {
  if (!singleton) singleton = new HostAgent()
  return singleton
}
