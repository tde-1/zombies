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
  dryRun: !!a['dry-run'],
  requireToken: a['require-token'] != null ? a['require-token'] !== 'false' : !!a.site,
  chunkMs: Number(a['chunk-ms'] ?? 60_000),
  zstdLevel: Number(a['zstd-level'] ?? 10),
  gameLog: a['game-log'] !== 'off',   // the IW4MAdmin/B3-readable games_mp.log mirror
  gameLogPrefix: a['game-log-prefix'] || 'ENWZombie',
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
  constructor(host, instance, { matchId, mode, vip, assignment, tokens, refereeConfig }) {
    super()
    this.host = host
    this.instance = instance
    this.matchId = matchId || makeId('m', 4)
    this.mode = mode || 'custom'
    this.vip = !!vip
    this.assignment = assignment || null
    this.tokens = tokens || {}
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
    for (const k of ['cap_warning', 'afk_warn', 'afk_kick', 'finish', 'signal', 'paused', 'resumed']) {
      this.referee.on(k, (d) => this.recordHostEvent({ t: 'referee', kind: k, ...(typeof d === 'object' ? d : { value: d }) }))
    }
    this.gameLog = new GameLog({ file: path.join(cfg.logDir, `${instance.id}.games_mp.log`), enabled: cfg.gameLog, prefix: cfg.gameLogPrefix })
    this.tickTimer = setInterval(() => this.referee.tick(), 1000)
    this.tickTimer.unref?.()
  }

  attach(conn) {
    this.conn = conn
    conn.on('message', (m) => this.onGameMessage(m))
    conn.on('close', () => { this.conn = null; this.log.info('game link closed') })
    for (const c of this.pending.splice(0)) conn.send(c)
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
      lockOwner: cfg.gameCopy, gameCopy: cfg.gameCopy, dryRun: cfg.dryRun, log: log.child('inst'),
    })
  }

  async start() {
    await this.link.listen()
    this.instances.linkPort = this.link.port
    this.link.on('hello', (conn, msg) => {
      const g = this.byInstance.get(conn.instance)
      if (!g) return log.warn(`hello from unknown instance ${conn.instance} — ignoring`)
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
      this.site = new SiteClient({ base: cfg.site, secret: cfg.secret, boxName: cfg.boxName, spoolDir: cfg.spoolDir, log: log.child('site') })
      try {
        const k = await this.site.fetchKeys()
        this.tokenGuard.setPublicKey(keys.publicFromRaw(k.invite_pub))
        log.info(`site invite key ${k.key_id} loaded — token checks ${cfg.requireToken ? 'ENFORCED' : 'advisory'}`)
      } catch (e) { log.warn(`could not fetch the site invite key (${e.message}); joins will be refused until it is available`) }
      this.site.on('assignment', (asg) => this.onAssignment(asg))
      this.site.on('chat', (e) => this.onNetworkChat(e))
      this.site.start()
      this.statusTimer = setInterval(() => this.reportStatus(), 10_000); this.statusTimer.unref?.()
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
      link: { host: cfg.linkHost, port: this.link.port, conns: this.link.stats() },
      site: this.site ? { base: cfg.site, online: this.site.online, ...this.site.stats } : null,
      token_checks: { required: cfg.requireToken, ...this.tokenGuard.stats },
      instances: this.instances.list().map((i) => {
        const g = this.byInstance.get(i.id)
        return { ...i.info(), game: g && !g.finished ? g.referee.state() : null, finished: !!g?.finished, replay: g?.replayFile || null }
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
for (const s of ['SIGINT', 'SIGTERM']) {
  process.on(s, async () => {
    if (closing) process.exit(1)
    closing = true
    await host.shutdown()
    process.exit(0)
  })
}

export { host, cfg }
