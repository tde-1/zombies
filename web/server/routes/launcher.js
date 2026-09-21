'use strict'

// `/api/launcher/*` — the contract between the site and the Electron launcher.
//
// The launcher WRAPS this site (`docs/kickstart/launcher.md` §4: the site is a native
// WebContentsView and its chrome is a page around it), so almost nothing needs an API: the
// player signs in on the site, picks a map on the site, and presses Play on the site. What
// the launcher cannot get from the DOM is the *game* half — what to install, what to
// launch, and the invite token — and that is what this file is.
//
// ── The one thing that had to change from the mock ────────────────────────────────
// The launcher today calls `POST /admin/lease` (`mock-site/site.js`'s route, which has no
// auth at all). **The real site must never let a player lease a box directly.** A lease
// picks a game box, mints invite tokens for a roster and burns real server time; if any
// client can ask for one, the box fleet is a free hosting service and the roster on a
// Verified game is whatever the client typed.
//
// So the flow inverts, and it is the flow B described anyway (13 §4b): the PLAYER presses
// Play, the SITE leases (it already knows the party, the map, the mode and who is ready),
// and the launcher watches for a match to appear and launches the game. `POST
// /api/launcher/play` exists for the launcher's own corner card — it does exactly what
// pressing Start in the party rail does, for the player who is asking, and nothing more.
//
// Nothing here hands out anybody else's invite token, ever.

const express = require('express')
const mapfiles = require('../lib/mapfiles')
const users = require('../lib/users')
const parties = require('../lib/parties')
const maps = require('../lib/maps')
const presence = require('../lib/presence')
const enw = require('../lib/enw')
const live = require('../lib/live')
const { db, now } = require('../db/database')
const { safeJson } = require('../lib/util')
const { requireUser, requireApproved } = require('../middleware/auth')

// What the launcher last told us it was doing, per player. In memory: it is a progress bar,
// it changes every few hundred milliseconds, and it is meaningless once the process is gone.
const launcherState = new Map()
const STATE_TTL_MS = 120_000

// Local games in flight live in `lib/localMatches.js`, in SQLite.
//
// They used to be a Map here, and that Map was the biggest hole in the MVP: the site
// restarting inside somebody's forty-minute run made the result arrive to "not your game"
// and the run was simply gone. A row survives the restart, remembers the highest round the
// live frames reported, and gets closed by a sweep instead of sitting live forever.
const localMatches = require('../lib/localMatches')

// The sweep runs on a timer AND on the way into the local endpoints, because a site that
// is only ever poked by a launcher still has to close out the run the launcher abandoned.
const SWEEP_MS = 60_000
setInterval(() => { try { localMatches.sweep() } catch (e) { console.warn('[launcher] local sweep:', e.message) } }, SWEEP_MS).unref?.()

const PROTOCOL_VERSION = 0

// ── Reading a body from a launcher ───────────────────────────────────────────────────
//
// `express.json()` will happily hand us a string, a number, an array or null, because all
// of those are valid JSON documents. `const b = req.body || {}` then passes them straight
// into property reads, and the first one that lands on a method — `.find` on a string —
// is a 500 rather than a 400. A half-working launcher must get a refusal it can log, not
// a server error it retries.
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {})

// A field that has to be a plain scalar before it can be a key, a name or an id. An object
// stringifies to "[object Object]", which is a perfectly good SQL value and a terrible one.
const text = (v, max = 200) => {
  if (v == null || typeof v === 'object') return ''
  const s = String(v).trim()
  return s ? s.slice(0, max) : ''
}

// Close out abandoned local matches on the way past. A site whose only visitor is a
// launcher gets no other chance to notice that somebody's run stopped heartbeating.
const sweepFirst = (req, res, next) => {
  try { localMatches.sweep() } catch (e) { console.warn('[launcher] local sweep:', e.message) }
  next()
}

function router() {
  const r = express.Router()

  // ---- hello -------------------------------------------------------------------
  // Called once at startup. It is how the launcher learns whether it is pointed at a real
  // site or at somebody's mock, what sign-in is in use, and what this build supports —
  // rather than probing ports and guessing, which is what it does today.
  r.get('/hello', (req, res) => {
    res.json({
      ok: true,
      site: 'ENW Zombies',
      protocol: PROTOCOL_VERSION,
      auth: require('./auth').effectiveMode(),
      // The launcher shows a sign-in button; this is where it sends the player. With the
      // mock provider that is a local page, with Steam it is Steam.
      sign_in_url: require('./auth').effectiveMode() === 'steam' ? '/auth/steam' : '/auth/mock',
      capabilities: {
        play: true,              // GET/POST /api/launcher/play
        settings: true,          // GET /api/me/settings
        state: true,             // POST /api/launcher/state
        reports: true,           // POST /api/launcher/report
        live_view: true,         // /live/<match> in the wrapped site
        // Local games: start / live / result, session-authenticated, no box secret.
        // Everything through them is stamped self-reported and counts for nothing.
        local: true,
        deep_links: ['/m/:map', '/live/:match', '/id/:who'],
        // Not built. Listed so the launcher can grey a button instead of calling and
        // getting a 404 it has to explain to the player.
        // True only when the files are actually on this box, not when we wish they were.
        map_downloads: mapfiles.available().length > 0,
        // `GET /api/replays/<match>` (the pointer and the evidence grade, public) and
        // `GET /api/replays/<match>/download` (the bytes, gated by lib/replays.mayDownload).
        // This said `false` while both routes existed and worked, which is the kind of lie
        // that makes a launcher grey out a button that would have worked.
        replay_downloads: true,
        // Local runs survive a site restart and are closed out if they never finish, so a
        // launcher may ask for its in-flight matches (`GET /api/launcher/local`) rather
        // than starting a second game after a crash.
        local_resume: true,
        og_cards: false,
      },
      enw: enw.status(),
      you: req.me ? users.pub(req.me) : null,
    })
  })

  // ---- what to do right now ---------------------------------------------------
  // The launcher polls this while its boot screen is up. Every field is either real or
  // absent — there is no placeholder in here for the boot screen to render as if it were
  // progress.
  r.get('/play', requireUser, (req, res) => {
    const sid = req.me.steam_id
    const party = parties.forPlayer(sid)
    const launch = parties.launchInfo(sid)
    const mapKey = (launch && launch.map) || (party && party.map && party.map.key) || null
    const m = mapKey ? maps.byKey(mapKey) : null

    res.json({
      protocol: PROTOCOL_VERSION,
      // The boot screen's own steps, named the way 13 §4b-2 names them, decided here so
      // the site and the launcher cannot disagree about what state a game is in.
      //   idle → selected → ready-check → reserving → loading → ready → in-game
      state: phaseOf(party, launch),
      party: party ? { id: party.id, code: party.code, mode: party.mode, visibility: party.visibility, members: party.members, all_ready: party.all_ready, is_leader: party.is_leader } : null,
      map: m ? mapPayload(m) : null,
      match: launch ? {
        match_id: launch.match_id,
        mode: launch.mode,
        fs_game: launch.fs_game,
        // THE PLAYER'S OWN TOKEN AND NOBODY ELSE'S. The launcher passes it to the game
        // over a named pipe (launcher.md §3) and it reaches the box in userinfo.
        token: launch.token,
        connect: launch.connect,
        state: launch.state,
      } : null,
      settings: users.settings(sid),
      vip: enw.isVip(sid),
    })
  })

  // ---- the launcher's own Play button ------------------------------------------
  // The corner card is the launcher's native chrome, not the site's, so it needs a way to
  // do what pressing Start in the rail does. It is the same code path, with the same
  // guards: approved players only, the leader decides, and a Verified lobby gets no knobs.
  r.post('/play', requireApproved, (req, res) => {
    const sid = req.me.steam_id
    const b = req.body || {}
    parties.ensure(sid)
    if (b.map_key) {
      const set = parties.setMap(sid, String(b.map_key))
      if (!set.ok) return res.status(400).json(set)
    }
    if (b.mode) {
      const set = parties.setMode(sid, String(b.mode))
      if (!set.ok) return res.status(400).json(set)
    }
    const party = parties.forPlayer(sid)
    if (!party || !party.map) return res.status(400).json({ error: 'pick a map first' })
    if (!party.is_leader) return res.status(403).json({ error: 'only the leader can start the game' })

    // Solo is the launcher's common case and a ready check with one member is ceremony.
    if (party.members.length === 1) parties.startReadyCheck(sid)
    else if (party.state !== 'ready-check') return res.status(409).json({ error: 'run the ready check first', party })

    const out = parties.launch(sid, { force: !!b.force })
    if (!out.ok) return res.status(409).json(out)
    return res.json({ ok: true, match_id: out.match_id, state: 'reserving' })
  })

  r.post('/cancel', requireUser, (req, res) => {
    const party = parties.forPlayer(req.me.steam_id)
    if (party && party.match_id) return res.json(require('../lib/assignments').cancel(party.match_id, req.me.steam_id))
    return res.json(parties.cancelReadyCheck(req.me.steam_id))
  })

  // ---- the launcher tells us what it is doing ----------------------------------
  // Feeds the boot screen on OTHER people's screens: a party member sees "Dexter is
  // installing the map" rather than an unexplained wait. It is also how the site knows a
  // player is actually in the game rather than merely leased a box.
  r.post('/state', requireUser, (req, res) => {
    const b = req.body || {}
    const phase = String(b.phase || '').slice(0, 32)
    if (!phase) return res.status(400).json({ error: 'which phase?' })
    launcherState.set(req.me.steam_id, {
      phase,
      detail: b.detail ? String(b.detail).slice(0, 160) : null,
      progress: Number.isFinite(Number(b.progress)) ? Math.max(0, Math.min(1, Number(b.progress))) : null,
      map: b.map ? String(b.map).slice(0, 64) : null,
      at: now(),
    })
    // 'in-game' from the launcher is a HINT, not a fact: the box's roster is the fact
    // (11 §9, "a box roster beats a lobby seat"), and presence.markInGame is the box's to
    // call. So this only ever refreshes the site-side heartbeat.
    presence.heartbeat(req.me.steam_id)
    res.json({ ok: true })
  })

  r.get('/state/:who', (req, res) => {
    const u = users.resolve(req.params.who)
    if (!u) return res.status(404).json({ error: 'no such player' })
    const s = launcherState.get(u.steam_id)
    res.json({ state: s && now() - s.at < STATE_TTL_MS ? s : null })
  })

  // ══ LOCAL GAMES ══════════════════════════════════════════════════════════════════
  //
  // A Local game (13 §4) runs on the player's own PC. There is no lease, no box, no invite
  // token and no server — and, crucially, **no box secret**. A player's machine must never
  // hold one: `x-match-secret` is what lets a process post a result as a game box, and the
  // moment a player has one, every board on the site is whatever they feel like typing.
  //
  // So local games get their own door, authenticated as the PLAYER by the ordinary session
  // cookie, and everything through it is stamped `self_reported`. The site stores it — you
  // should be able to see that you played Leviathan for forty minutes — and it is worth
  // exactly nothing: no badge, no record, no XP, and its replay is not evidence. That is
  // not a limitation of this implementation, it is 13 §4: "if they want their stuff
  // tracked, they have to play through our servers."

  /** Start one. Returns the match id the launcher uses for frames and the result. */
  r.post('/local/start', requireUser, sweepFirst, (req, res) => {
    const b = body(req)
    const mapKey = text(b.map_key, 64)
    const m = mapKey ? maps.byKey(mapKey) : null
    if (!m) return res.status(400).json({ error: 'which map?' })

    // A launcher that crashed and came back does not need a second match. Handing it the
    // one it already has is the difference between a recovered run and two half-runs, one
    // of which has the rounds and the other of which has the result.
    const open = localMatches.resumable(req.me.steam_id, m.key)
    const row = open || localMatches.start(req.me.steam_id, m.key)
    if (!open) {
      db.prepare("INSERT INTO activity_log (event, actor, metadata, logged_at) VALUES ('local.start', ?, ?, ?)")
        .run(req.me.steam_id, JSON.stringify({ match_id: row.match_id, map: m.key }), now())
    }
    res.json({
      ok: true,
      match_id: row.match_id,
      resumed: !!open,
      // Local is solo only (13 §4, decided). The launcher should not offer a party here.
      solo: true,
      map: mapPayload(m),
      settings: users.settings(req.me.steam_id),
      // Said plainly so the launcher can put it on the boot screen rather than inventing
      // its own wording.
      notice: 'Local game — untracked. No badges, no records and no XP.',
    })
  })

  /**
   * The local matches this player still has open.
   *
   * A launcher that restarted — or a PC that rebooted — asks this instead of guessing, and
   * posts its result against the match that is already there. Without it, the only way to
   * find a match id after losing it was to start a second game.
   */
  r.get('/local', requireUser, sweepFirst, (req, res) => {
    res.json({ matches: localMatches.inFlight(req.me.steam_id).map(localMatches.pub) })
  })

  /** One of them, by id — only ever the caller's own. */
  r.get('/local/:matchId', requireUser, (req, res) => {
    const row = localMatches.owned(req.params.matchId, req.me.steam_id)
    if (!row) return res.status(404).json({ error: 'not your game' })
    res.json({ match: localMatches.pub(row), game: row.game_id ? require('../lib/results').byId(row.game_id) : null })
  })

  /** Live frames for a local game, so a friend can watch it on the site. */
  r.post('/local/live', requireUser, (req, res) => {
    const b = body(req)
    // Only the player whose game it is may push frames for it — otherwise anybody could
    // paint anything onto anybody's live view.
    const row = localMatches.owned(b.match_id, req.me.steam_id)
    if (!row) return res.status(404).json({ error: 'not your game' })
    if (row.state !== 'live') return res.status(409).json({ error: `that game is already ${row.state}`, state: row.state })
    // `state` is spread into the frame, so it has to be an object. A string spreads into
    // `{0:'h',1:'e',…}` and was accepted before this line existed.
    const st = b.state
    if (!st || typeof st !== 'object' || Array.isArray(st)) return res.status(400).json({ error: 'state must be an object' })

    // THE HIGHEST ROUND SEEN IS THE RUN'S RECOVERY POINT. If the game dies here and never
    // posts a result, this is the only number that will survive, so it is written every
    // frame rather than only at the end.
    const beat = localMatches.heartbeat(row.match_id, st.round)

    // The "box" is the player's own PC. It is labelled `local` and NOT `local:<steamid>`:
    // the frame is broadcast to everyone watching, and the box label is rendered, so a
    // SteamID in it would put the host's account id on a public page. Who owns the game is
    // in `local_matches`, which is server-side and is what the guard above reads.
    const taken = live.push('local', {
      instance: 'local',
      match_id: row.match_id,
      state: { ...st, mode: 'local', map: text(st.map, 64) || row.map_key },
    })
    res.json({ ok: true, taken, round: beat.round, min_frame_ms: live.MIN_FRAME_MS })
  })

  /** The summary and the replay pointer for a finished local game. */
  r.post('/local/result', requireUser, (req, res) => {
    const b = body(req)
    const s = (b.summary && typeof b.summary === 'object' && !Array.isArray(b.summary)) ? b.summary : null
    if (!s || !s.match_id) return res.status(400).json({ error: 'no summary' })
    const row = localMatches.owned(s.match_id, req.me.steam_id)
    if (!row) return res.status(404).json({ error: 'not your game' })

    // A retry is not an error. A launcher whose POST succeeded and whose response was lost
    // to a closed laptop lid will send it again, and answering "not your game" to the
    // second one loses nothing but tells the launcher it lost everything. `ingest` is
    // idempotent on match_id, so the honest answer is to run it and say `repeat`.
    //
    // A result for an ABANDONED match is also accepted: the sweep wrote the run from its
    // frames, and the real summary supersedes that placeholder (lib/results.js).

    // The roster is the ONE thing the site overrides rather than trusts. Local is solo, so
    // the only player who can be in it is the one holding the session — otherwise a local
    // game could write rows against other people's accounts.
    if (s.players != null && !Array.isArray(s.players)) return res.status(400).json({ error: 'players must be a list' })
    const me = users.pub(req.me)
    const roster = (s.players || []).filter((p) => p && typeof p === 'object' && !Array.isArray(p))
    const mine = roster.find((p) => String(p.steamid) === String(req.me.steam_id)) || roster[0] || {}

    // If the referee says it refereed a different map from the one the launcher opened the
    // match on, the site keeps its own answer and says that they disagreed. Both claims
    // come from the same PC, so neither is evidence; what matters is that the run is filed
    // somewhere findable and that the disagreement is not swallowed.
    const claimed = text(s.map, 64)
    const flags = Array.isArray(s.flags) ? s.flags.slice(0, 32) : []
    if (claimed && claimed !== row.map_key && !flags.includes('map_mismatch')) flags.push('map_mismatch')

    const summary = {
      ...s,
      flags,
      match_id: row.match_id,
      mode: 'local',
      // THE MAP IS THE SITE'S, NOT THE CLIENT'S. The launcher said which map it was
      // starting and we wrote it down; a result naming a different one would file the run
      // on the wrong map page, or — when the field is simply missing — on no map at all.
      // That happened: `POST /local/result` with no `map` stored a game with `map_key: ''`
      // that appeared nowhere.
      map: row.map_key,
      solo: true,
      player_count: 1,
      players: [{ ...mine, slot: 0, steamid: req.me.steam_id, name: me.name }],
      records_eligible: false,
      xp_multiplier: 0,
    }

    const out = require('../lib/results').ingest(
      { box: null, instance: 'local', summary, replay: b.replay || null },
      { selfReported: true },
    )
    if (!out.ok) return res.status(400).json(out)

    live.drop(row.match_id)
    localMatches.finish(row.match_id, out.game_id)
    res.json({
      ...out,
      tracked: false,
      // What the site actually stored, echoed back, so a launcher can tell that the round
      // it sent is the round that landed rather than assuming a 200 means agreement.
      stored: { rounds: (require('../lib/results').byId(out.game_id) || {}).rounds ?? null, map_key: row.map_key },
      url: `/game/${row.match_id}`,
      notice: 'Stored as a Local game. It earns no badge, no record and no XP, and its replay is not record evidence.',
    })
  })

  // ---- silent error reports (99 §4.3) -------------------------------------------
  // "Errors auto-reported silently, with a short message to the player." The launcher
  // redacts tokens and pipe names before sending (launcher.md §4); the site stores what it
  // is given and never shows it to anyone but staff.
  r.post('/report', (req, res) => {
    const b = req.body || {}
    db.prepare(`INSERT INTO reports (kind, subject, reporter, reason, detail, status, created_at)
                VALUES ('launcher', ?, ?, ?, ?, 'new', ?)`)
      .run(String(b.kind || 'error').slice(0, 40), req.me ? req.me.steam_id : 'anonymous',
        String(b.message || '').slice(0, 300), JSON.stringify(b.context || {}).slice(0, 8000), now())
    // Always 200: a crash reporter that can fail is a crash reporter that produces a
    // second crash to report.
    res.json({ ok: true })
  })

  return r
}

function phaseOf(party, launch) {
  if (!party) return 'idle'
  if (launch && launch.state === 'live') return 'in-game'
  if (launch && launch.state === 'ready') return launch.connect ? 'ready' : 'loading'
  if (launch && launch.match_id) return 'reserving'
  if (party.state === 'ready-check') return 'ready-check'
  if (party.map) return 'selected'
  return 'idle'
}

// Everything the launcher needs to have the map on disk before it launches. `files` is the
// archive's record of the version — empty until the archive pipeline has imported one, and
// an empty list means "we cannot tell you how to install this", NOT "nothing to install".
function mapPayload(m) {
  const v = db.prepare('SELECT * FROM map_versions WHERE map_id=? AND latest=1').get(m.id)
  const files = v ? db.prepare("SELECT path, sha256, size, kind, source_url FROM map_files WHERE map_version_id=? AND kind != 'script'").all(v.id) : []
  return {
    key: m.key,
    title: m.title,
    art: m.art || null,
    author: m.author || null,
    health: m.health,
    fs_game: v ? v.fs_game : null,
    version: v ? v.version : null,
    version_id: v ? v.id : null,
    size_bytes: v ? v.size_bytes : null,
    files,
    install_known: files.length > 0,
    // The readme, for the boot screen to show while the map loads (13 §4b-2).
    readme: m.readme || m.description || null,
  }
}

const stateFor = (steamId) => {
  const s = launcherState.get(String(steamId))
  return s && now() - s.at < STATE_TTL_MS ? s : null
}

module.exports = { router, stateFor, PROTOCOL_VERSION }
