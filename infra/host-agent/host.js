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

// The site URL, resolved ONCE. It used to be resolved twice — `a.site || ENW_SITE` for
// `cfg.site`, and a bare `a.site` for `cfg.requireToken` — so a box configured the way the
// systemd unit configures it (ENW_SITE in the environment, no `--site` flag) talked to the
// site, loaded its invite key, and then ran every join with token checks *advisory*. The
// log said so out loud (`token checks advisory`) and nobody read it. One name, one answer.
const SITE = a.site || process.env.ENW_SITE || null

const cfg = {
  boxName: a.box || process.env.ENW_BOX || 'box-a',
  linkHost: a['link-host'] || '127.0.0.1',
  linkPort: Number(a['link-port'] ?? 38700),
  dashPort: Number(a['dash-port'] ?? 8787),
  dash: a.dash !== 'off',
  site: SITE,
  secret: a.secret || process.env.ENW_SECRET || 'devkey-a',
  replayDir: a['replay-dir'] || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'replays'),
  // THE SPOOL WAS NEVER WIRED UP. `cfg.spoolDir` was read by the SiteClient constructor
  // and never set by anything, so `--spool-dir` (which test/integration-site.js has passed
  // all along) did nothing and a result the site refused to take was logged and dropped
  // rather than held. Every "spooled" claim in this file before 2026-09-22 was about the
  // SiteClient's own unit behaviour, not about a running box.
  spoolDir: a['spool-dir'] || path.join(process.env.ZOMBIES_DEV || 'C:\\Users\\b\\ZombiesDev', 'spool'),
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
  requireToken: a['require-token'] != null ? a['require-token'] !== 'false' : !!SITE,
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
  // ---- GAME OVER: what happens to the instance afterwards ----------------------------
  // The referee sends `game_over` (the result) and then `match_end` ("this process is
  // idle and the instance can be reclaimed"). The contract — referee.md §10.3,
  // game-link-v0 — says the host MUST then pick one of two dispositions and must not
  // leave it in neither: reuse (`end` -> map_restart -> a new `map_loaded`) or terminate.
  //
  //   --after-game end|terminate   default `end`: keep the instance warm for the next
  //                                lease. A warm instance skips a whole map load.
  //   --games-per-instance N       terminate after the Nth game on one process, whatever
  //                                --after-game says. A process that has run all night is
  //                                the one with the leak nobody has found yet.
  //   --end-reply-ms / --map-reload-ms   how long the two halves of the handshake get
  //                                before the instance is torn down instead.
  //   --warm-idle-ms               a warm instance nobody leased is not free — it holds a
  //                                UDP port and a map's worth of RSS. Retire it.
  afterGame: (a['after-game'] || 'end') === 'terminate' ? 'terminate' : 'end',
  gamesPerInstance: Number(a['games-per-instance'] ?? 5),
  endReplyMs: Number(a['end-reply-ms'] ?? 10_000),
  mapReloadMs: Number(a['map-reload-ms'] ?? 60_000),
  warmIdleMs: Number(a['warm-idle-ms'] ?? 10 * 60_000),
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
    // `finish()` is async (it closes and signs the replay, then posts the result) and the
    // DISPOSITION of the instance must not start until it has returned — the contract is
    // "finish the replay, post the result, THEN send `end` or terminate", in that order,
    // because an `end` that lands first destroys the evidence of a game we had not
    // finished writing down. So the promise is kept and `match_end` waits on it.
    this.referee.on('over', (s) => { this.finishPromise = this.finish(s) })
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
    // Kept so `detach()` can hand this connection to the NEXT game on the same instance
    // without leaving a dead referee listening to it. An anonymous arrow cannot be removed.
    this.onMessageBound = (m) => this.onGameMessage(m)
    this.onCloseBound = () => {
      this.conn = null
      this.log.info('game link closed')
      this.onLinkClosed()
    }
    conn.on('message', this.onMessageBound)
    conn.on('close', this.onCloseBound)
    for (const c of this.pending.splice(0)) conn.send(c)
  }

  /**
   * Give up this connection so the successor game on the same instance can take it.
   * A warm instance keeps ONE socket across a map_restart — the DLL does not reconnect,
   * because the process never went away — so the handover is here rather than in a new
   * `hello`.
   */
  detach() {
    const c = this.conn
    if (!c) return null
    if (this.onMessageBound) c.off('message', this.onMessageBound)
    if (this.onCloseBound) c.off('close', this.onCloseBound)
    this.conn = null
    this.detached = true
    return c
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
    // A warm instance re-announces `map_loaded` after `end`, and the next game's first
    // connect must read as a START rather than as a join of the game that just finished.
    if (m.t === 'map_loaded') { this.announcedStart = false; this.starter = null }
    if (m.t === 'map_loaded') this.onMapLoaded(m)
    if (m.t === 'match_end') this.onMatchEnd(m)
    if (m.t === 'player_connect') this.authPlayer(m)
    // A WARM instance opens its replay on the first sign of an actual game rather than on
    // `map_loaded` — see `onMapLoaded`. `record()` buffers everything until then, so
    // nothing is lost and the header carries the match the game turned out to be.
    if (this.deferReplay && (m.t === 'player_connect' || m.t === 'round') && this.mapEv) this.openReplay(this.mapEv)
    if (m.t === 'chat') this.host.onGameChat(this, m)
    // 4. the four events the site turns into a system line in the same chat channel
    if (m.t === 'player_connect' || m.t === 'player_down' || m.t === 'game_over') {
      this.host.onGameSystemEvent(this, m)
    }
    this.gameLog.onEvent(m, this.referee)
    this.host.dash?.push('event', { instance: this.instance.id, ev: m })
  }

  // ---- invite tokens ------------------------------------------------------------
  authPlayer(ev) {
    const r = this.host.tokenGuard.admit(ev, this.matchId)
    const p = this.referee.players.get(ev.slot)
    if (p) p.tokenOk = r.allow
    // THE ANSWER IS ALSO THE IDENTITY. `token_check_disabled` is what TokenGuard says when
    // it holds no site key or is not enforcing — it is an admission, not a check, so it
    // leaves the claim where it was rather than promoting it to a verified account
    // (game-link-v0 `auth`, referee.md §13.3).
    const identity = !r.allow ? 'refused'
      : r.reason === 'token_check_disabled' ? (ev.token ? 'claimed' : 'none')
      : 'verified'
    this.referee.setIdentity(ev.slot, identity, r.reason)
    this.sendToGame({ t: 'auth', slot: ev.slot, allow: r.allow, reason: r.reason })
    this.recordHostEvent({ t: 'auth_decision', slot: ev.slot, steamid: ev.steamid || null, allow: r.allow, reason: r.reason, identity })
    this.log[r.allow ? 'info' : 'warn'](`auth slot ${ev.slot} ${ev.name || ''} ${ev.steamid || ''}: ${r.allow ? 'ALLOW' : 'DENY'} (${r.reason}) -> identity ${identity}`)
    // A refused player is dropped from OUR fold; the game still reports a row for them at
    // game over, and it arrives with no account on it and is carried through flagged.
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

  // ---- game over, and what becomes of the instance ---------------------------------
  /**
   * `map_loaded` is the signal to open a replay (referee.md §10.3) — for an instance we
   * booted for a known match. For a WARM instance it is the signal that the map came
   * back, and the match it will carry may not exist yet, so the file is opened on the
   * first `player_connect`/`round` instead and the buffered `map_loaded` goes into it.
   */
  onMapLoaded(ev) {
    this.mapEv = ev
    this.emit('map_loaded', ev)
    if (!this.deferReplay) this.openReplay(ev)
  }

  /**
   * MATCH END. The game process is idle and the instance can be reclaimed — and it is
   * STILL ALIVE, which is the thing the contract is emphatic the host must not assume
   * away: before `no_save_reload.cpp` a finished game took its server with it, and now a
   * finished game leaves a server simulating an empty intermission for ever.
   *
   * Order, and it is not negotiable: the replay is closed and signed and the result is
   * posted, and only then is the instance either reused or destroyed.
   */
  onMatchEnd(ev) {
    if (this.matchEndSeen) return
    this.matchEndSeen = true
    clearTimeout(this.disposeTimer)
    this.emit('match_end_seen', ev)
    // Belt and braces: `game_over` is supposed to arrive first and `finish()` is supposed
    // to be under way. If a game sends `match_end` on its own we still owe a result.
    if (!this.finished) {
      this.log.warn('match_end arrived without a game_over — calling the game ourselves so the replay is signed and the result posted')
      this.referee.flags.add('match_end_without_game_over')
      this.referee.finishGame(ev.reason || 'match_end')
    }
    Promise.resolve(this.finishPromise)
      .catch((e) => this.log.error(`finish failed: ${e.message}`))
      .then(() => this.dispose())
  }

  /**
   * One of two dispositions, and never neither. Reuse is the default because a warm
   * instance skips a whole map load; everything that could make reuse a lie terminates.
   */
  disposition() {
    const me = this.referee.matchEnd
    const played = (this.instance.gamesPlayed || 0) + 1
    const bad = ['server_crash', 'instance_failed', 'link_closed', 'host_shutdown'].filter((f) => this.referee.flags.has(f))
    if (this.instance.foreign) return { action: 'leave', why: 'a local game: the launcher owns the process, we never touch it' }
    if (!me) return { action: 'terminate', why: 'no match_end — the game never said it was idle, so it cannot be assumed to be' }
    if (me.server_alive === false) return { action: 'terminate', why: 'match_end said server_alive:false' }
    if (bad.length) return { action: 'terminate', why: `the game did not end cleanly (${bad.join(', ')})` }
    if (!this.conn) return { action: 'terminate', why: 'the link is gone' }
    if (cfg.afterGame === 'terminate') return { action: 'terminate', why: '--after-game terminate' }
    if (played >= cfg.gamesPerInstance) return { action: 'terminate', why: `${played} game(s) on this instance, the limit is ${cfg.gamesPerInstance}` }
    return { action: 'reuse', why: `game ${played} of ${cfg.gamesPerInstance} on this instance` }
  }

  async dispose() {
    if (this.disposed) return this.disposed
    this.disposed = (async () => {
      const plan = this.disposition()
      this.log.info(`disposition: ${plan.action.toUpperCase()} — ${plan.why}`)
      this.host.dash?.push('disposition', { instance: this.instance.id, match_id: this.matchId, ...plan })
      if (plan.action === 'leave') return plan
      if (plan.action === 'terminate') { await this.host.retire(this, plan.why); return plan }
      const r = await this.host.reuse(this)
      if (!r.ok) {
        this.log.warn(`reuse refused (${r.why}) — tearing the instance down instead, which is the other half of the contract`)
        await this.host.retire(r.game || this, r.why)
        return { action: 'terminate', why: r.why }
      }
      return plan
    })()
    return this.disposed
  }

  /**
   * Send `end` and see the instance all the way back to a loaded map. `reply.ok:false`
   * means the command buffer was unavailable and the instance MUST NOT be reused; a
   * silent reply, or a restart that never re-announces `map_loaded`, is the same answer
   * arrived at by timeout.
   */
  requestRestart(reason = 'next lease', { match = null, simRoster = null } = {}) {
    return new Promise((resolve) => {
      let settled = false
      let waitLoad = null
      // `match` IS THE POINT OF SENDING THIS TWICE. The game reads its lease id from
      // ENW_MATCH once, at process start, and clears it on every reset — so a warm
      // instance is serving a match the process has never heard of, and without being told
      // it here, before the map_restart, it refuses every legitimate invite token with
      // `wrong_match` (game-link-v0 `end`.`match`, referee.md §13.4). Omitting it is
      // correct and deliberate on the reuse that FOLLOWS a game: there is no next lease
      // yet, and a stale id is worse than none.
      //
      // `sim_roster` is a SIMULATOR-ONLY field, ignored by a real DLL under the protocol's
      // "unknown `t`/fields are ignored by both sides" rule. The simulator invents its
      // players, so it has to be handed the next party and their tokens; a real client
      // brings its own in its userinfo when it connects.
      const cmd = this.referee.send({
        t: 'end', reason,
        ...(match ? { match } : {}),
        ...(simRoster ? { sim_roster: simRoster } : {}),
      })
      const done = (ok, why) => {
        if (settled) return
        settled = true
        clearTimeout(waitReply); clearTimeout(waitLoad)
        this.referee.off('reply', onReply)
        this.off('map_loaded', onLoaded)
        resolve({ ok, why })
      }
      const onReply = (ev) => {
        if (ev.id !== cmd.id) return
        this.referee.off('reply', onReply)
        clearTimeout(waitReply)
        if (!ev.ok) return done(false, `the game refused \`end\`: ${ev.error || 'no reason given'}`)
        this.log.info('the game accepted `end`; waiting for the map to come back')
        waitLoad = setTimeout(() => done(false, `no map_loaded within ${cfg.mapReloadMs} ms of an accepted \`end\``), cfg.mapReloadMs)
        waitLoad.unref?.()
      }
      // map_loaded can legitimately beat the reply out of the socket (both arrive in one
      // TCP read), and a map that has demonstrably come back is the stronger evidence.
      const onLoaded = () => done(true, 'map_loaded re-announced')
      const waitReply = setTimeout(() => done(false, `no reply to \`end\` within ${cfg.endReplyMs} ms`), cfg.endReplyMs)
      waitReply.unref?.()
      this.referee.on('reply', onReply)
      this.on('map_loaded', onLoaded)
    })
  }

  /**
   * A warm instance has been leased. Two halves, and both are needed:
   *
   *   1. OUR side — the match identity, before anything records. The replay is deferred to
   *      the first sign of a game precisely so this can happen first, and the file it
   *      opens carries the leased match id in its header and signed footer.
   *   2. THE GAME's side — a second `end`, carrying `match`. The process read its lease id
   *      from ENW_MATCH once at start and cleared it on the last reset, so until it is
   *      told this one every invite token the site just minted is `wrong_match`.
   */
  async rebind(asg, tokens, roster) {
    this.matchId = asg.match_id
    this.mode = asg.mode || this.mode
    this.vip = !!asg.vip
    this.assignment = asg
    this.tokens = tokens || {}
    this.referee.matchId = asg.match_id
    this.referee.mode = this.mode
    this.referee.vip = this.vip
    this.instance.matchId = asg.match_id
    this.instance.assignment = asg
    this.log.info(`warm instance rebound to lease ${asg.match_id} (${this.mode}) — telling the game its new match id`)
    const r = await this.requestRestart(`lease ${asg.match_id}`, {
      match: asg.match_id,
      simRoster: this.instance.kind === 'sim' ? roster : null,
    })
    if (r.ok) this.recordHostEvent({ t: 'instance_leased', match_id: asg.match_id, games_on_instance: this.instance.gamesPlayed || 0, why: r.why })
    return r
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
    // WAIT A BEAT FOR `match_end`. The referee sends it immediately after `game_over`, and
    // a result that carries it is a result that says whether the instance was left free —
    // which is the one fact an operator reading a finished game wants and cannot get from
    // anywhere else. Half a second, never more, and a game that never sends one (a crash,
    // the cap, a host shutdown) pays exactly that and no more.
    //
    // It happens BEFORE the replay footer is written so the footer's summary and the
    // posted summary are the same object. `match_end` itself is NOT an event of the match
    // and is not appended to the replay: `game_over` is the last event, by contract.
    if (!this.matchEndSeen && this.conn) {
      await new Promise((r) => {
        const t = setTimeout(r, 500); t.unref?.()
        this.once('match_end_seen', () => { clearTimeout(t); r() })
      })
    }
    summary.match_end = this.referee.matchEnd
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
    this.emit('finished', summary)
    // The instance is NOT reaped here any more. `dispose()` decides what becomes of it,
    // and it waits for this function to return — closing a replay and posting a result
    // are the two things that must happen before the game process is touched. A game that
    // ended without a `match_end` (a crash, the cap, an AFK close, a host shutdown) has
    // no idle server to reuse, so it disposes of itself right here.
    if (!this.matchEndSeen) {
      // 3 s, not 0: a game that sends `match_end` a beat after `game_over` (the referee
      // sends them back to back, but a busy link reorders nothing and delays plenty) must
      // not have its warm instance destroyed because the result POST was quick.
      this.disposeTimer = setTimeout(() => {
        if (this.matchEndSeen) return
        this.log.warn('no match_end after game over — the game may or may not still be alive, so the instance is torn down rather than assumed idle')
        this.dispose()
      }, 3000)
      this.disposeTimer.unref?.()
    }
  }
}

class HostAgent {
  constructor() {
    this.games = new Map()          // matchId -> { summary, replay }
    this.byInstance = new Map()     // instanceId -> Game
    this.expected = new Map()       // instanceId -> { match_id, map, at } (local mode)
    // A WARM instance: a game process that has finished a match, taken `end`, restarted
    // its map and is sitting at `map_loaded` with nobody in it. It is the cheapest thing
    // a box can hand the next lease — no process start, no map load, no 4-10 s wait.
    this.warm = new Map()           // instanceId -> Game (idle, map loaded, no match)
    mkdirp(cfg.replayDir); mkdirp(cfg.logDir); mkdirp(cfg.keyDir); mkdirp(cfg.spoolDir)
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
          games: a['sim-games'] ? Number(a['sim-games']) : null,
          endFails: !!a['sim-end-fails'],
          noMatchEnd: !!a['sim-no-match-end'],
          gatecrash: !!a['sim-gatecrash'],
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
      // How many matches this simulated process plays before it goes quiet, and whether
      // it refuses `end`. Both exist to exercise the game-over disposition: a real server
      // plays as many as it is asked and its `end` either works or does not.
      if (s.games) simArgs.push('--games', String(s.games))
      if (s.endFails) simArgs.push('--end-fails')
      if (s.noMatchEnd) simArgs.push('--no-match-end')
      if (s.gatecrash) simArgs.push('--gatecrash')
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

  // ---- game over: the two dispositions ---------------------------------------------
  /**
   * TERMINATE. Stop the process, free the port and the slot, and forget the game — the
   * summary and the replay pointer are already in `this.games` and already at the site.
   *
   * This is also what makes `boxes.list()` say idle again: the box's `last_state` comes
   * from the status heartbeat, and the heartbeat counts LIVE games. Leaving a finished
   * game in `byInstance` (which is what happened before tonight) left a box reporting
   * `live` for ever after its first match — online, leasable by `pickFree`, and showing
   * an operator a game that ended hours ago.
   */
  async retire(game, why = 'game over') {
    const id = game.instance.id
    // Re-entry guard AND the contract: a game being retired has had its disposition made
    // for it, so nothing downstream may pick another one.
    game.disposed = game.disposed || Promise.resolve({ action: 'terminate', why })
    // AN OPEN REPLAY MUST NOT GO WITH THE PROCESS. A replay with no signed footer is not
    // a replay, it is a prefix of one (the same reasoning as `onLinkClosed`). A warm
    // instance normally has no writer at all — it defers until a match actually starts —
    // but one that got as far as a player joining has real events in it.
    if (game.writer && !game.finished) {
      game.log.warn(`retiring an instance with an open replay (${why}) — signing it first so what happened is still evidence`)
      game.referee.flags.add('instance_retired')
      try { game.referee.finishGame(why); await game.finishPromise } catch (e) { game.log.error(`could not close the replay: ${e.message}`) }
    }
    this.warm.delete(id)
    clearTimeout(game.warmTimer)
    game.detach()
    log.info(`retiring instance ${id}: ${why}`)
    await this.instances.remove(id, why).catch((e) => log.warn(`could not remove ${id}: ${e.message}`))
    if (this.byInstance.get(id) === game) this.byInstance.delete(id)
    this.reportStatus()
    return true
  }

  /**
   * REUSE. `end` -> the referee map_restarts, resets and re-announces `map_loaded`, and
   * the instance is warm. The successor `Game` is created FIRST and takes the socket,
   * because the reply and the new `map_loaded` can arrive in the same TCP read and a
   * finished referee must not be the thing that sees them.
   */
  async reuse(old) {
    const inst = old.instance
    const conn = old.detach()
    if (!conn) return { ok: false, why: 'the link is gone', game: old }
    inst.gamesPlayed = (inst.gamesPlayed || 0) + 1
    const next = new Game(this, inst, {
      matchId: makeId('m', 4),
      mode: old.mode,
      vip: old.vip,
      // NO assignment and NO tokens: this game belongs to no lease yet. `rebind()` gives
      // it a real identity if and when one arrives.
    })
    // A warm instance does not open a replay at `map_loaded`, because the match it will
    // carry may not have been leased yet. `record()` buffers until it does.
    next.deferReplay = true
    // THE PROCESS NEVER SAID `hello` TWICE, because it never went away. Without this the
    // second game on a warm instance writes a replay header with a null `exe_sha256` and
    // a null `dll_build` — the two fields the run fingerprint is computed over and the
    // whole basis on which the site calls a replay record-grade. They are the same
    // process's, so they are carried across, and the successor's replay records that they
    // were inherited rather than heard.
    next.referee.hashes = { ...old.referee.hashes }
    next.referee.pid = old.referee.pid
    next.referee.role = old.referee.role
    next.referee.phase = 'loading'
    next.inheritedFrom = old.matchId
    this.byInstance.set(inst.id, next)
    next.attach(conn)
    // NO `match` HERE. This reuse follows a finished game and precedes any lease, so the
    // instance is told nothing to check tokens against — which is exactly right: it must
    // admit nobody until the site gives it a match. `rebind()` sends the id when one
    // arrives, in a second `end`.
    const r = await next.requestRestart('next lease')
    if (!r.ok) return { ok: false, why: r.why, game: next }
    next.recordHostEvent({
      t: 'instance_reused', from_match: old.matchId, games_on_instance: inst.gamesPlayed,
      pid: old.referee.pid || null, exe_sha256: next.referee.hashes.exe_sha256 || null,
      dll_build: next.referee.hashes.dll_build || null, inherited: true, why: r.why,
    })
    this.markWarm(next)
    return { ok: true, game: next }
  }

  markWarm(game) {
    const id = game.instance.id
    this.warm.set(id, game)
    log.info(`instance ${id} is WARM: ${game.referee.map || 'map'} loaded, no match, ${game.instance.gamesPlayed} game(s) played — ready for the next lease`)
    clearTimeout(game.warmTimer)
    // A warm instance nobody leases is not free. It holds a UDP port, a map's worth of
    // RSS and (on Windows) the game lock, so it is retired rather than left to be somebody
    // else's surprise.
    game.warmTimer = setTimeout(() => {
      if (this.warm.get(id) !== game || game.assignment) return
      this.retire(game, `warm and unleased for ${Math.round(cfg.warmIdleMs / 1000)} s`)
    }, cfg.warmIdleMs)
    game.warmTimer.unref?.()
    this.reportStatus()
  }

  /** A warm instance already sitting on this map, if there is one. */
  takeWarm(map) {
    for (const [id, g] of this.warm) {
      if (g.finished || g.assignment) { this.warm.delete(id); continue }
      // `end` is a map_restart, not a map change: a warm instance can only serve a lease
      // for the map it is already on. Anything else has to be a fresh process.
      if (map && g.referee.map && g.referee.map !== map) continue
      this.warm.delete(id)
      clearTimeout(g.warmTimer)
      return g
    }
    return null
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
    const tokens = Object.fromEntries(roster.filter((r) => r.token).map((r) => [r.slot, r.token]))

    // A WARM INSTANCE TAKES THE LEASE. No process start, no map load. It can only serve a
    // lease for the map it is already sitting on, because `end` is a map_restart and not a
    // map change — so warm instances on other maps are retired rather than kept for a
    // lease that may never come.
    //
    // UNPROVEN AGAINST A REAL LEASE, and it says so out loud: the simulator receives its
    // roster in its environment at spawn, so a warm sim instance cannot be handed a
    // DIFFERENT party. What is proven tonight is the half below it — the handshake, the
    // warm state, and a second match on the same process (host.md §12).
    const warm = this.takeWarm(asg.map)
    if (warm) {
      for (const [id, g] of this.warm) if (g !== warm) this.retire(g, `a lease for ${asg.map} arrived and this instance is on ${g.referee.map}`)
      this.site?.status({ state: 'booting', match_id: asg.match_id, instance: warm.instance.id, nonce: asg.nonce, warm: true })
      warm.referee.once('live', () => this.site?.status({ state: 'live', match_id: asg.match_id, instance: warm.instance.id }))
      log.info(`lease ${asg.match_id} handed to WARM instance ${warm.instance.id} — no boot, no map load`)
      // The rebind talks to the game and can fail, so it is awaited off to one side. A
      // warm instance that will not take its new match id is no use to this lease: it is
      // torn down and a fresh one is booted, because the alternative is a lease served by
      // a process that will refuse every token the site just minted.
      warm.rebind(asg, tokens, roster).then((r) => {
        if (r.ok) return this.site?.status({ state: 'ready', match_id: asg.match_id, instance: warm.instance.id, port: warm.instance.port })
        log.warn(`the warm instance would not take lease ${asg.match_id} (${r.why}) — tearing it down and booting a fresh one`)
        return this.retire(warm, `would not take a new lease: ${r.why}`).then(() => this.onAssignment(asg))
      }).catch((e) => log.error(`rebind failed: ${e.message}`))
      return warm
    }

    const game = this.boot({
      roster,
      kind: a.game ? 'game' : 'sim',
      matchId: asg.match_id,
      mode: asg.mode,
      map: asg.map,
      vip: asg.vip,
      assignment: asg,
      tokens,
      sim: {
        players: asg.players?.length || 1,
        timescale: Number(asg.sim?.timescale ?? a['sim-timescale'] ?? 1),
        maxRound: Number(asg.sim?.max_round ?? a['sim-max-round'] ?? 15),
        eeRound: asg.sim?.ee_round ?? null,
        endingRound: asg.sim?.ending_round ?? null,
        afkSlot: asg.sim?.afk_slot ?? null,
        lateJoinMs: asg.sim?.late_join_ms ?? null,
        games: asg.sim?.games ?? (a['sim-games'] ? Number(a['sim-games']) : null),
        endFails: !!a['sim-end-fails'],
        noMatchEnd: !!a['sim-no-match-end'],
        gatecrash: !!a['sim-gatecrash'],
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
    // LIVE means a match is being played, not "this process has ever seen one". Counting
    // `byInstance` counted finished games too, so a box went `live` at its first lease and
    // never came back — which is what an operator reads off `boxes.list()` and what an
    // idle-box dashboard would key on.
    const live = [...this.byInstance.values()].filter((g) => !g.finished && !this.warm.has(g.instance.id))
    const r = await this.site?.status({
      state: live.length ? 'live' : 'idle',
      live_games: live.length,
      warm_instances: [...this.warm.keys()],
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

  /**
   * Somebody started a game, joined one, went down, or finished — the four facts the
   * site turns into a system line in the global chat channel ("<handle> just went down
   * on round 30 on Verrückt").
   *
   * THE BOX SENDS FACTS, NOT SENTENCES (`siteclient.postEvent`). What it does decide,
   * because only it can, is **which connect is a start**: the first player to connect
   * to a given game started it and everybody after them joined it. There is no
   * "started" event in the protocol to read instead — `map_loaded` is the map coming
   * up, which on a warm instance happened before anybody leased it — and a game that
   * announced no start and then five joins reads like something everyone walked into.
   *
   * `steamid` goes only where the game marked the row `verified`; `game-link-v0` has
   * had that rule since §13 and a chat line is not where it gets relaxed.
   */
  onGameSystemEvent(game, ev) {
    if (!this.site) return
    const ref = game.referee
    let kind = null
    let name = ev.name || null
    let identity = ev.identity || null
    let steamid = ev.steamid || null

    if (ev.t === 'player_connect') {
      // `authPlayer` has already run for this message (it is earlier in
      // `onGameMessage`), so the referee's row holds the identity AFTER the check
      // rather than the `claimed` the game arrived with.
      // A REFUSED player has no row at all — `authPlayer` deletes it — and says
      // nothing in chat. A game announcing that somebody it just kicked joined it is
      // the one system line that would be a lie.
      const p = ref.players.get(ev.slot)
      if (!p || p.identity === 'refused') return
      identity = p.identity || identity; steamid = p.steamid || steamid; name = p.name || name
      kind = game.announcedStart ? 'joined' : 'started'
      game.announcedStart = true
      game.starter = { name, steamid, identity }
    } else if (ev.t === 'player_down') {
      kind = 'down'
      if (!name) name = ref.players.get(ev.slot)?.name || null
    } else if (ev.t === 'game_over') {
      kind = 'ended'
      // The game belongs to whoever started it; game_over names every player and
      // none of them in particular.
      name = game.starter?.name || null
      steamid = game.starter?.steamid || null
      identity = game.starter?.identity || null
    }
    if (!kind) return

    this.site.postEvent({
      event: kind,
      name,
      // Only a verified row travels with an account. Anything less is a claim.
      steamid: identity === 'verified' ? steamid : null,
      identity: identity || 'none',
      map: ev.map || ref.map || null,
      map_name: ref.manifest?.title || null,
      round: Number.isFinite(Number(ev.round)) ? Number(ev.round) : ref.round || 0,
      match_id: game.matchId || null,
      instance: game.instance.id,
    })
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
      after_game: { disposition: cfg.afterGame, games_per_instance: cfg.gamesPerInstance, warm: [...this.warm.keys()] },
      instances: this.instances.list().map((i) => {
        const g = this.byInstance.get(i.id)
        return { ...i.info(), game: g && !g.finished ? g.referee.state() : null, finished: !!g?.finished, replay: g?.replayFile || null, self_reported: !!g?.selfReported, warm: this.warm.has(i.id), games_played: i.gamesPlayed || 0 }
      }),
      games: [...this.games.entries()].map(([k, v]) => ({ match_id: k, summary: v.summary, replay: v.replay })),
      manifests: this.manifests.list().map((m) => ({ map: m.map, title: m.title, confidence: m.confidence, source: m._source })),
    }
  }

  async shutdown() {
    log.info('shutting down')
    clearInterval(this.reaper); clearInterval(this.statusTimer)
    for (const g of this.warm.values()) clearTimeout(g.warmTimer)
    this.warm.clear()
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
