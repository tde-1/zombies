'use strict'

// The routes that are the site itself rather than one noun: home, records, badges,
// playlists, the party rail, chat, and the game view.

const express = require('express')
const maps = require('../lib/maps')
const mapWeek = require('../lib/mapWeek')
const feed = require('../lib/feed')
const presence = require('../lib/presence')
const assignments = require('../lib/assignments')
const records = require('../lib/records')
const badges = require('../lib/badges')
const achievements = require('../lib/achievements')
const playlists = require('../lib/playlists')
const parties = require('../lib/parties')
const results = require('../lib/results')
const chat = require('../lib/chatNetwork')
const live = require('../lib/live')
const seats = require('../lib/seats')
const replays = require('../lib/replays')
const enw = require('../lib/enw')
const users = require('../lib/users')
const roster = require('../lib/roster')
const { safeJson } = require('../lib/util')
const { db } = require('../db/database')
const { requireUser, requireApproved } = require('../middleware/auth')

// 20 invite-link lookups a minute per account (Movement's INVITE_RATE_LIMIT is 20/min per IP).
const linkHits = new Map()
function linkLimited(sid) {
  const t = Date.now()
  const list = (linkHits.get(sid) || []).filter((x) => t - x < 60_000)
  list.push(t)
  linkHits.set(sid, list)
  if (linkHits.size > 5000) linkHits.clear()
  return list.length > 20
}

function router() {
  const r = express.Router()

  // ---- home (13 §3) --------------------------------------------------------------
  // Top to bottom, exactly the order B gave: live games + friends online, map of the week
  // + featured, latest records + badges.
  r.get('/home', (req, res) => {
    const me = req.me ? req.me.steam_id : null
    res.json({
      live: assignments.live(),
      // Which of those are actually sending frames, so home can offer Watch on the ones
      // where it would work and stay quiet on the ones where it would not.
      watchable: live.list(me),
      friends: me ? presence.friendsOnline(me) : [],
      online: presence.stats(),
      week: mapWeek.current(),
      featured: maps.list({ sort: 'popular', limit: 4, me }).maps,
      feed: feed.recent(24),
      map_count: maps.count(),
      // What is real and what is not, stated on the page rather than in a document.
      // Nobody opening this for the first time should have to wonder whether something is
      // broken or simply not built yet.
      build: {
        auth: require('./auth').effectiveMode(),
        enw: enw.status().enabled,
        archive_total: db.prepare('SELECT COUNT(*) c FROM maps').get().c,
        // Each of these is a thing a visitor can see and might reasonably expect to work.
        stubbed: [
          !enw.status().enabled && 'The ENW name service is not connected, so the name you choose here is checked against the ENW rules but not against drops.ws itself, and VIP is whatever is set locally.',
          'Map art is missing everywhere, so cards show the map’s engine name instead.',
          'The launcher is not installed here, so Play Local and map downloads have nothing to launch or fetch.',
          'Badge art is not drawn yet — every badge is a hexagon with the map name in it.',
        ].filter(Boolean),
      },
      // No "rescued" counter anywhere in v1 (13 §3). This is the map count the way Movement
      // shows it, and nothing else.
    })
  })

  // ---- records hub ----------------------------------------------------------------
  r.get('/records', (req, res) => {
    res.json({
      records: records.hub({
        category: req.query.category || null,
        playerCount: req.query.players ? Number(req.query.players) : null,
        profile: req.query.profile || 'ENW-Verified',
        // A map's own game mode (game-modes.md): e.g. `gungame`. Absent = every mode.
        gameMode: req.query.game_mode ? String(req.query.game_mode).slice(0, 64) : null,
      }),
      categories: records.categories(),
      profiles: records.profiles(),
    })
  })

  r.get('/records/board/:id', (req, res) => {
    const b = db.prepare('SELECT * FROM boards WHERE id=?').get(Number(req.params.id))
    if (!b) return res.status(404).json({ error: 'no such board' })
    res.json({ board: b, rows: records.rowsFor(b.id, 100) })
  })

  // ---- badges directory -----------------------------------------------------------
  r.get('/badges', (req, res) => {
    const me = req.me ? req.me.steam_id : null
    res.json({
      badges: badges.list({ includeRetired: false }),
      progress: me ? achievements.progressFor(me) : {},
      held: me ? badges.forPlayer(me).map((b) => b.id) : [],
    })
  })

  r.get('/badges/:slug', (req, res) => {
    const b = badges.bySlug(req.params.slug)
    if (!b) return res.status(404).json({ error: 'no such badge' })
    res.json({ badge: badges.get(b.id), holders: badges.holders(b.id) })
  })

  // ---- playlists ------------------------------------------------------------------
  r.get('/playlists', (req, res) => {
    res.json({ playlists: playlists.live({ me: req.me ? req.me.steam_id : null, withMaps: true }) })
  })

  r.get('/playlists/:slug', (req, res) => {
    const p = playlists.bySlug(req.params.slug, { me: req.me ? req.me.steam_id : null })
    if (!p) return res.status(404).json({ error: 'no such playlist' })
    res.json({ playlist: p })
  })

  // ---- the archive page ---------------------------------------------------------
  // The story and the numbers, all counted rather than typed. The map list itself comes
  // from /api/maps?archive=1, which paginates.
  r.get('/archive', (req, res) => {
    res.json({
      stats: maps.archiveStats(),
      broken: maps.list({ includeBroken: true, sort: 'name' }).maps.filter((m) => m.health === 'broken').slice(0, 50),
      newest: maps.list({ sort: 'newest', limit: 8 }).maps,
      // Where the links point, so the page can say which sites the archive actually rests
      // on rather than claiming a number.
      hosts: db.prepare(`SELECT site, COUNT(*) n,
                                SUM(CASE WHEN status IN ('alive','fetched') THEN 1 ELSE 0 END) alive,
                                SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END) dead
                           FROM archive_sources WHERE site IS NOT NULL
                          GROUP BY site ORDER BY n DESC LIMIT 12`).all(),
    })
  })

  // ---- creators -------------------------------------------------------------------
  r.get('/creators', (req, res) => res.json({ creators: maps.authors({ all: true }) }))

  r.get('/creators/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name)
    const rows = maps.list({ author: name, sort: 'oldest', me: req.me ? req.me.steam_id : null })
    if (!rows.total) return res.status(404).json({ error: 'no such creator' })
    const c = db.prepare('SELECT * FROM creators WHERE lower(name)=lower(?)').get(name)
    res.json({
      creator: {
        name,
        slug: c ? c.slug : null,
        bio: c ? c.bio : null,
        claimed_by: c && c.claimed_by ? users.publicById(c.claimed_by) : null,
      },
      maps: rows.maps,
      plays: rows.maps.reduce((n, m) => n + (m.plays || 0), 0),
    })
  })

  // ---- the party rail --------------------------------------------------------------
  r.get('/party', (req, res) => {
    if (!req.me) return res.json({ party: null })
    const row = parties.forPlayerRow(req.me.steam_id)
    if (row && row.pending_map_key) parties.maybeSwitch(row.id)   // [PC] a pending map switch
    const party = parties.forPlayer(req.me.steam_id)
    const launch = parties.launchInfo(req.me.steam_id)
    res.json({
      party,
      launch,
      invites: parties.invitesFor(req.me.steam_id),
      // The same phase the launcher's poll is shown (lib/seats.js), and `resume` when the
      // server card should offer Resume: this player crashed out of a game that is still up.
      phase: seats.phaseOf(party, launch, req.me.steam_id),
      resume: seats.resumeInfo(launch, req.me.steam_id),
      // [reconnect] the game is paused, waiting for a player who dropped (host drop hold):
      // the server card says who and for how long.
      hold: launch && launch.match_id ? live.hold(launch.match_id, req.me.steam_id) : null,
    })
  })

  // QUIT ON PURPOSE (the in-game Esc menu's Exit game, B 2026-09-23): the last player in the
  // game cancels the server, so the launcher has nothing to boot you back into; in a co-op game
  // it goes on for the others. You STAY in the party either way (B 2026-09-24: parties persist
  // across games; lib/seats.js quit). A crash or Alt+F4 sends nothing, and that absence is
  // what makes the game resumable (lib/seats.js).
  //
  // The game calls this with its CHAT PASS (the launcher mints it at launch; the game
  // never holds the session), so it accepts that bearer as well as a session cookie.
  r.post('/party/quit', (req, res) => {
    let sid = req.me ? req.me.steam_id : null
    if (!sid) {
      const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))
      const u = m ? require('../lib/gameChat').verifyPass(m[1]) : null
      sid = u ? u.steam_id : null
    }
    if (!sid) return res.status(401).json({ error: 'sign in, or send the game\'s chat pass' })
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    res.json(seats.quit(sid, b.match_id ? String(b.match_id).slice(0, 40) : null))
  })

  // CLOSE THE SERVER from the rail's server card (its ×): the party's game ends for everybody
  // and the party stays, back to forming with its map (lib/seats.js `end`). Host only.
  r.post('/party/end', requireUser, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const out = seats.end(req.me.steam_id, b.match_id ? String(b.match_id).slice(0, 40) : null)
    res.status(out.ok ? 200 : 400).json(out)
  })

  // CONTINUE WITHOUT from the rail's server card: the party host plays on without a player the
  // game is paused for (lib/seats.js continueWithout). Host only.
  r.post('/party/continue', requireUser, (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const out = seats.continueWithout(req.me.steam_id, b.match_id ? String(b.match_id).slice(0, 40) : null)
    res.status(out.ok ? 200 : 400).json(out)
  })

  // RESUME from the rail's server card: back into the game this player crashed out of.
  // The launcher's watcher follows the phase this puts back (`in-game`), with a fresh token.
  r.post('/party/resume', requireUser, (req, res) => {
    const launch = parties.launchInfo(req.me.steam_id)
    const matchId = (req.body && req.body.match_id) || (launch && launch.match_id)
    if (!matchId) return res.status(400).json({ ok: false, error: 'there is nothing to resume' })
    const out = seats.resume(req.me.steam_id, String(matchId))
    res.status(out.ok ? 200 : 400).json(out)
  })

  const partyAction = (fn) => (req, res) => {
    const out = fn(req)
    res.status(out && out.ok === false ? 400 : 200).json(out)
  }

  r.post('/party/create', requireApproved, partyAction((req) => {
    const b = req.body || {}
    // `game_mode` is what the rail had staged before a party existed; create() keeps it only
    // if the staged map offers it.
    return { ok: true, party: parties.create(req.me.steam_id, { ...b, gameMode: b.game_mode ?? b.gameMode ?? null }) }
  }))
  r.post('/party/join', requireApproved, partyAction((req) => parties.join(req.me.steam_id, Number((req.body && req.body.party_id) || 0))))
  r.post('/party/leave', requireUser, partyAction((req) => parties.leave(req.me.steam_id)))
  r.post('/party/map', requireApproved, partyAction((req) => parties.setMap(req.me.steam_id, (req.body && req.body.map_key) || null)))
  // [PC] Change map while the party's game runs: switch the party's server (lib/parties.js
  // switchMap). With no game running it is the same as /party/map.
  r.post('/party/switch', requireApproved, partyAction((req) => parties.switchMap(req.me.steam_id, (req.body && req.body.map_key) || null)))
  r.post('/party/switch/now', requireApproved, partyAction((req) => parties.switchNow(req.me.steam_id)))
  r.post('/party/switch/cancel', requireApproved, partyAction((req) => parties.cancelSwitch(req.me.steam_id)))
  r.post('/party/mode', requireApproved, partyAction((req) => parties.setMode(req.me.steam_id, (req.body && req.body.mode) || 'verified')))
  // The map's own game mode (game-modes.md): leader only, only a mode the map offers.
  r.post('/party/game-mode', requireApproved, partyAction((req) => parties.setGameMode(req.me.steam_id, (req.body && req.body.game_mode) || '')))
  r.post('/party/visibility', requireApproved, partyAction((req) => parties.setVisibility(req.me.steam_id, (req.body && req.body.visibility) || 'friends')))
  r.post('/party/settings', requireApproved, partyAction((req) => parties.setSettings(req.me.steam_id, (req.body && req.body.settings) || {})))
  r.post('/party/ready-check', requireApproved, partyAction((req) => parties.startReadyCheck(req.me.steam_id, { force: !!(req.body && req.body.force) })))
  // Every member's launcher posts its own map download here while the party forms
  // (docs/protocol/launcher-v0.md). requireUser, not requireApproved: a member of a party
  // is already somebody the leader let in, and refusing the download report of an
  // unapproved friend would leave the panel showing a bar that never moves.
  r.post('/party/:id/progress', requireUser, partyAction((req) => parties.reportProgress(req.me.steam_id, Number(req.params.id), req.body || {})))
  r.post('/party/ready', requireApproved, partyAction((req) => parties.setReady(req.me.steam_id, !!(req.body && req.body.ready))))
  r.post('/party/cancel', requireApproved, partyAction((req) => parties.cancelReadyCheck(req.me.steam_id)))
  r.post('/party/launch', requireApproved, partyAction((req) => parties.launch(req.me.steam_id, { force: !!(req.body && req.body.force) })))
  // By SteamID (a row in the online list) or by ENW name (the invite box). A name is
  // resolved here and nowhere else, so the client never needs to learn anybody's id first.
  // `stage` is what the rail had picked before a party existed (lib/parties.invite).
  r.post('/party/invite', requireApproved, partyAction((req) => {
    const b = req.body || {}
    let to = String(b.steam_id || '')
    if (!to && b.username) {
      const u = users.resolve(String(b.username))
      if (!u) return { ok: false, error: 'no player by that name' }
      to = u.steam_id
    }
    const stage = b.stage && typeof b.stage === 'object' ? b.stage : null
    return parties.invite(req.me.steam_id, to, stage)
  }))
  // Movement's accept (`POST /api/party/invites/:id/accept`): the invite, not the party id,
  // so an expired or withdrawn invite is refused by name rather than by the lobby's rules.
  r.post('/party/invites/:id/accept', requireApproved, partyAction((req) => parties.acceptInvite(req.me.steam_id, Number(req.params.id))))
  r.post('/party/invites/:id/decline', requireUser, partyAction((req) => parties.declineInvite(req.me.steam_id, Number(req.params.id))))
  // The invite LINK (lib/parties.js): get yours (any member; a party is made from the
  // stage if there is none), change it (leader), look one up, join by one. Lookups are
  // rate-limited per account: a code is a key, and guessing keys should be slow.
  r.post('/party/link', requireApproved, partyAction((req) => {
    const b = req.body || {}
    return parties.link(req.me.steam_id, b.stage && typeof b.stage === 'object' ? b.stage : null)
  }))
  r.post('/party/link/reset', requireApproved, partyAction((req) => parties.resetLink(req.me.steam_id)))
  r.get('/party/link/:code', requireUser, (req, res) => {
    if (linkLimited(req.me.steam_id)) return res.status(429).json({ ok: false, error: 'slow down' })
    const out = parties.linkPreview(req.params.code, req.me.steam_id)
    res.status(out.ok ? 200 : 404).json(out)
  })
  r.post('/party/link/:code/join', requireApproved, (req, res) => {
    if (linkLimited(req.me.steam_id)) return res.status(429).json({ ok: false, error: 'slow down' })
    const out = parties.joinByLink(req.me.steam_id, req.params.code)
    res.status(out.ok ? 200 : 400).json(out)
  })
  r.post('/party/invites/:id/cancel', requireUser, partyAction((req) => parties.cancelInvite(req.me.steam_id, Number(req.params.id))))
  r.post('/party/kick', requireApproved, partyAction((req) => parties.kick(req.me.steam_id, String((req.body && req.body.steam_id) || ''))))

  // The rail's online block and its invite search (lib/roster.js). Signed out there is
  // nobody to be online FOR, so it is an empty list rather than a 401 the rail has to catch.
  r.get('/party/online', (req, res) => {
    if (!req.me) return res.json({ scope: 'online', players: [] })
    res.json(roster.forViewer(req.me.steam_id))
  })
  r.get('/party/invite-search', requireUser, (req, res) => {
    res.json({ results: roster.search(req.me.steam_id, req.query.q) })
  })

  // ---- friends (lane SOC, 2026-09-23) -------------------------------------------------
  // Requests waiting on me, for the rail's Requests block. Accept / Decline are the
  // profile's existing POST /api/players/:who/friend {action}; both push to the other side.
  r.get('/friends/requests', requireUser, (req, res) => {
    res.json({ requests: users.pendingRequests(req.me.steam_id) })
  })

  // ---- party chat and DMs from the site (lane SOC) ----------------------------------
  // The same private ring the in-game overlay speaks (lib/gameChat.js, channel party|dm):
  // the launcher chimes on a DM or a party line, so the site has to be able to show and
  // answer one. Same rules as in game: DMs to friends and party members, 5 lines / 10 s.
  r.get('/chat/private', requireUser, (req, res) => {
    const gameChat = require('../lib/gameChat')
    res.json({ lines: gameChat.privateFor(req.me.steam_id, Number(req.query.after) || 0, { tailN: 40 }) })
  })
  r.post('/chat/private', requireUser, (req, res) => {
    const gameChat = require('../lib/gameChat')
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const channel = b.channel === 'dm' ? 'dm' : 'party'
    const out = gameChat.send(req.me, { channel, to: b.to ? String(b.to) : null, text: b.text })
    res.status(out.ok ? 200 : 400).json(out)
  })
  r.post('/party/quick-join', requireApproved, partyAction((req) => parties.quickJoin(req.me.steam_id, (req.body && req.body.map_key) || null)))

  // ---- presets (the Custom knobs) ---------------------------------------------------
  r.get('/presets', (req, res) => {
    const rows = db.prepare('SELECT * FROM presets ORDER BY locked DESC, featured DESC, created_at DESC').all()
    res.json({
      presets: rows.map((p) => ({
        id: p.id, code: p.code, name: p.name, blurb: p.blurb,
        knobs: JSON.parse(p.knobs_json || '{}'), locked: !!p.locked, featured: !!p.featured,
        mine: req.me ? p.owner === req.me.steam_id : false,
      })),
      // The eight knob groups of 13 §4c, with their ranges. The UI draws itself from this so
      // the caps live in one place — and the caps are the spec's: "wide but capped".
      groups: KNOB_GROUPS,
    })
  })

  r.post('/presets', requireApproved, (req, res) => {
    const { shortCode } = require('../lib/util')
    const b = req.body || {}
    if (!b.name) return res.status(400).json({ error: 'name it' })
    const code = shortCode(6)
    db.prepare(`INSERT INTO presets (code, owner, name, blurb, knobs_json, created_at)
                VALUES (?,?,?,?,?,?)`).run(code, req.me.steam_id, String(b.name).slice(0, 60), b.blurb || null,
      JSON.stringify(b.knobs || {}), Date.now())
    res.json({ ok: true, code })
  })

  r.get('/presets/:code', (req, res) => {
    const p = db.prepare('SELECT * FROM presets WHERE code=?').get(String(req.params.code).toUpperCase())
    if (!p) return res.status(404).json({ error: 'no such share code' })
    db.prepare('UPDATE presets SET uses=COALESCE(uses,0)+1 WHERE id=?').run(p.id)
    res.json({ preset: { code: p.code, name: p.name, blurb: p.blurb, knobs: JSON.parse(p.knobs_json || '{}'), locked: !!p.locked } })
  })

  // ---- games ------------------------------------------------------------------------
  r.get('/games/:id', (req, res) => {
    const g = /^\d+$/.test(req.params.id) ? results.byId(req.params.id) : results.byMatch(req.params.id)
    if (!g) return res.status(404).json({ error: 'no such game' })
    res.json({ game: g })
  })

  // ---- live games and the live view --------------------------------------------------
  // `/api/live` is the lobby-level list (what has been leased); `/api/live/watch` is the
  // list of games actually sending frames, which is the one the spectator list wants.
  // ---- replays ------------------------------------------------------------------
  // The pointer and the evidence grade are PUBLIC for every game: 99 §4.7 rests records
  // on a signed replay, and a record nobody can check is a record nobody should believe.
  // The bytes are gated (Q-host-1).
  r.get('/replays/:matchId', (req, res) => {
    const d = replays.describe(req.params.matchId, req.me)
    if (!d) return res.status(404).json({ error: 'no replay for that game' })
    res.json({ replay: d })
  })

  r.get('/replays/:matchId/download', (req, res) => {
    const row = replays.rowFor(req.params.matchId)
    const may = replays.mayDownload(row, req.me)
    if (!may.ok) return res.status(row ? 403 : 404).json({ error: may.reason })
    const f = replays.fileFor(req.params.matchId)
    if (!f) {
      return res.status(503).json({
        error: 'the file is on the game box and there is no object store yet',
        // Say where it is rather than pretending it does not exist — on a dev box the
        // person asking can just go and get it.
        file: row.file || null,
      })
    }
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('content-length', f.size)
    res.setHeader('content-disposition', `attachment; filename="${f.name}"`)
    require('fs').createReadStream(f.path).pipe(res)
  })

  r.get('/live', (req, res) => res.json({
    live: assignments.live(),
    watchable: live.list(req.me ? req.me.steam_id : null),
    stats: live.stats(),
  }))

  r.get('/live/:matchId', (req, res) => {
    const id = String(req.params.matchId)
    const may = live.canWatch(id, req.me ? req.me.steam_id : null)
    if (!may.ok) return res.status(403).json({ error: may.reason })
    const frame = live.get(id)
    const game = db.prepare('SELECT * FROM games WHERE match_id=?').get(id)
    const a = db.prepare('SELECT * FROM assignments WHERE match_id=?').get(id)
    if (!frame && !game && !a) return res.status(404).json({ error: 'no such game' })
    const mapKey = (frame && frame.state.map) || (game && game.map_key) || (a && a.map_key) || null
    res.json({
      match_id: id,
      frame,
      // A game that has ENDED still resolves here, and says so rather than 404ing: a
      // spectator watching the last round should land on the result, not on a dead page.
      ended: game ? results.project(game) : null,
      state: frame ? 'live' : game ? 'ended' : a ? String(a.state) : 'unknown',
      map: mapKey ? maps.project(maps.byKey(mapKey), { me: req.me ? req.me.steam_id : null }) : null,
      // The manifest's signals, so the view can say WHICH of them have fired rather than
      // printing the raw ids the box sends.
      signal_labels: mapKey ? signalLabels(mapKey) : {},
    })
  })

  // ---- global chat --------------------------------------------------------------
  // `?since=<id>` is the dock's catch-up after a socket reconnect: only what it missed, in
  // order, never the tail again. Without it, the backlog (the tail).
  r.get('/chat', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 40))
    const since = Number(req.query.since)
    const rows = Number.isFinite(since) && since > 0 ? chat.since(since, { limit }) : chat.tail(limit)
    res.json({ chat: rows, latest: chat.latest() })
  })

  r.post('/chat', requireUser, (req, res) => {
    const text = (req.body && req.body.text) || ''
    if (!text) return res.status(400).json({ error: 'no text' })
    // origin 'web' is nobody's box, so every box picks it up on its next drain.
    const line = chat.push({ from: users.pub(req.me).name, text, steamId: req.me.steam_id, origin: 'web' })
    res.json({ ok: true, line })
  })

  // ---- reports -----------------------------------------------------------------------
  r.post('/report', requireUser, (req, res) => {
    const bansLib = require('../lib/bans')
    const b = req.body || {}
    if (!b.kind) return res.status(400).json({ error: 'what kind of report?' })
    res.json(bansLib.report({
      kind: String(b.kind), subject: b.subject != null ? String(b.subject) : null,
      reporter: req.me.steam_id, reported: b.reported ? String(b.reported) : null,
      reason: b.reason || null, detail: b.detail || null,
    }))
  })

  r.delete('/comments/:id', requireUser, (req, res) => {
    const out = require('../lib/comments').remove(Number(req.params.id), req.me.steam_id, { moderator: !!(req.me.is_mod || req.me.is_admin) })
    res.status(out.ok ? 200 : 403).json(out)
  })

  // ---- search (the one box) ---------------------------------------------------------
  r.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ maps: [], players: [] })
    const me = req.me ? req.me.steam_id : null
    res.json({
      maps: maps.list({ q, limit: 8, me }).maps,
      players: db.prepare(`SELECT * FROM users WHERE deleted=0 AND (lower(enw_name) LIKE ? OR lower(username) LIKE ?) LIMIT 6`)
        .all(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`).map(users.pub),
    })
  })

  return r
}

// `signal_id -> human label`, read from the map's referee manifest. The box reports
// `power_on`; the manifest calls it "Power turned on"; the live view should say the second.
function signalLabels(mapKey) {
  const m = db.prepare(`SELECT mf.json FROM manifests mf JOIN map_versions v ON v.id=mf.map_version_id
                         JOIN maps mp ON mp.id=v.map_id WHERE mp.key=? AND v.latest=1`).get(String(mapKey))
  const j = m ? safeJson(m.json, {}) : {}
  const out = {}
  for (const s of (j && j.signals) || []) if (s && s.id) out[s.id] = s.label || s.id
  for (const f of (j && j.finishes) || []) if (f && f.id) out[f.id] = f.label || f.id
  return out
}

// 13 §4c. Defaults are WaW's stock values; the ranges are wide but capped, and anything
// beyond them is what the host console is for.
const KNOB_GROUPS = [
  { key: 'start', label: 'Start', knobs: [
    { key: 'round', label: 'Starting round', type: 'int', min: 1, max: 255, default: 1 },
    { key: 'points', label: 'Starting points', type: 'int', min: 0, max: 1000000, default: 500 },
  ] },
  { key: 'perks', label: 'Perks & power', knobs: [
    { key: 'all_perks', label: 'Start with all perks', type: 'bool', default: false },
    { key: 'power_on', label: 'Power on from the start', type: 'bool', default: false },
    { key: 'no_limit', label: 'Perk limit off', type: 'bool', default: false },
  ] },
  { key: 'box', label: 'Box & weapons', knobs: [
    { key: 'starting_weapon', label: 'Starting weapon', type: 'string', default: null },
    { key: 'pap_cost', label: 'Pack-a-Punch cost', type: 'int', min: 0, max: 20000, default: 5000 },
    { key: 'infinite_ammo', label: 'Infinite ammo', type: 'bool', default: false },
  ] },
  { key: 'zombies', label: 'Zombies', knobs: [
    { key: 'health', label: 'Health multiplier', type: 'float', min: 0.1, max: 10, default: 1 },
    { key: 'speed', label: 'Speed', type: 'enum', options: ['walk', 'run', 'sprint'], default: null },
    { key: 'max_alive', label: 'Max alive', type: 'int', min: 1, max: 64, default: 24 },
    { key: 'dogs', label: 'Dog rounds', type: 'bool', default: true },
  ] },
  { key: 'powerups', label: 'Powerups & drops', knobs: [
    { key: 'drop_rate', label: 'Drop rate', type: 'float', min: 0, max: 5, default: 1 },
    { key: 'max_ammo_every', label: 'Max ammo frequency', type: 'int', min: 0, max: 20, default: 0 },
  ] },
  { key: 'players', label: 'Player rules', knobs: [
    { key: 'downs', label: 'Downs allowed', type: 'int', min: 0, max: 99, default: 3 },
    { key: 'bleedout', label: 'Bleedout time (s)', type: 'int', min: 5, max: 300, default: 45 },
    { key: 'revive_speed', label: 'Revive speed', type: 'float', min: 0.1, max: 5, default: 1 },
    { key: 'friendly_fire', label: 'Friendly fire', type: 'bool', default: false },
    { key: 'respawn_each_round', label: 'Respawn each round', type: 'bool', default: true },
  ] },
  { key: 'speed', label: 'Game speed & gravity', knobs: [
    { key: 'timescale', label: 'Timescale', type: 'float', min: 0.25, max: 4, default: 1 },
    { key: 'g_speed', label: 'Player speed', type: 'int', min: 50, max: 500, default: 190 },
    { key: 'jump_height', label: 'Jump height', type: 'int', min: 10, max: 512, default: 39 },
    { key: 'gravity', label: 'Gravity', type: 'int', min: 50, max: 1600, default: 800 },
  ] },
  { key: 'console', label: 'Console', knobs: [
    { key: 'host_console', label: 'Host gets the dev console', type: 'bool', default: true },
  ] },
]

module.exports = { router, KNOB_GROUPS }
