// Launching the game and getting the player onto our server.
//
// The command line is the one from the brief:
//     +set com_introPlayed 1 +set fs_game mods/enw +connect <host>
// plus the settings the account owns (spec 13 §2: settings live in ENW, applied over
// the top at launch, the player's own WaW config never modified) and the handful of
// dvars that make an automated boot survivable.
//
// THE INVITE TOKEN IS NEVER ON THE COMMAND LINE. Any process on the machine can read
// another process's command line (and it lands in logs, crash dumps and screenshots),
// and the token is a bearer credential for a match. It goes over a named pipe; the env
// var is a fallback for a client build that cannot read the pipe yet.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { P, ensureDirs, isInside, protectedRoots } from './paths.js'
import { MOD_NAME } from './setup.js'
import * as lock from './gamelock.js'

const NANNY = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'tools', 'window-nanny.ps1')
const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

// The boot screen's states, in order (spec 99 §4.3).
export const PHASES = ['reserving', 'loading', 'ready', 'launching', 'in_game', 'ended', 'failed']

// ------------------------------------------------------------- the token pipe --

// A one-shot named pipe. The game connects, we write the token, we close and delete.
// The pipe name is random per launch and passed in ENW_TOKEN_PIPE; the token itself
// never appears in the command line, and (unless the fallback is on) never in the
// environment either.
export function serveToken(token, { timeoutMs = 120000 } = {}) {
  const name = `enw-launch-${crypto.randomBytes(8).toString('hex')}`
  const pipePath = `\\\\.\\pipe\\${name}`
  const state = { pipePath, delivered: false, connections: 0, closed: false }

  const server = net.createServer((sock) => {
    state.connections++
    sock.on('error', () => {})
    sock.end(`${JSON.stringify({ v: 0, token })}\n`, () => {
      state.delivered = true
    })
  })
  server.on('error', () => {})
  server.listen(pipePath)

  const timer = setTimeout(() => close(), timeoutMs)
  function close() {
    if (state.closed) return
    state.closed = true
    clearTimeout(timer)
    try { server.close() } catch {}
  }
  // Getters, not a spread of `state`. The first version spread it, which froze
  // `closed` at false forever while `close()` updated the inner object — a pipe that
  // reported itself open long after it had shut. Caught by test/launch-harness.js.
  return {
    pipePath,
    close,
    get delivered() { return state.delivered },
    get connections() { return state.connections },
    get closed() { return state.closed },
  }
}

// ------------------------------------------------------------- the safe-mode marker --

// %LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW is 4 bytes holding the pid of the running
// instance. It survives a crash, and the next launch then shows a modal "Run In Safe
// Mode?" before any logging and blocks forever (dedi, board 00:37). We clear it only
// when the pid inside is dead — never out from under a live game.
export function clearStartupBlockers({ homeDir = P.home, gameDir = P.game } = {}) {
  const notes = []
  const marker = path.join(process.env.LOCALAPPDATA || '', 'Activision', 'CoDWaW', '__CoDWaW')
  if (fs.existsSync(marker)) {
    let pid = -1
    try { const b = fs.readFileSync(marker); if (b.length === 4) pid = b.readInt32LE(0) } catch {}
    let live = false
    if (pid > 0) { try { process.kill(pid, 0); live = true } catch (e) { live = e.code === 'EPERM' } }
    if (live) {
      return { ok: false, notes, blockedBy: pid, reason: `World at War is already running (process ${pid}). Close it first.` }
    }
    try { fs.unlinkSync(marker); notes.push(`cleared a leftover crash marker (dead process ${pid}) that would have shown "Run In Safe Mode?"`) } catch {}
  }
  for (const root of [homeDir, gameDir, path.join(process.env.LOCALAPPDATA || '', 'Activision', 'CoDWaW')]) {
    for (const rel of ['main/safemode.cfg', 'players/safemode.cfg', 'safemode.cfg']) {
      const p = path.join(root, ...rel.split('/'))
      try { if (fs.existsSync(p)) { fs.unlinkSync(p); notes.push(`removed ${p}`) } } catch {}
    }
  }
  return { ok: true, notes }
}

// ------------------------------------------------------------------ arguments --

// The account's settings, applied over the top at launch. The player's own WaW config
// is never edited: these are command-line dvars on OUR copy, with OUR fs_homepath.
function settingsArgs(s = {}) {
  const a = []
  const push = (dvar, v) => { if (v !== undefined && v !== null && v !== '') a.push('+set', dvar, String(v)) }
  push('cg_fov', s.fov)
  push('com_maxfps', s.maxFps)
  push('r_fullscreen', s.fullscreen === undefined ? undefined : s.fullscreen ? '1' : '0')
  if (s.resolution) push('r_mode', s.resolution)
  push('snd_volume', s.volume)
  push('cg_drawFPS', s.showFps ? '1' : undefined)
  push('sensitivity', s.sensitivity)
  return a
}

export function buildArgs({
  host = null,
  map = null,
  fsGame = MOD_NAME,
  settings = {},
  homeDir = P.home,
  stealth = false,
  windowMode = null,
  extra = [],
} = {}) {
  // `stealth: true` is the old spelling of windowMode 'offscreen'.
  windowMode = windowMode || (stealth ? 'offscreen' : 'player')
  const a = []

  // Our own home path: profile, config and console.log land in the ENW folder.
  // (foundation.md §7: this moves main/, not players/ — so we also never write into
  // the player's game folder, only their Activision profile dir, which we do not edit.)
  a.push('+set', 'fs_homepath', homeDir)

  // The three from the brief.
  a.push('+set', 'com_introPlayed', '1')
  a.push('+set', 'fs_game', fsGame)

  // Startup dvars that make an unattended boot survivable. These are the launch.ps1
  // set, minus the dev-only ones.
  a.push('+set', 'com_startupIntroPlayed', '1')
  a.push('+set', 'ui_autoContinue', '1')
  a.push('+set', 'cl_allowDownload', '0')
  a.push('+set', 'logfile', '2')

  // Three window modes, and the difference matters more than it looks.
  //
  //   'player'    the player's own settings. What ships.
  //   'small'     windowed 800x600 and muted, ON SCREEN. dev-box rule 6 without the
  //               off-screen part.
  //   'offscreen' 'small' plus parked at -4000,-4000 and never focused.
  //
  // **Prefer 'small' over 'offscreen' for anything that has to run for more than a
  // minute.** The referee measured the game's tick stopping at 65.2 s, twice, when its
  // window was off-screen and unfocused — Windows throttles it and it looks exactly
  // like a crash at the one-minute mark. foundation is fixing it in the DLL; until
  // then, a run that needs a live game needs a window on the screen.
  if (windowMode === 'offscreen' || windowMode === 'small') {
    a.push('+set', 'r_fullscreen', '0', '+set', 'r_mode', '800x600')
    a.push('+set', 'snd_volume', '0', '+set', 'snd_menu_master', '0')
    if (windowMode === 'offscreen') {
      a.push('+set', 'vid_xpos', '-4000', '+set', 'vid_ypos', '-4000')
    } else {
      // Bottom-right, out of the way of whatever B is doing, but on screen.
      a.push('+set', 'vid_xpos', '40', '+set', 'vid_ypos', '40')
    }
  } else {
    a.push(...settingsArgs(settings))
  }

  a.push(...extra.filter(Boolean))

  // Last, because the engine runs +commands in order and connecting should be the
  // final thing it does.
  if (map) a.push('+map', map)
  if (host) a.push('+connect', host)
  return a
}

// --------------------------------------------------------------------- launch --

export class GameLaunch extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.opts = opts
    this.phase = null
    this.pids = new Set()
    this.dialogs = []
    this.notes = []
    this.tokenPipe = null
    this.nanny = null
    this.child = null
    this.lockName = opts.lockName || 'launcher'
    this.holdsLock = false
    this.ended = false
  }

  setPhase(phase, detail) {
    this.phase = phase
    this.emit('phase', { phase, detail, at: Date.now() })
  }

  note(text) {
    this.notes.push(text)
    this.emit('note', text)
  }

  async start() {
    const o = this.opts
    const gameDir = o.gameDir || P.game
    const exe = path.join(gameDir, 'CoDWaW.exe')
    const homeDir = o.homeDir || P.home

    // Rule 1, enforced here too rather than trusted: we never RUN out of the player's
    // install either, because running implies writing (console.log, configs).
    for (const root of protectedRoots()) {
      if (isInside(exe, root)) throw new Error(`Refusing to launch out of ${root}. ENW runs its own copy.`)
    }
    if (!fs.existsSync(exe)) throw new Error(`No game to launch at ${exe}. Run setup first.`)
    if (path.basename(exe).toLowerCase() === 'codwawmp.exe') throw new Error('ENW never launches the multiplayer executable.')

    ensureDirs()
    // Pre-create both places the engine may open console.log in. foundation measured
    // that a missing <fs_homepath>\main gave no console log at all, and with fs_game
    // set the engine uses the mod folder instead (see watchConsoleLog).
    fs.mkdirSync(path.join(homeDir, 'main'), { recursive: true })
    // NOT an unconditional recursive mkdir. An installed custom map's mod folder is a
    // JUNCTION into the ENW map library, and `fs.mkdirSync(<junction>, {recursive:true})`
    // throws ENOENT on Windows rather than treating it as an existing directory — it
    // failed the first launch of a custom map outright. existsSync follows the link, so
    // check first and only create what is genuinely absent.
    const modDir = path.join(homeDir, ...String(o.fsGame || MOD_NAME).split('/'))
    if (!fs.existsSync(modDir)) fs.mkdirSync(modDir, { recursive: true })

    // The dev-box lock. A player's machine has none and this is a no-op.
    if (o.useGameLock !== false) {
      const got = lock.acquire(this.lockName, o.why || 'launcher: play')
      if (!got.ok) throw new Error(got.reason)
      this.holdsLock = lock.enabled()
      if (got.reason) this.note(got.reason)
    }

    try {
      const blockers = clearStartupBlockers({ homeDir, gameDir })
      if (!blockers.ok) throw new Error(blockers.reason)
      for (const n of blockers.notes) this.note(n)

      const args = buildArgs({
        host: o.host,
        map: o.map,
        fsGame: o.fsGame,
        settings: o.settings,
        homeDir,
        stealth: !!o.stealth,
        windowMode: o.windowMode || null,
        extra: o.extraArgs || [],
      })

      // Environment: game-link v0 (ENW_HOST/INSTANCE/ROLE) plus the SteamStub hints,
      // without which a copied exe exits(0) after ~1.5 s (dedi, board 00:35).
      const env = {
        ...process.env,
        SteamAppId: '10090',
        SteamGameId: '10090',
        ENW_INSTANCE: o.instance || 'launcher',
        ENW_ROLE: o.role || 'client',
        ENW_LOGDIR: P.logs,
      }
      // Only point the game-link somewhere when there is something to point it at.
      // A local game has no host agent, and the DLL's documented behaviour for an
      // absent ENW_HOST is to stay dormant — better than 20 failed connects and a
      // backoff ladder in the log of every offline game.
      if (o.linkHost) env.ENW_HOST = o.linkHost
      else delete env.ENW_HOST

      // The token. Pipe first; env only if explicitly allowed.
      if (o.token) {
        this.tokenPipe = serveToken(o.token)
        env.ENW_TOKEN_PIPE = this.tokenPipe.pipePath
        if (o.tokenViaEnv) {
          env.ENW_TOKEN = o.token
          this.note('invite token passed in the environment (fallback) — never on the command line')
        } else {
          this.note(`invite token offered over a private pipe (${this.tokenPipe.pipePath}) — never on the command line`)
        }
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outLog = path.join(P.logs, `${stamp}-stdout.log`)
      const errLog = path.join(P.logs, `${stamp}-stderr.log`)
      const out = fs.openSync(outLog, 'a')
      const err = fs.openSync(errLog, 'a')

      const spawnAt = Date.now()
      this.setPhase('launching', `starting ${path.basename(exe)}`)
      this.child = spawn(exe, args, {
        cwd: gameDir,
        env,
        stdio: ['ignore', out, err],
        windowsHide: false,
        detached: false,
      })
      this.pids.add(this.child.pid)
      this.commandLine = `"${exe}" ${args.join(' ')}`
      this.emit('spawn', { pid: this.child.pid, exe, args, commandLine: this.commandLine, stdout: outLog, stderr: errLog })
      if (this.holdsLock) {
        lock.update(this.lockName, this.child.pid, o.why || 'launcher: play')
        this.startLockHeartbeat(o.why || 'launcher: play')
      }

      this.child.on('exit', (code, signal) => {
        this.emit('exit', { pid: this.child?.pid, code, signal })
        this.finish('ended', `the game exited (code ${code ?? signal})`)
      })
      this.child.on('error', (e) => {
        this.emit('error', e)
        this.finish('failed', e.message)
      })

      this.startNanny(spawnAt)
      this.watchConsoleLog(homeDir)
      return { pid: this.child.pid, commandLine: this.commandLine, args, stdout: outLog, stderr: errLog }
    } catch (e) {
      this.releaseLock()
      throw e
    }
  }

  // The dialog nanny. Answering "Set Optimal Settings?" is what turns a launch into a
  // game — every unattended run before it existed sat on that box forever.
  startNanny(spawnAt) {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', NANNY,
      '-WatchPids', String(this.child.pid),
      '-SinceUnixMs', String(spawnAt),
      '-Seconds', String(this.opts.nannySeconds || 300),
    ]
    if ((this.opts.windowMode || (this.opts.stealth ? 'offscreen' : 'player')) === 'offscreen') args.push('-Park')
    const n = spawn(PWSH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.nanny = n
    let buf = ''
    n.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        this.onNannyEvent(ev)
      }
    })
    n.stderr.on('data', (d) => this.emit('nanny_stderr', d.toString()))
    n.on('error', () => this.note('could not start the dialog helper; a Windows dialog may need a click'))
  }

  onNannyEvent(ev) {
    this.emit('nanny', ev)
    if (ev.t === 'adopt') {
      // SteamStub relaunched the game under a new pid. Track it so we can stop only
      // our own processes later (dev-box.md rule 4).
      this.pids.add(ev.pid)
      this.note(`Steam restarted the game as process ${ev.pid}`)
      if (this.holdsLock) lock.update(this.lockName, ev.pid, this.opts.why || 'launcher: play')
    } else if (ev.t === 'dialog') {
      this.dialogs.push(ev)
      const friendly = /optimal/i.test(ev.title)
        ? 'World at War asked to change your graphics settings; ENW answered No and kept yours.'
        : /safe mode/i.test(ev.title)
          ? 'World at War offered safe mode after its last crash; ENW answered No and started normally.'
          : `Answered a World at War dialog ("${ev.title}") with ${ev.answered}.`
      this.note(friendly)
      this.emit('dialog', { ...ev, friendly })
    } else if (ev.t === 'all_gone') {
      this.finish('ended', 'the game closed')
    }
  }

  // Follow the engine's own console.log to know when the map is up. This is the same
  // file foundation reads; it is the only signal available until the DLL's game-link
  // reports map_loaded.
  // Follow the engine's own console.log to know what the game is doing.
  //
  // TWO THINGS THAT COST A RUN EACH, both worth keeping written down:
  //
  //  1. **With `fs_game` set, the engine writes `console.log` under the MOD folder,
  //     not `main/`.** `<fs_homepath>\mods\enw\console.log` had 12,813 lines while
  //     `<fs_homepath>\main\console.log` sat at 0 bytes. Anything watching only
  //     `main\console.log` (tools/dev/launch.ps1 does) sees nothing whenever a mod is
  //     loaded — which for us is always. So we watch both and take whichever grows.
  //  2. **Never truncate it.** The first version wrote '' to get a clean read, after
  //     the engine had already opened the file; every subsequent line went past the
  //     truncation point and the file stayed empty for a whole 60 s run. Record the
  //     starting length instead.
  watchConsoleLog(homeDir) {
    const candidates = [
      path.join(homeDir, ...String(this.opts.fsGame || MOD_NAME).split('/'), 'console.log'),
      path.join(homeDir, 'main', 'console.log'),
    ]
    const pos = new Map()
    for (const f of candidates) {
      let n = 0
      try { n = fs.statSync(f).size } catch {}
      pos.set(f, n)
    }
    const tick = () => {
      if (this.ended) return
      for (const file of candidates) {
        try {
          const st = fs.statSync(file)
          let from = pos.get(file)
          // THE ENGINE TRUNCATES console.log ON EVERY LAUNCH ("logfile opened on …" is
          // always line 1). Remembering the previous run's length and reading forward
          // therefore skips the whole of this run: a launch that really did reach
          // `AUTOSAVE_LEVELSTART` at line 7,587 was reported as "no map yet" because
          // 7,587 lines was still fewer bytes than the file had before. A file that
          // has shrunk has been rewritten — start again from the beginning.
          if (st.size < from) { from = 0; pos.set(file, 0) }
          if (st.size <= from) continue
          const fd = fs.openSync(file, 'r')
          const buf = Buffer.alloc(st.size - from)
          fs.readSync(fd, buf, 0, buf.length, from)
          fs.closeSync(fd)
          pos.set(file, st.size)
          if (!this._logSource) { this._logSource = file; this.note(`reading the game's own log at ${file}`) }
          for (const line of buf.toString('latin1').split(/\r?\n/)) {
            if (line.trim()) this.onConsoleLine(line)
          }
        } catch {}
      }
      this._logTimer = setTimeout(tick, 400)
    }
    tick()
  }

  // The lines that actually mean something, verified against a real 12,813-line run of
  // nazi_zombie_prototype. "Loading fastfile <x>" is NOT one of them: the engine loads
  // a dozen (code_post_gfx, ui, common, patch…) long before any map, so matching it
  // reports a map that is not there yet.
  onConsoleLine(line) {
    this.emit('console', line)
    if (/^Server:\s*(\S+)/i.test(line)) {
      this.mapName = line.match(/^Server:\s*(\S+)/i)[1]
      this.sawServer = true
      this.setPhase('loading', `the server is bringing up ${this.mapName}`)
      this.checkMapUp(line)
    } else if (/Loading fastfile 'mod'/i.test(line)) {
      // dedi's marker: the mod ZONE loaded. If this never appears, the map is
      // installed somewhere World at War does not look — the commonest failure and
      // the one that looks like a broken map.
      this.note('the map mod loaded (Loading fastfile \'mod\')')
      this.sawMod = true
    } else if (/Waited .* for asset 'maps\/.*\.d3dbsp'/i.test(line) || /^LOADING\.\.\.\s*maps\//i.test(line)) {
      this.sawBsp = true
      this.setPhase('loading', line.trim().slice(0, 120))
      this.checkMapUp(line)
    } else if (/AUTOSAVE_LEVELSTART/i.test(line)) {
      this.sawAutosave = true
      this.checkMapUp(line)
    } else if (/enw_t4 (online|ready|loaded)/i.test(line)) {
      this.note('the ENW client is running inside the game')
    } else if (/Connecting to/i.test(line)) {
      this.setPhase('launching', line.trim().slice(0, 120))
    }
  }

  // "The map is up" needs a signal that works for stock AND custom maps.
  // `AUTOSAVE_LEVELSTART` is the cleanest but zombies-specific and not every custom
  // map reaches it; the pair (`Server: <map>` + the map's own `.d3dbsp` loading) is
  // what actually means the level is in. Either is enough.
  checkMapUp(line) {
    if (this.mapUp) return
    if (!this.sawAutosave && !(this.sawServer && this.sawBsp)) return
    this.mapUp = true
    this.emit('map_up', { map: this.mapName || null, line: String(line).trim() })
    this.setPhase('in_game', `the map is up${this.mapName ? `: ${this.mapName}` : ''}`)
  }

  // The silent failure dedi found, named. A custom map installed anywhere but
  // %LOCALAPPDATA%\Activision\CoDWaW\mods mounts its .iwd files and shows up in the
  // printed search path, so everything LOOKS right — but `mod.ff` is a zone, never
  // loads, and `+map` quietly does nothing. The tell is that `Loading fastfile 'mod'`
  // never appears. Anyone debugging this without knowing blames the map.
  diagnose() {
    const custom = this.opts.fsGame && this.opts.fsGame !== MOD_NAME
    if (!custom) return null
    if (this.sawMod) return null
    return {
      problem: 'the map mod never loaded',
      why: "World at War loads a custom map's mod only from %LOCALAPPDATA%\Activision\CoDWaW\mods. " +
        'Anywhere else the .iwd files still mount and the search path still looks right, but ' +
        "`Loading fastfile 'mod'` never happens and the map silently does not start.",
      check: this.opts.installDir || null,
    }
  }

  // Only ever stops processes we started or adopted (dev-box.md rule 4).
  stop(reason = 'stopped by the launcher') {
    for (const pid of this.pids) {
      try { process.kill(pid) } catch {}
    }
    this.finish('ended', reason)
  }

  finish(phase, detail) {
    if (this.ended) return
    this.ended = true
    clearTimeout(this._logTimer)
    try { this.tokenPipe?.close() } catch {}
    try { this.nanny?.kill() } catch {}
    this.releaseLock()
    this.setPhase(phase, detail)
    this.emit('finished', { phase, detail, dialogs: this.dialogs, notes: this.notes })
  }

  // Keep the shared lock alive for as long as OUR game is. See gamelock.heartbeat():
  // a lock goes stale after 15 minutes and a real game runs for hours, so without this
  // another agent would rightly take it mid-game.
  startLockHeartbeat(why) {
    clearInterval(this._lockTimer)
    this._lockTimer = setInterval(() => {
      if (this.ended || !this.holdsLock) return
      const livePid = [...this.pids].find((p) => { try { process.kill(p, 0); return true } catch (e) { return e.code === 'EPERM' } })
      if (!livePid) return
      const r = lock.heartbeat(this.lockName, livePid, why)
      if (r.action === 'restored' || r.action === 'taken_by_other') this.note(r.detail)
      if (r.action === 'taken_by_other') this.emit('lock_conflict', r)
    }, 60_000)
    this._lockTimer.unref?.()
  }

  releaseLock() {
    clearInterval(this._lockTimer)
    if (!this.holdsLock) return
    this.holdsLock = false
    const r = lock.release(this.lockName)
    if (r.released) this.note('released the shared game lock')
    else if (r.reason) this.note(`game lock: ${r.reason}`)
  }
}

export function launch(opts) {
  const l = new GameLaunch(opts)
  return { launch: l, started: l.start() }
}
