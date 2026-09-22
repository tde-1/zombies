#!/usr/bin/env node
// ENW Zombies host agent — the software that runs on a game box.
//
// One process per box. It starts game-server instances, talks to them over
// game-link-v0, referees them, records a signed replay of every game, bridges chat to the
// site's global channel, answers the DLL's invite-token checks, reports results over the
// pull protocol, and serves a local dashboard with a live 2D view.
//
//   node host.js --boot 1 --sim-players 4                 # standalone, one simulated game
//   node host.js --site http://127.0.0.1:8080 --secret devkey-a --box box-a
//   node host.js --game --map nazi_zombie_asylum          # a real CoDWaW.exe (takes game.lock)
//   node host.js --game --wine --map nazi_zombie_prototype  # the Linux box: wine, no lock
//
// Nothing here needs the game to exist: --boot runs the simulator, and the real DLL drops
// into the same socket.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { makeLog, parseArgs, setLogLevel, mkdirp, id as makeId, fmtBytes, fmtDur, sha256hex } from './lib/util.js'
import { GameLinkServer } from './lib/gamelink.js'
import { InstanceManager } from './lib/instances.js'
import { Referee } from './lib/referee.js'
import { ManifestStore } from './lib/manifests.js'
import { ReplayWriter } from './lib/replay.js'
import { TokenGuard } from './lib/tokens.js'
import * as keys from './lib/keys.js'
import { SiteClient } from './lib/siteclient.js'
import { Dashboard } from './lib/dashboard.js'
import { hostInfo } from './lib/procstat.js'
import { GameLog } from './lib/gamelog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Weapons the magic box will only hand out one of. Holding one must survive a drop, or
// the box hands out a second and weapon duplication is a ban on every board.
const LIMITED = new Set(['wunderwaffe', 'wunderwaffe_dg2', 'm2_flamethrower', 'flamethrower'])
const REPO = path.resolve(__dirname, '..', '..')
const a = parseArgs(process.argv.slice(2))
if (a.debug) setLogLevel('debug')
const log = makeLog('host')

const cfg = {
  boxName: a.box || process.env.ENW_BOX || 'box-a',
  linkHost: a['link-host'] || '127.0.0.1',
  linkPort: Number(a['link-port'] ?? 38700),
  dashPort: Number(a['dash-port'] ?? 8787),
  dash: a.dash !== 'off',
  site: a.site || process.env.ENW_SITE || null,
  secret: a.secret || process.env.ENW_SECRET || 'devkey-a',
  replayDir: a['replay-dir'] || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'replays'),
  logDir: a['log-dir'] || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'logs', 'host'),
  keyDir: a['key-dir'] || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'keys'),
  maxInstances: Number(a['max-instances'] ?? 8),
  basePort: Number(a['base-port'] ?? 28960),
  launchScript: a['launch-script'] || path.join(REPO, 'tools', 'dev', 'launch.ps1'),
  gameCopy: a['game-copy'] || 'host',   // ZombiesDev\waw-<this>, and the game.lock owner
  // ---- WINE MODE (the Linux box; off unless --wine, docs/kickstart/vps.md §13) --------
  // `--game` normally shells out to tools/dev/launch.ps1, which needs PowerShell, a
  // Windows game copy and ZombiesDev\locks\game.lock. On zombies-dev there is none of
  // that, so --wine spawns `wine CoDWaW.exe` directly instead. `{id}` in either path is
  // replaced with the instance id, which is what allows more than one instance: sharing a
  // game copy and a homepath is the only reason the Windows path allows exactly one.
  wine: a.wine
    ? {
        bin: a['wine-bin'] || 'wine',
        prefix: a['wine-prefix'] || '/home/waw/pfx',
        display: a['wine-display'] || ':99',
        debug: a['wine-debug'] || '-all',
        gameDir: a['wine-game-dir'] || '/home/waw/pfx/drive_c/zdev/waw-{id}',
        homeWin: a['wine-homepath'] || 'C:\\zdev\\homes\\{id}',
        maxFps: Number(a['wine-maxfps'] ?? 60),
      }
    : null,
  dryRun: !!a['dry-run'],
  requireToken: a['require-token'] != null ? a['require-token'] !== 'false' : !!a.site,
  chunkMs: Number(a['chunk-ms'] ?? 60_000),
  zstdLevel: Number(a['zstd-level'] ?? 10),
  gameLog: a['game-log'] !== 'off',   // the IW4MAdmin/B3-readable games_mp.log mirror
  gameLogPrefix: a['game-log-prefix'] || 'ENWZombie',
  // ---- LOCAL MODE (Play Local; the launcher owns the process, we are the referee) -----
  // On a player's own PC the launcher launches the game and the host agent runs beside it.
  // That is the opposite of a game box, and the two must never be confused, so it is off
  // by default and refuses to engage while this box holds a lease.
  //   --local        accept a game we were TOLD to expect (POST /api/local/expect)
  //   --adopt-local  additionally accept a `hello` we were told nothing about
  local: !!a.local || !!a['adopt-local'],
  adoptLocal: !!a['adopt-local'],
  // How long a local game's link may stay down before we call the game and sign the
  // replay. Long enough for a SteamStub relaunch, short enough that a player who quits
  // gets their result while they are still looking at the launcher.
  localOrphanMs: Number(a['local-orphan-ms'] ?? 15_000),
  liveHz: Number(a['live-hz'] ?? 4),   // frames per second to the site's spectator view
  referee: {
    ...(a['cap-ms'] ? { capMs: Number(a['cap-ms']) } : {}),
    ...(a['cap-warn-ms'] ? { capWarnMs: String(a['cap-warn-ms']).split(',').map(Number) } : {}),
    ...(a['afk-warn-ms'] ? { afkWarnMs: Number(a['afk-warn-ms']) } : {}),
    ...(a['afk-kick-ms'] ? { afkKickMs: Number(a['afk-kick-ms']) } : {}),
    ...(a['all-afk-pause-ms'] ? { allAfkPauseMs: Number(a['all-afk-pause-ms']) } : {}),
    ...(a['all-afk-close-ms'] ? { allAfkCloseMs: Number(a['all-afk-close-ms']) } : {}),
    ...(a['crash-grace-ms'] ? { crashGraceMs: Number(a['crash-grace-ms']) } : {}),
    ...(a['empty-close-ms'] ? { emptyCloseMs: Number(a['empty-close-ms']) } : {}),
  },
}

/** One game: an instance, its link connection, its referee and its replay writer. */
class Game extends EventEmitter {
  constructor(host, instance, { matchId, mode, vip, assignment, tokens, refereeConfig, selfReported = false }) {
    super()
    this.host = host
    this.instance = instance
    this.matchId = matchId || makeId('m', 4)
    this.mode = mode || 'custom'
    this.vip = !!vip
    this.assignment = assignment || null
    this.tokens = tokens || {}
    // A game this box did not launch. Everything it produces says so, all the way to the
    // site, and nothing can un-say it later.
    this.selfReported = !!selfReported
    this.conn = null
    this.pending = []
    this.writer = null
    this.replayFile = null
    this.log = log.child(instance.id)
    this.manifest = host.manifests.get(null)
    this.referee = new Referee({
      instanceId: instance.id, matchId: this.matchId, mode: this.mode, vip: this.vip,
      manifest: this.manifest, config: { ...cfg.referee, ...(refereeConfig || {}) }, log: this.log,
    })
    this.referee.on('command', (c) => this.sendToGame(c))
    this.referee.on('over', (s) => this.finish(s))
    this.referee.on('manifest_wanted', (map) => { this.manifest = host.manifests.get(map); this.referee.setManifest(this.manifest) })
    // Crash recovery (vault 10 §5). The referee decides WHEN; the host does the two bits
    // of I/O: ask the game for the leaving player's state, and hand it back when they
    // return. Both are recorded, because "Resumed" has to be auditable from the replay.
    this.referee.on('snapshot_wanted', ({ slot, steamid }) => this.snapshotFor(slot, steamid))
    this.referee.on('restore_wanted', ({ slot, steamid, state }) => {
      const cmd = this.referee.send({ t: 'restore', slot, state })
      this.recordHostEvent({ t: 'restore', slot, steamid, id: cmd.id, keys: Object.keys(state || {}) })
      this.log.info(`restoring ${steamid} into slot ${slot} (${state?.players?.length ? 'full state' : 'partial'})`)
    })
    for (const k of ['cap_warning', 'afk_warn', 'afk_kick', 'finish', 'signal', 'paused', 'resumed', 'resume_countdown', 'state_held']) {
      this.referee.on(k, (d) => this.recordHostEvent({ t: 'referee', kind: k, ...(typeof d === 'object' ? d : { value: d }) }))
    }
    this.gameLog = new GameLog({ file: path.join(cfg.logDir, `${instance.id}.games_mp.log`), enabled: cfg.gameLog, prefix: cfg.gameLogPrefix })
    this.tickTimer = setInterval(() => this.referee.tick(), 1000)
    this.tickTimer.unref?.()
  }

  attach(conn) {
    this.conn = conn
    clearTimeout(this.orphanTimer)
    conn.on('message', (m) => this.onGameMessage(m))
    conn.on('close', () => {
      this.conn = null
      this.log.info('game link closed')
      this.onLinkClosed()
    })
    for (const c of this.pending.splice(0)) conn.send(c)
  }

  /**
   * The link went away. For an instance WE launched, the process watcher already
   * handles this — an exit we did not want becomes `server_crash` and the game is
   * saved up to the crash.
   *
   * A LOCAL GAME HAS NO SUCH WATCHER. The launcher owns the process and we never
   * touch it (dev-box.md rule 4), so if the player alt-F4s World at War, or it
   * crashes, nothing here ever notices. The consequences are worse than they look:
   * `finish()` is what CLOSES THE REPLAY, and a replay with no signed footer is not a
   * replay — it is a prefix of one. Every local game that did not end through the
   * scripts' own game-over would have left an unverifiable stub on the player's disk.
   *
   * So: a grace period, then call it. The grace is there because the one way a link
   * legitimately drops mid-game is SteamStub relaunching the game under a new pid
   * (referee, board 01:20), and that reconnects within a second or two.
   */
  onLinkClosed() {
    if (this.finished || !this.instance.foreign) return
    clearTimeout(this.orphanTimer)
    this.orphanTimer = setTimeout(() => {
      if (this.finished || this.conn) return
      this.log.warn('the local game closed its link and did not come back — ending the game so the replay is written and signed')
      this.referee.flags.add('link_closed')
      this.referee.finishGame('link_closed')
    }, Number(cfg.localOrphanMs))
    this.orphanTimer.unref?.()
  }

  sendToGame(c) {
    if (this.conn) this.conn.send(c)
    else this.pending.push(c)
  }

  onGameMessage(m) {
    // 1. the referee decides what it means
    this.referee.onEvent(m)
    // 2. it goes into the replay, unmodified
    this.record(m)
    // 3. the side effects that are the HOST's job, not the referee's
    if (m.t === 'map_loaded') this.openReplay(m)
    if (m.t === 'player_connect') this.authPlayer(m)
    if (m.t === 'chat') this.host.onGameChat(this, m)
    this.gameLog.onEvent(m, this.referee)
    this.host.dash?.push('event', { instance: this.instance.id, ev: m })
  }

  // ---- invite tokens ------------------------------------------------------------
  authPlayer(ev) {
    const r = this.host.tokenGuard.admit(ev, this.matchId)
    const p = this.referee.players.get(ev.slot)
    if (p) p.tokenOk = r.allow
    this.sendToGame({ t: 'auth', slot: ev.slot, allow: r.allow, reason: r.reason })
    this.recordHostEvent({ t: 'auth_decision', slot: ev.slot, steamid: ev.steamid || null, allow: r.allow, reason: r.reason })
    this.log[r.allow ? 'info' : 'warn'](`auth slot ${ev.slot} ${ev.name || ''} ${ev.steamid || ''}: ${r.allow ? 'ALLOW' : 'DENY'} (${r.reason})`)
    if (!r.allow) this.referee.players.delete(ev.slot)
  }

  /**
   * Ask the game for the restorable state and keep the leaving player's slice of it.
   * The whole-level snapshot is what the protocol returns; we hold only that person's
   * part plus the level-scoped facts a restore needs.
   */
  snapshotFor(slot, steamid) {
    const cmd = this.referee.send({ t: 'snapshot_state' })
    const timer = setTimeout(() => {
      this.referee.off('reply', onReply)
      this.log.warn(`snapshot_state for ${steamid} timed out — nothing to restore if they come back`)
      this.recordHostEvent({ t: 'snapshot_failed', slot, steamid, reason: 'timeout' })
    }, 5000)
    timer.unref?.()
    const onReply = (ev) => {
      if (ev.id !== cmd.id) return
      clearTimeout(timer)
      this.referee.off('reply', onReply)
      if (!ev.ok) { this.log.warn(`snapshot_state failed: ${ev.error}`); return }
      const whole = ev.value || {}
      const mine = (whole.players || []).find((p) => String(p.steamid) === String(steamid) || p.slot === slot)
      const state = {
        ...mine,
        round: whole.round,
        power_on: whole.power_on,
        pap_built: whole.pap_built,
        // What the box must keep reserved while they are away: the magic box counts
        // limited weapons held by CONNECTED players only, so a dropped Wunderwaffe can
        // come out of the box again and be duplicated (vault 10 §5).
        limited_weapons_held: mine?.weapon && LIMITED.has(mine.weapon) ? [mine.weapon] : [],
      }
      this.referee.holdState(steamid, state)
      this.recordHostEvent({ t: 'snapshot_held', slot, steamid, score: state.score ?? null, weapon: state.weapon ?? null, reserved: state.limited_weapons_held })
    }
    this.referee.on('reply', onReply)
  }

  // ---- replay --------------------------------------------------------------------
  openReplay(mapEv) {
    if (this.writer) return
    const file = path.join(cfg.replayDir, `${this.matchId}.enwr`)
    const header = {
      match_id: this.matchId,
      instance: this.instance.id,
      box: cfg.boxName,
      mode: this.mode,
      map: mapEv.map,
      fs_game: mapEv.fs_game || null,
      map_name: this.manifest.title || null,
      manifest: this.manifest.map || null,
      manifest_source: this.manifest._source || null,
      manifest_confidence: this.manifest.confidence || null,
      script_fingerprints: this.manifest.script_fingerprints || null,
      sv_maxclients: mapEv.sv_maxclients ?? null,
      started_at: new Date().toISOString(),
      // The environment the run happened in — vault 10 §4: the server proves the
      // environment, and the fingerprint on the HUD is derived from exactly this.
      exe_sha256: this.referee.hashes.exe_sha256 || null,
      dll_build: this.referee.hashes.dll_build || null,
      dvars: this.assignment?.settings?.dvars || {},
      knobs: this.assignment?.settings?.knobs || {},
      players: this.assignment?.players || null,
      protocol: 'game-link-v0',
      self_reported: this.selfReported,
      host_info: hostInfo(),
    }
    this.writer = new ReplayWriter({
      file, header, privateKey: this.host.hostKey.privateKey,
      pub: this.host.hostKey.pub, keyId: this.host.hostKey.keyId,
      chunkMs: cfg.chunkMs, level: cfg.zstdLevel,
    })
    this.replayFile = file
    this.fingerprint = sha256hex(Buffer.from(this.writer.headerBytes)).slice(0, 16)
    this.log.info(`recording -> ${file} (fingerprint ${this.fingerprint})`)
    for (const ev of this.preMap || []) this.writer.append(ev)
    this.preMap = null
  }

  record(ev) {
    // Once the footer is signed the file is closed for good. Anything the game says
    // after the referee called the game (a few trailing snaps as the process winds down)
    // is logged and dropped rather than silently changing a signed replay.
    if (this.finished) { this.lateEvents = (this.lateEvents || 0) + 1; return }
    if (this.writer) this.writer.append(ev)
    else (this.preMap ||= []).push(ev)
  }

  /** A host-side decision (auth, AFK kick, cap warning, chat relayed in) is evidence too. */
  recordHostEvent(ev) { this.record({ ms: this.referee.now(), host: true, ...ev }) }

  // ---- end -----------------------------------------------------------------------
  async finish(summary) {
    if (this.finished) return
    this.finished = true
    clearInterval(this.tickTimer)
    // The game is decided; a restart now would be a new, empty game on a dead match.
    this.instance.maxRestarts = 0
    summary.fingerprint = this.fingerprint || null
    if (this.selfReported) {
      // Belt and braces on top of mode 'local' already zeroing both of these.
      summary.self_reported = true
      summary.records_eligible = false
      summary.xp_multiplier = 0
      if (!summary.flags.includes('self_reported')) summary.flags.push('self_reported')
    }
    let replay = null
    if (this.writer) {
      const stats = this.writer.close({ summary })
      replay = {
        file: stats.file, size: stats.size, chunks: stats.chunks, events: stats.events,
        raw_bytes: stats.rawBytes, ratio: Number(stats.ratio.toFixed(1)),
        mb_per_hour: stats.durationMs > 0 ? Number((stats.size / 1048576 / (stats.durationMs / 3600000)).toFixed(2)) : null,
        // WHICH KEY SIGNED IT. Without this the site stores the replay unpinned and record
        // review correctly refuses to call it evidence: a file that verifies against the
        // key it carries proves integrity, not authorship (host.md §5).
        key_id: this.host.hostKey.keyId,
        pub: this.host.hostKey.pub,
      }
      this.log.info(`replay closed: ${fmtBytes(stats.size)} in ${stats.chunks} chunks, ${stats.events} events, ${stats.ratio.toFixed(1)}x, ${replay.mb_per_hour} MB/game-hour`)
    }
    summary.usage = this.instance.usage()
    this.gameLog.onSummary(summary); this.gameLog.close()
    this.log.info(`SUMMARY ${summary.map} round ${summary.rounds} finish=${summary.finish?.kind || 'none'} ${fmtDur(summary.duration_ms)} flags=[${summary.flags.join(',')}] eligible=${summary.records_eligible}`)
    this.host.games.set(this.matchId, { summary, replay })
    this.host.dash?.push('summary', { instance: this.instance.id, summary, replay })
    await this.host.site?.postResult({ box: cfg.boxName, instance: this.instance.id, summary, replay })
      .catch((e) => this.log.warn(`result post failed (${e.message}) — held in the spool, not lost`))
    // Reap: stop the process and free the slot.
    setTimeout(() => this.host.instances.remove(this.instance.id, 'game over'), 3000).unref?.()
    this.emit('finished', summary)
  }
}

class HostAgent {
  constructor() {
    this.games = new Map()          // matchId -> { summary, replay }
    this.byInstance = new Map()     // instanceId -> Game
    this.expected = new Map()       // instanceId -> { match_id, map, at } (local mode)
    mkdirp(cfg.replayDir); mkdirp(cfg.logDir); mkdirp(cfg.keyDir)
    this.hostKey = keys.loadOrCreate(path.join(cfg.keyDir, `host-${cfg.boxName}.json`))
    this.manifests = new ManifestStore([
      path.join(__dirname, 'manifests'),          // our fallbacks / the schema examples
      path.join(REPO, 'referee', 'manifests'),    // the referee agent's, which win
    ])
    this.tokenGuard = new TokenGuard(null, { requireToken: cfg.requireToken })
    this.link = new GameLinkServer({ host: cfg.linkHost, port: cfg.linkPort, log: log.child('link') })
    this.instances = new InstanceManager({
      root: __dirname, logDir: cfg.logDir, linkHost: cfg.linkHost, linkPort: cfg.linkPort,
      basePort: cfg.basePort, maxInstances: cfg.maxInstances, launchScript: cfg.launchScript,
      lockOwner: cfg.gameCopy, gameCopy: cfg.gameCopy, wine: cfg.wine, dryRun: cfg.dryRun, log: log.child('inst'),
    })
  }

  async start() {
    await this.link.listen()
    this.instances.linkPort = this.link.port
    this.link.on('hello', (conn, msg) => {
      let g = this.byInstance.get(conn.instance)
      if (!g) g = this.acceptLocal(conn, msg)
      if (!g) return
      log.info(`instance ${conn.instance} linked (pid ${msg.pid}, ${msg.dll_build})`)
      g.attach(conn)
      g.referee.onEvent(msg)
      g.record(msg)
    })
    this.instances.startSampling()
    this.reaper = setInterval(() => this.instances.reap(), 15_000); this.reaper.unref?.()

    if (cfg.dash) {
      // The dashboard is an operator convenience; refereeing games is the job. A busy
      // port must not take the box down with it — that turned a port clash with another
      // tool on this machine into a box that silently never booted while the site happily
      // leased games to it.
      this.dash = new Dashboard({ port: cfg.dashPort, host: this, replayDir: cfg.replayDir, log: log.child('dash') })
      try { await this.dash.listen() }
      catch (e) {
        log.warn(`dashboard disabled: ${e.code === 'EADDRINUSE' ? `port ${cfg.dashPort} is already in use (--dash-port to move it, --dash off to silence this)` : e.message}`)
        this.dash = null
      }
    }

    if (cfg.site) {
      this.site = new SiteClient({ base: cfg.site, secret: cfg.secret, boxName: cfg.boxName, spoolDir: cfg.spoolDir, liveHz: cfg.liveHz, log: log.child('site') })
      try {
        const k = await this.site.fetchKeys()
        this.tokenGuard.setPublicKey(keys.publicFromRaw(k.invite_pub))
        log.info(`site invite key ${k.key_id} loaded — token checks ${cfg.requireToken ? 'ENFORCED' : 'advisory'}`)
      } catch (e) { log.warn(`could not fetch the site invite key (${e.message}); joins will be refused until it is available`) }
      // The live spectator view: the same referee state() the local dashboard draws,
      // pushed to the site ~4x a second. This is what replaces web/tools/live-bridge.js.
      this.site.liveFrames = () => [...this.byInstance.values()]
        .filter((g) => !g.finished && g.referee.phase !== 'boot')
        .map((g) => ({ instance: g.instance.id, match_id: g.matchId, state: g.referee.state() }))
      this.site.on('assignment', (asg) => this.onAssignment(asg))
      this.site.on('chat', (e) => this.onNetworkChat(e))
      this.site.start()
      this.statusTimer = setInterval(() => this.reportStatus(), 10_000); this.statusTimer.unref?.()
    }

    if (cfg.local && cfg.site) {
      log.error('REFUSING TO START: --local/--adopt-local cannot be combined with --site. ' +
        'A box attached to the site serves leased games and must never adopt processes off its own loopback. ' +
        'Play Local runs a separate agent with no --site; the launcher is what talks to the site.')
      process.exit(2)
    }
    if (cfg.local) {
      log.warn(`LOCAL MODE is on (${cfg.adoptLocal ? 'adopt ANY hello' : 'expected instances only'}). ` +
        'Games adopted here are stamped self-reported: no XP, no records, no badges. Never run this on a game box.')
    }

    log.info(`host agent up: box=${cfg.boxName} link=${cfg.linkHost}:${this.link.port} dash=${cfg.dash ? `http://127.0.0.1:${cfg.dashPort}` : 'off'} key=${this.hostKey.keyId}`)
    log.info(`host: ${hostInfo().cpu} (${hostInfo().cores} cores)`)

    const boot = Number(a.boot || 0)
    for (let i = 0; i < boot; i++) {
      this.boot({
        kind: a.game ? 'game' : 'sim',
        matchId: makeId('m', 4),
        mode: a.mode || 'custom',
        map: a.map || 'nazi_zombie_asylum',
        vip: !!a.vip,
        sim: {
          players: Number(a['sim-players'] ?? 4),
          timescale: Number(a['sim-timescale'] ?? 1),
          maxRound: Number(a['sim-max-round'] ?? 15),
          eeRound: a['sim-ee-round'] ? Number(a['sim-ee-round']) : null,
          afkSlot: a['sim-afk-slot'] != null ? Number(a['sim-afk-slot']) : null,
          lateJoinMs: a['sim-late-join-ms'] ? Number(a['sim-late-join-ms']) : null,
          seed: Number(a.seed ?? 1337) + i,
        },
      })
    }
  }

  localEnabled() { return !!cfg.local }
  /**
   * The gate on adoption, and it is deliberately blunt: **a box that can serve leases is
   * a game box and never adopts**, whatever its flags say. Having a site configured at
   * all is enough — not "is currently leased", because the window between leases is
   * exactly when a race would slip through. A Play Local agent has no site: the launcher
   * is the thing that talks to the site.
   */
  leaseHeld() { return !!cfg.site || [...this.byInstance.values()].some((x) => x.assignment && !x.finished) }
  linkAddress() { return `${cfg.linkHost}:${this.link.port}` }

  /**
   * A `hello` from a process we did not launch. Play Local: the launcher owns the game,
   * we are the referee and the replay writer beside it.
   *
   * THREE THINGS KEEP THIS FROM BECOMING A HOLE.
   *  1. It is off by default and needs `--local` (expected instances only) or
   *     `--adopt-local` (anything). A plain game box ignores the hello exactly as before.
   *  2. It is REFUSED while this box holds a lease. A box serving Verified games must
   *     never also be adopting processes off its own loopback, whatever its flags say.
   *  3. Everything it produces is stamped `self_reported` and forced to mode `local`:
   *     no XP, no records, no badges, and the flag travels into the summary, the signed
   *     replay header and the result POST. The site refuses to grade local games anyway;
   *     this is the second lock on the same door.
   */
  acceptLocal(conn, msg) {
    const id = conn.instance
    const expected = this.expected.get(id)
    if (!cfg.local && !expected) { log.warn(`hello from unknown instance ${id} — ignoring (local mode is off; --local to accept expected instances)`); return null }
    // Expired registrations are not registrations.
    if (expected && Date.now() - expected.at > 10 * 60_000) { this.expected.delete(id); log.warn(`the registration for ${id} expired; treating it as unexpected`); return this.acceptLocal(conn, msg) }
    const leased = this.leaseHeld()
    if (leased) { log.error(`REFUSING to adopt ${id}: this box holds a lease. A box serving leased games never adopts local processes.`); return null }
    if (!expected && !cfg.adoptLocal) { log.warn(`hello from unexpected instance ${id} — ignoring (--local accepts only instances registered with POST /api/local/expect; --adopt-local to accept any)`); return null }
    this.expected.delete(id)

    const game = new Game(this, this.localInstance(id, msg), {
      matchId: expected?.match_id || id,
      mode: 'local',
      selfReported: true,
    })
    this.byInstance.set(id, game)
    log.warn(`ADOPTED a local game: instance ${id}, match ${game.matchId}, pid ${msg.pid}, ${msg.dll_build} — ` +
      `${expected ? 'registered in advance' : 'BLIND (--adopt-local)'}. Marked self-reported: no XP, no records, no badges.`)
    return game
  }

  /** A stand-in Instance for a process the launcher owns: we watch it, we never kill it. */
  localInstance(id, msg) {
    const inst = this.instances.create({ id, kind: 'local', role: msg.role || 'solo', matchId: id, port: 0 })
    inst.state = 'running'
    inst.startedAt = Date.now()
    // Sample its CPU and RAM, but do NOT add it to ownedPids: we did not start it, so
    // `stop()` must never kill it (dev-box.md rule 4). The launcher owns the lifetime.
    inst.pid = msg.pid || null
    inst.foreign = true
    return inst
  }

  /** Boot one game-server instance and wire a referee + replay to it. */
  boot(opts) {
    const simArgs = []
    const s = opts.sim || {}
    if (opts.kind !== 'game') {
      simArgs.push('--players', String(s.players ?? 1))
      simArgs.push('--timescale', String(s.timescale ?? 1))
      simArgs.push('--max-round', String(s.maxRound ?? 15))
      simArgs.push('--map', opts.map || 'nazi_zombie_asylum')
      simArgs.push('--seed', String(s.seed ?? 1337))
      if (s.eeRound) simArgs.push('--ee-round', String(s.eeRound))
      if (s.endingRound) simArgs.push('--ending-round', String(s.endingRound))
      if (s.afkSlot != null) simArgs.push('--afk-slot', String(s.afkSlot))
      if (s.lateJoinMs) simArgs.push('--late-join-ms', String(s.lateJoinMs))
    }
    const inst = this.instances.create({
      kind: opts.kind || 'sim',
      role: 'server',
      matchId: opts.matchId,
      assignment: opts.assignment || { map: opts.map, mode: opts.mode },
      args: simArgs,
      env: opts.roster ? { ENW_SIM_ROSTER: JSON.stringify(opts.roster) } : (opts.tokens ? { ENW_SIM_TOKENS: JSON.stringify(opts.tokens) } : {}),
    })
    const game = new Game(this, inst, {
      matchId: opts.matchId, mode: opts.mode, vip: opts.vip,
      assignment: opts.assignment, tokens: opts.tokens,
      // The site owns the rule windows (a VIP lobby is uncapped, a tournament might get a
      // different AFK budget), so a lease may override them. The box just enforces.
      refereeConfig: opts.assignment?.settings?.referee || null,
    })
    this.byInstance.set(inst.id, game)
    inst.on('exit', ({ wanted }) => {
      if (!wanted && !game.finished) {
        game.referee.flags.add('server_crash')
        game.log.warn('instance exited unexpectedly — saving the game up to the crash')
        game.referee.finishGame('server_crash')
      }
    })
    inst.on('failed', (why) => { game.log.error(`instance failed: ${why}`); if (!game.finished) game.referee.finishGame('instance_failed') })
    const ok = inst.start()
    if (ok) log.info(`booted ${inst.id} match=${game.matchId} kind=${inst.kind} map=${opts.map || '-'}`)
    return game
  }

  // ---- the pull protocol ---------------------------------------------------------
  onAssignment(asg) {
    if (asg.status !== 'leased') return
    if ([...this.byInstance.values()].some((g) => g.matchId === asg.match_id && !g.finished)) return
    log.info(`lease ${asg.match_id}: ${asg.map} ${asg.mode} ${asg.players?.length || 0}p`)
    // Boot, then say "ready". On the CS fleet the box announces readiness by its first
    // authenticated poll; here we say it explicitly so the site can time boot-to-joinable.
    // The roster the instance boots with: the real SteamIDs from the lobby, each with the
    // invite token the site minted for it. The DLL will present these at connect.
    const roster = (asg.players || []).map((p, i) => ({ slot: i, name: p.name, steamid: p.steamid, token: asg.tokens?.[p.steamid] ?? null }))
    const game = this.boot({
      roster,
      kind: a.game ? 'game' : 'sim',
      matchId: asg.match_id,
      mode: asg.mode,
      map: asg.map,
      vip: asg.vip,
      assignment: asg,
      tokens: Object.fromEntries(roster.filter((r) => r.token).map((r) => [r.slot, r.token])),
      sim: {
        players: asg.players?.length || 1,
        timescale: Number(asg.sim?.timescale ?? a['sim-timescale'] ?? 1),
        maxRound: Number(asg.sim?.max_round ?? a['sim-max-round'] ?? 15),
        eeRound: asg.sim?.ee_round ?? null,
        endingRound: asg.sim?.ending_round ?? null,
        afkSlot: asg.sim?.afk_slot ?? null,
        lateJoinMs: asg.sim?.late_join_ms ?? null,
        seed: Number(asg.sim?.seed ?? 1337),
      },
    })
    this.site?.status({ state: 'booting', match_id: asg.match_id, instance: game.instance.id, nonce: asg.nonce })
    game.referee.once('live', () => this.site?.status({ state: 'live', match_id: asg.match_id, instance: game.instance.id }))
    const waitReady = setInterval(() => {
      if (game.conn) { clearInterval(waitReady); this.site?.status({ state: 'ready', match_id: asg.match_id, instance: game.instance.id, port: game.instance.port }) }
      if (game.finished) clearInterval(waitReady)
    }, 250)
    waitReady.unref?.()
  }

  async reportStatus() {
    const r = await this.site?.status({
      state: this.byInstance.size ? 'live' : 'idle',
      instances: this.instances.list().map((i) => i.info()),
      host: hostInfo(),
      local_mode: cfg.local ? (cfg.adoptLocal ? 'adopt' : 'expect') : false,
      // Offer our replay-signing PUBLIC key on every heartbeat. The site pins it on first
      // sight and answers { key_pinned, pinned_key_id }; a box whose key stopped matching
      // then finds out within seconds instead of at the end of a game.
      pub: this.hostKey.pub,
      key_id: this.hostKey.keyId,
    })
    if (!r) return
    if (r.warning) log.error(`SITE: ${r.warning}`)
    if (r.key_pinned && !this.keyPinnedLogged) {
      this.keyPinnedLogged = true
      log.info(`replay key ${r.pinned_key_id || this.hostKey.keyId} is PINNED at the site — replays from this box are record-grade`)
    }
    if (r.key_pinned === false && r.pinned_key_id && r.pinned_key_id !== this.hostKey.keyId) {
      log.error(`KEY MISMATCH: the site has ${r.pinned_key_id} pinned for this box but we sign with ${this.hostKey.keyId}. Every replay we write is being stored unpinned.`)
    }
  }

  // ---- cross-server chat -----------------------------------------------------------
  /** A player spoke in one of OUR games. Mirror it to every other game here, then to the site. */
  onGameChat(game, ev) {
    const p = game.referee.players.get(ev.slot)
    const from = p?.name || `slot${ev.slot}`
    const line = { t: 'say', text: `${from}: ${ev.text}`, from: `${game.referee.map || 'game'}` }
    for (const [instId, other] of this.byInstance) {
      if (instId === game.instance.id || other.finished) continue
      other.sendToGame(line)
      other.recordHostEvent({ t: 'chat_in', from, text: ev.text, origin: game.instance.id })
    }
    this.dash?.push('chat', { origin: game.instance.id, from, text: ev.text, map: game.referee.map, steamid: p?.steamid || null })
    this.site?.sayToNetwork({ from, steamid: p?.steamid || null, text: ev.text, map: game.referee.map, instance: game.instance.id })
  }

  /** The site's global channel said something. Push it into every live game here. */
  onNetworkChat(e) {
    const text = `${e.from}: ${e.text}`
    for (const g of this.byInstance.values()) {
      if (g.finished) continue
      g.sendToGame({ t: 'say', text, from: 'Global' })
      g.recordHostEvent({ t: 'chat_in', from: e.from, text: e.text, origin: e.origin || 'site' })
    }
    this.dash?.push('chat', { origin: e.origin || 'site', from: e.from, text: e.text, network: true })
  }

  /** Typed in the dashboard — same path as a site line, plus a post so other boxes see it. */
  sayFromDashboard(from, text) {
    this.onNetworkChat({ from, text, origin: 'dashboard' })
    this.site?.sayToNetwork({ from, text, instance: 'dashboard' })
  }

  state() {
    return {
      box: cfg.boxName,
      key_id: this.hostKey.keyId,
      host: hostInfo(),
      // The agent's OWN footprint. Per box, not per game — the number that says whether
      // the thing doing the refereeing, recording and reporting is free or not.
      agent_rss_bytes: process.memoryUsage().rss,
      agent_heap_bytes: process.memoryUsage().heapUsed,
      agent_uptime_s: Math.round(process.uptime()),
      link: { host: cfg.linkHost, port: this.link.port, conns: this.link.stats() },
      site: this.site ? { base: cfg.site, online: this.site.online, ...this.site.stats } : null,
      token_checks: { required: cfg.requireToken, ...this.tokenGuard.stats },
      local: { enabled: cfg.local, mode: cfg.adoptLocal ? 'adopt-any' : 'expected-only', lease_held: this.leaseHeld(), expected: [...this.expected.keys()] },
      instances: this.instances.list().map((i) => {
        const g = this.byInstance.get(i.id)
        return { ...i.info(), game: g && !g.finished ? g.referee.state() : null, finished: !!g?.finished, replay: g?.replayFile || null, self_reported: !!g?.selfReported }
      }),
      games: [...this.games.entries()].map(([k, v]) => ({ match_id: k, summary: v.summary, replay: v.replay })),
      manifests: this.manifests.list().map((m) => ({ map: m.map, title: m.title, confidence: m.confidence, source: m._source })),
    }
  }

  async shutdown() {
    log.info('shutting down')
    clearInterval(this.reaper); clearInterval(this.statusTimer)
    this.site?.stop()
    for (const g of this.byInstance.values()) if (!g.finished) { try { g.referee.finishGame('host_shutdown') } catch { /* ignore */ } }
    await this.instances.stopAll('host shutdown')
    await this.link.close()
    await this.dash?.close()
  }
}

const host = new HostAgent()
await host.start()

let closing = false
const close = async (why, code = 0) => {
  if (closing) process.exit(1)
  closing = true
  log.info(`closing: ${why}`)
  await host.shutdown()
  process.exit(code)
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => close(s))

// --exit-with-pid <pid>: die when whoever started us dies.
//
// The launcher starts this agent as a child and kills it on quit, but a launcher that
// CRASHES never gets to. An orphaned referee holds the game-link port, so the next
// game connects to a process that will never report anything to anyone — a failure
// with no symptom at all. Polling a pid is crude and it is also the only thing on
// Windows that survives every way a parent can die.
if (a['exit-with-pid']) {
  const watch = Number(a['exit-with-pid'])
  if (Number.isFinite(watch) && watch > 0) {
    log.info(`will exit when pid ${watch} does`)
    const t = setInterval(() => {
      try { process.kill(watch, 0) } catch {
        clearInterval(t)
        close(`the process that started us (pid ${watch}) is gone`)
      }
    }, 2000)
    t.unref?.()
  }
}

export { host, cfg }
