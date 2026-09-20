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
const users = require('../lib/users')
const parties = require('../lib/parties')
const maps = require('../lib/maps')
const presence = require('../lib/presence')
const enw = require('../lib/enw')
const { db, now } = require('../db/database')
const { safeJson } = require('../lib/util')
const { requireUser, requireApproved } = require('../middleware/auth')

// What the launcher last told us it was doing, per player. In memory: it is a progress bar,
// it changes every few hundred milliseconds, and it is meaningless once the process is gone.
const launcherState = new Map()
const STATE_TTL_MS = 120_000

const PROTOCOL_VERSION = 0

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
        deep_links: ['/m/:map', '/live/:match', '/id/:who'],
        // Not built. Listed so the launcher can grey a button instead of calling and
        // getting a 404 it has to explain to the player.
        map_downloads: false,
        replay_downloads: false,
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
