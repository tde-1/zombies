// Instance manager — start, watch, sample and stop game-server processes.
//
// Two kinds of instance speak the same protocol and are otherwise interchangeable:
//   kind 'sim'  — `node sim/sim-instance.js`, a fake game. Used for everything until the
//                 DLL lands, and afterwards as the reference the real thing is diffed against.
//   kind 'game' — a real `CoDWaW.exe` dev copy with our DLL, launched through
//                 `tools/dev/launch.ps1` (owned by the foundation agent). Only this kind
//                 takes the game lock.
//
// WINE MODE (`--wine`, off by default, docs/kickstart/vps.md §13). On the Linux box there
// is no PowerShell, no `launch.ps1` and no `ZombiesDev\locks\game.lock`, so a 'game'
// instance is spawned as `wine CoDWaW.exe …` directly and the child IS the game: no
// launcher wrapper, no PID to adopt, no lock to take or release. Everything else — the
// argument list, the environment, sampling, stop-by-PID — is shared with the Windows path
// on purpose, so the two cannot drift.
//
// SAFETY (docs/dev-box.md rules 4 and 5)
//   * We keep the PID of every process WE started and only ever kill those, by PID.
//     There is no name-based kill anywhere in this file, on purpose: B or another agent
//     may have their own CoDWaW.exe running.
//   * A 'game' instance acquires ZombiesDev\locks\game.lock before launch and releases it
//     on stop. A lock older than 15 min whose PID is dead is stale and may be taken.
import { GAME_MODE_DVARS, gameModeDvars } from './gamemode.js'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { makeLog, mkdirp, id as makeId } from './util.js'
import { ProcSampler } from './procstat.js'

export const LOCK_FILE = path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'locks', 'game.lock')
export const LOCK_STALE_MS = 15 * 60 * 1000

// The engine keeps the exe path plus at most 31 `+` commands; Com_ParseCommandLine (0x59AFA0)
// starts a new command at every '+' and stops at 0x20 lines, dropping the rest of the line
// without an error -- `+map`, which must be last, first of all (game-modes.md, lane UGX).
export const ENGINE_PLUS_LIMIT = 31
// tools/dev/launch.ps1's own `+` commands ahead of -GameArgs: fs_homepath + 14 defaults, +1
// spare (the Windows path is dev-only; the box uses the wine prefix, which is counted exactly).
export const LAUNCH_PS1_PLUS = 16
/** How many `+` commands the engine will see in these argv strings (it splits at every '+'). */
export function countPlusCommands(list) {
  let n = 0
  for (const s of list) for (const ch of String(s)) if (ch === '+') n++
  return n
}

export function readLock(file = LOCK_FILE) {
  try {
    const txt = fs.readFileSync(file, 'utf8').trim()
    const [owner, pid, iso, ...what] = txt.split(/\s+/)
    return { owner, pid, iso, what: what.join(' '), ageMs: Date.now() - Date.parse(iso), raw: txt }
  } catch { return null }
}

/**
 * A Custom lease's own dvars, as the ones that may go on a command line and the ones that
 * may not (with why). Each becomes `+set <k> <v>` and the argv is later split on spaces,
 * so before 2026-09-23 a value like `1 +exec x` or a key like `a +quit` was an arbitrary
 * command-line injection by any party leader (the site stores Custom settings verbatim,
 * parties.setSettings). Names and values are one token each now, and the dvars the host
 * itself owns — the ones that decide whether the server is headless, where it writes, who
 * can join, how hard it runs, and developer mode (README rule 5) — are never the lease's.
 */
const LEASE_DVAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const LEASE_DVAR_VALUE = /^[A-Za-z0-9_.:\-]{1,64}$/
const HOST_OWNED_DVARS = new Set([
  'dedicated', 'developer', 'developer_script', 'logfile', 'net_port', 'net_ip', 'sv_maxclients',
  'com_maxfps', 'fs_game', 'fs_homepath', 'fs_basepath', 'fs_localappdata', 'fs_cdpath',
  'fs_basegame', 'zombiemode', 'sv_maxrate', 'rcon_password', 'sv_punkbuster', 'r_fullscreen',
  // The map's game mode (game-modes.md): set from the lease's `game_mode`, never from a party.
  ...GAME_MODE_DVARS,
].map((s) => s.toLowerCase()))
export function safeLeaseDvars(entries) {
  const ok = []
  const refused = []
  for (const [k, v] of entries) {
    const key = String(k)
    const val = String(v)
    if (!LEASE_DVAR_NAME.test(key)) refused.push(`${JSON.stringify(key).slice(0, 40)}: not a dvar name`)
    else if (HOST_OWNED_DVARS.has(key.toLowerCase())) refused.push(`${key}: the host sets it`)
    else if (!LEASE_DVAR_VALUE.test(val)) refused.push(`${key}: value is not one plain token`)
    else ok.push([key, val])
  }
  return { ok, refused }
}

/**
 * The dev-knob environment for one lease (dedi.md §23). ON only for an AGENT lease (the
 * site sets `agent` from lease-cli; a player's Play never has it) in CUSTOM mode that asks
 * for it in `settings.dev`. Everything else gets the switches explicitly EMPTY, which the
 * DLL reads as off (it tests for "1"), so nothing inherited from the agent's own
 * environment reaches a game. The DLL's referee then reports `enw_dev_knobs` and the
 * Verified judge fails any run that had them.
 */
export function devKnobsFor(a) {
  const dev = a && a.agent === true && a.mode === 'custom' && a.settings && a.settings.dev
  const god = !!(dev && dev.god === true)
  // Soak bots (dedi.md §26, server/components/dedicated/bots.cpp): server-side test clients
  // that kill zombies so rounds advance. 1..4, whole numbers only; anything else is none.
  const bots = devBotsFor(a)
  const on = god || bots > 0
  return { ENW_DEV_KNOBS: on ? '1' : '', ENW_DEV_GOD: god ? '1' : '', ENW_DEV_BOTS: bots > 0 ? String(bots) : '' }
}

/** How many soak bots an agent's Custom dev lease asked for (0 for every other lease). */
export function devBotsFor(a) {
  const dev = a && a.agent === true && a.mode === 'custom' && a.settings && a.settings.dev
  const n = dev ? dev.bots : 0
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 0
}

/**
 * A soak lease's bots (dedi.md §27) are server-side test clients the DLL's referee never reports
 * as players, so to the host the game is empty -- and the empty close (two minutes) ended every
 * bot soak at 2 m 00 s (`game over: empty`, 2026-09-23 18:52 UTC). Only an agent's Custom dev
 * lease that asked for bots gets the empty close pushed out to the lease cap; nothing else changes.
 */
export function soakBotConfig(assignment) {
  return devBotsFor(assignment) > 0 ? { emptyCloseMs: 24 * 60 * 60 * 1000 } : {}
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

  /**
   * The game args a real launch needs, as PowerShell array elements.
   *
   * This is the DEDICATED-SERVER recipe, and its source of truth is the server half of
   * `tools/dev/jointest.ps1` — the only launch line a `CoDWaW.exe` has ever answered a
   * connectionless packet from. Keep the two in step; if they disagree, jointest wins,
   * because that is the one somebody watches.
   *
   * Two things here are load-bearing and were wrong before:
   *
   *   1. **`+map` must be LAST.** The engine executes `+` commands in command-line order,
   *      and `+map` is the one that starts the server. Anything set after it is set on a
   *      server that is already listening — so `+map … +set net_port 28971` binds 28960
   *      and the box then probes a port nothing is on. This used to emit `+map` second.
   *   2. **`+set dedicated 1` is what makes it headless.** Without it the stock SP exe
   *      brings up Direct3D and a window. It was never passed at all: every `--game`
   *      launch before this was a windowed single-player game wearing a server's name.
   *
   * `+set developer 1` is never passed (dev-box.md rule 6).
   */
  gameArgs(prefixPlus = 0) {
    const out = this.gameArgsUnchecked()
    // The engine keeps at most ENGINE_PLUS_LIMIT `+` commands and silently drops the rest of
    // the line -- `+map` (last) first of all (game-modes.md: Com_ParseCommandLine 0x59AFA0).
    // A line that would not fit is refused here, loudly, instead of booting a server with no map.
    const n = prefixPlus + countPlusCommands(out)
    if (n > ENGINE_PLUS_LIMIT) {
      throw new Error(`command line has ${n} '+' commands (${prefixPlus} from the launcher prefix); the engine keeps ${ENGINE_PLUS_LIMIT} and would drop the rest, +map included -- lease refused (fewer lease dvars)`)
    }
    return out
  }

  gameArgsUnchecked() {
    const a = this.assignment || {}
    const out = []
    // fs_game first: it decides where the engine even looks for the map and the console log.
    if (a.fs_game) out.push(`+set fs_game ${a.fs_game}`)
    out.push(
      '+set dedicated 1',            // headless: no D3D, no window, no front end
      '+set zombiemode 1',           // the zombies GSC path
      '+set logfile 2',              // flushed console.log under <fs_homepath>
      '+set s_volume 0', '+set snd_volume 0',
      // These three exist only so the DLL has something to flag DVAR_SAVED; the engine has
      // to create them first (dedi.md §4, site 2).
      '+set con_typewriterColorBase 1.0 1.0 1.0',
      '+set hud_drawhud 1',
      '+set ui_campaign american',
      // A soak lease's bots need client slots of their own (dedi.md §26).
      `+set sv_maxclients ${Math.max(1, Math.min(8, Math.max(Number(a.slots?.length || a.max_players || 4), devBotsFor(a))))}`,
      `+set net_port ${this.port}`,
    )
    // The map's own game mode (game-modes.md), host-owned, in Verified and Custom alike: the
    // mode is the map's content, not a setting. Invalid -> none of it, and the map's own
    // menu shows (the safe failure); the referee then marks the mode unconfirmed.
    const gm = gameModeDvars(a.game_mode)
    if (gm.error) this.log?.warn?.(`game mode refused (${gm.error}); the map's own menu will show`)
    for (const [k, v] of gm.dvars) out.push(`+set ${k} ${v}`)
    // A lease's own dvars are for Custom games. A Verified game runs the stock server and
    // nothing else (verified-rules.md §4): a lease that asks for dvars in Verified gets
    // none of them, and the log says which were dropped.
    const leaseDvars = Object.entries(a.settings?.dvars || {})
    if (a.mode === 'verified' && leaseDvars.length) {
      this.log?.warn?.(`verified lease: refused ${leaseDvars.length} lease dvar(s) (${leaseDvars.map(([k]) => k).join(', ')}); a Verified game runs stock settings`)
    } else {
      const { ok, refused } = safeLeaseDvars(leaseDvars)
      if (refused.length) this.log?.warn?.(`custom lease: refused ${refused.length} lease dvar(s): ${refused.join('; ')}`)
      for (const [k, v] of ok) out.push(`+set ${k} ${v}`)
    }
    for (const extra of this.args) out.push(extra)
    if (a.map) out.push(`+map ${a.map}`)
    return out
  }

  /**
   * The environment a headless game needs on top of what launch.ps1 sets itself.
   * Both of these are proven blockers, not belt and braces — see `tools/dev/jointest.ps1`:
   *   ENW_RAW_SOCKETS           Sys_SendPacket routes through Demonware's bdSocketRouter,
   *                             which drops every packet with addrHandle=0. Without this
   *                             the server never answers anything (dedi.md §7f wall 2).
   *   ENW_DEDI_SUPPRESS_MAPSUMMARY
   *                             SV_SpawnServer raises ERR_MAPLOADERRORSUMMARY with an
   *                             EMPTY error list, so Com_Init never returns and the frame
   *                             loop never starts (dedi.md §0).
   */
  gameEnv() {
    return {
      ENW_RAW_SOCKETS: '1', ENW_DEDI_SUPPRESS_MAPSUMMARY: '1',
      // Where this instance's Demonware game socket asks to go (dedi DLL lobby_port.cpp,
      // dedi.md §19): 3074 for slot 0, 3075 for slot 1, ... The engine probes 100 ports up
      // from whatever it is given, so this is not what makes a third instance possible; it
      // makes each instance's port its own, so two booting together never race for one.
      // The box firewall opens 3074-3079. An older DLL ignores it.
      ENW_LOBBY_PORT: String(this.lobbyPort()),
      // Dev knobs (host `exec`, the soak's test god mode: dedi.md §23) are set HERE or
      // nowhere: empty unless devKnobsFor() says this lease is an agent's Custom dev lease,
      // so an ENW_DEV_KNOBS exported into the agent's own environment can never leak into
      // a player's game through `...process.env`.
      ...devKnobsFor(this.assignment),
    }
  }

  /**
   * This instance's SLOT: 0 for the first game port, 1 for the next, ... Derived from the
   * port, which the manager hands out lowest-free-first and takes back on remove, so it is
   * stable for the life of the instance and reused by the next one — unlike the id, whose
   * counter only ever grows.
   */
  slot() {
    const n = Math.floor((Number(this.port) - Number(this.mgr.basePort)) / 2)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }

  /** The Demonware port this instance asks for: --lobby-base (3074) + its slot. */
  lobbyPort() { return (Number(this.mgr.lobbyBase) || 3074) + this.slot() }

  /** `inst-01` for slot 0: the name of the per-slot game copy and homepath on a box. */
  slotName() { return `inst-${String(this.slot() + 1).padStart(2, '0')}` }

  /**
   * Wine mode: where THIS instance's game copy and homepath live. `{id}` in either
   * configured path is replaced with the instance id, which is what makes several
   * instances on one box possible — they are the two things Windows instances have to
   * share (host.md §10.5 / vps.md §13) and the reason the Windows path allows only one.
   */
  winePaths() {
    const w = this.mgr.wine
    // `{slot}` (inst-01, inst-02, ... by game port) is what a box should use: `{id}` grows
    // with every boot of the agent's life, and a box only has so many copies. MEASURED
    // 2026-09-22 23:27-23:32: after four boots one agent was at inst-05..inst-24 and every
    // lease failed with `no game copy at .../waw-inst-05` until the agent was restarted.
    const sub = (s) => String(s).replace(/\{id\}/g, this.id).replace(/\{slot\}/g, this.slotName())
    return { gameDir: sub(w.gameDir), homeWin: sub(w.homeWin), perInstance: /\{id\}|\{slot\}/.test(w.gameDir) }
  }

  spawnArgs() {
    if (this.kind === 'sim') {
      return { cmd: process.execPath, argv: [path.join(this.mgr.root, 'sim', 'sim-instance.js'), ...this.args] }
    }
    if (this.mgr.wine) {
      // The child is the game. `wine` execs the loader in place, so the pid we spawn is
      // the pid we sample and the pid we kill.
      const w = this.mgr.wine
      const { gameDir, homeWin } = this.winePaths()
      const prefix = [
        'CoDWaW.exe',
        '+set', 'fs_homepath', homeWin,
        '+set', 'r_fullscreen', '0', '+set', 'r_mode', '800x600',
        '+set', 'vid_xpos', '-4000', '+set', 'vid_ypos', '-4000',
        '+set', 'com_introPlayed', '1', '+set', 'com_startupIntroPlayed', '1',
        '+set', 'sys_configureGHz', '1', '+set', 'ui_autoContinue', '1',
        '+set', 'cl_allowDownload', '0', '+set', 'developer', '0', '+set', 'con_minicon', '1',
        // com_maxfps: without it dedicated mode free-runs at ~237 Hz and burns a whole
        // core (dedi.md §7j). jointest.ps1 passes 60; so do we.
        '+set', 'com_maxfps', String(w.maxFps || 60),
      ]
      const argv = [...prefix, ...this.gameArgs(countPlusCommands(prefix)).flatMap((s) => s.split(' '))]
      return { cmd: w.bin || 'wine', argv, cwd: gameDir }
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
    const ga = this.gameArgs(LAUNCH_PS1_PLUS)
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
    // A REMOVED INSTANCE NEVER STARTS (host.md §16). The manager has forgotten it — its port
    // and slot may already be someone else's — so a process started now is an orphan: the
    // 2026-09-23 12:13 incident was exactly this, a queued boot whose lease had been retired
    // starting 50 s later and saying `hello` to a host that no longer knew it.
    if (this.removed || this.mgr.stopping) {
      this.log.warn(`not starting ${this.id}: ${this.removed ? 'it was removed (its lease ended) before its turn to boot' : 'the host is shutting down'}`)
      this.state = 'exited'
      return false
    }
    if (this.kind === 'game' && this.mgr.wine) {
      // Wine mode: no launch.ps1, no game.lock, no Windows game copy to look for. The
      // one-game-per-box rule is a consequence of SHARING a game copy and a homepath, so
      // it only applies when the configured paths have no `{id}` in them.
      const { gameDir, homeWin, perInstance } = this.winePaths()
      if (!perInstance) {
        const otherGame = [...this.mgr.instances.values()].find(
          (i) => i !== this && i.kind === 'game' && (i.state === 'starting' || i.state === 'running'))
        if (otherGame && !this.mgr.dryRun) {
          this.state = 'failed'
          this.failReason = `only one real game per box: ${otherGame.id} already holds game copy "${gameDir}". Put {slot} in --wine-game-dir and --wine-homepath to run several.`
          this.log.warn(this.failReason); this.emit('failed', this.failReason); return false
        }
      }
      if (!fs.existsSync(path.join(gameDir, 'CoDWaW.exe')) && !this.mgr.dryRun) {
        this.state = 'failed'
        this.failReason = `no game copy at ${gameDir} (infra/vps/05-run-dedi.sh builds one)`
        this.log.warn(this.failReason); this.emit('failed', this.failReason); return false
      }
      // The safe-mode marker, or the next launch hangs with NOTHING in any log.
      //
      // `%LOCALAPPDATA%\Activision\CoDWaW\__CoDWaW` is a 4-byte file holding the PID of
      // the running instance, written at startup and deleted on a clean exit. If a game
      // is killed hard it survives, and the next launch puts up a modal "Run In Safe
      // Mode?" *before* the engine opens console.log — so the symptom is a process
      // sitting at ~50 MB, no console.log at all, and our own DLL reporting
      // `engine never came up within 120000 ms`. It cost a run here.
      //
      // launch.ps1 deletes it only when the PID inside is dead and REFUSES when it is
      // live, because on Windows that marker is a real single-instance interlock. On
      // this box it is not: every instance has its own lobby port (ENW_LOBBY_PORT,
      // dedi.md §19), its own game copy and fs_homepath, and the
      // marker is one shared file in one Wine prefix that instance two would always
      // find live. So here it is removed unconditionally. DO NOT copy this to the
      // Windows path.
      if (!this.mgr.dryRun && this.mgr.wine.marker !== false) {
        const marker = this.mgr.wine.marker
          || path.join(this.mgr.wine.prefix, 'drive_c', 'users', 'waw', 'AppData', 'Local', 'Activision', 'CoDWaW', '__CoDWaW')
        try { if (fs.existsSync(marker)) { fs.unlinkSync(marker); this.log.debug(`cleared the stale safe-mode marker ${marker}`) } } catch (e) { this.log.warn(`could not clear ${marker}: ${e.message}`) }
      }
      try { fs.mkdirSync(path.join(this.mgr.wine.prefix, 'drive_c', ...homeWin.replace(/^[A-Za-z]:\\/, '').split('\\'), 'main'), { recursive: true }) } catch { /* best effort */ }
      this.log.info(`wine: ${gameDir} -> fs_homepath ${homeWin} (slot ${this.slot()}, lobby port ${this.lobbyPort()})`)
    } else if (this.kind === 'game') {
      // ONE REAL GAME PER BOX, and say so out loud.
      //
      // Every game instance this manager starts uses the same `gameCopy`, so the same
      // ZombiesDev\waw-<copy>, the same fs_homepath, and the same game.lock owner name.
      // `launch.ps1` takes the lock exclusively, so a second one throws. Measured:
      // `--boot 2 --game` starts both in the same tick, the lock file does not exist yet
      // for the check below, inst-02's PowerShell exits 1, and the referee logs it as
      // `server_crash` — a game that never existed, recorded as a crashed one.
      //
      // Refuse it here instead, with the actual reason. Lifting the limit needs a game
      // copy and a homepath PER INSTANCE plus `-Companion` for the second onwards; the
      // engine itself is fine with it (two headless servers coexist — see
      // docs/kickstart/host.md §10.5).
      const otherGame = [...this.mgr.instances.values()].find(
        (i) => i !== this && i.kind === 'game' && (i.state === 'starting' || i.state === 'running'))
      if (otherGame && !this.mgr.dryRun) {
        this.state = 'failed'
        this.failReason = `only one real game per box: ${otherGame.id} already holds game copy "${this.mgr.gameCopy}" and the game lock`
        this.log.warn(this.failReason); this.emit('failed', this.failReason); return false
      }
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
    let spawned
    try { spawned = this.spawnArgs() } catch (e) {
      this.state = 'failed'
      this.failReason = e.message
      this.log.warn(this.failReason); this.emit('failed', this.failReason); return false
    }
    const { cmd, argv, cwd } = spawned
    const env = {
      ...process.env,
      ENW_HOST: `${this.mgr.linkHost}:${this.mgr.linkPort}`,
      ENW_INSTANCE: this.id,
      ENW_ROLE: this.role,
      ENW_MATCH: this.matchId || '',
      ENW_PORT: String(this.port),
      ...(this.kind === 'game' ? this.gameEnv() : {}),
      // Wine mode: launch.ps1 is not there to set these, so we do. SteamAppId/SteamGameId
      // are what stop SteamStub asking Steam to relaunch app 10090 out of the Steam
      // folder (foundation.md §7); DISPLAY and WINEPREFIX pick the headless X server and
      // the 32-bit prefix the Steam client is logged in under.
      ...(this.kind === 'game' && this.mgr.wine
        ? {
            WINEPREFIX: this.mgr.wine.prefix,
            DISPLAY: this.mgr.wine.display,
            WINEDEBUG: this.mgr.wine.debug || '-all',
            SteamAppId: '10090',
            SteamGameId: '10090',
          }
        : {}),
      ...this.env,
    }
    this.state = 'starting'
    this.startedAt = Date.now()
    this.log.info(`start ${this.kind} port ${this.port} -> ${path.basename(argv[0] || cmd)}`)
    this.logStream.write(`\n=== ${new Date().toISOString()} start ${this.kind} ${cmd} ${argv.join(' ')}\n`)
    const child = spawn(cmd, argv, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
    // A removed instance's exit is never a crash to restart or a failure to report: the
    // host already forgot it (the 12:15 "inst-61 ... out of restarts" line was this).
    const wanted = this.state === 'exiting' || !!this.removed
    this.state = 'exited'
    this.log.info(`exit code=${code} signal=${sig || '-'}${wanted ? '' : ' (unexpected)'}`)
    this.logStream.write(`=== ${new Date().toISOString()} exit ${code} ${sig || ''}\n`)
    // launch.ps1 took the lock in OUR game-copy's name and then returned, so releasing it
    // is our job. releaseGameLock only deletes a lock whose owner matches, so we can never
    // free another agent's.
    // Wine mode never took a lock, so it has none to release.
    if (this.kind === 'game' && !this.mgr.wine) releaseGameLock(this.mgr.gameCopy)
    this.emit('exit', { code, sig, wanted })
    if (!wanted && this.restartPolicy() ) {
      this.restarts++
      const delay = Math.min(30_000, 1000 * 2 ** (this.restarts - 1))
      this.log.warn(`restarting in ${delay}ms (${this.restarts}/${this.maxRestarts})`)
      setTimeout(() => { if (!this.mgr.stopping && !this.removed) this.start() }, delay).unref?.()
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
    // A FOREIGN instance (Play Local: the launcher launched the game, we only referee it)
    // is not ours to kill. dev-box.md rule 4 is about not killing other agents' game
    // processes; the same reasoning covers a player's own game on their own PC.
    if (this.foreign) { this.log.info(`not stopping ${this.id}: we did not start it (${reason})`); this.state = 'exited'; this.exitedAt = Date.now(); return Promise.resolve() }
    if (!this.child || this.state === 'exited') {
      // Never started (a queued boot): nothing to kill, and it must not start later.
      if (!this.child && this.state === 'new') { this.state = 'exited'; this.exitedAt = Date.now() }
      return Promise.resolve()
    }
    this.state = 'exiting'
    this.log.info(`stopping: ${reason}`)
    // A real game was never our child, so there is no SIGTERM to send and no 'exit' to
    // wait for: kill the PID we adopted and release the lock launch.ps1 left behind.
    if (this.kind === 'game' && this.gamePid) {
      if (this.watch) { clearInterval(this.watch); this.watch = null }
      // BY PID, OURS, AND ON EITHER PLATFORM. `taskkill.exe` does not exist on the Linux
      // box, and in `--wine` mode the game is usually our own child so this branch does
      // not run — but the engine prints its own `PID <n>` line on some boots, which
      // adopts a gamePid and lands here, and a `taskkill.exe` that fails to spawn leaves
      // the process up with the instance believing it killed it.
      try {
        if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(this.gamePid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        else process.kill(this.gamePid, 'SIGKILL')
      } catch (e) { this.log.debug(`kill ${this.gamePid}: ${e.message}`) }
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
      // For a real game `pid` is the PowerShell WRAPPER, which exits seconds later — the
      // game itself is `game_pid`, and that is the one an operator would taskkill and the
      // one the CPU/RAM samples are taken from. Reporting only `pid` meant the dashboard
      // showed a PID that no longer existed.
      game_pid: this.gamePid || null,
      foreign: !!this.foreign,
      state: this.state, match_id: this.matchId, restarts: this.restarts,
      uptime_ms: this.startedAt ? (this.exitedAt || Date.now()) - this.startedAt : 0,
      log: this.logFile, fail: this.failReason || null, usage: this.usage(),
      assignment: this.assignment ? { map: this.assignment.map, mode: this.assignment.mode, nonce: this.assignment.nonce } : null,
    }
  }
}

export class InstanceManager extends EventEmitter {
  constructor({ root, logDir, linkHost, linkPort, basePort = 28960, lobbyBase = 3074, maxInstances = 8, launchScript, lockOwner = 'host', gameCopy = 'host', wine = null, dryRun = false, sampleMs = 5000, log } = {}) {
    super()
    this.root = root
    this.logDir = logDir
    this.linkHost = linkHost
    this.linkPort = linkPort
    this.basePort = basePort
    this.lobbyBase = lobbyBase
    this.maxInstances = maxInstances
    this.launchScript = launchScript
    this.lockOwner = lockOwner
    // The dev game copy (ZombiesDev\waw-<gameCopy>) AND the name launch.ps1 writes into
    // game.lock — they are the same string in launch.ps1, so they must be here too.
    this.gameCopy = gameCopy
    // null on Windows. Set (by --wine) it replaces launch.ps1 with a direct `wine
    // CoDWaW.exe`, and with it the lock, the PID adoption and the Windows game copy.
    this.wine = wine
    this.dryRun = dryRun
    this.sampleMs = sampleMs
    this.log = log || makeLog('instances')
    this.instances = new Map()
    this.removedRecently = new Map()   // id -> Instance, the last 32 removed (orphan hellos)
    this.ownedPids = new Set()
    this.usedPorts = new Set()
    this.stopping = false
    this.sampler = new ProcSampler({ log: this.log })
    this.seq = 0
  }

  startSampling() {
    if (this.sampleTimer) return
    const run = async () => {
      // Foreign instances are sampled too — knowing what a real game costs is the point —
      // we just never kill them.
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
    // Marked BEFORE the stop: a start() queued anywhere (the boot queue, a restart timer)
    // must find it gone even while the stop is still in flight.
    inst.removed = true
    await inst.stop(reason)
    this.usedPorts.delete(inst.port)
    this.instances.delete(id)
    // Kept, briefly, so a `hello` from a process that escaped anyway can be matched to the
    // child we spawned and killed by OUR pid (host.js onOrphanHello). Never reused.
    this.removedRecently.set(id, inst)
    if (this.removedRecently.size > 32) this.removedRecently.delete(this.removedRecently.keys().next().value)
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
